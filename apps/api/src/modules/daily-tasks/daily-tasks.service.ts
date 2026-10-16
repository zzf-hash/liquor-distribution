import { ConflictException, Injectable, Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { NotifyService } from '../../common/notify.service';
import { StatementsService } from '../statements/statements.service';
import { readAgingConfig, agingBucketLabels, arOpenOf } from '../receivables/aging';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ 每日自动化任务(M9-2/M9-5/M9-8 的"主动触达"补齐) ═══════════════
// 此前到期提醒是拉取式接口、对账单靠手动逐客户生成、归档 API 无人触发。
// 本服务复用库存日切(StockAlertDailyTask)的零依赖定时框架, 三个任务:
//   ① 到期提醒: 每日扫描未结应收 → 到期前 N 天(remind_days_before 可配) + 逾期分档摘要 → 飞书推送
//   ② 月结对账单: 每月 1 日自动生成上月对账单并推送(客户小程序可确认/提异议), 已存在则跳过
//   ③ 自动归档: 已结满 6 个月的应收单软归档(R8, 客户侧不可见/后台可恢复)
// 手动触发端点(演示/补跑): POST /daily-tasks/{reminders|statements|archive}/run

@Injectable()
export class DailyTasksService {
  private readonly logger = new Logger('DailyTasks');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly statements: StatementsService,
  ) {}

  private async cfgNumber(tenantId: string, key: string, dflt: number): Promise<number> {
    const row = await this.prisma.systemConfig.findFirst({ where: { tenantId, key } });
    const v = row ? Number((row.value as { v?: unknown })?.v ?? row.value) : NaN;
    return Number.isFinite(v) ? v : dflt;
  }

  /** ① 到期提醒(M9-2): 到期前 N 天未结单 + 逾期分档摘要 → 推送 */
  async runDueReminders(actor: AuthUser): Promise<{ dueSoonCount: number; dueSoonAmount: number; overdue: Record<string, number>; notified: boolean }> {
    const tenantId = actor.tenantId;
    const n = await this.cfgNumber(tenantId, 'remind_days_before', 7);
    const aging = await readAgingConfig(this.prisma, tenantId);
    const labels = agingBucketLabels(aging);
    const ars = await this.prisma.receivable.findMany({
      where: { archivedAt: null, disputeFlag: false },
      include: { customer: { select: { name: true } }, ledger: true },
      orderBy: [{ dueDate: 'asc' }],
    });
    const dueSoon: Array<{ docNo: string; customer: string; open: number; dueDate: string; daysLeft: number }> = [];
    const overdue: Record<string, number> = { b1: 0, b2: 0, b3: 0, b4: 0 };
    let overdueTotal = 0;
    for (const ar of ars) {
      const { open } = arOpenOf(Number(ar.total), ar.ledger);
      if (open <= 0.0001) continue;
      const days = dayjs().startOf('day').diff(dayjs(ar.dueDate).startOf('day'), 'day');
      if (days > 0) {
        const b = days <= aging.b1 ? 'b1' : days <= aging.b2 ? 'b2' : days <= aging.b3 ? 'b3' : 'b4';
        overdue[b] += open;
        overdueTotal += open;
      } else if (dayjs(ar.dueDate).isBefore(dayjs().add(n, 'day').endOf('day'))) {
        dueSoon.push({ docNo: ar.sourceDocNo, customer: ar.customer.name, open, dueDate: dayjs(ar.dueDate).format('YYYY-MM-DD'), daysLeft: -days });
      }
    }
    const dueSoonAmount = dueSoon.reduce((s, r) => s + r.open, 0);
    let notified = false;
    if (dueSoon.length > 0 || overdueTotal > 0) {
      const lines = [`到期前 ${n} 天待收: ${dueSoon.length} 单 ¥${dueSoonAmount.toFixed(2)}`];
      for (const b of ['b1', 'b2', 'b3', 'b4'] as const) {
        if (overdue[b] > 0) lines.push(`${labels[b]}: ¥${overdue[b].toFixed(2)}`);
      }
      for (const r of dueSoon.slice(0, 8)) lines.push(`· ${r.docNo} ${r.customer} ¥${r.open.toFixed(2)} (${r.daysLeft === 0 ? '今天' : `${r.daysLeft}天后`}到期)`);
      if (dueSoon.length > 8) lines.push(`…等共 ${dueSoon.length} 单`);
      try { await this.notify.send('应收到期提醒(每日)', lines); notified = true; } catch { /* 推送失败不阻断, 次日重推 */ }
    }
    await this.audit.log({
      user: actor, action: 'AR_REMINDER_RUN', entityType: 'Receivable', entityId: dayjs().format('YYYY-MM-DD'),
      after: { dueSoon: dueSoon.length, dueSoonAmount, overdue, overdueTotal, notified },
    });
    return { dueSoonCount: dueSoon.length, dueSoonAmount, overdue, notified };
  }

  /** ② 月结对账单自动生成(M9-5): 上月有应收活动的客户 逐个 generate→send; 已存在跳过(幂等) */
  async runMonthlyStatements(actor: AuthUser, periodInput?: string): Promise<{ period: string; generated: number; sent: number; skipped: number; errors: number }> {
    const period = periodInput && /^\d{4}-\d{2}$/.test(periodInput)
      ? periodInput
      : dayjs().subtract(1, 'month').format('YYYY-MM'); // 默认上月
    const start = dayjs(`${period}-01`).startOf('month').toDate();
    const end = dayjs(`${period}-01`).endOf('month').toDate();
    // 活动客户 = 期间内生成过应收 或 期间内核销过(旧单当期收款也要对账, 与 P1-11 口径一致)
    const ars = await this.prisma.receivable.findMany({
      where: { archivedAt: null, OR: [{ generatedAt: { gte: start, lte: end } }, { ledger: { some: { createdAt: { gte: start, lte: end } } } }] },
      select: { customerId: true },
    });
    const customerIds = [...new Set(ars.map((a) => a.customerId))];
    let generated = 0; let sent = 0; let skipped = 0; let errors = 0;
    for (const customerId of customerIds) {
      try {
        const st = (await this.statements.generate(actor, { customerId, period })) as { id: string };
        generated += 1;
        try {
          await this.statements.send(actor, st.id);
          sent += 1;
        } catch { /* 发送失败留 GENERATED, 后台可手动再推 */ }
      } catch (e) {
        if (e instanceof ConflictException) { skipped += 1; continue; } // 已存在, 幂等跳过
        errors += 1;
        this.logger.warn(`statement ${period} customer ${customerId} failed: ${String(e).slice(0, 200)}`);
      }
    }
    await this.audit.log({
      user: actor, action: 'STATEMENT_AUTOGEN_RUN', entityType: 'Statement', entityId: period,
      after: { period, customers: customerIds.length, generated, sent, skipped, errors },
    });
    if (generated > 0) {
      try {
        await this.notify.send(`月结对账单已自动生成 ${period}`, [
          `覆盖客户: ${customerIds.length} 家`,
          `新生成: ${generated} 张, 已推送客户: ${sent} 张, 已存在跳过: ${skipped} 张`,
        ]);
      } catch { /* 推送失败不阻断 */ }
    }
    return { period, generated, sent, skipped, errors };
  }

  /** ③ 自动归档(M9-8/R8): 已结满 6 个月 → archivedAt(软归档, 客户不可见, 后台可恢复) */
  async runAutoArchive(actor: AuthUser): Promise<{ archived: number; candidates: number }> {
    const cutoff = dayjs().subtract(6, 'month').toDate();
    const ars = await this.prisma.receivable.findMany({
      where: { archivedAt: null },
      include: { ledger: { orderBy: { createdAt: 'desc' } } },
    });
    let archived = 0; let candidates = 0;
    for (const ar of ars) {
      const { open } = arOpenOf(Number(ar.total), ar.ledger);
      if (open > 0.0001) continue;
      const lastClose = ar.ledger.find((l) => ['SETTLE', 'REBATE_OFFSET', 'WAIVE', 'WRITEOFF', 'RETURN_CREDIT'].includes(l.direction));
      if (!lastClose || lastClose.createdAt > cutoff) continue;
      candidates += 1;
      await this.prisma.receivable.update({ where: { id: ar.id }, data: { archivedAt: new Date(), archivedById: actor.id } });
      await this.audit.log({ user: actor, action: 'DOC_ARCHIVE', entityType: 'Receivable', entityId: ar.id, after: { archivedAt: new Date().toISOString(), sourceDocNo: ar.sourceDocNo, auto: true } });
      archived += 1;
    }
    if (archived > 0) {
      await this.audit.log({ user: actor, action: 'AR_AUTO_ARCHIVE_RUN', entityType: 'Receivable', entityId: dayjs().format('YYYY-MM-DD'), after: { archived, candidates } });
    }
    return { archived, candidates };
  }
}
