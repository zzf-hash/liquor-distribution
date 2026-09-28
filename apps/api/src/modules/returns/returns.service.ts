import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T03 退货销户 (F10 + R4 + D13) ═══════════════
// D13: 签收后 48h 窗口 + 关联原单必填 + 老板审批; 退回按原批次回冲库存, 应收按实退重算
// R4: 退货数量只能多不能少——行 append-only(增走追加行), 禁 UPDATE/DELETE(Prisma 守卫)
// 应收重算: RETURN_CREDIT 流水(负方向核减 open), 不改原单金额(B3 同原则)

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  async create(user: AuthUser, dto: { sourceOrderId: string; reason: string; lines: Array<{ orderLineId: string; qty: number; note?: string }> }): Promise<unknown> {
    if (!dto.reason?.trim()) throw new BadRequestException('退货必须填写原因');
    if (!dto.lines?.length) throw new BadRequestException('退货至少一行');
    const order = await this.prisma.salesOrder.findUnique({ where: { id: dto.sourceOrderId }, include: { lines: true, returns: { include: { lines: true } } } });
    if (!order) throw new NotFoundException('原订单不存在');
    if (!['SIGNED', 'SETTLED'].includes(order.status)) throw new ConflictException('仅已签收/已销账订单可退货');
    // D13: 48h 窗口(签收后)
    if (order.signedAt && dayjs().diff(dayjs(order.signedAt), 'hour') > 48) {
      throw new ConflictException('已超过签收后 48h 退货窗口(D13), 需走人工调账');
    }
    // R4 上限校验: 每行累计退货 ≤ 原行净量(扣红字)
    const netByLine = new Map<string, number>();
    for (const l of order.lines) {
      if (l.reversalOfId) continue;
      const reversed = order.lines.filter((r) => r.reversalOfId === l.id).reduce((s, r) => s + Number(r.qty), 0);
      netByLine.set(l.id, Number(l.qty) + reversed);
    }
    const returnedByLine = new Map<string, number>();
    for (const r of order.returns.filter((x) => x.status !== 'CANCELLED')) {
      for (const l of r.lines) returnedByLine.set(l.orderLineId, (returnedByLine.get(l.orderLineId) ?? 0) + Number(l.qty));
    }
    for (const l of dto.lines) {
      const net = netByLine.get(l.orderLineId);
      if (net === undefined) throw new BadRequestException(`行 ${l.orderLineId} 不属于原订单`);
      if (l.qty <= 0) throw new BadRequestException('退货数量须大于 0');
      const already = returnedByLine.get(l.orderLineId) ?? 0;
      if (already + l.qty > net + 0.0001) throw new BadRequestException(`行退货累计 ${already + l.qty} 超过原行净量 ${net}(R4 只能多不能少的上限=原量)`);
    }
    const seq = (await this.prisma.returnOrder.count({ where: { returnNo: { startsWith: `RT${dayjs().format('YYYYMMDD')}` } } })) + 1;
    const created = await this.prisma.returnOrder.create({
      data: {
        tenantId: user.tenantId,
        returnNo: `RT${dayjs().format('YYYYMMDD')}-${String(seq).padStart(4, '0')}`,
        sourceOrderId: dto.sourceOrderId, customerId: order.customerId,
        reason: dto.reason, status: 'PENDING_REVIEW', createdById: user.id,
        lines: { create: dto.lines.map((l) => ({ tenantId: user.tenantId, orderLineId: l.orderLineId, productId: order.lines.find((x) => x.id === l.orderLineId)!.productId, qty: new Prisma.Decimal(l.qty), note: l.note })) },
      } as never,
      include: { lines: true },
    });
    const amount = dto.lines.reduce((s, l) => {
      const line = order.lines.find((x) => x.id === l.orderLineId)!;
      return s + Number(line.unitPrice) * l.qty;
    }, 0);
    const approval = await this.approvals.create(user, {
      line: 'RETURN', entityType: 'RETURN', entityId: created.id,
      title: `退货审批 ${created.returnNo} ← ${order.orderNo}`, amount, reason: dto.reason,
      payload: { returnNo: created.returnNo, orderNo: order.orderNo, lines: dto.lines.map((l) => ({ name: order.lines.find((x) => x.id === l.orderLineId)!.productName, qty: l.qty })) },
    });
    await this.audit.log({ user, action: 'RETURN_CREATE', entityType: 'RETURN', entityId: created.id, after: { returnNo: created.returnNo, orderNo: order.orderNo, amount, approvalId: approval.id } });
    return { ...created, approvalId: approval.id, amount };
  }

  async list(user: AuthUser, q: { status?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where = { status: q.status as never };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.returnOrder.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { lines: true, order: { select: { orderNo: true } }, customer: { select: { name: true } } },
      }),
      this.prisma.returnOrder.count({ where }),
    ]);
    void user;
    return { items, total };
  }

  async detail(id: string): Promise<unknown> {
    const r = await this.prisma.returnOrder.findUnique({ where: { id }, include: { lines: true, order: { include: { lines: true } }, customer: { select: { name: true } } } });
    if (!r) throw new NotFoundException('退货单不存在');
    return r;
  }

  /** R4: 追加退货行(数量只增)——仅 PENDING_REVIEW/APPROVED 且未收货 */
  async appendLines(user: AuthUser, id: string, lines: Array<{ orderLineId: string; qty: number }>): Promise<unknown> {
    const r = await this.prisma.returnOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!r) throw new NotFoundException('退货单不存在');
    if (r.status !== 'PENDING_REVIEW' && r.status !== 'APPROVED') throw new ConflictException('已收货的退货单不可追加(R4)');
    const order = await this.prisma.salesOrder.findUnique({ where: { id: r.sourceOrderId }, include: { lines: true, returns: { include: { lines: true } } } });
    if (!order) throw new NotFoundException('原订单不存在');
    const netByLine = new Map<string, { net: number; productId: string }>();
    for (const l of order.lines) {
      if (l.reversalOfId) continue;
      const reversed = order.lines.filter((x) => x.reversalOfId === l.id).reduce((s, x) => s + Number(x.qty), 0);
      netByLine.set(l.id, { net: Number(l.qty) + reversed, productId: l.productId });
    }
    const returned = new Map<string, number>();
    for (const ro of order.returns.filter((x) => x.status !== 'CANCELLED')) {
      for (const l of ro.lines) returned.set(l.orderLineId, (returned.get(l.orderLineId) ?? 0) + Number(l.qty));
    }
    for (const l of lines) {
      const info = netByLine.get(l.orderLineId);
      if (!info || l.qty <= 0) throw new BadRequestException('追加行非法');
      if ((returned.get(l.orderLineId) ?? 0) + l.qty > info.net + 0.0001) throw new BadRequestException(`累计退货超过原行净量(R4)`);
    }
    await this.prisma.returnLine.createMany({
      data: lines.map((l) => ({ tenantId: user.tenantId, returnOrderId: id, orderLineId: l.orderLineId, productId: netByLine.get(l.orderLineId)!.productId, qty: new Prisma.Decimal(l.qty) })),
    });
    await this.audit.log({ user, action: 'RETURN_APPEND', entityType: 'RETURN', entityId: id, after: { added: lines.length } });
    return { appended: lines.length };
  }

  /** 收货回冲: 原批次 IN 流水 + 应收 RETURN_CREDIT 冲减; 仓库执行(APPROVED 后) */
  async receive(user: AuthUser, id: string): Promise<unknown> {
    const r = await this.prisma.returnOrder.findUnique({
      where: { id },
      include: { lines: true, order: { include: { lines: true, outbounds: { include: { lines: true } }, receivables: true } } },
    });
    if (!r) throw new NotFoundException('退货单不存在');
    if (r.status !== 'APPROVED') throw new ConflictException('退货审批通过后才可收货回冲');
    // 原批次回冲(该行出库批次顺序取)
    const batches: Array<{ productId: string; batchId: string; qty: number }> = [];
    let arCredit = 0;
    for (const l of r.lines) {
      const orderLine = r.order.lines.find((x) => x.id === l.orderLineId);
      if (!orderLine) continue;
      const minQty = Number(l.qty) * (orderLine.unit === 'BASE' ? orderLine.conversionRate : 1);
      const outLines = r.order.outbounds.flatMap((o) => o.lines).filter((ol) => ol.orderLineId === l.orderLineId);
      let remaining = minQty;
      for (const ol of outLines) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(ol.qty));
        remaining -= take;
        batches.push({ productId: l.productId, batchId: ol.batchId, qty: take });
      }
      arCredit += Number(orderLine.unitPrice) * Number(l.qty);
    }
    await this.prisma.$transaction(async (tx) => {
      for (const b of batches) {
        await tx.inventoryLedger.create({
          data: { tenantId: user.tenantId, productId: b.productId, batchId: b.batchId, direction: 'IN', qty: new Prisma.Decimal(b.qty), refType: 'RETURN_IN', refNo: r.returnNo, note: `退货回冲 ${r.returnNo}`, createdBy: user.id },
        });
      }
      // 应收冲减: 找订单应收写 RETURN_CREDIT 流水(不改原单 total, B3)
      const ar = r.order.receivables[0];
      if (ar && arCredit > 0) {
        await tx.receivableLedger.create({
          data: { tenantId: user.tenantId, receivableId: ar.id, direction: 'RETURN_CREDIT', amount: new Prisma.Decimal(arCredit), note: `退货冲减 ${r.returnNo}: ${r.reason}`, createdBy: user.id },
        });
      }
      await tx.returnOrder.update({ where: { id }, data: { status: 'RECEIVED', receivedAt: new Date(), receivedById: user.id } });
    });
    await this.audit.log({ user, action: 'RETURN_RECEIVE', entityType: 'RETURN', entityId: id, after: { returnNo: r.returnNo, batches: batches.length, arCredit } });
    return { returnNo: r.returnNo, status: 'RECEIVED', batches, arCredit };
  }

  async cancel(user: AuthUser, id: string): Promise<unknown> {
    const r = await this.prisma.returnOrder.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('退货单不存在');
    if (r.status !== 'PENDING_REVIEW') throw new ConflictException('仅待审批退货可取消');
    await this.prisma.returnOrder.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.log({ user, action: 'RETURN_CANCEL', entityType: 'RETURN', entityId: id });
    return { id, status: 'CANCELLED' };
  }
}
