import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { BUSINESS_TZ, bizDayDiff, bizDayStamp, bizNow, bizStartOfMonth } from '../../common/business-time';
import { AuditService, AuditAction } from '../../audit/audit.service';
import { IdempotencyService } from '../../audit/idempotency.service';
import { assertPaymentTransition, PaymentState } from '../../statemachine/payment-state';
import { NotifyService } from '../../common/notify.service';
import type { AuthUser } from '../../common/current-user.decorator';
import {
  AgingBucket, AgingConfig, readAgingConfig, normalizeAgingConfig, bucketOfDays,
  AGING_CONFIG_KEY, DEFAULT_AGING_CONFIG, arOpenOf,
} from './aging';

// ═══════════════ P0-T30 应收台账 + P0-T31 收款销账(F9) + T03 抹零坏账 + T32 软归档 + T51 提醒 ═══════════════
// D4 冻结口径: 生成=签收完成; 到期日=生成日+账期; 分档未到期/b1/b2/b3/b4(档位租户级可配, 默认30/50/90, Q1已确认);
//   核销 FIFO(最早到期优先), 禁止比例分摊; 争议款不进分档与提醒
// B4: open=流水投影(total−SETTLE−WAIVE−WRITEOFF−冲正); B3 同原则: 收款冲正只准红字新单

export type { AgingBucket } from './aging';

interface ArRow {
  id: string; sourceType: string; sourceDocNo: string; customerName: string;
  total: number; settled: number; open: number; dueDate: string; daysOverdue: number;
  disputeFlag: boolean; bucket: AgingBucket; settledAt?: string;
}

/** 距到期的上海日历天数。dueDate 是 YYYY-MM-DD。正数=还没到期。 */
function daysUntil(dueDate: string): number {
  return -bizDayDiff(dayjs.tz(dueDate, BUSINESS_TZ).toDate());
}

@Injectable()
export class ReceivablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly idem: IdempotencyService,
    private readonly notify: NotifyService,
  ) {}

  private bucketOf(dueDate: Date, disputeFlag: boolean, cfg: AgingConfig): { daysOverdue: number; bucket: AgingBucket } {
    if (disputeFlag) return { daysOverdue: -1, bucket: 'disputed' };
    const days = bizDayDiff(dueDate);
    return { daysOverdue: Math.max(0, days), bucket: bucketOfDays(days, cfg) };
  }

  /** B4 统一开账口径(实现移入 aging.ts 与定时任务共用): settled = Σ(SETTLE+REBATE) − Σ(带 paymentId 的 REVERSAL);
   *  open = max(0, total − settled − WAIVE − WRITEOFF − RETURN_CREDIT(退货) − Σ(无 paymentId 的 REVERSAL)) */
  private arOpen(r: { total: unknown; ledger: Array<{ direction: string; amount: unknown; paymentId: string | null }> }): { settled: number; open: number } {
    return arOpenOf(Number(r.total), r.ledger);
  }

  /** M9-3: 账龄档位配置(租户级, Q1 已确认默认 30/50/90) */
  async getAgingConfig(user: AuthUser): Promise<AgingConfig> {
    return readAgingConfig(this.prisma, user.tenantId);
  }

  async saveAgingConfig(user: AuthUser, patch: Partial<AgingConfig>, ip?: string): Promise<AgingConfig> {
    if (user.role !== 'OWNER') throw new ForbiddenException('账龄档位仅老板可配置');
    const cur = await this.getAgingConfig(user);
    const next = normalizeAgingConfig({ ...cur, ...patch });
    await this.prisma.systemConfig.upsert({
      where: { tenantId_key: { tenantId: user.tenantId, key: AGING_CONFIG_KEY } },
      create: { tenantId: user.tenantId, key: AGING_CONFIG_KEY, value: { v: next } as never, updatedBy: user.id, note: '账龄分档档位(天)' },
      update: { value: { v: next } as never, updatedBy: user.id },
    });
    await this.audit.log({ user, action: 'AGING_CONFIG_SAVE', entityType: 'SystemConfig', entityId: AGING_CONFIG_KEY, before: cur, after: next, ip });
    return next;
  }

  /** SystemConfig 读取(带默认值): 数值型商户签字可否决(业务适配清单§0) */
  private async cfgNumber(key: string, dflt: number): Promise<number> {
    const row = await this.prisma.systemConfig.findFirst({ where: { key } });
    const v = row ? Number((row.value as { v?: unknown })?.v ?? row.value) : NaN;
    return Number.isFinite(v) ? v : dflt;
  }

  /** 全量应收行(不分页): list 分页与 summary/reminders 聚合共用 */
  private async rows(user: AuthUser, q: { bucket?: AgingBucket; customerId?: string; archived?: 'only' | 'all' }, includeRecentSettled = false): Promise<ArRow[]> {
    let customerIdFilter: Prisma.ReceivableWhereInput['customerId'] = q.customerId;
    if (user.role === 'CUSTOMER') {
      if (!user.customerId) throw new ForbiddenException('客户账号未绑定客户资料');
      customerIdFilter = user.customerId;
    }
    else if (user.role === 'REP') {
      const mine = await this.prisma.customer.findMany({ where: { salespersonId: user.id }, select: { id: true } });
      const mineIds = mine.map((c) => c.id);
      customerIdFilter = q.customerId ? (mineIds.includes(q.customerId) ? q.customerId : '__none__') : { in: mineIds };
    }
    const where: Prisma.ReceivableWhereInput = {
      customerId: customerIdFilter,
      // T32: 客户侧强制只见未归档; 内勤默认未归档, archived=all 审计查全量, only 查已归档
      archivedAt: user.aud === 'customer' ? null : q.archived === 'all' ? undefined : q.archived === 'only' ? { not: null } : null,
    };
    const all = await this.prisma.receivable.findMany({
      where,
      include: { customer: { select: { name: true } }, ledger: { where: { direction: { in: ['SETTLE', 'REBATE_OFFSET', 'WAIVE', 'WRITEOFF', 'RETURN_CREDIT', 'FEE_OFFSET', 'REVERSAL'] } } } },
      orderBy: [{ dueDate: 'asc' }, { generatedAt: 'asc' }],
    });
    const aging = await readAgingConfig(this.prisma, user.tenantId); // 档位租户级可配(M9-3)
    const mapped: ArRow[] = all.map((r) => {
      const { settled, open } = this.arOpen(r);
      const { daysOverdue, bucket } = this.bucketOf(r.dueDate, r.disputeFlag, aging);
      const settledAt = open <= 0.0001
        ? r.ledger.filter((l) => ['SETTLE', 'REBATE_OFFSET', 'WAIVE', 'WRITEOFF', 'RETURN_CREDIT'].includes(l.direction)).reduce<Date | null>((latest, l) => !latest || l.createdAt > latest ? l.createdAt : latest, null)
        : null;
      return {
        id: r.id, sourceType: r.sourceType, sourceDocNo: r.sourceDocNo, customerName: r.customer.name,
        total: Number(r.total), settled, open, dueDate: dayjs(r.dueDate).tz(BUSINESS_TZ).format('YYYY-MM-DD'), daysOverdue, disputeFlag: r.disputeFlag, bucket,
        ...(settledAt ? { settledAt: settledAt.toISOString() } : {}),
      };
    }).filter((r) => r.open > 0.0001 || (includeRecentSettled && !!r.settledAt && dayjs(r.settledAt).isAfter(bizNow().subtract(6, 'month'))));
    return q.bucket ? mapped.filter((r) => r.bucket === q.bucket) : mapped;
  }

  async list(user: AuthUser, q: { bucket?: AgingBucket; customerId?: string; page?: number; pageSize?: number; archived?: 'only' | 'all' }): Promise<{ items: ArRow[]; total: number; openTotal: number }> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const items = await this.rows(user, q, user.role === 'CUSTOMER');
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, openTotal: items.reduce((sum, row) => sum + row.open, 0) };
  }

  /** 看板欠款汇总(争议款单列, D11) */
  async summary(user: AuthUser): Promise<Record<string, number>> {
    // P1-7: 原实现复用 list() 的第一页切片, 未结超 50 条时欠款总额严重低估
    const items = await this.rows(user, {});
    const out: Record<string, number> = { not_due: 0, b1: 0, b2: 0, b3: 0, b4: 0, disputed: 0 };
    for (const r of items) out[r.bucket] += r.open;
    out.total = items.reduce((s, r) => s + r.open, 0);
    return out;
  }

  // ─────────────── F9 收款: 业务员上报 → 内勤录入确认 → FIFO 销账 ───────────────
  async reportPayment(user: AuthUser, dto: { customerId: string; amount: number; method?: string; voucher?: string; note?: string }, idemKey: string, ip?: string): Promise<unknown> {
    if (!idemKey) throw new BadRequestException('收款必须携带 Idempotency-Key 头');
    if (dto.amount <= 0) throw new BadRequestException('金额必须大于 0');
    const dup = await this.idem.check(user, 'payments.report', idemKey, { c: dto.customerId, a: dto.amount, m: dto.method ?? '' });
    if (dup) return { replay: true, summary: dup.summary };
    const prior = await this.prisma.payment.findFirst({ where: { tenantId: user.tenantId, idemKey } });
    if (prior) {
      if (prior.status === 'REPORTED' && (user.role === 'CLERK' || user.role === 'OWNER')) {
        const resumed = await this.confirmPayment(user, prior.id, ip);
        await this.idem.complete(user, 'payments.report', idemKey, { c: dto.customerId, a: dto.amount, m: dto.method ?? '' }, { paymentNo: prior.paymentNo });
        return resumed;
      }
      return prior;
    }
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('客户不存在');
    // P1-9: REP 只能为自己名下客户上报收款(原实现可冒名上报刷他人业绩/污染他人客户账目)
    if (user.role === 'REP' && customer.salespersonId !== user.id) {
      throw new ForbiddenException('仅可为自己名下客户上报收款');
    }
    // P1-8: 收款金额不超过客户未结合计——无预收模型, 超收部分会"消失"于账外且对账永远对不齐
    const openArs = await this.prisma.receivable.findMany({
      where: { customerId: dto.customerId, disputeFlag: false },
      include: { ledger: true },
    });
    const totalOpen = openArs.reduce((s, r) => s + Math.max(0, this.arOpen(r).open), 0);
    if (dto.amount > totalOpen + 0.0001) {
      throw new BadRequestException(`收款金额 ¥${dto.amount.toFixed(2)} 超过客户未结合计 ¥${totalOpen.toFixed(2)}, 请核对(暂不支持预收挂账)`);
    }
    // P1-14: count+1 并发撞号 → P2002; 失败按 seq 顺延重试(≤5 次)
    const payDay = bizDayStamp();
    let payment: Awaited<ReturnType<typeof this.prisma.payment.create>> | null = null;
    for (let attempt = 0; attempt < 5 && !payment; attempt++) {
      const seq = (await this.prisma.payment.count({ where: { paymentNo: { startsWith: `PAY${payDay}` } } })) + 1 + attempt;
      try {
        payment = await this.prisma.payment.create({
          data: {
            tenantId: user.tenantId,
            paymentNo: `PAY${payDay}-${String(seq).padStart(4, '0')}`,
            customerId: dto.customerId, amount: new Prisma.Decimal(dto.amount), kind: 'PAYMENT',
            method: dto.method, voucher: dto.voucher, note: dto.note,
            reportedById: user.role === 'REP' ? user.id : null,
            enteredById: user.role === 'CLERK' || user.role === 'OWNER' ? user.id : null,
            status: 'REPORTED',
            confirmedAt: null,
            idemKey,
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!payment) throw new ConflictException('单号生成冲突, 请重试');
    const result = user.role === 'REP' ? payment : await this.confirmPayment(user, payment.id, ip);
    await this.idem.complete(user, 'payments.report', idemKey, { c: dto.customerId, a: dto.amount, m: dto.method ?? '' }, { paymentNo: payment.paymentNo });
    return result;
  }

  /** 确认: 收款(PAYMENT)→FIFO 销账; 抹零(WAIVE)→老板审批生效(T03) */
  async confirmPayment(user: AuthUser, paymentId: string, ip?: string): Promise<unknown> {
    const payment0 = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment0) throw new NotFoundException('收款单不存在');
    assertPaymentTransition(payment0.status as PaymentState, 'CONFIRMED'); // P0-C 状态机: 非法转换 409
    if (payment0.kind === 'WAIVE') {
      if (user.role !== 'OWNER') throw new ForbiddenException('抹零审批仅老板可执行(D7)');
      const claimed = await this.prisma.payment.updateMany({ where: { id: paymentId, status: payment0.status }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });
      if (claimed.count === 0) throw new ConflictException('收款单状态已变化(可能已确认), 请刷新后重试');
      await this.audit.log({ user, action: AuditAction.WAIVE_APPROVE, entityType: 'Payment', entityId: paymentId, before: { status: payment0.status }, after: { status: 'CONFIRMED' }, ip });
      return this.applyWaive(user, paymentId, payment0.receivableId!, ip);
    }
    if (user.role !== 'CLERK' && user.role !== 'OWNER') throw new ForbiddenException('仅内勤/老板可确认收款');
    return this.settleFifo(user, paymentId, ip, payment0.status);
  }

  /** FIFO 销账(D4: 最早到期优先, 到期日同按生成先后; 逐单冲抵) */
  private async settleFifo(user: AuthUser, paymentId: string, ip?: string, expectedStatus?: string): Promise<unknown> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('收款单不存在');
    // P1-5 收尾: 应收 open 快照与核销写入同一事务(原快照在事务外, 与退货冲减/抹零/坏账并发可超核销)
    let settled: Array<{ receivableId: string; sourceDocNo: string; amount: number; fullySettled: boolean }> = [];
    let remain = Number(payment.amount);
    await this.prisma.$transaction(async (tx) => {
      if (expectedStatus) {
        const claimed = await tx.payment.updateMany({
          where: { id: paymentId, status: expectedStatus as never },
          data: { status: 'CONFIRMED', confirmedAt: new Date(), enteredById: user.id },
        });
        if (claimed.count === 0) throw new ConflictException('收款单状态已变化(可能已确认), 请刷新后重试');
      }
      // Serialize all FIFO writers for this customer; row locks are held until ledger commit.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "Receivable" WHERE "tenantId" = ${payment.tenantId} AND "customerId" = ${payment.customerId} AND "disputeFlag" = false ORDER BY id FOR UPDATE`);
      const ars = await tx.receivable.findMany({
        where: { customerId: payment.customerId, disputeFlag: false },
        include: { ledger: true },
        orderBy: [{ dueDate: 'asc' }, { generatedAt: 'asc' }], // D4 FIFO 唯一算法
      });
      settled = [];
      remain = Number(payment.amount);
      for (const ar of ars) {
        if (remain <= 0.0001) break;
        const { open } = this.arOpen(ar);
        if (open <= 0.0001) continue;
        const take = Math.min(open, remain);
        remain -= take;
        const fully = open - take <= 0.0001;
        settled.push({ receivableId: ar.id, sourceDocNo: ar.sourceDocNo, amount: take, fullySettled: fully });
      }
      if (remain > 0.0001) throw new ConflictException(`待核销余额不足 ¥${(Number(payment.amount) - remain).toFixed(2)}，收款仍保持待确认，可重试处理`);
      for (const s of settled) {
        await tx.receivableLedger.create({
          data: { tenantId: user.tenantId, receivableId: s.receivableId, paymentId, direction: 'SETTLE', amount: new Prisma.Decimal(s.amount), note: `FIFO 核销 ${payment.paymentNo}`, createdBy: user.id },
        });
        if (s.fullySettled) {
          const ar = ars.find((a) => a.id === s.receivableId)!;
          if (ar.sourceType === 'ORDER') {
            // schema 关系已移除(期初应收 FK 不成立), 按 unique(tenantId, orderNo) 关联
            const order = await tx.salesOrder.findUnique({ where: { tenantId_orderNo: { tenantId: ar.tenantId, orderNo: ar.sourceDocNo } } });
            if (order && order.status === 'SIGNED') {
              await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'SETTLED', settledAt: new Date() } }); // 未签收不可销账由 receivable 仅签收后存在保证
            }
          }
        }
      }
    });
    await this.audit.log({ user, action: AuditAction.SETTLE, entityType: 'Payment', entityId: paymentId, after: { paymentNo: payment.paymentNo, amount: Number(payment.amount), applied: settled, unapplied: remain }, ip });
    const customer = await this.prisma.customer.findUnique({ where: { id: payment.customerId }, select: { name: true } });
    void this.notify.send('收款销账完成', [
      `客户: ${customer?.name ?? payment.customerId}`,
      `收款单: ${payment.paymentNo} ¥${Number(payment.amount).toFixed(2)}`,
      `核销: ${settled.length} 张应收单${remain > 0.0001 ? `, 未分配 ¥${remain.toFixed(2)}` : ''}`,
    ]);
    return { paymentNo: payment.paymentNo, amount: Number(payment.amount), applied: settled, unapplied: remain };
  }

  /** T03: 抹零(内勤发起→老板审批; 单笔/月累计上限护栏, D7§4) */
  async waive(user: AuthUser, receivableId: string, dto: { amount: number; reason: string }, idemKey: string, ip?: string): Promise<unknown> {
    if (user.role !== 'CLERK' && user.role !== 'OWNER') throw new ForbiddenException('仅内勤可发起抹零');
    if (!idemKey) throw new BadRequestException('抹零必须携带 Idempotency-Key 头');
    if (!dto.reason?.trim()) throw new BadRequestException('抹零必须填写原因');
    if (dto.amount <= 0) throw new BadRequestException('抹零金额须大于 0');
    const dup = await this.idem.check(user, 'receivables.waive', idemKey, { r: receivableId, a: dto.amount, reason: dto.reason });
    if (dup) return { replay: true, summary: dup.summary };
    const ar = await this.prisma.receivable.findUnique({ where: { id: receivableId }, include: { ledger: true } });
    if (!ar) throw new NotFoundException('应收单不存在');
    const { open } = this.arOpen(ar);
    if (dto.amount > open + 0.0001) throw new BadRequestException(`抹零金额 ${dto.amount} 超过未结 ${open.toFixed(2)}`);
    const singleMax = await this.cfgNumber('waive_single_max', 50);
    const monthMax = await this.cfgNumber('waive_monthly_max', 500);
    if (dto.amount > singleMax) throw new BadRequestException(`单笔抹零超上限 ${singleMax} 元(可配置)`);
    const monthWaived = await this.prisma.receivableLedger.aggregate({
      where: { direction: 'WAIVE', createdAt: { gte: bizStartOfMonth() } }, _sum: { amount: true },
    });
    if (Number(monthWaived._sum.amount ?? 0) + dto.amount > monthMax) {
      throw new BadRequestException(`本月抹零累计将超上限 ${monthMax} 元(当前 ${Number(monthWaived._sum.amount ?? 0)})`);
    }
    // P1-14: count+1 并发撞号 → P2002; 失败按 seq 顺延重试(≤5 次)
    const wvDay = bizDayStamp();
    let payment: Awaited<ReturnType<typeof this.prisma.payment.create>> | null = null;
    for (let attempt = 0; attempt < 5 && !payment; attempt++) {
      const seq = (await this.prisma.payment.count({ where: { paymentNo: { startsWith: `WV${wvDay}` } } })) + 1 + attempt;
      try {
        payment = await this.prisma.payment.create({
          data: {
            tenantId: user.tenantId,
            paymentNo: `WV${wvDay}-${String(seq).padStart(4, '0')}`,
            customerId: ar.customerId, amount: new Prisma.Decimal(dto.amount), kind: 'WAIVE', receivableId,
            method: '抹零', note: dto.reason, reportedById: user.id,
            status: user.role === 'OWNER' ? 'CONFIRMED' : 'REPORTED', // 老板发起即生效
            confirmedAt: user.role === 'OWNER' ? new Date() : null,
            idemKey,
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!payment) throw new ConflictException('单号生成冲突, 请重试');
    await this.idem.complete(user, 'receivables.waive', idemKey, { r: receivableId, a: dto.amount, reason: dto.reason }, { paymentNo: payment.paymentNo });
    await this.audit.log({ user, action: 'WAIVE_INITIATE', entityType: 'Receivable', entityId: receivableId, after: { paymentNo: payment.paymentNo, amount: dto.amount, reason: dto.reason }, ip });
    if (payment.status === 'CONFIRMED') return this.applyWaive(user, payment.id, receivableId, ip);
    return payment;
  }

  /** 抹零生效: 写 WAIVE 流水(append-only), open 核减 */
  private async applyWaive(user: AuthUser, paymentId: string, receivableId: string, ip?: string): Promise<unknown> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('抹零单不存在');
    // P1-5 收尾: 幂等检查与写入同事务(原 findFirst→create 分离, TOCTOU 可双份 WAIVE 流水)
    return this.prisma.$transaction(async (tx) => {
      const already = await tx.receivableLedger.findFirst({ where: { paymentId, direction: 'WAIVE' } });
      if (already) return { paymentNo: payment.paymentNo, alreadyApplied: true };
      await tx.receivableLedger.create({
        data: { tenantId: user.tenantId, receivableId, paymentId, direction: 'WAIVE', amount: payment.amount, note: `抹零 ${payment.paymentNo}: ${payment.note ?? ''}`, createdBy: user.id },
      });
      await this.audit.log({ user, action: 'WAIVE_APPLY', entityType: 'Receivable', entityId: receivableId, after: { paymentNo: payment.paymentNo, amount: Number(payment.amount) }, ip });
      return { paymentNo: payment.paymentNo, waived: Number(payment.amount) };
    });
  }

  /** T03: 坏账核销(老板直接执行, R2 级动作, 幂等) */
  async writeOff(user: AuthUser, receivableId: string, reason: string, idemKey: string, ip?: string): Promise<unknown> {
    if (user.role !== 'OWNER') throw new ForbiddenException('坏账核销仅老板可执行');
    if (!reason?.trim()) throw new BadRequestException('坏账核销必须填写原因');
    if (!idemKey) throw new BadRequestException('坏账核销必须携带 Idempotency-Key 头');
    const dup = await this.idem.check(user, 'receivables.writeOff', idemKey, { r: receivableId, reason });
    if (dup) return { replay: true, summary: dup.summary };
    const ar = await this.prisma.receivable.findUnique({ where: { id: receivableId }, include: { ledger: true } });
    if (!ar) throw new NotFoundException('应收单不存在');
    const { open } = this.arOpen(ar);
    if (open <= 0.0001) throw new ConflictException('该应收已结清, 无需核销');
    // P1-14: count+1 并发撞号 → P2002; 失败按 seq 顺延重试(≤5 次)
    const bdDay = bizDayStamp();
    let payment: Awaited<ReturnType<typeof this.prisma.payment.create>> | null = null;
    for (let attempt = 0; attempt < 5 && !payment; attempt++) {
      const seq = (await this.prisma.payment.count({ where: { paymentNo: { startsWith: `BD${bdDay}` } } })) + 1 + attempt;
      try {
        payment = await this.prisma.payment.create({
          data: {
            tenantId: user.tenantId,
            paymentNo: `BD${bdDay}-${String(seq).padStart(4, '0')}`,
            customerId: ar.customerId, amount: new Prisma.Decimal(open), kind: 'BAD_DEBT', receivableId,
            method: '坏账核销', note: reason, status: 'CONFIRMED', confirmedAt: new Date(), idemKey,
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!payment) throw new ConflictException('单号生成冲突, 请重试');
    await this.prisma.receivableLedger.create({
      data: { tenantId: user.tenantId, receivableId, paymentId: payment.id, direction: 'WRITEOFF', amount: payment.amount, note: `坏账核销 ${payment.paymentNo}: ${reason}`, createdBy: user.id },
    });
    await this.idem.complete(user, 'receivables.writeOff', idemKey, { r: receivableId, reason }, { paymentNo: payment.paymentNo });
    await this.audit.log({ user, action: AuditAction.BAD_DEBT_WRITEOFF, entityType: 'Receivable', entityId: receivableId, before: { open }, after: { paymentNo: payment.paymentNo, amount: open, reason }, ip });
    return { paymentNo: payment.paymentNo, writtenOff: open };
  }

  // ─────────────── T32: 电子单据软归档(已结满6个月; 客户不可见, 后台可恢复, 禁物理删除 R8) ───────────────
  async archive(user: AuthUser, receivableId: string, ip?: string): Promise<unknown> {
    const ar = await this.prisma.receivable.findUnique({ where: { id: receivableId }, include: { ledger: { orderBy: { createdAt: 'desc' } } } });
    if (!ar) throw new NotFoundException('应收单不存在');
    if (ar.archivedAt) throw new ConflictException('该单据已归档');
    const { open } = this.arOpen(ar);
    if (open > 0.0001) throw new ConflictException('仅已结清单据可归档');
    const lastSettle = ar.ledger.find((l) => l.direction === 'SETTLE');
    if (!lastSettle || lastSettle.createdAt > bizNow().subtract(6, 'month').toDate()) {
      throw new ConflictException('已结单据须满 6 个月方可归档(R8)');
    }
    const updated = await this.prisma.receivable.update({ where: { id: receivableId }, data: { archivedAt: new Date(), archivedById: user.id } });
    await this.audit.log({ user, action: 'DOC_ARCHIVE', entityType: 'Receivable', entityId: receivableId, after: { archivedAt: updated.archivedAt }, ip });
    return { id: receivableId, archivedAt: updated.archivedAt };
  }

  async unarchive(user: AuthUser, receivableId: string, ip?: string): Promise<unknown> {
    const ar = await this.prisma.receivable.findUnique({ where: { id: receivableId } });
    if (!ar) throw new NotFoundException('应收单不存在');
    if (!ar.archivedAt) throw new ConflictException('该单据未归档');
    await this.prisma.receivable.update({ where: { id: receivableId }, data: { archivedAt: null, archivedById: null } });
    await this.audit.log({ user, action: 'DOC_UNARCHIVE', entityType: 'Receivable', entityId: receivableId, before: { archivedAt: ar.archivedAt }, ip });
    return { id: receivableId, restored: true };
  }

  /** T51: 账期提醒——到期前 N 天(cfg remind_days_before 默认7)的未结单据 */
  async reminders(user: AuthUser): Promise<unknown> {
    const n = await this.cfgNumber('remind_days_before', 7);
    // P1-7: 原实现只看第一页 50 条, 排序把未到期单压在尾部被截断, 催收提醒整批漏发
    const items = await this.rows(user, {});
    return items
      .filter((r) => r.bucket === 'not_due' && daysUntil(r.dueDate) >= 0 && daysUntil(r.dueDate) <= n)
      .map((r) => ({ sourceDocNo: r.sourceDocNo, dueDate: r.dueDate, open: r.open, daysLeft: daysUntil(r.dueDate) }));
  }

  /** 收款冲正: 只准红字新单(禁改原收款, B3 同原则) */
  async reversePayment(user: AuthUser, paymentId: string, reason: string, ip?: string): Promise<unknown> {
    if (user.role !== 'OWNER') throw new ForbiddenException('冲正仅老板可执行');
    if (!reason?.trim()) throw new BadRequestException('冲正必须填写原因');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { ledger: true } });
    if (!payment) throw new NotFoundException('收款单不存在');
    assertPaymentTransition(payment.status as PaymentState, 'CANCELLED'); // P0-C: 已冲正/终态 409
    await this.prisma.$transaction(async (tx) => {
      // 条件更新抢占(2026-10 审查修复: 并发冲正双写 REVERSAL)
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, status: payment.status },
        data: { status: 'CANCELLED', note: `${payment.note ?? ''} | 冲正: ${reason}` },
      });
      if (claimed.count === 0) throw new ConflictException('收款单状态已变化(可能已冲正), 请刷新后重试');
      for (const l of payment.ledger.filter((x) => x.direction === 'SETTLE')) {
        await tx.receivableLedger.create({
          data: { tenantId: user.tenantId, receivableId: l.receivableId, paymentId, direction: 'REVERSAL', amount: l.amount, note: `冲正 ${payment.paymentNo}: ${reason}`, createdBy: user.id },
        });
      }
      const affectedOrderNos = new Set(payment.ledger.map((l) => l.receivableId));
      for (const receivableId of affectedOrderNos) {
        const ar = await tx.receivable.findUnique({ where: { id: receivableId }, include: { ledger: true } });
        if (!ar || ar.sourceType !== 'ORDER') continue;
        const order = await tx.salesOrder.findUnique({ where: { tenantId_orderNo: { tenantId: ar.tenantId, orderNo: ar.sourceDocNo } } });
        if (order?.status === 'SETTLED' && this.arOpen(ar).open > 0.0001) {
          await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'SIGNED', settledAt: null } });
        }
      }
    });
    await this.audit.log({ user, action: AuditAction.PAYMENT_REVERSE, entityType: 'Payment', entityId: paymentId, before: { status: payment.status }, after: { status: 'CANCELLED', reason }, ip });
    return { paymentNo: payment.paymentNo, status: 'CANCELLED' };
  }

  async payments(user: AuthUser, q: { status?: string; customerId?: string }): Promise<unknown> {
    return this.prisma.payment.findMany({
      where: {
        status: (q.status as never) ?? undefined,
      customerId: user.role === 'CUSTOMER' ? user.customerId ?? '__unbound_customer__' : q.customerId,
        // P1-9: REP 只看自己上报的收款(原实现横向可见全部业务员的客户姓名/金额/凭证号)
        ...(user.role === 'REP' ? { reportedById: user.id } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { customer: { select: { name: true } } },
    });
  }
}
