import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T07 盘点报损 (Q11 分工) ═══════════════
// 仓管盘(录实盘) → 内勤核对(差异清单) → 差异金额超阈值(cfg)报老板审批 → ADJUST 流水调账
// 双签留痕: countedById + reconciledById + (超阈值时) 审批人; 未审批不影响可用库存(核对即冻结该差异不落账)
// B4: 调账只走 ADJUST 不可变流水, 账面=流水投影天然一致

@Injectable()
export class StocktakesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  private async threshold(): Promise<number> {
    const row = await this.prisma.systemConfig.findFirst({ where: { key: 'stocktake_adjust_threshold' } });
    const v = row ? Number((row.value as { v?: unknown })?.v ?? row.value) : NaN;
    return Number.isFinite(v) ? v : 200;
  }

  /** 建单: 全量批次账面快照(抽盘可选品类过滤) */
  async create(user: AuthUser, dto: { type: 'SPOT' | 'FULL'; category?: string }): Promise<unknown> {
    if (user.role !== 'WAREHOUSE' && user.role !== 'OWNER') throw new ForbiddenException('盘点建单由仓管执行(Q11)');
    const products = await this.prisma.product.findMany({
      where: { status: 'ON_SALE', category: dto.category as never },
      select: { id: true },
    });
    const batches = await this.prisma.batchStock.findMany({
      where: { productId: { in: products.map((p) => p.id) } },
      include: { ledger: true },
    });
    const lines = batches
      .map((b) => {
        const systemQty = b.ledger.reduce((s, l) => s + (l.direction === 'IN' ? Number(l.qty) : -Number(l.qty)), 0);
        return { productId: b.productId, batchId: b.id, systemQty, unitCost: Number(b.unitCost) };
      })
      .filter((l) => l.systemQty !== 0);
    if (lines.length === 0) throw new ConflictException('无可盘批次(账面为零)');
    const seq = (await this.prisma.stocktake.count({ where: { takeNo: { startsWith: `PD${dayjs().format('YYYYMMDD')}` } } })) + 1;
    const created = await this.prisma.stocktake.create({
      data: {
        tenantId: user.tenantId,
        takeNo: `PD${dayjs().format('YYYYMMDD')}-${String(seq).padStart(4, '0')}`,
        type: dto.type, status: 'DRAFT', countedById: user.id,
        lines: { create: lines.map((l) => ({ tenantId: user.tenantId, ...l, systemQty: new Prisma.Decimal(l.systemQty), countedQty: new Prisma.Decimal(l.systemQty), unitCost: new Prisma.Decimal(l.unitCost) })) },
      } as never,
      include: { lines: { include: { batch: { include: { product: { select: { name: true, skuCode: true } } } } } } },
    });
    await this.audit.log({ user, action: 'STOCKTAKE_CREATE', entityType: 'STOCKTAKE', entityId: created.id, after: { takeNo: created.takeNo, type: dto.type, lines: lines.length } });
    return created;
  }

  /** 仓管录实盘 → COUNTED */
  async count(user: AuthUser, id: string, lines: Array<{ id: string; countedQty: number }>): Promise<unknown> {
    if (user.role !== 'WAREHOUSE' && user.role !== 'OWNER') throw new ForbiddenException('实盘由仓管录入(Q11)');
    const st = await this.prisma.stocktake.findUnique({ where: { id }, include: { lines: true } });
    if (!st) throw new NotFoundException('盘点单不存在');
    if (st.status !== 'DRAFT' && st.status !== 'COUNTED') throw new ConflictException(`当前状态 ${st.status} 不可录实盘`);
    for (const l of lines) {
      if (l.countedQty < 0) throw new BadRequestException('实盘数不能为负');
      const line = st.lines.find((x) => x.id === l.id);
      if (!line) throw new BadRequestException(`行 ${l.id} 不属于本盘点单`);
    }
    await this.prisma.$transaction(async (tx) => {
      for (const l of lines) {
        await tx.stocktakeLine.update({ where: { id: l.id }, data: { countedQty: new Prisma.Decimal(l.countedQty) } });
      }
      await tx.stocktake.update({ where: { id }, data: { status: 'COUNTED', countedAt: new Date(), countedById: user.id } });
    });
    await this.audit.log({ user, action: 'STOCKTAKE_COUNT', entityType: 'STOCKTAKE', entityId: id, after: { lines: lines.length } });
    return { id, status: 'COUNTED' };
  }

  /** 内勤核对: 差异清单 + 金额; 超阈值→老板审批, 否则直接可调账 */
  async reconcile(user: AuthUser, id: string): Promise<unknown> {
    if (user.role !== 'CLERK' && user.role !== 'OWNER') throw new ForbiddenException('核对由内勤执行(Q11)');
    const st = await this.prisma.stocktake.findUnique({ where: { id }, include: { lines: { include: { batch: { include: { product: { select: { name: true, skuCode: true } } } } } } } });
    if (!st) throw new NotFoundException('盘点单不存在');
    if (st.status !== 'COUNTED') throw new ConflictException(`仅已录实盘可核对(当前 ${st.status})`);
    const diffs = st.lines
      .map((l) => ({ lineId: l.id, skuCode: l.batch.product.skuCode, name: l.batch.product.name, batchId: l.batchId, productId: l.productId, systemQty: Number(l.systemQty), countedQty: Number(l.countedQty), diffQty: Number(l.countedQty) - Number(l.systemQty), diffAmount: Number(((Number(l.countedQty) - Number(l.systemQty)) * Number(l.unitCost)).toFixed(2)) }))
      .filter((d) => Math.abs(d.diffQty) > 0.0001);
    const diffAmount = Number(diffs.reduce((s, d) => s + d.diffAmount, 0).toFixed(2));
    const threshold = await this.threshold();
    const thresholdOver = Math.abs(diffAmount) > threshold;
    // 先抢占状态再建审批单(2026-10 审查修复: 并发核对重复提审)
    const claimed = await this.prisma.stocktake.updateMany({
      where: { id, status: 'COUNTED' },
      data: { status: thresholdOver ? 'PENDING_APPROVAL' : 'RECONCILED', reconciledById: user.id, reconciledAt: new Date(), diffAmount: new Prisma.Decimal(diffAmount), thresholdOver },
    });
    if (claimed.count === 0) throw new ConflictException('盘点单状态已变化(可能已核对), 请刷新后重试');
    let approvalId: string | undefined;
    if (thresholdOver) {
      const approval = await this.approvals.create(user, {
        line: 'STOCKTAKE', entityType: 'STOCKTAKE', entityId: id,
        title: `盘点差异调账 ${st.takeNo} ¥${diffAmount}`, amount: Math.abs(diffAmount),
        reason: `差异超阈值 ¥${threshold}, 报老板审批(Q11)`,
        payload: { takeNo: st.takeNo, diffAmount, diffs: diffs.slice(0, 50) },
      });
      approvalId = approval.id;
    }
    await this.audit.log({ user, action: 'STOCKTAKE_RECONCILE', entityType: 'STOCKTAKE', entityId: id, before: { status: 'COUNTED' }, after: { diffAmount, thresholdOver, approvalId, diffLines: diffs.length } });
    return { id, status: thresholdOver ? 'PENDING_APPROVAL' : 'RECONCILED', diffAmount, thresholdOver, threshold, diffs, approvalId };
  }

  /** 调账落账: 差异行写 ADJUST 流水(盘盈 IN / 盘亏 OUT); 超阈值须审批通过 */
  async adjust(user: AuthUser, id: string): Promise<unknown> {
    const st = await this.prisma.stocktake.findUnique({ where: { id }, include: { lines: true } });
    if (!st) throw new NotFoundException('盘点单不存在');
    if (st.status === 'ADJUSTED') throw new ConflictException('该盘点已调账(幂等拒绝)');
    if (st.status !== 'RECONCILED') {
      if (st.status === 'PENDING_APPROVAL') throw new ConflictException('差异超阈值, 老板审批通过后才可调账');
      throw new ConflictException(`当前状态 ${st.status} 不可调账`);
    }
    let adjusted = 0;
    await this.prisma.$transaction(async (tx) => {
      // 事务内抢占(2026-10 审查修复: 状态检查在事务外, 并发调账双倍写 ADJUST 流水且无幂等键)
      const claimed = await tx.stocktake.updateMany({ where: { id, status: 'RECONCILED' }, data: { status: 'ADJUSTED', adjustedAt: new Date() } });
      if (claimed.count === 0) throw new ConflictException('盘点单状态已变化(可能已调账), 请刷新后重试');
      // P1-27: 盘点不冻结库存——建单→实盘→核对→调账期间批次可能发生出入库,
      // 按陈旧快照落账会把流水打成负数/重复盘盈。调账前按当前流水复核每行快照, 漂移即拒绝重盘
      const batchIds = [...new Set(st.lines.map((l) => l.batchId))];
      const groups = await tx.inventoryLedger.groupBy({
        by: ['batchId', 'direction'],
        where: { batchId: { in: batchIds } },
        _sum: { qty: true },
      });
      const current = new Map<string, number>();
      for (const g of groups) {
        current.set(g.batchId, (current.get(g.batchId) ?? 0) + (g.direction === 'IN' ? Number(g._sum.qty ?? 0) : -Number(g._sum.qty ?? 0)));
      }
      for (const l of st.lines) {
        const nowQty = current.get(l.batchId) ?? 0;
        if (Math.abs(nowQty - Number(l.systemQty)) > 0.0001) {
          throw new ConflictException(`批次 ${l.batchId} 盘点期间发生出入库(当前现存量 ${nowQty} ≠ 盘点快照 ${Number(l.systemQty)}), 本单已失效请重新盘点`);
        }
      }
      for (const l of st.lines) {
        const diff = Number(l.countedQty) - Number(l.systemQty);
        if (Math.abs(diff) <= 0.0001) continue;
        await tx.inventoryLedger.create({
          data: { tenantId: user.tenantId, productId: l.productId, batchId: l.batchId, direction: diff > 0 ? 'IN' : 'OUT', qty: new Prisma.Decimal(Math.abs(diff)), refType: 'ADJUST', refNo: st.takeNo, note: `盘点调账 ${st.takeNo}(${diff > 0 ? '盘盈' : '盘亏'})`, createdBy: user.id },
        });
        adjusted++;
      }
    });
    await this.audit.log({ user, action: 'STOCKTAKE_ADJUST', entityType: 'STOCKTAKE', entityId: id, after: { takeNo: st.takeNo, adjustedLines: adjusted, diffAmount: Number(st.diffAmount ?? 0) } });
    return { id, status: 'ADJUSTED', adjustedLines: adjusted };
  }

  async list(q: { status?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where = { status: q.status as never };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.stocktake.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.stocktake.count({ where }),
    ]);
    return { items, total };
  }

  async detail(id: string): Promise<unknown> {
    const st = await this.prisma.stocktake.findUnique({
      where: { id },
      include: { lines: { include: { batch: { include: { product: { select: { name: true, skuCode: true } } } } } } },
    });
    if (!st) throw new NotFoundException('盘点单不存在');
    return st;
  }
}
