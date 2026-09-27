import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, AuditAction } from '../../audit/audit.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P0-T30 应收台账 + P0-T31 收款销账(F9) ═══════════════
// D4 冻结口径: 生成=签收完成; 到期日=生成日+账期; 分档未到期/1-30/31-60/61-90/>90(可配);
//   核销 FIFO(最早到期优先, 到期日同按生成先后), 禁止比例分摊; 争议款不进分档与提醒
// B4: 余额=total-Σ(SETTLE+REBATE_OFFSET) 流水投影; B3 同原则: 收款冲正只准红字新单

export type AgingBucket = 'not_due' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90p' | 'disputed';

interface ArRow {
  id: string; sourceType: string; sourceDocNo: string; customerName: string;
  total: number; settled: number; open: number; dueDate: string; daysOverdue: number;
  disputeFlag: boolean; bucket: AgingBucket;
}

@Injectable()
export class ReceivablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private bucketOf(dueDate: Date, disputeFlag: boolean): { daysOverdue: number; bucket: AgingBucket } {
    if (disputeFlag) return { daysOverdue: -1, bucket: 'disputed' };
    const days = dayjs().startOf('day').diff(dayjs(dueDate).startOf('day'), 'day');
    const bucket: AgingBucket = days <= 0 ? 'not_due' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90p';
    return { daysOverdue: Math.max(0, days), bucket };
  }

  /** B4 统一开账口径: settled = Σ(SETTLE+REBATE) − Σ(带 paymentId 的 REVERSAL);
   *  open = total − settled − Σ(无 paymentId 的 REVERSAL=导入批次冲正, 整单作废) */
  private arOpen(r: { total: unknown; ledger: Array<{ direction: string; amount: unknown; paymentId: string | null }> }): { settled: number; open: number } {
    let settled = 0; let reversalNoPay = 0;
    for (const l of r.ledger) {
      const amt = Number(l.amount);
      if (l.direction === 'SETTLE' || l.direction === 'REBATE_OFFSET') settled += amt;
      else if (l.direction === 'REVERSAL') { if (l.paymentId) settled -= amt; else reversalNoPay += amt; }
    }
    return { settled, open: Number(r.total) - settled - reversalNoPay };
  }

  async list(user: AuthUser, q: { bucket?: AgingBucket; customerId?: string; page?: number; pageSize?: number }): Promise<{ items: ArRow[]; total: number }> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const where: Prisma.ReceivableWhereInput = {
      customerId: user.role === 'CUSTOMER' ? user.customerId : q.customerId,
    };
    const rows = await this.prisma.receivable.findMany({
      where,
      include: { customer: { select: { name: true } }, ledger: { where: { direction: { in: ['SETTLE', 'REBATE_OFFSET', 'REVERSAL'] } } } },
      orderBy: [{ dueDate: 'asc' }, { generatedAt: 'asc' }], // FIFO 顺序即列表顺序
    });
    const mapped: ArRow[] = rows.map((r) => {
      const { settled, open } = this.arOpen(r);
      void settled;
      const { daysOverdue, bucket } = this.bucketOf(r.dueDate, r.disputeFlag);
      return {
        id: r.id, sourceType: r.sourceType, sourceDocNo: r.sourceDocNo, customerName: r.customer.name,
        total: Number(r.total), settled, open, dueDate: dayjs(r.dueDate).format('YYYY-MM-DD'), daysOverdue, disputeFlag: r.disputeFlag, bucket,
      };
    }).filter((r) => r.open > 0.0001); // 未核销
    const items = q.bucket ? mapped.filter((r) => r.bucket === q.bucket) : mapped;
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length };
  }

  /** 看板欠款汇总(争议款单列, D11) */
  async summary(user: AuthUser): Promise<Record<string, number>> {
    const { items } = await this.list(user, {});
    const out: Record<string, number> = { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0, disputed: 0 };
    for (const r of items) out[r.bucket] += r.open;
    out.total = items.reduce((s, r) => s + r.open, 0);
    return out;
  }

  // ─────────────── F9 收款: 业务员上报 → 内勤录入确认 → FIFO 销账 ───────────────
  async reportPayment(user: AuthUser, dto: { customerId: string; amount: number; method?: string; voucher?: string; note?: string }, idemKey: string, ip?: string): Promise<unknown> {
    if (!idemKey) throw new BadRequestException('收款必须携带 Idempotency-Key 头');
    if (dto.amount <= 0) throw new BadRequestException('金额必须大于 0');
    const dup = await this.prisma.idempotencyRecord.findUnique({ where: { tenantId_key: { tenantId: user.tenantId, key: idemKey } } });
    if (dup) return { replay: true, summary: dup.responseSummary };
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('客户不存在');
    const seq = (await this.prisma.payment.count({ where: { paymentNo: { startsWith: `PAY${dayjs().format('YYYYMMDD')}` } } })) + 1;
    const payment = await this.prisma.payment.create({
      data: {
        tenantId: user.tenantId,
        paymentNo: `PAY${dayjs().format('YYYYMMDD')}-${String(seq).padStart(4, '0')}`,
        customerId: dto.customerId, amount: new Prisma.Decimal(dto.amount),
        method: dto.method, voucher: dto.voucher, note: dto.note,
        reportedById: user.role === 'REP' ? user.id : null,
        enteredById: user.role === 'CLERK' || user.role === 'OWNER' ? user.id : null,
        status: user.role === 'REP' ? 'REPORTED' : 'CONFIRMED',
        confirmedAt: user.role === 'REP' ? null : new Date(),
        idemKey,
      },
    });
    await this.prisma.idempotencyRecord.create({
      data: { tenantId: user.tenantId, key: idemKey, endpoint: 'payments.report', requestHash: JSON.stringify({ c: dto.customerId, a: dto.amount }), createdBy: user.id, responseSummary: { paymentNo: payment.paymentNo } as never },
    });
    await this.audit.log({ user, action: AuditAction.PAYMENT_CONFIRM, entityType: 'Payment', entityId: payment.id, after: { paymentNo: payment.paymentNo, amount: dto.amount, status: payment.status }, ip });
    // 内勤/老板直录 = 上报即确认 → 直接销账
    if (payment.status === 'CONFIRMED') return this.settleFifo(user, payment.id, ip);
    return payment;
  }

  /** 内勤确认 → FIFO 销账(D4: 最早到期优先, 到期日同按生成先后; 逐单冲抵) */
  async confirmPayment(user: AuthUser, paymentId: string, ip?: string): Promise<unknown> {
    if (user.role !== 'CLERK' && user.role !== 'OWNER') throw new ForbiddenException('仅内勤/老板可确认收款');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('收款单不存在');
    if (payment.status === 'CONFIRMED') throw new ConflictException('该收款已确认');
    if (payment.status === 'CANCELLED') throw new ConflictException('该收款已冲正');
    await this.prisma.payment.update({ where: { id: paymentId }, data: { status: 'CONFIRMED', enteredById: user.id, confirmedAt: new Date() } });
    return this.settleFifo(user, paymentId, ip);
  }

  private async settleFifo(user: AuthUser, paymentId: string, ip?: string): Promise<unknown> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('收款单不存在');
    const ars = await this.prisma.receivable.findMany({
      where: { customerId: payment.customerId, disputeFlag: false },
      include: { ledger: true, order: { select: { id: true } } },
      orderBy: [{ dueDate: 'asc' }, { generatedAt: 'asc' }], // D4 FIFO 唯一算法
    });
    let remain = Number(payment.amount);
    const settled: Array<{ receivableId: string; sourceDocNo: string; amount: number; fullySettled: boolean }> = [];
    for (const ar of ars) {
      if (remain <= 0.0001) break;
      const { open } = this.arOpen(ar);
      if (open <= 0.0001) continue;
      const take = Math.min(open, remain);
      remain -= take;
      const fully = open - take <= 0.0001;
      settled.push({ receivableId: ar.id, sourceDocNo: ar.sourceDocNo, amount: take, fullySettled: fully });
    }
    await this.prisma.$transaction(async (tx) => {
      for (const s of settled) {
        await tx.receivableLedger.create({
          data: { tenantId: user.tenantId, receivableId: s.receivableId, paymentId, direction: 'SETTLE', amount: new Prisma.Decimal(s.amount), note: `FIFO 核销 ${payment.paymentNo}`, createdBy: user.id },
        });
        // 订单应收全额核销 → SIGNED→SETTLED(状态机白名单: 未签收不可销账由 receivable 仅签收后存在保证)
        if (s.fullySettled) {
          const ar = ars.find((a) => a.id === s.receivableId)!;
          if (ar.order) {
            const order = await tx.salesOrder.findUnique({ where: { id: ar.order.id } });
            if (order && order.status === 'SIGNED') {
              await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'SETTLED', settledAt: new Date() } });
            }
          }
        }
      }
    });
    await this.audit.log({ user, action: AuditAction.SETTLE, entityType: 'Payment', entityId: paymentId, after: { paymentNo: payment.paymentNo, amount: Number(payment.amount), applied: settled, unapplied: remain }, ip });
    return { paymentNo: payment.paymentNo, amount: Number(payment.amount), applied: settled, unapplied: remain };
  }

  /** 收款冲正: 只准红字新单(禁改原收款, B3 同原则) */
  async reversePayment(user: AuthUser, paymentId: string, reason: string, ip?: string): Promise<unknown> {
    if (user.role !== 'OWNER') throw new ForbiddenException('冲正仅老板可执行');
    if (!reason?.trim()) throw new BadRequestException('冲正必须填写原因');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { ledger: true } });
    if (!payment) throw new NotFoundException('收款单不存在');
    if (payment.status === 'CANCELLED') throw new ConflictException('该收款已冲正');
    await this.prisma.$transaction(async (tx) => {
      for (const l of payment.ledger.filter((x) => x.direction === 'SETTLE')) {
        await tx.receivableLedger.create({
          data: { tenantId: user.tenantId, receivableId: l.receivableId, paymentId, direction: 'REVERSAL', amount: l.amount, note: `冲正 ${payment.paymentNo}: ${reason}`, createdBy: user.id },
        });
      }
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'CANCELLED', note: `${payment.note ?? ''} | 冲正: ${reason}` } });
    });
    await this.audit.log({ user, action: AuditAction.PAYMENT_REVERSE, entityType: 'Payment', entityId: paymentId, before: { status: payment.status }, after: { status: 'CANCELLED', reason }, ip });
    return { paymentNo: payment.paymentNo, status: 'CANCELLED' };
  }

  async payments(user: AuthUser, q: { status?: string; customerId?: string }): Promise<unknown> {
    return this.prisma.payment.findMany({
      where: { status: (q.status as 'REPORTED' | 'CONFIRMED' | 'CANCELLED') ?? undefined, customerId: user.role === 'CUSTOMER' ? user.customerId : q.customerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { customer: { select: { name: true } } },
    });
  }
}
