import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { bizDateKey, bizDayStamp } from '../../common/business-time';
import { sequential } from '../../prisma/relation-read';
import { AuditService } from '../../audit/audit.service';
import { IdempotencyService } from '../../audit/idempotency.service';
import { ApprovalsService } from '../approvals/approvals.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T06 采购双流程 (F3 先付 / F4 后付) ═══════════════
// F3 先付: DRAFT→PENDING_APPROVAL→APPROVED→PAID→RECEIVED (审批→付款→收货)
// F4 后付: DRAFT→PENDING_APPROVAL→APPROVED→RECEIVED→PAID (审批→收货→付款)
// 收货入库: 批次建/补 + IN 流水(PURCHASE_IN) + 成本价新版本(COST, D08 版本化)
// 资金/库存动作: 幂等键 + 审计

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly idem: IdempotencyService,
    private readonly approvals: ApprovalsService,
  ) {}

  async create(user: AuthUser, dto: { supplier: string; type: 'PREPAID' | 'POSTPAID'; payeeNote?: string; note?: string; lines: Array<{ productId: string; batchNo: string; qty: number; unitCost: number; produceDate?: string; expiryDate?: string }> }): Promise<unknown> {
    if (!dto.supplier?.trim()) throw new BadRequestException('供应商必填');
    if (!dto.lines?.length) throw new BadRequestException('采购单至少一行');
    for (const l of dto.lines) {
      if (l.qty <= 0 || l.unitCost < 0) throw new BadRequestException('数量须>0, 成本须≥0');
      if (!l.batchNo?.trim()) throw new BadRequestException('批次号必填');
      if (l.expiryDate && l.expiryDate < bizDateKey()) throw new BadRequestException('已过期批次拒入');
    }
    const products = await this.prisma.product.findMany({ where: { id: { in: dto.lines.map((l) => l.productId) } } });
    if (products.length !== new Set(dto.lines.map((l) => l.productId)).size) throw new BadRequestException('存在无效商品');
    const totalAmount = dto.lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
    const seq = (await this.prisma.purchaseOrder.count({ where: { purNo: { startsWith: `CG${bizDayStamp()}` } } })) + 1;
    const created = await this.prisma.purchaseOrder.create({
      data: {
        tenantId: user.tenantId,
        purNo: `CG${bizDayStamp()}-${String(seq).padStart(4, '0')}`,
        supplier: dto.supplier, type: dto.type, status: 'DRAFT',
        totalAmount: new Prisma.Decimal(totalAmount.toFixed(2)),
        payeeNote: dto.payeeNote, note: dto.note, createdById: user.id,
        lines: { create: dto.lines.map((l) => ({ tenantId: user.tenantId, productId: l.productId, batchNo: l.batchNo, qty: new Prisma.Decimal(l.qty), unitCost: new Prisma.Decimal(l.unitCost), produceDate: l.produceDate ? new Date(l.produceDate) : undefined, expiryDate: l.expiryDate ? new Date(l.expiryDate) : undefined })) },
      } as never,
      include: { lines: true },
    });
    await this.audit.log({ user, action: 'PURCHASE_CREATE', entityType: 'PURCHASE', entityId: created.id, after: { purNo: created.purNo, type: dto.type, totalAmount } });
    return created;
  }

  async submit(user: AuthUser, id: string): Promise<unknown> {
    const p = await this.prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!p) throw new NotFoundException('采购单不存在');
    if (p.type === 'POSTPAID') {
      if (p.status === 'DRAFT') {
        const claimed = await this.prisma.purchaseOrder.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'APPROVED' } });
        if (claimed.count === 0) throw new ConflictException('采购单状态已变化，请刷新后重试');
        return { id, status: 'APPROVED', step: 'CLERK_CONFIRMED' };
      }
      if (p.status !== 'RECEIVED_PENDING_APPROVAL') throw new ConflictException('后付采购须先由内勤确认并完成收货');
      const pending = await this.prisma.approvalRecord.findFirst({ where: { entityType: 'PURCHASE', entityId: id, status: 'PENDING' } });
      if (pending) throw new ConflictException('该后付采购正在等待老板审批');
    } else {
      if (p.status !== 'DRAFT') throw new ConflictException(`仅草稿可提交(当前 ${p.status})`);
      const claimed = await this.prisma.purchaseOrder.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } });
      if (claimed.count === 0) throw new ConflictException('采购单状态已变化，请刷新后重试');
    }
    const approval = await this.approvals.create(user, {
      line: 'PURCHASE', entityType: 'PURCHASE', entityId: id,
      title: `采购 ${p.purNo} ${p.supplier} ¥${Number(p.totalAmount)}`,
      amount: Number(p.totalAmount), reason: `${p.type === 'PREPAID' ? 'F3 先付' : 'F4 后付'}采购, ${p.lines.length} 行`,
      payload: { purNo: p.purNo, type: p.type, supplier: p.supplier, lines: p.lines.map((l) => ({ productId: l.productId, qty: Number(l.qty), unitCost: Number(l.unitCost) })) },
    });
    return { id, status: 'PENDING_APPROVAL', approvalId: approval.id };
  }

  /** 付款: F3 先付=APPROVED 后; F4 后付=RECEIVED 后; 幂等键统一基座(P0-03) */
  async pay(user: AuthUser, id: string, idemKey: string, note?: string): Promise<unknown> {
    if (!idemKey) throw new BadRequestException('付款必须携带 Idempotency-Key 头');
    const pPayload = { p: id, note: note ?? '' };
    const dup = await this.idem.check(user, 'purchases.pay', idemKey, pPayload);
    if (dup) return { replay: true, summary: dup.summary };
    const p = await this.prisma.purchaseOrder.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('采购单不存在');
    if (p.status === 'PAID') throw new ConflictException('该采购单已付款');
    const validFrom = p.type === 'PREPAID' ? 'APPROVED' : 'RECEIVED';
    if (p.status !== validFrom) {
      throw new ConflictException(p.type === 'PREPAID' ? 'F3 先付流程: 审批通过后才可付款' : 'F4 后付流程: 收货入库后才可付款');
    }
    // 条件更新抢占(2026-10 审查修复: 并发付款双写 PAID; 2026-10 审查修复前 update 无状态守卫)
    const claimed = await this.prisma.purchaseOrder.updateMany({
      where: { id, status: validFrom },
      data: { status: 'PAID', paidAt: new Date(), payeeNote: note ?? p.payeeNote },
    });
    if (claimed.count === 0) throw new ConflictException('采购单状态已变化(可能已付款), 请刷新后重试');
    await this.idem.complete(user, 'purchases.pay', idemKey, pPayload, { purNo: p.purNo });
    await this.audit.log({ user, action: 'PURCHASE_PAY', entityType: 'PURCHASE', entityId: id, after: { purNo: p.purNo, amount: Number(p.totalAmount), note } });
    return { purNo: p.purNo, status: 'PAID', amount: Number(p.totalAmount) };
  }

  /** 收货入库: F3 先付=PAID 后; F4 后付=APPROVED 后; 批次+IN 流水+COST 价版本 */
  async receive(user: AuthUser, id: string): Promise<unknown> {
    const p = await this.prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: { include: { product: true } } } });
    if (!p) throw new NotFoundException('采购单不存在');
    if (p.status === 'RECEIVED') throw new ConflictException('该采购单已收货');
    const validFrom = p.type === 'PREPAID' ? 'PAID' : 'APPROVED';
    if (p.status !== validFrom) {
      throw new ConflictException(p.type === 'PREPAID' ? 'F3 先付流程: 付款后才可收货' : 'F4 后付流程: 审批通过后才可收货');
    }
    const batches: Array<{ productId: string; batchNo: string; qty: number }> = [];
    await this.prisma.$transaction(async (tx) => {
      // 事务内抢占(2026-10 审查修复: 状态检查在事务外, 并发收货双倍入库且无幂等键)
      const targetStatus = p.type === 'POSTPAID' ? 'RECEIVED_PENDING_APPROVAL' : 'RECEIVED';
      const claimed = await tx.purchaseOrder.updateMany({ where: { id, status: validFrom }, data: { status: targetStatus, receivedAt: new Date() } });
      if (claimed.count === 0) throw new ConflictException('采购单状态已变化(可能已收货), 请刷新后重试');
      // P1-29: COST 价版本以 validFrom 做唯一键, 循环内逐行 new Date() 同毫秒必撞 P2002 整单失败;
      // 改为基准时间+行序号错开
      const costBaseMs = Date.now();
      for (const [i, l] of p.lines.entries()) {
        let batch = await tx.batchStock.findFirst({ where: { productId: l.productId, batchNo: l.batchNo } });
        if (!batch) {
          batch = await tx.batchStock.create({
            data: {
              tenantId: user.tenantId, productId: l.productId, batchNo: l.batchNo,
              produceDate: l.produceDate ?? undefined, expiryDate: l.expiryDate ?? undefined,
              unitCost: l.unitCost, isInitial: false,
            },
          });
        } else {
          // P1-30: 并入已有批次时按移动加权(R7)重算 unitCost——原实现从不更新,
          // 价涨后盘点差异金额/库存估值长期按旧成本
          const groups = await tx.inventoryLedger.groupBy({ by: ['direction'], where: { batchId: batch.id }, _sum: { qty: true } });
          const onHand = groups.reduce((s, g) => s + (g.direction === 'IN' ? Number(g._sum.qty ?? 0) : -Number(g._sum.qty ?? 0)), 0);
          const prevCost = Number(batch.unitCost);
          const totalQty = onHand + Number(l.qty);
          const newCost = onHand <= 0 || prevCost === 0 ? Number(l.unitCost) : (onHand * prevCost + Number(l.qty) * Number(l.unitCost)) / totalQty;
          batch = await tx.batchStock.update({ where: { id: batch.id }, data: { unitCost: new Prisma.Decimal(newCost.toFixed(4)) } });
        }
        await tx.inventoryLedger.create({
          data: { tenantId: user.tenantId, productId: l.productId, batchId: batch.id, direction: 'IN', qty: l.qty, refType: 'PURCHASE_IN', refNo: p.purNo, note: `采购入库 ${p.purNo}`, createdBy: user.id },
        });
        // 成本价录入 → COST 价新版本(D08: 版本化, 最小单位口径); P2002 顺延重试防跨单同毫秒
        let costCreated = false;
        for (let offset = 0; offset < 3 && !costCreated; offset++) {
          try {
            await tx.price.create({
              data: { tenantId: user.tenantId, productId: l.productId, unit: 'MIN', levelType: 'COST', price: l.unitCost, validFrom: new Date(costBaseMs + i + offset), approvalRef: `CG-${p.purNo}`, note: '采购成本录入', createdBy: user.id },
            });
            costCreated = true;
          } catch (e) {
            if ((e as { code?: string }).code !== 'P2002' || offset === 2) throw e;
          }
        }
        batches.push({ productId: l.productId, batchNo: l.batchNo, qty: Number(l.qty) });
      }
    });
    if (p.type === 'POSTPAID') {
      const approval = await this.approvals.create(user, {
        line: 'PURCHASE', entityType: 'PURCHASE', entityId: id,
        title: `后付采购付款确认 ${p.purNo} ${p.supplier} ¥${Number(p.totalAmount)}`,
        amount: Number(p.totalAmount), reason: 'F4 后付采购已收货，申请老板确认付款',
        payload: { purNo: p.purNo, type: p.type, received: true },
      });
      await this.audit.log({ user, action: 'PURCHASE_RECEIVE', entityType: 'PURCHASE', entityId: id, after: { purNo: p.purNo, approvalId: approval.id, status: 'RECEIVED_PENDING_APPROVAL', batches } });
      return { purNo: p.purNo, status: 'RECEIVED_PENDING_APPROVAL', approvalId: approval.id, batches };
    }
    await this.audit.log({ user, action: 'PURCHASE_RECEIVE', entityType: 'PURCHASE', entityId: id, after: { purNo: p.purNo, batches, costVersions: p.lines.length } });
    return { purNo: p.purNo, status: 'RECEIVED', batches, costPriceVersions: p.lines.length };
  }

  async list(q: { status?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where = { status: q.status as never };
    const [items, total] = await sequential([
      this.prisma.purchaseOrder.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { lines: { include: { product: { select: { name: true, skuCode: true } } } } } }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return { items, total };
  }

  async detail(id: string): Promise<unknown> {
    const p = await this.prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: { include: { product: { select: { name: true, skuCode: true } } } } } });
    if (!p) throw new NotFoundException('采购单不存在');
    return p;
  }
}
