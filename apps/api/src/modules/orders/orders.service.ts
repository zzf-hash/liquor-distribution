import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, AuditAction } from '../../audit/audit.service';
import { IdempotencyService } from '../../audit/idempotency.service';
import { assertOrderTransition, ORDER_STATUS_LABELS } from '../../statemachine/order-state';
import type { OrderStatus } from '../../statemachine/order-state';
import { assertOutboundTransition, OutboundState } from '../../statemachine/outbound-state';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P0-T20~T25 订单主线 ═══════════════
// 设计依据: docs/baseline/开发任务书_MVP分期_v1.md WS-2 + docs/M0/业务适配清单.md
//   T20 三入口统一订单池 | T21 审单预检四要素(信用/价格/库存/起送量, 超额拦截+老板特批)
//   T22 出库 FIFO 批次+复核(不可变流水) | T23 签收→应收(D4) + 回包装回填
//   T24 纸单回录 | T25 改单(红字冲销 B3)/取消/拒收(库存回冲)

export interface CreateLineDto {
  productId: string;
  qty: number;
  unit: 'BASE' | 'MIN';
  /** 内勤/老板手工价(留痕 priceType=MANUAL) */
  priceOverride?: number;
  isGift?: boolean;
}

export interface CreateOrderDto {
  /** P1-5: CUSTOMER 角色禁传(服务端强制取 token 身份); CLERK/REP 必传 */
  customerId?: string;
  source: 'CLERK' | 'REP' | 'CUSTOMER';
  lines: CreateLineDto[];
  addressOverride?: string;
  deliveryDate?: string;
  note?: string;
  /** 老板特批放行(信用超额/超起送量), 仅 OWNER; 必须给理由 */
  forceSpecial?: boolean;
  specialReason?: string;
}

interface PrecheckResult {
  customer: { ok: boolean; detail: string };
  credit: { ok: boolean; available: number; openAr: number; inTransit: number; limit: number; need: number };
  inventory: Array<{ productId: string; productName: string; ok: boolean; onHand: number; occupied: number; need: number }>;
  minOrder: { ok: boolean; amount: number; min: number };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly idem: IdempotencyService,
  ) {}

  // ─────────────── 取价引擎 (D08/R1: 专属价>终端供货>二批>一批>零售; 无生效价拒单) ───────────────
  private async resolvePrice(customerId: string, productId: string, unit: 'BASE' | 'MIN'): Promise<{ price: Prisma.Decimal; priceType: string; priceVersion: string } | null> {
    const now = new Date();
    const valid = { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] };
    const exclusive = await this.prisma.customerPrice.findFirst({
      where: { customerId, productId, unit, ...valid },
      orderBy: { validFrom: 'desc' },
    });
    if (exclusive) return { price: exclusive.price, priceType: 'CUSTOMER_EXCLUSIVE', priceVersion: `${exclusive.id}:${exclusive.validFrom.toISOString()}` };
    const order: Array<'TERMINAL' | 'TIER2' | 'TIER1' | 'RETAIL'> = ['TERMINAL', 'TIER2', 'TIER1', 'RETAIL'];
    for (const level of order) {
      const row = await this.prisma.price.findFirst({
        where: { productId, unit, levelType: level, ...valid },
        orderBy: { validFrom: 'desc' },
      });
      if (row) return { price: row.price, priceType: level, priceVersion: `${row.id}:${row.validFrom.toISOString()}` };
    }
    return null;
  }

  // ─────────────── 库存投影 (B4: 全部由流水推导, 无余额列) ───────────────
  private async stockProjection(productIds: string[]): Promise<Map<string, { onHand: number; occupied: number }>> {
    const map = new Map<string, { onHand: number; occupied: number }>();
    if (productIds.length === 0) return map;
    const groups = await this.prisma.inventoryLedger.groupBy({
      by: ['productId', 'direction'],
      where: { productId: { in: productIds } },
      _sum: { qty: true },
    });
    const onHandMap = new Map<string, number>();
    for (const g of groups) {
      const q = Number(g._sum.qty ?? 0);
      onHandMap.set(g.productId, (onHandMap.get(g.productId) ?? 0) + (g.direction === 'IN' ? q : -q));
    }
    // 占用 = 待确认/已确认订单的行净数量(未出库)
    const activeOrders = await this.prisma.orderLine.findMany({
      where: { order: { status: { in: ['PENDING_CONFIRM', 'CONFIRMED'] } } },
      select: { productId: true, qty: true, unit: true, conversionRate: true, reversalOfId: true },
    });
    const occupiedMap = new Map<string, number>();
    for (const l of activeOrders) {
      const q = Number(l.qty) * (l.unit === 'BASE' ? l.conversionRate : 1);
      occupiedMap.set(l.productId, (occupiedMap.get(l.productId) ?? 0) + q);
    }
    for (const pid of productIds) {
      map.set(pid, { onHand: onHandMap.get(pid) ?? 0, occupied: occupiedMap.get(pid) ?? 0 });
    }
    return map;
  }

  // ─────────────── 信用投影 (D07: 可用 = 额度 − 未核销应收 − 在途占用) ───────────────
  private async creditProjection(customerId: string): Promise<{ openAr: number; inTransit: number }> {
    const ars = await this.prisma.receivable.findMany({
      where: { customerId, disputeFlag: false },
      // P1-8: 核销口径须含 RETURN_CREDIT/WAIVE/WRITEOFF——漏算会低估已核销额→误拦新单
      include: { ledger: { where: { direction: { in: ['SETTLE', 'REBATE_OFFSET', 'RETURN_CREDIT', 'WAIVE', 'WRITEOFF'] } } } },
    });
    const openAr = ars.reduce((s, r) => s + Number(r.total) - r.ledger.reduce((x, l) => x + Number(l.amount), 0), 0);
    const inTransitOrders = await this.prisma.salesOrder.aggregate({
      where: { customerId, status: 'CONFIRMED' }, // D07: 已审通过未出库
      _sum: { totalAmount: true },
    });
    return { openAr, inTransit: Number(inTransitOrders._sum.totalAmount ?? 0) };
  }

  // ─────────────── P0-T20 三入口下单 + P0-T21 审单预检 ───────────────
  async create(dto: CreateOrderDto, user: AuthUser, idemKey?: string, ip?: string): Promise<{ id: string; orderNo: string; status: string; totalAmount: number; precheck: PrecheckResult; replay?: boolean }> {
    if (!dto.lines?.length) throw new BadRequestException('订单至少一行商品');
    // 下单接入幂等基座(2026-10 审查修复: 此前后端不消费 Idempotency-Key, 防重复下单只剩前端布尔位;
    // 客户端 miniapp api.ts orders.create 与 admin 均已随请求携带)。快照在 CUSTOMER source 改写前,
    // 保证 check 与落库两侧指纹一致。
    const idemPayload = { ...dto } as unknown as Record<string, unknown>;
    const dup = await this.idem.check(user, 'orders.create', idemKey ?? '', idemPayload);
    if (dup) return { ...(dup.summary as { id: string; orderNo: string; status: string; totalAmount: number; precheck: PrecheckResult }), replay: true };
    // P1-5: 客户身份一律取自 token
    let customerId = dto.customerId;
    if (user.role === 'CUSTOMER') {
      customerId = user.customerId ?? '';
      if (!customerId) throw new ForbiddenException('请联系业务员或内勤处理');
      dto.source = 'CUSTOMER';
    }
    // P1-5: customerId 可选化(CUSTOMER 取 token); CLERK/REP 代下单必须显式指定客户
    if (!customerId) throw new BadRequestException('customerId 必传(代下单场景)');
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { salesperson: { select: { id: true, name: true } } },
    });
    if (!customer) throw new NotFoundException('客户不存在');

    // 四要素①: 客户有效(终审+未禁用; 未终审不可自主下单 Q4, 红线1 文案)
    const customerOk = customer.status === 'ACTIVE' && (dto.source === 'CUSTOMER' ? customer.onboarding === 'ACTIVE' : customer.onboarding === 'ACTIVE' || customer.onboarding === 'PENDING_OWNER');
    const precheckCustomer = {
      ok: customerOk,
      detail: customer.status !== 'ACTIVE' ? '客户已禁用' : customer.onboarding !== 'ACTIVE' && dto.source === 'CUSTOMER' ? '请联系业务员或内勤处理' : 'ok',
    };
    if (!customerOk && user.role === 'CUSTOMER') throw new ForbiddenException('请联系业务员或内勤处理'); // 红线1: 不出现内部术语

    // 行构建: 快照 + 取价
    const productIds = [...new Set(dto.lines.map((l) => l.productId))];
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });
    const productMap = new Map(products.map((p) => [p.id, p]));
    const lineData: Array<Omit<Prisma.OrderLineUncheckedCreateInput, 'id' | 'createdAt' | 'orderId'>> = [];
    let totalAmount = new Prisma.Decimal(0); // P1-13: Decimal 精确累加, 原浮点累加合计≠行和边界风险
    for (const l of dto.lines) {
      const p = productMap.get(l.productId);
      if (!p) throw new BadRequestException(`商品 ${l.productId} 不存在`);
      if (p.status !== 'ON_SALE') throw new BadRequestException(`商品 ${p.name} 已停售`);
      if (l.qty <= 0) throw new BadRequestException('数量必须大于 0');
      if (l.unit === 'BASE' && !Number.isInteger(l.qty)) throw new BadRequestException('整件(箱)数量必须为整数');
      let price: Prisma.Decimal;
      let priceType: string;
      let priceVersion: string;
      if (l.isGift) {
        // 2026-10 审查修复: isGift 与 priceOverride 同权(0 元直接改订单金额), 限定内勤/老板
        if (user.role !== 'CLERK' && user.role !== 'OWNER') throw new ForbiddenException('仅内勤/老板可标记赠品行');
        price = new Prisma.Decimal(0); priceType = 'MANUAL'; priceVersion = 'gift'; // 赠品 0 价参与库存扣减, 不占信用(D02)
      } else if (l.priceOverride !== undefined) {
        if (user.role !== 'CLERK' && user.role !== 'OWNER') throw new ForbiddenException('仅内勤/老板可手工价');
        if (l.priceOverride < 0) throw new BadRequestException('价格不能为负');
        price = new Prisma.Decimal(l.priceOverride); priceType = 'MANUAL'; priceVersion = `manual:${user.username}`;
      } else {
        const resolved = await this.resolvePrice(customerId, l.productId, l.unit);
        if (!resolved) throw new HttpException({ code: 422, message: `商品 ${p.name} 无生效价, 请补价后下单(不得静默回退)` }, HttpStatus.UNPROCESSABLE_ENTITY);
        ({ price, priceType, priceVersion } = resolved);
      }
      const amount = price.mul(l.qty);
      totalAmount = totalAmount.add(amount);
      lineData.push({
        tenantId: user.tenantId, // 嵌套 create 不经过租户注入, 显式携带
        productId: p.id,
        productName: p.name,
        specText: p.specText,
        unit: l.unit,
        conversionRate: p.packSize,
        qty: new Prisma.Decimal(l.qty),
        unitPrice: price,
        amount,
        priceType: priceType as never,
        priceVersion,
        isGift: l.isGift ?? false,
        createdById: user.id,
      });
    }

    // P1-15: deliveryDate 无格式校验, 非法串 new Date()=Invalid Date 落库/序列化 500 → 显式 400
    if (dto.deliveryDate !== undefined) {
      const d = new Date(dto.deliveryDate);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('deliveryDate 格式非法(须为 ISO 日期)');
    }
    // 四要素②③④: 信用 / 库存 / 起送量
    const credit = await this.creditProjection(customerId);
    const limit = Number(customer.creditLimit);
    // P1-12: 现结客户额度=0 款到发货(D07)——原三元两分支相同是死代码, 款到发货未实现;
    // 现结客户信用需求按全额计且不参与"额度充足"豁免: 额度=0 时必须收款/特批才能过
    const totalNum = Number(totalAmount);
    const creditNeed = customer.settlement === 'CASH' ? totalNum + credit.openAr + credit.inTransit : totalNum;
    const creditOk = customer.settlement === 'CASH'
      ? creditNeed <= limit // 现结: 全额+在途必须被额度覆盖(额度0则恒 false, 款到发货)
      : creditNeed <= limit - credit.openAr - credit.inTransit;
    const stock = await this.stockProjection(productIds);
    const inventory = productIds.map((pid) => {
      const s = stock.get(pid) ?? { onHand: 0, occupied: 0 };
      const need = dto.lines!.filter((l) => l.productId === pid).reduce((sum, l) => sum + l.qty * (l.unit === 'BASE' ? (productMap.get(pid)?.packSize ?? 1) : 1), 0);
      return { productId: pid, productName: productMap.get(pid)?.name ?? pid, ok: s.onHand - s.occupied >= need, onHand: s.onHand, occupied: s.occupied, need };
    });
    const minOrder = { ok: totalNum >= Number(customer.minOrderAmount), amount: totalNum, min: Number(customer.minOrderAmount) };
    const precheck: PrecheckResult = { customer: precheckCustomer, credit: { ok: creditOk, available: limit - credit.openAr - credit.inTransit, ...credit, limit, need: creditNeed }, inventory, minOrder };
    const failed = !precheckCustomer.ok || !creditOk || inventory.some((i) => !i.ok) || !minOrder.ok;

    // T21: 超额自动拦截留痕; 老板特批可放行(D01/R2, 信用放行须老板本人)
    let specialApproved = false;
    if (failed) {
      await this.audit.log({ user, action: AuditAction.PRECHECK_BLOCK, entityType: 'Order', before: precheck, after: { customerId, totalAmount: totalNum }, ip });
      const creditOrMin = !creditOk || !minOrder.ok; // 信用/起送类可特批; 库存不足不可特批(物理不可出库)
      if (!(dto.forceSpecial && user.role === 'OWNER' && dto.specialReason && creditOrMin && precheckCustomer.ok && inventory.every((i) => i.ok))) {
        throw new HttpException({ code: 422, message: '审单预检未通过', data: precheck }, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      specialApproved = true;
    }

    // 单号: SO{yyyymmdd}-{seq}
    // P1-14: count+1 并发撞号 → P2002 500。序号在事务内取且失败按 seq+1 重试(≤5 次)
    const today = dayjs().format('YYYYMMDD');
    const prefix = `SO${today}`;
    let orderNo = '';
    let order: { id: string; orderNo: string; status: string } | null = null;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
      const seq = (await this.prisma.salesOrder.count({ where: { orderNo: { startsWith: prefix } } })) + 1 + attempt;
      orderNo = `${prefix}-${String(seq).padStart(4, '0')}`;
      try {
        order = await this.createOrderTx(user, orderNo, customerId, customer, dto, lineData, totalNum, precheck, specialApproved, idemKey, idemPayload);
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!order) throw new ConflictException('单号生成冲突, 请重试');

    if (specialApproved) {
      await this.audit.log({ user, action: AuditAction.CREDIT_RELEASE, entityType: 'Order', entityId: order.id, after: { orderNo, amount: totalNum, reason: dto.specialReason } , ip });
    }
    await this.audit.log({ user, action: AuditAction.ORDER_CREATE, entityType: 'Order', entityId: order.id, after: { orderNo, source: dto.source, totalAmount: totalNum, precheck }, ip });
    return { id: order.id, orderNo, status: order.status, totalAmount: totalNum, precheck };
  }

  /** 订单+行+特批审批单+幂等记录 同事务原子落(2026-10 审查修复: 此前主表/行分离写, 中断留零行订单) */
  private async createOrderTx(
    user: AuthUser, orderNo: string, customerId: string,
    customer: { name: string; salespersonId: string | null; signMode: string; address: string | null },
    dto: CreateOrderDto, lineData: unknown[], totalAmount: number, precheck: PrecheckResult,
    specialApproved: boolean, idemKey?: string, idemPayload?: Record<string, unknown>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.salesOrder.create({
        data: {
          tenantId: user.tenantId, // 显式租户(双保险: 中间件注入失败也不至 Argument missing)
          orderNo,
          customerId,
          customerName: customer.name,
          salespersonId: customer.salespersonId, // D5: 下单时点 owner 快照
          source: dto.source,
          signMode: customer.signMode,
          status: 'PENDING_CONFIRM',
          totalAmount: new Prisma.Decimal(totalAmount),
          addressSnapshot: dto.addressOverride ?? customer.address,
          deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : undefined,
          precheck: precheck as never,
          specialApproved,
          createdById: user.id,
        } as never,
      });
      await tx.orderLine.createMany({
        data: (lineData as Array<Record<string, unknown>>).map((l) => ({ ...l, orderId: created.id })) as never,
      });
      if (specialApproved) {
        await tx.approvalRecord.create({
          data: {
            tenantId: user.tenantId, line: 'CREDIT_RELEASE', entityType: 'ORDER', entityId: created.id,
            title: `信用放行 ${orderNo} ¥${totalAmount}`, amount: new Prisma.Decimal(totalAmount), // totalAmount 参数已是 number
            reason: dto.specialReason!, applicantId: user.id, approverId: user.id,
            status: 'APPROVED', decidedAt: new Date(),
          },
        });
      }
      // 幂等记录与订单同事务(参照 confirmOutbound; complete() 的 tx 参数类型不符故内联)
      if (idemKey) {
        await tx.idempotencyRecord.create({
          data: {
            tenantId: user.tenantId, key: idemKey, endpoint: 'orders.create',
            requestHash: IdempotencyService.requestHash('orders.create', idemPayload ?? {}),
            responseSummary: { id: created.id, orderNo: created.orderNo, status: created.status, totalAmount, precheck } as never,
            createdBy: user.id,
          },
        });
      }
      return created;
    });
  }

  async list(user: AuthUser, q: { status?: string; customerId?: string; keyword?: string; page?: number; pageSize?: number }): Promise<{ items: unknown[]; total: number }> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where: Prisma.SalesOrderWhereInput = {
      status: (q.status as OrderStatus) ?? undefined,
      customerId: q.customerId,
      OR: q.keyword ? [{ orderNo: { contains: q.keyword } }, { customerName: { contains: q.keyword } }] : undefined,
    };
    // 行范围(安全评审 2.1): 业务员查自己客户, 客户查自己订单
    if (user.role === 'REP' && user.dataScope === 'OWN_CUSTOMERS') {
      const mine = await this.prisma.customer.findMany({ where: { salespersonId: user.id }, select: { id: true } });
      const mineIds = mine.map((c) => c.id);
      where.customerId = q.customerId ? (mineIds.includes(q.customerId) ? q.customerId : '__none__') : { in: mineIds };
    } else if (user.role === 'CUSTOMER') {
      // P1-9: 未绑定客户的 CUSTOMER 账号强制空集, 防退化为全租户可见
      where.customerId = user.customerId ?? '__none__';
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.salesOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { lines: { select: { id: true } } },
      }),
      this.prisma.salesOrder.count({ where }),
    ]);
    return { items: items.map((o) => ({ ...o, lineCount: o.lines.length, lines: undefined })), total };
  }

  /** P1-10 行范围全入口收敛: detail/cancel/confirm/reverseLine 均校验 CUSTOMER=本人, REP=自己名下客户 */
  private async assertOrderScope(user: AuthUser, customerId: string): Promise<void> {
    if (user.role === 'CUSTOMER') {
      if (customerId !== user.customerId) throw new ForbiddenException('无权操作该订单');
    } else if (user.role === 'REP' && user.dataScope === 'OWN_CUSTOMERS') {
      const mine = await this.prisma.customer.findFirst({ where: { id: customerId, salespersonId: user.id }, select: { id: true } });
      if (!mine) throw new ForbiddenException('仅可操作自己名下客户的订单');
    }
  }

  async detail(user: AuthUser, id: string): Promise<unknown> {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, code: true, name: true, phone: true, termsDays: true, settlement: true } },
        lines: { include: { reversalOf: { select: { id: true } }, reversedBy: { select: { id: true } } }, orderBy: { createdAt: 'asc' } },
        outbounds: { include: { lines: { include: { batch: { select: { batchNo: true } } } } } },
        signature: true,
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    this.assertOrderScope(user, order.customerId);
    // 应收按应用层关联(sourceType='ORDER' && sourceDocNo=orderNo), schema FK 已移除
    const receivables = await this.prisma.receivable.findMany({
      where: { tenantId: order.tenantId, sourceType: 'ORDER', sourceDocNo: order.orderNo },
      include: { ledger: true },
    });
    return { ...order, receivables, statusLabel: ORDER_STATUS_LABELS[order.status] };
  }

  private async transition(user: AuthUser, orderId: string, to: OrderStatus, extra: Prisma.SalesOrderUpdateInput, auditAction: string, ip?: string): Promise<unknown> {
    const order = await this.prisma.salesOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('订单不存在');
    await this.assertOrderScope(user, order.customerId);
    const from = order.status as OrderStatus;
    assertOrderTransition(from, to); // P0-C 白名单, 非法 409
    // 条件更新抢占(2026-10 审查修复: check-then-act 并发下确认/取消互踩, 后写覆盖前者)
    const claimed = await this.prisma.salesOrder.updateMany({
      where: { id: orderId, status: from },
      data: { status: to, ...extra } as never,
    });
    if (claimed.count === 0) throw new ConflictException('订单状态已变化, 请刷新后重试');
    const updated = await this.prisma.salesOrder.findUnique({ where: { id: orderId } });
    await this.audit.log({ user, action: auditAction, entityType: 'Order', entityId: orderId, before: { status: from }, after: { status: to }, ip });
    return updated;
  }

  /** T20 确认: 待确认→已确认(重跑预检, 通过才放行) */
  async confirm(user: AuthUser, orderId: string, ip?: string): Promise<unknown> {
    const order = await this.prisma.salesOrder.findUnique({ where: { id: orderId }, include: { lines: true } });
    if (!order) throw new NotFoundException('订单不存在');
    await this.assertOrderScope(user, order.customerId);
    if (order.status !== 'PENDING_CONFIRM') throw new ConflictException('仅待确认订单可确认');
    const credit = await this.creditProjection(order.customerId);
    const customer = await this.prisma.customer.findUnique({ where: { id: order.customerId } });
    const need = Number(order.totalAmount) + credit.inTransit + credit.openAr;
    if (customer && !order.specialApproved && need > Number(customer.creditLimit)) {
      await this.audit.log({ user, action: AuditAction.PRECHECK_BLOCK, entityType: 'Order', entityId: orderId, before: { stage: 'confirm', credit } , ip });
      throw new HttpException({ code: 422, message: '信用复核未通过, 需老板特批', data: credit }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return this.transition(user, orderId, 'CONFIRMED', { confirmedAt: new Date() }, AuditAction.ORDER_CONFIRM, ip);
  }

  /** D01 特批: 老板本人, 必须给理由 */
  async approveSpecial(user: AuthUser, orderId: string, body: { type: 'CREDIT_RELEASE' | 'PRICE_SPECIAL' | 'ORDER_SPECIAL'; reason: string; amount?: number }, ip?: string): Promise<unknown> {
    if (user.role !== 'OWNER') throw new ForbiddenException('特批仅老板本人可执行');
    if (!body.reason?.trim()) throw new BadRequestException('特批必须填写理由');
    const order = await this.prisma.salesOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('订单不存在');
    // P1-11: 类型映射原写反(ORDER_SPECIAL→PRICE_SPECIAL), 且不限订单状态——已出库/已拒收的单也能被"特批"
    if (!['PENDING_CONFIRM', 'CONFIRMED'].includes(order.status)) {
      throw new ConflictException('仅待确认/已确认订单可特批');
    }
    const lineMap: Record<string, 'CREDIT_RELEASE' | 'PRICE_SPECIAL'> = {
      CREDIT_RELEASE: 'CREDIT_RELEASE', PRICE_SPECIAL: 'PRICE_SPECIAL', ORDER_SPECIAL: 'PRICE_SPECIAL',
    };
    await this.prisma.approvalRecord.create({
      data: {
        tenantId: user.tenantId, line: lineMap[body.type] ?? 'CREDIT_RELEASE',
        entityType: 'ORDER', entityId: orderId,
        title: `特批 ${order.orderNo} ${body.type}`, 
        amount: body.amount !== undefined ? new Prisma.Decimal(body.amount) : undefined,
        reason: body.reason, applicantId: user.id, approverId: user.id,
        status: 'APPROVED', decidedAt: new Date(),
      },
    });
    await this.audit.log({ user, action: AuditAction.SPECIAL_APPROVE, entityType: 'Order', entityId: orderId, after: { type: body.type, reason: body.reason }, ip });
    return this.prisma.salesOrder.update({ where: { id: orderId }, data: { specialApproved: true } });
  }

  /** T25 取消: 配送前拦截(PENDING_CONFIRM/CONFIRMED → CANCELLED); 占用为推导量, 无需回冲 */
  async cancel(user: AuthUser, orderId: string, reason: string, ip?: string): Promise<unknown> {
    if (!reason?.trim()) throw new BadRequestException('取消必须填写原因');
    const updated = (await this.transition(user, orderId, 'CANCELLED', { cancelReason: reason }, AuditAction.ORDER_CANCEL, ip)) as { id: string; orderNo: string };
    return updated;
  }

  /** T25 改单 = 红字冲销行(B3): 只允许配送前(PENDING_CONFIRM/CONFIRMED); 配送中协商走拒收/签收差额 */
  async reverseLine(user: AuthUser, orderId: string, lineId: string, qty: number, reason: string, ip?: string): Promise<unknown> {
    if (!reason?.trim()) throw new BadRequestException('冲销必须填写原因');
    const order = await this.prisma.salesOrder.findUnique({ where: { id: orderId }, include: { lines: true } });
    if (!order) throw new NotFoundException('订单不存在');
    await this.assertOrderScope(user, order.customerId);
    if (!['PENDING_CONFIRM', 'CONFIRMED'].includes(order.status)) {
      throw new ConflictException('订单已出库, 改单走拒收/签收差额路径(配送中协商), 禁止直接冲销');
    }
    const line = order.lines.find((l) => l.id === lineId);
    if (!line) throw new NotFoundException('订单行不存在');
    const reversedAlready = order.lines.filter((l) => l.reversalOfId === lineId).reduce((s, l) => s + Number(l.qty), 0); // 负数累计
    const netQty = Number(line.qty) + reversedAlready;
    if (qty <= 0 || qty > netQty) throw new BadRequestException(`冲销数量须在 (0, ${netQty}] 内`);
    const reversalAmount = line.unitPrice.mul(-qty);
    await this.prisma.orderLine.create({
      data: {
        tenantId: user.tenantId, orderId, productId: line.productId,
        productName: line.productName, specText: line.specText, unit: line.unit,
        conversionRate: line.conversionRate, qty: new Prisma.Decimal(-qty),
        unitPrice: line.unitPrice, amount: reversalAmount, priceType: line.priceType,
        priceVersion: `reversal:${line.priceVersion}`, isGift: line.isGift,
        reversalOfId: lineId, createdById: user.id,
      } as never,
    });
    const total = await this.prisma.orderLine.aggregate({ where: { orderId }, _sum: { amount: true } });
    const updated = await this.prisma.salesOrder.update({ where: { id: orderId }, data: { totalAmount: total._sum.amount ?? new Prisma.Decimal(0) } });
    await this.audit.log({ user, action: AuditAction.ORDER_MODIFY, entityType: 'Order', entityId: orderId, before: { lineId, qty }, after: { reversalQty: -qty, reason, newTotal: Number(updated.totalAmount) }, ip });
    return updated;
  }

  // ─────────────── T22 出库: FIFO 建议批次 + 复核确认(不可变流水) ───────────────
  async createOutbound(user: AuthUser, orderId: string): Promise<unknown> {
    const order = await this.prisma.salesOrder.findUnique({ where: { id: orderId }, include: { lines: true } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'CONFIRMED') throw new ConflictException('仅已确认订单可出库');
    // FIFO: 到期日优先, 无到期日按入库时间
    const suggestions: Array<{ orderLineId: string; productId: string; productName: string; batchNo: string; batchId: string; qty: number }> = [];
    for (const line of order.lines) {
      const need = Number(line.qty) * (line.unit === 'BASE' ? line.conversionRate : 1);
      if (need <= 0) continue;
      const batches = await this.prisma.batchStock.findMany({
        where: { productId: line.productId },
        include: { ledger: true },
        orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      });
      let remaining = need;
      for (const b of batches) {
        if (remaining <= 0) break;
        const onHand = b.ledger.reduce((s, l) => s + (l.direction === 'IN' ? Number(l.qty) : -Number(l.qty)), 0);
        if (onHand <= 0) continue;
        const take = Math.min(onHand, remaining);
        remaining -= take;
        suggestions.push({ orderLineId: line.id, productId: line.productId, productName: line.productName, batchNo: b.batchNo, batchId: b.id, qty: take });
      }
      if (remaining > 0) throw new ConflictException(`商品 ${line.productName} 库存不足(需 ${need}, 缺 ${remaining}), FIFO 无法分配`);
    }
    // P1-14: count+1 并发撞号 → P2002; 失败按 seq 顺延重试(≤5 次)
    const obDay = dayjs().format('YYYYMMDD');
    let outbound: Awaited<ReturnType<typeof this.prisma.outbound.create>> | null = null;
    for (let attempt = 0; attempt < 5 && !outbound; attempt++) {
      const seq = (await this.prisma.outbound.count({ where: { outboundNo: { startsWith: `OB${obDay}` } } })) + 1 + attempt;
      try {
        outbound = await this.prisma.outbound.create({
          data: {
            tenantId: user.tenantId, outboundNo: `OB${obDay}-${String(seq).padStart(4, '0')}`,
            orderId, status: 'PICKING', pickerId: user.id,
            lines: { create: suggestions.map((s) => ({ tenantId: user.tenantId, orderLineId: s.orderLineId, batchId: s.batchId, qty: new Prisma.Decimal(s.qty) })) },
          } as never,
          include: { lines: { include: { batch: true } } },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!outbound) throw new ConflictException('单号生成冲突, 请重试');
    return { outbound, suggestions };
  }

  /** 复核确认出库: 写 InventoryLedger OUT 流水(B4) + 出库状态机推进(P0-C); 需 Idempotency-Key, 幂等记录与出库同事务原子落 */
  async confirmOutbound(user: AuthUser, outboundNo: string, idemKey: string, ip?: string): Promise<unknown> {
    if (!idemKey) throw new BadRequestException('出库确认必须携带 Idempotency-Key 头');
    const outbound = await this.prisma.outbound.findUnique({ where: { tenantId_outboundNo: { tenantId: user.tenantId, outboundNo } }, include: { lines: { include: { orderLine: true } }, order: true } });
    if (!outbound) throw new NotFoundException('出库单不存在');
    const h = IdempotencyService.requestHash('outbound.confirm', { no: outboundNo });
    const dup = await this.idem.check(user, 'outbound.confirm', idemKey, { no: outboundNo });
    if (dup) return { replay: true, summary: dup.summary };
    if (outbound.status === 'CONFIRMED') return { alreadyConfirmed: true };
    assertOutboundTransition(outbound.status as OutboundState, 'CONFIRMED'); // P0-C 白名单, 非法 409
    assertOrderTransition(outbound.order.status as OrderStatus, 'OUTBOUND');
    await this.prisma.$transaction(async (tx) => {
      // 抢占式条件更新(2026-10 审查修复: 状态检查在事务外+update 无状态守卫, 并发不同 key 双写 OUT 流水双扣库存)
      const claimedOrder = await tx.salesOrder.updateMany({
        where: { id: outbound.orderId, status: 'CONFIRMED' },
        data: { status: 'OUTBOUND', outboundAt: new Date() },
      });
      if (claimedOrder.count === 0) throw new ConflictException('订单状态已变化, 请刷新后重试');
      const claimed = await tx.outbound.updateMany({
        where: { id: outbound.id, status: 'PICKING' },
        data: { status: 'CONFIRMED', checkerId: user.id, confirmedAt: new Date() },
      });
      if (claimed.count === 0) throw new ConflictException('出库单已被确认, 请勿重复提交');
      // P1-7 出库确认前逐行复核现存量, 不足则拒绝(防止下单后库存被耗尽 → 负库存)
      for (const l of outbound.lines) {
        const rows = await tx.inventoryLedger.findMany({
          where: { productId: l.orderLine.productId },
          select: { direction: true, qty: true },
        });
        const onHand = rows.reduce((s, r) => s + (r.direction === 'IN' ? Number(r.qty) : -Number(r.qty)), 0);
        if (onHand < Number(l.qty)) {
          throw new ConflictException(
            `商品 ${l.orderLine.productName} 现有库存不足(现存 ${onHand}, 出库需 ${Number(l.qty)}), 已取消本次出库`,
          );
        }
      }
      for (const l of outbound.lines) {
        await tx.inventoryLedger.create({
          data: {
            tenantId: user.tenantId, productId: l.orderLine.productId,
            batchId: l.batchId, direction: 'OUT', qty: l.qty, refType: 'OUTBOUND',
            refNo: outbound.order.orderNo, createdBy: user.id,
          },
        });
      }
      // 幂等记录与出库流水同事务原子落(不可用 idem.complete: 其 tx 参数是 PrismaService, 而此处须 Prisma.TransactionClient)
      await tx.idempotencyRecord.create({
        data: { tenantId: user.tenantId, key: idemKey, endpoint: 'outbound.confirm', requestHash: h, createdBy: user.id,
          responseSummary: { outboundNo, lines: outbound.lines.length } as never },
      });
    });
    await this.audit.log({ user, action: AuditAction.OUTBOUND_CONFIRM, entityType: 'Outbound', entityId: outbound.id, after: { outboundNo, orderNo: outbound.order.orderNo, lines: outbound.lines.map((l) => ({ batch: l.batchId, qty: Number(l.qty) })) }, ip });
    return { outboundNo, confirmed: true, lines: outbound.lines.length };
  }

  /** 发运: OUTBOUND → DELIVERING */
  async deliver(user: AuthUser, orderId: string, ip?: string): Promise<unknown> {
    return this.transition(user, orderId, 'DELIVERING', {}, 'ORDER_DELIVER', ip);
  }

  /** 出库单列表(仓配工作台): PICKING=待拣货复核, CONFIRMED=已出库 */
  async listOutbounds(q: { status?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where = { status: q.status as never };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.outbound.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          order: { select: { orderNo: true, customerName: true, addressSnapshot: true, status: true, deliveryDate: true } },
          lines: { include: { batch: { select: { batchNo: true } }, orderLine: { select: { productName: true, unit: true, conversionRate: true, qty: true } } } },
        },
      }),
      this.prisma.outbound.count({ where }),
    ]);
    return { items, total };
  }

  // ─────────────── T23 签收(+T24 纸单回录): 部分签收/拒收回冲/回包装回填 → 应收生成(D4) ───────────────
  async sign(
    user: AuthUser, orderId: string,
    body: { type: 'E_SIGN' | 'PHOTO' | 'PAPER'; signerName?: string; photoUrl?: string; signatureData?: string; deviceInfo?: string; returnPackages?: Array<{ category: string; qty: number }>; lines?: Array<{ orderLineId: string; actualQty: number }> },
    ip?: string,
  ): Promise<unknown> {
    const order = await this.prisma.salesOrder.findUnique({ where: { id: orderId }, include: { lines: true, customer: true, outbounds: { include: { lines: true } } } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'DELIVERING') throw new ConflictException('仅配送中订单可签收(未签收不可销账由状态机保证)');
    // 每行净可签数量(扣红字冲销)
    const netByLine = new Map<string, { line: (typeof order.lines)[number]; net: number }>();
    for (const l of order.lines) {
      if (l.reversalOfId) continue;
      const reversed = order.lines.filter((r) => r.reversalOfId === l.id).reduce((s, r) => s + Number(r.qty), 0);
      netByLine.set(l.id, { line: l, net: Number(l.qty) + reversed });
    }
    let acceptedAmount = 0;
    let anyAccepted = false;
    const rejections: Array<{ productId: string; batchId: string | null; qty: number }> = [];
    const perLine = body.lines?.length ? new Map(body.lines.map((l) => [l.orderLineId, l.actualQty])) : null;
    for (const { line, net } of netByLine.values()) {
      const actual = perLine ? (perLine.get(line.id) ?? net) : net;
      if (actual < 0 || actual > net) throw new BadRequestException(`行 ${line.productName} 实收须在 [0, ${net}]`);
      if (actual > 0) anyAccepted = true;
      acceptedAmount += Number(line.unitPrice) * actual;
      const rejectedQty = net - actual;
      if (rejectedQty > 0) {
        // 拒收部分: 找该行的出库批次回冲
        const outLines = order.outbounds.flatMap((o) => o.lines).filter((ol) => ol.orderLineId === line.id);
        let remaining = rejectedQty * (line.unit === 'BASE' ? line.conversionRate : 1);
        for (const ol of outLines) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, Number(ol.qty));
          remaining -= take;
          rejections.push({ productId: line.productId, batchId: ol.batchId, qty: take });
        }
      }
    }
    // 整单拒收按"所有行实收数量为 0"判定(2026-10 审查修复: 原按 acceptedAmount<=0 金额判定,
    // 全赠品订单(单价全 0)正常签收也会被误判成整单拒收→全量回冲+状态 REJECTED)
    const allRejected = netByLine.size > 0 && !anyAccepted;
    const signedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      // 抢占式状态推进: 并发签收/拒收/重复请求只有一个能提交(check-then-act 竞态修复),
      // 否则 sign×reject 并发会同时落"应收+全量回冲"两套矛盾数据
      const claimed = await tx.salesOrder.updateMany({
        where: { id: orderId, status: 'DELIVERING' },
        data: { status: allRejected ? 'REJECTED' : 'SIGNED', signedAt },
      });
      if (claimed.count === 0) throw new ConflictException('订单状态已变化(可能已被签收/拒收), 请刷新后重试');
      // 签收凭证 append-only(P1-6)
      await tx.signatureRecord.create({
        data: {
          tenantId: user.tenantId, orderId, type: body.type, signerName: body.signerName,
          photoUrl: body.photoUrl, signatureData: body.signatureData, deviceInfo: body.deviceInfo,
          recordedById: user.id, returnPackages: (body.returnPackages ?? undefined) as never,
        } as never,
      });
      // T04 联动: 回包装回填落押金台账(WITH_ORDER, 单价 cfg)
      if (body.returnPackages?.length) {
        for (const pkg of body.returnPackages) {
          const cfgRow = await tx.systemConfig.findFirst({ where: { key: `deposit_${pkg.category}` } });
          const unitD = cfgRow ? Number((cfgRow.value as { v?: unknown })?.v ?? cfgRow.value) : NaN;
          const unit = Number.isFinite(unitD) ? unitD : ({ 周转箱: 15, 啤酒瓶: 0.5, 白酒盒: 2 } as Record<string, number>)[pkg.category] ?? 0;
          await tx.packageRecord.create({
            data: { tenantId: user.tenantId, customerId: order.customerId, category: pkg.category, qty: Math.max(0, Math.trunc(pkg.qty)), type: 'WITH_ORDER', orderId, depositPaid: new Prisma.Decimal((unit * Math.trunc(pkg.qty)).toFixed(2)), note: `签收回填 ${order.orderNo}`, recordedById: user.id },
          });
        }
      }
      if (allRejected) {
        // 整单拒收: 全量回冲出库量(2026-10 审查修复: 原 rejections 逐行回冲与全量回冲两段都执行,
        // 同批货 IN 流水写两遍→库存凭空翻倍)
        for (const { line } of netByLine.values()) {
          const outLines = order.outbounds.flatMap((o) => o.lines).filter((ol) => ol.orderLineId === line.id);
          for (const ol of outLines) {
            await tx.inventoryLedger.create({
              data: { tenantId: user.tenantId, productId: line.productId, batchId: ol.batchId, direction: 'IN', qty: ol.qty, refType: 'REJECT_RETURN', refNo: order.orderNo, note: '整单拒收回冲', createdBy: user.id },
            });
          }
        }
        return;
      }
      // 部分拒收回冲(不可变流水 IN, refType=REJECT_RETURN)
      for (const r of rejections) {
        if (!r.batchId) continue;
        await tx.inventoryLedger.create({
          data: { tenantId: user.tenantId, productId: r.productId, batchId: r.batchId, direction: 'IN', qty: new Prisma.Decimal(r.qty), refType: 'REJECT_RETURN', refNo: order.orderNo, note: '签收拒收回冲', createdBy: user.id },
        });
      }
      // T23/D4: 签收完成 = 应收生成时点; 到期日 = 生成日 + 账期天数(现结=0)
      const dueDate = dayjs(signedAt).add(order.customer.termsDays ?? 0, 'day').endOf('day').toDate();
      await tx.receivable.create({
        data: {
          tenantId: user.tenantId, sourceType: 'ORDER', sourceDocNo: order.orderNo,
          customerId: order.customerId, total: new Prisma.Decimal(acceptedAmount),
          dueDate, generatedAt: signedAt,
          ledger: { create: { tenantId: user.tenantId, direction: 'CHARGE', amount: new Prisma.Decimal(acceptedAmount), note: `签收生成 ${order.orderNo}`, createdBy: user.id } },
        } as never,
      });
    });

    await this.audit.log({
      user, action: allRejected ? AuditAction.REJECT : AuditAction.SIGN, entityType: 'Order', entityId: orderId,
      after: { type: body.type, acceptedAmount, rejectedLines: rejections.length, returnPackages: body.returnPackages }, ip,
    });
    return { orderNo: order.orderNo, status: allRejected ? 'REJECTED' : 'SIGNED', acceptedAmount, receivableGenerated: !allRejected };
  }

  /** T25 整单拒收(配送中): DELIVERING → REJECTED, 全量库存回冲 */
  async reject(user: AuthUser, orderId: string, reason: string, ip?: string): Promise<unknown> {
    if (!reason?.trim()) throw new BadRequestException('拒收必须填写原因');
    const order = await this.prisma.salesOrder.findUnique({ where: { id: orderId }, include: { lines: true, outbounds: { include: { lines: true } } } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'DELIVERING') throw new ConflictException('仅配送中订单可拒收');
    await this.prisma.$transaction(async (tx) => {
      // 抢占式条件更新: 与 sign() 并发时只有一个能提交, 杜绝"应收+全量回冲"双落
      const claimed = await tx.salesOrder.updateMany({
        where: { id: orderId, status: 'DELIVERING' },
        data: { status: 'REJECTED', cancelReason: reason, signedAt: new Date() },
      });
      if (claimed.count === 0) throw new ConflictException('订单状态已变化(可能已被签收/拒收), 请刷新后重试');
      for (const o of order.outbounds) {
        for (const ol of o.lines) {
          const line = order.lines.find((l) => l.id === ol.orderLineId);
          if (!line) continue;
          await tx.inventoryLedger.create({
            data: { tenantId: user.tenantId, productId: line.productId, batchId: ol.batchId, direction: 'IN', qty: ol.qty, refType: 'REJECT_RETURN', refNo: order.orderNo, note: `拒收回冲: ${reason}`, createdBy: user.id },
          });
        }
      }
    });
    await this.audit.log({ user, action: AuditAction.REJECT, entityType: 'Order', entityId: orderId, before: { status: order.status }, after: { status: 'REJECTED', reason }, ip });
    return { orderNo: order.orderNo, status: 'REJECTED' };
  }
}
