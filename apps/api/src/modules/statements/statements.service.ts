import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T10 月结对账 ═══════════════
// 流程: 生成(期间应收/核销汇总) → 推送客户(miniap 可见) → 客户确认 或 异议(差异工作池四类) → 逐条处理 → RESOLVED
// 口径: 当期发生=期间内生成的应收 CHARGE; 当期核销=期间内 SETTLE+REBATE_OFFSET; 期末未结=客户当前 open 合计

@Injectable()
export class StatementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async generate(user: AuthUser, dto: { customerId: string; period: string }): Promise<unknown> {
    if (!/^\d{4}-\d{2}$/.test(dto.period)) throw new BadRequestException('期间格式 YYYY-MM');
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('客户不存在');
    const dup = await this.prisma.statement.findUnique({ where: { tenantId_customerId_period: { tenantId: user.tenantId, customerId: dto.customerId, period: dto.period } } });
    if (dup) throw new ConflictException(`该客户 ${dto.period} 对账单已存在(${dup.statementNo})`);
    const start = dayjs(`${dto.period}-01`).startOf('month').toDate();
    const end = dayjs(`${dto.period}-01`).endOf('month').toDate();
    const ars = await this.prisma.receivable.findMany({
      where: { customerId: dto.customerId, generatedAt: { gte: start, lte: end }, archivedAt: null },
      include: { ledger: true },
      orderBy: { generatedAt: 'asc' },
    });
    const lines: Array<Record<string, unknown>> = [];
    let totalCharged = 0; let totalSettled = 0; let openBalance = 0;
    for (const ar of ars) {
      let charged = 0; let settled = 0; let waived = 0; let writtenOff = 0; let returnCredit = 0; let revNoPay = 0;
      for (const l of ar.ledger) {
        const amt = Number(l.amount);
        const inPeriod = l.createdAt >= start && l.createdAt <= end;
        if (l.direction === 'CHARGE') { charged += amt; if (inPeriod) totalCharged += amt; }
        else if ((l.direction === 'SETTLE' || l.direction === 'REBATE_OFFSET') && inPeriod) { settled += amt; totalSettled += amt; }
        else if (l.direction === 'SETTLE' || l.direction === 'REBATE_OFFSET') settled += amt;
        else if (l.direction === 'WAIVE') waived += amt;
        else if (l.direction === 'WRITEOFF') writtenOff += amt;
        else if (l.direction === 'RETURN_CREDIT') returnCredit += amt;
        else if (l.direction === 'REVERSAL') { if (l.paymentId) settled -= amt; else revNoPay += amt; }
      }
      void charged;
      const open = Math.max(0, Number(ar.total) - settled - waived - writtenOff - returnCredit - revNoPay);
      openBalance += open;
      lines.push({ docNo: ar.sourceDocNo, type: ar.sourceType, total: Number(ar.total), settledInPeriod: Number(ar.ledger.filter((l) => (l.direction === 'SETTLE' || l.direction === 'REBATE_OFFSET') && l.createdAt >= start && l.createdAt <= end).reduce((s, l) => s + Number(l.amount), 0).toFixed(2)), open: Number(open.toFixed(2)), generatedAt: dayjs(ar.generatedAt).format('YYYY-MM-DD'), dueDate: dayjs(ar.dueDate).format('YYYY-MM-DD'), dispute: ar.disputeFlag });
    }
    // P1-14: count+1 并发撞号 → P2002; 失败按 seq 顺延重试(≤5 次)
    const dzPrefix = `DZ${dto.period.replace('-', '')}`;
    let created: Awaited<ReturnType<typeof this.prisma.statement.create>> | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const seq = (await this.prisma.statement.count({ where: { statementNo: { startsWith: dzPrefix } } })) + 1 + attempt;
      try {
        created = await this.prisma.statement.create({
      data: {
        tenantId: user.tenantId,
        statementNo: `${dzPrefix}-${String(seq).padStart(4, '0')}`,
        customerId: dto.customerId, period: dto.period,
        totalCharged: new Prisma.Decimal(totalCharged.toFixed(2)),
        totalSettled: new Prisma.Decimal(totalSettled.toFixed(2)),
        openBalance: new Prisma.Decimal(openBalance.toFixed(2)),
        lines: lines as never, generatedById: user.id, status: 'GENERATED',
      },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!created) throw new ConflictException('单号生成冲突, 请重试');
    await this.audit.log({ user, action: 'STATEMENT_GENERATE', entityType: 'Statement', entityId: created.id, after: { statementNo: created.statementNo, period: dto.period, totalCharged, totalSettled, openBalance, lines: lines.length } });
    return created;
  }

  async send(user: AuthUser, id: string): Promise<unknown> {
    const st = await this.prisma.statement.findUnique({ where: { id } });
    if (!st) throw new NotFoundException('对账单不存在');
    if (st.status !== 'GENERATED') throw new ConflictException(`仅已生成可推送(当前 ${st.status})`);
    const updated = await this.prisma.statement.update({ where: { id }, data: { status: 'SENT', sentAt: new Date() } });
    await this.audit.log({ user, action: 'STATEMENT_SEND', entityType: 'Statement', entityId: id });
    return updated;
  }

  /** 客户确认(客户 token 或内勤代确认) */
  async confirm(user: AuthUser, id: string): Promise<unknown> {
    const st = await this.prisma.statement.findUnique({ where: { id } });
    if (!st) throw new NotFoundException('对账单不存在');
    if (user.role === 'CUSTOMER' && st.customerId !== user.customerId) throw new ForbiddenException('无权操作该对账单');
    if (st.status !== 'SENT') throw new ConflictException(`仅已推送可确认(当前 ${st.status})`);
    const updated = await this.prisma.statement.update({ where: { id }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });
    await this.audit.log({ user, action: 'STATEMENT_CONFIRM', entityType: 'Statement', entityId: id });
    return updated;
  }

  /** 客户异议: 差异四类进工作池 */
  async dispute(user: AuthUser, id: string, items: Array<{ type: 'MISSING_ORDER' | 'PRICE' | 'GIFT' | 'RETURN'; content: string }>): Promise<unknown> {
    if (!items?.length) throw new BadRequestException('至少一条差异项');
    if (items.some((i) => !i.content?.trim())) throw new BadRequestException('差异描述必填');
    const st = await this.prisma.statement.findUnique({ where: { id } });
    if (!st) throw new NotFoundException('对账单不存在');
    if (user.role === 'CUSTOMER' && st.customerId !== user.customerId) throw new ForbiddenException('无权操作该对账单');
    if (st.status !== 'SENT') throw new ConflictException(`仅已推送可提异议(当前 ${st.status})`);
    await this.prisma.$transaction(async (tx) => {
      await tx.disputeItem.createMany({ data: items.map((i) => ({ tenantId: user.tenantId, statementId: id, type: i.type, content: i.content })) });
      await tx.statement.update({ where: { id }, data: { status: 'DISPUTED' } });
    });
    await this.audit.log({ user, action: 'STATEMENT_DISPUTE', entityType: 'Statement', entityId: id, after: { items: items.length } });
    return { id, status: 'DISPUTED', items: items.length };
  }

  async resolveDispute(user: AuthUser, disputeId: string, resolution: string): Promise<unknown> {
    if (!resolution?.trim()) throw new BadRequestException('处理结论必填');
    const d = await this.prisma.disputeItem.findUnique({ where: { id: disputeId }, include: { statement: true } });
    if (!d) throw new NotFoundException('差异项不存在');
    if (d.status === 'RESOLVED') throw new ConflictException('该差异已处理');
    await this.prisma.$transaction(async (tx) => {
      await tx.disputeItem.update({ where: { id: disputeId }, data: { status: 'RESOLVED', resolution, resolvedBy: user.id, resolvedAt: new Date() } });
      const open = await tx.disputeItem.count({ where: { statementId: d.statementId, status: 'OPEN' } });
      if (open === 0) {
        await tx.statement.update({ where: { id: d.statementId }, data: { status: 'RESOLVED' } });
      }
    });
    await this.audit.log({ user, action: 'DISPUTE_RESOLVE', entityType: 'DisputeItem', entityId: disputeId, after: { resolution } });
    return { id: disputeId, status: 'RESOLVED' };
  }

  async list(user: AuthUser, q: { status?: string; customerId?: string; period?: string }): Promise<unknown> {
    const where = {
      status: q.status as never,
      customerId: user.role === 'CUSTOMER' ? user.customerId : q.customerId,
      period: q.period,
    };
    return this.prisma.statement.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100, include: { customer: { select: { code: true, name: true } } } });
  }

  async detail(user: AuthUser, id: string): Promise<unknown> {
    const st = await this.prisma.statement.findUnique({ where: { id }, include: { disputes: true, customer: { select: { code: true, name: true } } } });
    if (!st) throw new NotFoundException('对账单不存在');
    if (user.role === 'CUSTOMER' && st.customerId !== user.customerId) throw new ForbiddenException('无权查看该对账单');
    return st;
  }
}
