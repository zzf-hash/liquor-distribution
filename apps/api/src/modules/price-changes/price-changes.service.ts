import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { bizDateKey, bizNow, bizStartOfDay } from '../../common/business-time';
import { sequential } from '../../prisma/relation-read';
import { AuditService } from '../../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T05 调价引擎 (F7) ═══════════════
// D08: 价格只新增版本不覆盖历史(生效=插入新 Price 行 validFrom=生效日), 历史单据不受影响(快照物理脱钩)
// R7/D15: 存货增贬值只测算登记(stockImpact), 不做自动估值调账
// 审批: PRICE_CHANGE 线(≤2000 内勤/>2000 老板, 审批中心统一)

@Injectable()
export class PriceChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  async create(user: AuthUser, dto: { productId: string; unit: 'BASE' | 'MIN'; levelType: string; newPrice: number; effectiveDate: string; reason: string; customerSync?: boolean }): Promise<unknown> {
    if (dto.levelType === 'COST' && user.role !== 'OWNER') throw new ConflictException('成本价调价仅老板可发起');
    if (dto.newPrice < 0) throw new BadRequestException('新价不能为负');
    if (!dto.reason?.trim()) throw new BadRequestException('调价必须填写理由');
    const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('商品不存在');
    const effective = new Date(dto.effectiveDate);
    if (Number.isNaN(effective.getTime())) throw new BadRequestException('生效日格式错');
    // #25: 调价不允许回溯生效——生效日早于今天会在 effectuate 时插入一条 validFrom 在历史区间的版本,
    // 被取价引擎的"最新 validFrom"静默淹没(或错误改写历史口径订单的取价)。退改须走新调价单。
    const todayStart = bizStartOfDay();
    if (effective < todayStart) throw new BadRequestException('生效日不能早于今天(不允许回溯调价)');
    // 旧价快照: 当前最新生效价
    const oldRow = await this.prisma.price.findFirst({
      where: { productId: dto.productId, unit: dto.unit, levelType: dto.levelType as never, validFrom: { lte: new Date() }, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
      orderBy: { validFrom: 'desc' },
    });
    const oldPrice = Number(oldRow?.price ?? 0);
    // 存货增贬值测算(登记不调账): 在库量×价差
    const groups = await this.prisma.inventoryLedger.groupBy({
      by: ['direction'], where: { productId: dto.productId }, _sum: { qty: true },
    });
    const onHandQty = groups.reduce((s, g) => s + (g.direction === 'IN' ? Number(g._sum.qty ?? 0) : -Number(g._sum.qty ?? 0)), 0);
    const stockImpact = { onHandQty, oldPrice, newPrice: dto.newPrice, deltaAmount: Number((onHandQty * (dto.newPrice - oldPrice)).toFixed(2)) };
    const created = await this.prisma.priceChangeRequest.create({
      data: {
        tenantId: user.tenantId, productId: dto.productId, unit: dto.unit, levelType: dto.levelType as never,
        oldPrice: new Prisma.Decimal(oldPrice), newPrice: new Prisma.Decimal(dto.newPrice),
        effectiveDate: effective, reason: dto.reason, stockImpact: stockImpact as never,
        customerSync: dto.customerSync ?? false, status: 'DRAFT', createdById: user.id,
      },
    });
    await this.audit.log({ user, action: 'PRICE_CHANGE_CREATE', entityType: 'PRICE_CHANGE', entityId: created.id, before: { oldPrice }, after: { newPrice: dto.newPrice, effectiveDate: dto.effectiveDate, stockImpact } });
    return { ...created, stockImpact };
  }

  async submit(user: AuthUser, id: string): Promise<unknown> {
    const r = await this.prisma.priceChangeRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('调价单不存在');
    if (r.status !== 'DRAFT') throw new ConflictException(`仅草稿可提交(当前 ${r.status})`);
    const product = await this.prisma.product.findUnique({ where: { id: r.productId } });
    const approval = await this.approvals.create(user, {
      line: 'PRICE_CHANGE', entityType: 'PRICE_CHANGE', entityId: id,
      title: `调价 ${product?.name ?? r.productId} ${r.levelType} ¥${Number(r.oldPrice)}→¥${Number(r.newPrice)}`,
      amount: Number(r.stockImpact ? (r.stockImpact as { deltaAmount?: number }).deltaAmount ?? 0 : 0),
      reason: r.reason,
      payload: { productId: r.productId, unit: r.unit, levelType: r.levelType, oldPrice: Number(r.oldPrice), newPrice: Number(r.newPrice), effectiveDate: bizDateKey(r.effectiveDate), stockImpact: r.stockImpact },
    });
    await this.prisma.priceChangeRequest.update({ where: { id }, data: { status: 'PENDING', approvalId: approval.id } });
    return { id, status: 'PENDING', approvalId: approval.id };
  }

  /** 一键生效: 审批通过后插入新价格版本行(D08: 不覆盖历史)。
   *  C组 M2-7: customerSync=true 时同步平移该商品全部客户专属价(新版本 validFrom=生效日, 价差=新价-旧价, 保持客户与层级价差) */
  async effectuate(user: AuthUser, id: string): Promise<unknown> {
    const r = await this.prisma.priceChangeRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('调价单不存在');
    if (r.status === 'EFFECTIVE') throw new ConflictException('该调价已生效(幂等拒绝)');
    if (r.status !== 'APPROVED') throw new ConflictException('审批通过后才可生效');
    const price = await this.prisma.price.create({
      data: {
        tenantId: user.tenantId, productId: r.productId, unit: r.unit, levelType: r.levelType,
        price: r.newPrice, validFrom: r.effectiveDate, approvalRef: `PC-${id.slice(0, 8)}`,
        note: `调价生效: ${r.reason}`, createdBy: user.id,
      },
    });
    // C组: 客户专属价联动(平移价差, 版本化留痕; COST 级不联动)
    let customerSyncResult: { customers: number; delta: number } | null = null;
    if (r.customerSync && r.levelType !== 'COST') {
      const delta = Number(r.newPrice) - Number(r.oldPrice);
      if (Math.abs(delta) > 0.0001) {
        const exclusives = await this.prisma.customerPrice.findMany({
          where: { productId: r.productId, unit: r.unit, validFrom: { lte: new Date() }, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
          orderBy: { validFrom: 'desc' },
        });
        const latestByCustomer = new Map<string, typeof exclusives[number]>();
        for (const cp of exclusives) if (!latestByCustomer.has(cp.customerId)) latestByCustomer.set(cp.customerId, cp);
        let synced = 0;
        for (const [, cp] of latestByCustomer) {
          const next = Number(cp.price) + delta;
          if (next < 0) continue; // 价差不至于把专属价打到负
          await this.prisma.customerPrice.create({
            data: {
              tenantId: user.tenantId, customerId: cp.customerId, productId: r.productId, unit: r.unit,
              price: new Prisma.Decimal(next.toFixed(2)), validFrom: r.effectiveDate,
              approvalRef: `PC-${id.slice(0, 8)}`, note: `调价联动 ${Number(r.oldPrice)}→${Number(r.newPrice)}`, createdBy: user.id,
            },
          });
          synced += 1;
        }
        customerSyncResult = { customers: synced, delta: Number(delta.toFixed(2)) };
        await this.audit.log({ user, action: 'PRICE_CUSTOMER_SYNC', entityType: 'PRICE_CHANGE', entityId: id, after: customerSyncResult });
      }
    }
    await this.prisma.priceChangeRequest.update({ where: { id }, data: { status: 'EFFECTIVE', effectuatedAt: new Date(), customerSyncResult: customerSyncResult as never } });
    await this.audit.log({ user, action: 'PRICE_CHANGE_EFFECT', entityType: 'PRICE_CHANGE', entityId: id, after: { priceRowId: price.id, validFrom: r.effectiveDate, newPrice: Number(r.newPrice), customerSyncResult } });
    return { id, status: 'EFFECTIVE', priceRowId: price.id, customerSyncResult };
  }

  // ─────────────── C组 M2-7 一键批量调价 ───────────────

  /** 批量创建(DRAFT, 共用批次号/生效日/理由/联动开关) → 自动逐单提审 */
  async createBatch(user: AuthUser, dto: {
    items: Array<{ productId: string; unit?: 'BASE' | 'MIN'; levelType: string; newPrice: number }>;
    effectiveDate: string; reason: string; customerSync?: boolean;
  }): Promise<unknown> {
    if (!dto.items?.length) throw new BadRequestException('批量调价至少一个商品');
    if (dto.items.length > 100) throw new BadRequestException('单批最多 100 个商品');
    const batchNo = `PC-B${bizNow().format('YYYYMMDDHHmmss')}`;
    const created: Array<{ id: string; productId: string; oldPrice: number; newPrice: number; approvalId: string }> = [];
    for (const item of dto.items) {
      const row = (await this.create(user, {
        productId: item.productId, unit: item.unit ?? 'BASE', levelType: item.levelType,
        newPrice: item.newPrice, effectiveDate: dto.effectiveDate, reason: `${dto.reason}(批量 ${batchNo})`,
        customerSync: dto.customerSync,
      })) as { id: string; oldPrice: number; newPrice: number };
      await this.prisma.priceChangeRequest.update({ where: { id: row.id }, data: { batchNo } });
      const submitted = (await this.submit(user, row.id)) as { approvalId: string };
      created.push({ id: row.id, productId: item.productId, oldPrice: row.oldPrice, newPrice: item.newPrice, approvalId: submitted.approvalId });
    }
    await this.audit.log({ user, action: 'PRICE_CHANGE_BATCH_CREATE', entityType: 'PRICE_CHANGE', entityId: batchNo, after: { batchNo, count: created.length, effectiveDate: dto.effectiveDate, customerSync: dto.customerSync ?? false } });
    return { batchNo, count: created.length, items: created };
  }

  /** 批量生效: 该批次全部已批未生效单一次落价(逐单幂等, 单条失败不拖垮批次) */
  async effectuateBatch(user: AuthUser, batchNo: string): Promise<unknown> {
    const rows = await this.prisma.priceChangeRequest.findMany({ where: { batchNo }, orderBy: { createdAt: 'asc' } });
    if (rows.length === 0) throw new NotFoundException('批次不存在');
    const applied: Array<{ id: string; status: string; customerSyncResult?: { customers: number } | null }> = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const r of rows) {
      try {
        const res = (await this.effectuate(user, r.id)) as { status: string; customerSyncResult?: { customers: number } | null };
        applied.push({ id: r.id, status: res.status, customerSyncResult: res.customerSyncResult ?? null });
      } catch (e) {
        failed.push({ id: r.id, error: String((e as Error).message ?? e).slice(0, 120) });
      }
    }
    return { batchNo, applied: applied.length, failed, items: applied };
  }

  /** 批次列表(一键调价工作台) */
  async batches(): Promise<unknown> {
    const rows = await this.prisma.priceChangeRequest.findMany({
      where: { batchNo: { not: null } },
      orderBy: { createdAt: 'desc' },
      include: { product: { select: { skuCode: true, name: true } } },
      take: 300,
    });
    const byBatch = new Map<string, { batchNo: string; createdAt: string; total: number; draft: number; pending: number; approved: number; effective: number; rejected: number; items: unknown[] }>();
    for (const r of rows) {
      const b = byBatch.get(r.batchNo!) ?? { batchNo: r.batchNo!, createdAt: r.createdAt.toISOString(), total: 0, draft: 0, pending: 0, approved: 0, effective: 0, rejected: 0, items: [] };
      b.total += 1;
      if (r.status === 'DRAFT') b.draft += 1;
      else if (r.status === 'PENDING') b.pending += 1;
      else if (r.status === 'APPROVED') b.approved += 1;
      else if (r.status === 'EFFECTIVE') b.effective += 1;
      else if (r.status === 'REJECTED') b.rejected += 1;
      (b.items as unknown[]).push({ id: r.id, approvalId: r.approvalId, product: r.product.name, skuCode: r.product.skuCode, levelType: r.levelType, oldPrice: Number(r.oldPrice), newPrice: Number(r.newPrice), status: r.status, customerSync: r.customerSync, customerSyncResult: r.customerSyncResult });
      byBatch.set(r.batchNo!, b);
    }
    return [...byBatch.values()];
  }

  async list(q: { status?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where = { status: q.status as never };
    const [items, total] = await sequential([
      this.prisma.priceChangeRequest.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { product: { select: { skuCode: true, name: true } } },
      }),
      this.prisma.priceChangeRequest.count({ where }),
    ]);
    return { items, total };
  }
}
