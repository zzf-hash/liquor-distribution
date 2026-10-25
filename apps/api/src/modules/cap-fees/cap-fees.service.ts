import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ExpensesService } from '../expenses/expenses.service';
import { centsToNumber, mulQtyFeeRateToCents, toCents } from '../../common/money';
import { isCapFeePolicyTenantTrigger, isUniqueViolation } from '../../common/prisma-error';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ B组 开瓶费引擎 (M3-4 回/不回瓶盖两态 + M7-7 瓶盖回收兑付) ═══════════════
// 商品级政策 CapFeePolicy:
//   requireCap=true  → 瓶盖回收单(业务员/仓配登记) → 出纳确认 → 生成 CAP_FEE 费用单(进审批) → 付款/冲抵
//   requireCap=false → 月度自动计提(每日任务/手动): 当期签收订单瓶数 × perBottleFee × noCapRate
//                      → 系统直入 APPROVED 费用单(AR_OFFSET 待出纳冲抵) —— "不回瓶盖系统自动扣减"
// Q3("减多少")落为可配比例 noCapRate: 默认 1=全额, 0.5=对折。

interface RecycleLineInput { productId: string; qty: number }

@Injectable()
export class CapFeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly expenses: ExpensesService,
  ) {}

  // ─────────────── 政策(商品级) ───────────────

  async listPolicies(user: AuthUser): Promise<unknown> {
    const rows = await this.prisma.capFeePolicy.findMany({
      where: { tenantId: user.tenantId, closedAt: null },
      include: { product: { select: { skuCode: true, name: true, category: true, baseUnit: true, minUnit: true, packSize: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((p) => ({
      id: p.id, productId: p.productId, skuCode: p.product.skuCode, productName: p.product.name,
      unitLabel: `${p.product.baseUnit}/${p.product.minUnit}`, packSize: p.product.packSize,
      perBottleFee: Number(p.perBottleFee), requireCap: p.requireCap, noCapRate: Number(p.noCapRate),
      validFrom: p.validFrom,
    }));
  }

  async savePolicy(user: AuthUser, dto: { productId: string; perBottleFee: number; requireCap?: boolean; noCapRate?: number }): Promise<unknown> {
    if (user.role !== 'OWNER' && user.role !== 'CLERK') throw new ForbiddenException('仅老板/内勤可维护开瓶费政策');
    if (!(dto.perBottleFee > 0)) throw new BadRequestException('每瓶开瓶费必须大于 0');
    const rate = dto.noCapRate ?? 1;
    if (!(rate > 0 && rate <= 1)) throw new BadRequestException('不回盖兑付比例须在 (0,1] 之间(Q3 可配)');
    const product = await this.prisma.product.findFirst({ where: { id: dto.productId, tenantId: user.tenantId } });
    if (!product) throw new NotFoundException('商品不存在');
    const before = await this.prisma.capFeePolicy.findFirst({ where: { tenantId: user.tenantId, productId: dto.productId, closedAt: null } });
    let saved: { id: string; requireCap: boolean };
    try {
      saved = await this.prisma.capFeePolicy.upsert({
        where: { tenantId_productId: { tenantId: user.tenantId, productId: dto.productId } },
        update: { perBottleFee: new Prisma.Decimal(dto.perBottleFee), requireCap: dto.requireCap ?? before?.requireCap ?? true, noCapRate: new Prisma.Decimal(rate), closedAt: null, updatedAt: new Date() },
        create: {
          tenantId: user.tenantId, productId: dto.productId,
          perBottleFee: new Prisma.Decimal(dto.perBottleFee),
          requireCap: dto.requireCap ?? true, noCapRate: new Prisma.Decimal(rate),
          createdById: user.id,
        },
      });
    } catch (e) {
      // 触发器 cap_fee_policy_same_tenant：政策租户与商品租户不一致，或商品已不存在。不改写行。
      if (isCapFeePolicyTenantTrigger(e)) throw new ConflictException('开瓶费政策与商品不属于同一商户');
      throw e;
    }
    await this.audit.log({ user, action: 'CAPFEE_POLICY_SAVE', entityType: 'CapFeePolicy', entityId: saved.id, before: before ? { perBottleFee: Number(before.perBottleFee), requireCap: before.requireCap, noCapRate: Number(before.noCapRate) } : null, after: { perBottleFee: dto.perBottleFee, requireCap: saved.requireCap, noCapRate: rate } });
    return saved;
  }

  async closePolicy(user: AuthUser, id: string): Promise<unknown> {
    if (user.role !== 'OWNER' && user.role !== 'CLERK') throw new ForbiddenException('仅老板/内勤可维护开瓶费政策');
    const claimed = await this.prisma.capFeePolicy.updateMany({ where: { id, tenantId: user.tenantId, closedAt: null }, data: { closedAt: new Date() } });
    if (claimed.count === 0) throw new ConflictException('政策不存在或已关闭');
    await this.audit.log({ user, action: 'CAPFEE_POLICY_CLOSE', entityType: 'CapFeePolicy', entityId: id });
    return { id, closed: true };
  }

  // ─────────────── 瓶盖回收(requireCap=true 路径) ───────────────

  async createRecycle(user: AuthUser, dto: { customerId: string; lines: RecycleLineInput[]; note?: string }): Promise<unknown> {
    if (!dto.lines?.length) throw new BadRequestException('至少一行回收明细');
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('客户不存在');
    if (user.role === 'REP' && customer.salespersonId !== user.id) throw new ForbiddenException('仅可为自己名下客户登记回收');
    const lines: Array<{ productId: string; productName: string; qty: number; perBottleFee: number; amount: number }> = [];
    for (const l of dto.lines) {
      if (!(l.qty > 0)) throw new BadRequestException('回收数量必须大于 0');
      const policy = await this.prisma.capFeePolicy.findFirst({ where: { tenantId: user.tenantId, productId: l.productId, closedAt: null }, include: { product: true } });
      if (!policy) throw new BadRequestException('商品未配置开瓶费政策');
      if (!policy.requireCap) throw new BadRequestException(`${policy.product.name} 是不回瓶盖模式, 无需登记回收(系统自动计提)`);
      lines.push({
        productId: l.productId, productName: policy.product.name, qty: Math.trunc(l.qty),
        perBottleFee: Number(policy.perBottleFee), amount: Number((Math.trunc(l.qty) * Number(policy.perBottleFee)).toFixed(2)),
      });
    }
    const total = Number(lines.reduce((s, l) => s + l.amount, 0).toFixed(2));
    const day = dayjs().format('YYYYMMDD');
    let order: Awaited<ReturnType<typeof this.prisma.capRecycleOrder.create>> | null = null;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
      const seq = (await this.prisma.capRecycleOrder.count({ where: { recycleNo: { startsWith: `GAI${day}` } } })) + 1 + attempt;
      try {
        order = await this.prisma.capRecycleOrder.create({
          data: {
            tenantId: user.tenantId, recycleNo: `GAI${day}-${String(seq).padStart(4, '0')}`,
            customerId: dto.customerId, status: 'PENDING_CONFIRM', lines: lines as never,
            totalAmount: new Prisma.Decimal(total), note: dto.note, createdById: user.id,
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!order) throw new ConflictException('单号生成冲突, 请重试');
    await this.audit.log({ user, action: 'CAP_RECYCLE_CREATE', entityType: 'CapRecycleOrder', entityId: order.id, after: { recycleNo: order.recycleNo, customer: customer.name, lines: lines.length, total } });
    return order;
  }

  async listRecycles(user: AuthUser, q: { status?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where = {
      status: q.status as never,
      // 业务员只见自己登记/自己客户
      ...(user.role === 'REP' ? { createdById: user.id } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.capRecycleOrder.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { customer: { select: { code: true, name: true } } },
      }),
      this.prisma.capRecycleOrder.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /** 出纳确认 → 同一事务里先抢 PENDING_CONFIRM，再生成 CAP_FEE 费用单（LQ1-008）。 */
  async confirmRecycle(user: AuthUser, id: string, dto: { payMode?: 'CASH' | 'AR_OFFSET'; note?: string }): Promise<unknown> {
    if (user.role !== 'CLERK' && user.role !== 'OWNER') throw new ForbiddenException('仅内勤出纳/老板可确认回收兑付');
    const payMode = dto.payMode ?? 'AR_OFFSET';
    const confirmed = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.capRecycleOrder.updateMany({
        where: { id, tenantId: user.tenantId, status: 'PENDING_CONFIRM' },
        data: { status: 'CONFIRMED', confirmedById: user.id, confirmedAt: new Date() },
      });
      if (claimed.count === 0) {
        const exists = await tx.capRecycleOrder.findFirst({ where: { id, tenantId: user.tenantId }, select: { status: true } });
        if (!exists) throw new NotFoundException('回收单不存在');
        throw new ConflictException(`仅待确认可兑付(当前 ${exists.status})`);
      }
      const order = await tx.capRecycleOrder.findFirst({ where: { id, tenantId: user.tenantId }, include: { customer: true } });
      if (!order) throw new NotFoundException('回收单不存在');
      const note = `${order.note ? `${order.note} | ` : ''}${dto.note ? `${dto.note} | ` : ''}瓶盖回收兑付, 明细: ${(order.lines as Array<{ productName: string; qty: number }>).map((l) => `${l.productName}×${l.qty}`).join('; ')}`;
      const expense = await this.expenses.createLinkedInTx(tx, user, {
        category: 'CAP_FEE',
        title: `开瓶费兑付 ${order.recycleNo}(${order.customer.name})`,
        amount: order.totalAmount,
        customerId: order.customerId,
        payMode,
        note,
        source: `CAP_RECYCLE:${order.recycleNo}`,
        customerName: order.customer.name,
      });
      await tx.capRecycleOrder.update({ where: { id, tenantId: user.tenantId }, data: { expenseId: expense.id } });
      return { recycleNo: order.recycleNo, customerId: order.customerId, expense, amount: centsToNumber(toCents(order.totalAmount)), title: `开瓶费兑付 ${order.recycleNo}(${order.customer.name})` };
    });
    await this.expenses.announceLinked(user, {
      title: `费用单 ${confirmed.expense.expenseNo} 开瓶费·${confirmed.title}`,
      amount: confirmed.amount,
      expenseId: confirmed.expense.id,
      expenseNo: confirmed.expense.expenseNo,
      category: 'CAP_FEE',
      payMode,
      customerId: confirmed.customerId,
      approvalId: confirmed.expense.approvalId,
    });
    await this.audit.log({ user, action: 'CAP_RECYCLE_CONFIRM', entityType: 'CapRecycleOrder', entityId: id, after: { recycleNo: confirmed.recycleNo, expenseNo: confirmed.expense.expenseNo, amount: confirmed.amount, payMode } });
    return { recycleNo: confirmed.recycleNo, status: 'CONFIRMED', expenseNo: confirmed.expense.expenseNo, approvalId: confirmed.expense.approvalId };
  }

  async cancelRecycle(user: AuthUser, id: string, reason: string): Promise<unknown> {
    if (!reason?.trim()) throw new BadRequestException('取消原因必填');
    const claimed = await this.prisma.capRecycleOrder.updateMany({
      where: { id, tenantId: user.tenantId, status: 'PENDING_CONFIRM' },
      data: { status: 'CANCELLED', note: reason },
    });
    if (claimed.count === 0) {
      const exists = await this.prisma.capRecycleOrder.findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true } });
      if (!exists) throw new NotFoundException('回收单不存在');
      throw new ConflictException('仅待确认可取消');
    }
    await this.audit.log({ user, action: 'CAP_RECYCLE_CANCEL', entityType: 'CapRecycleOrder', entityId: id, after: { reason } });
    return { id, status: 'CANCELLED' };
  }

  // ─────────────── 不回瓶盖: 月度自动计提 (M3-4 "系统自动扣减") ───────────────

  /**
   * 按 period(默认上月)聚合各客户各政策商品的签收瓶数 → 系统直入 APPROVED 费用单(AR_OFFSET 待出纳冲抵)。
   * 幂等: source=CAP_ACCRUAL:<period>:<customerId> 的费用单已存在则跳过该客户。
   */
  async accrue(actor: AuthUser, periodInput?: string): Promise<{ period: string; customers: number; expenses: number; totalAmount: number; skipped: number }> {
    const period = periodInput && /^\d{4}-\d{2}$/.test(periodInput) ? periodInput : dayjs().subtract(1, 'month').format('YYYY-MM');
    const start = dayjs(`${period}-01`).startOf('month').toDate();
    const end = dayjs(`${period}-01`).endOf('month').toDate();
    const policies = await this.prisma.capFeePolicy.findMany({
      where: { tenantId: actor.tenantId, requireCap: false, closedAt: null },
      include: { product: { select: { name: true } } },
    });
    if (policies.length === 0) return { period, customers: 0, expenses: 0, totalAmount: 0, skipped: 0 };
    const policyByProduct = new Map(policies.map((p) => [p.productId, p]));
    // 当期签收订单行(瓶数 = BASE行×换算率 / MIN行原值), 按客户×商品聚合
    const orders = await this.prisma.salesOrder.findMany({
      where: { tenantId: actor.tenantId, status: { in: ['SIGNED', 'SETTLED'] }, signedAt: { gte: start, lte: end } },
      select: { customerId: true, lines: { select: { productId: true, unit: true, qty: true, conversionRate: true } } },
    });
    const bottles = new Map<string, number>(); // customerId|productId → 瓶
    for (const o of orders) {
      for (const l of o.lines) {
        if (!policyByProduct.has(l.productId)) continue;
        const qty = Number(l.qty) * (l.unit === 'BASE' ? l.conversionRate : 1);
        const key = `${o.customerId}|${l.productId}`;
        bottles.set(key, (bottles.get(key) ?? 0) + qty);
      }
    }
    // 按客户聚合 → 一客户一费用单
    const byCustomer = new Map<string, Array<{ productName: string; bottles: number; perBottleFee: number; rate: number; amount: number; amountCents: number }>>();
    for (const [key, qty] of bottles) {
      const [customerId, productId] = key.split('|');
      const p = policyByProduct.get(productId)!;
      // S5: 先乘到分再四舍五入。先 toFixed(2) 再转分会在 x.xx5 上少 1 分。
      const amountCents = mulQtyFeeRateToCents(qty, p.perBottleFee, p.noCapRate);
      if (amountCents <= 0) continue;
      const list = byCustomer.get(customerId) ?? [];
      list.push({
        productName: p.product.name, bottles: Math.trunc(qty),
        perBottleFee: Number(p.perBottleFee), rate: Number(p.noCapRate),
        amount: centsToNumber(amountCents), amountCents,
      });
      byCustomer.set(customerId, list);
    }
    let expenses = 0; let totalCents = 0; let skipped = 0;
    // LQ1-019: 瓶数按签收行累计，不扣退货。B 组清单写明「退货不回算」，Q2 未关闭，此处不改口径。
    // LQ1-020: 事务咨询锁 + source 部分唯一索引。冲突视为该客户已计提。
    if (byCustomer.size > 0) {
      await this.prisma.$transaction(async (tx) => {
        const lockKey = `cap-accrual:${actor.tenantId}:${period}`;
        // pg_advisory_xact_lock 返回 void。$queryRaw 会按列反序列化，Prisma 报
        // Failed to deserialize column of type 'void'，计提整段 500（LQ1-050）。
        // $executeRaw 只取影响行数，不读 void 列。
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
        for (const [customerId, lines] of byCustomer) {
          const source = `CAP_ACCRUAL:${period}:${customerId}`;
          const dup = await tx.expense.findFirst({ where: { tenantId: actor.tenantId, source } });
          if (dup) { skipped += 1; continue; }
          const amountCents = lines.reduce((s, l) => s + l.amountCents, 0);
          const amount = centsToNumber(amountCents);
          try {
            await this.expenses.createSystemApproved(actor, {
              category: 'CAP_FEE',
              title: `开瓶费自动计提 ${period}(${lines.map((l) => l.productName).join('/')})`,
              amount, customerId, payMode: 'AR_OFFSET', occurredAt: end,
              note: `不回瓶盖自动扣减: ${lines.map((l) => `${l.productName} ${l.bottles}瓶×¥${l.perBottleFee}×${l.rate}`).join('; ')}`,
              source,
            }, tx);
          } catch (e) {
            if (isUniqueViolation(e, 'source') || isUniqueViolation(e, 'cap_source')) { skipped += 1; continue; }
            throw e;
          }
          expenses += 1;
          totalCents += amountCents;
        }
      });
    }
    const totalAmount = centsToNumber(totalCents);
    await this.audit.log({ user: actor, action: 'CAP_FEE_ACCRUE', entityType: 'Expense', entityId: period, after: { period, customers: byCustomer.size, expenses, skipped, totalAmount } });
    return { period, customers: byCustomer.size, expenses, totalAmount, skipped };
  }
}
