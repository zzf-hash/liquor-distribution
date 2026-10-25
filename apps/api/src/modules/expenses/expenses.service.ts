import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { bizDayStamp, bizMonthKey, bizMonthRange } from '../../common/business-time';
import { AuditService } from '../../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { arOpenOf } from '../receivables/aging';
import { centsToDecimal, toCents } from '../../common/money';
import { isUniqueViolation } from '../../common/prisma-error';
import type { AuthUser } from '../../common/current-user.decorator';

type ExpenseWriter = Pick<PrismaService, 'expense' | 'approvalRecord'>;

// ═══════════════ B组 费用域: 统一费用台账(M4-3 办公费用 / M10-3 运营费用 / M3-5 陈列进店费) ═══════════════
// 流程: 创建(PENDING_APPROVAL) → EXPENSE 审批线(D01 金额路由: ≤阈值出纳可批, >阈值老板)
//       → 付款 PAID(现金/转账) 或 冲抵货款(AR_OFFSET → FEE_OFFSET 应收流水 FIFO, M9-7)
// 口径: FEE_OFFSET 核减客户未结但不计入回款(与 REBATE_OFFSET 区别在对账单"当期核销"列不进)

/** 客户级费用科目(必须关联客户, 可冲抵货款) */
const CUSTOMER_CATEGORIES = new Set(['DISPLAY', 'ENTRY', 'CAP_FEE', 'REBATE']);

export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  OFFICE: '办公费用',
  FUEL_TOLL: '油费路桥',
  REPAIR: '车辆维修',
  HANDLING: '装卸',
  UTILITY: '水电',
  DISPLAY: '陈列费',
  ENTRY: '进店费',
  CAP_FEE: '开瓶费',
  REBATE: '返利现金',
  OTHER: '其他',
};

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  async create(user: AuthUser, dto: {
    category: 'OFFICE' | 'FUEL_TOLL' | 'REPAIR' | 'HANDLING' | 'UTILITY' | 'DISPLAY' | 'ENTRY' | 'CAP_FEE' | 'REBATE' | 'OTHER';
    title: string; amount: number; customerId?: string; payee?: string;
    occurredAt?: string; payMode?: 'CASH' | 'AR_OFFSET'; note?: string; voucherUrl?: string; source?: string;
  }): Promise<unknown> {
    if (!(dto.amount > 0)) throw new BadRequestException('费用金额必须大于 0');
    if (!dto.title?.trim()) throw new BadRequestException('费用事由必填');
    if (CUSTOMER_CATEGORIES.has(dto.category) && !dto.customerId) {
      throw new BadRequestException(`${EXPENSE_CATEGORY_LABELS[dto.category]}为客户级费用, 必须关联客户`);
    }
    // 系统链路科目不接受手工直建(留痕唯一来源): 开瓶费=回收确认, 返利现金=月末核算
    if (dto.category === 'CAP_FEE' && !(dto.source ?? '').startsWith('CAP_RECYCLE:')) {
      throw new BadRequestException('开瓶费费用单由瓶盖回收确认自动生成, 不可手工创建');
    }
    if (dto.category === 'REBATE' && !(dto.source ?? '').startsWith('REBATE_SETTLE:')) {
      throw new BadRequestException('返利现金费用单由月末核算(CASH 形式)自动生成, 不可手工创建');
    }
    if (dto.payMode === 'AR_OFFSET' && !dto.customerId) throw new BadRequestException('冲抵货款必须关联客户');
    let customer: { id: string; name: string } | null = null;
    if (dto.customerId) {
      customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId }, select: { id: true, name: true } });
      if (!customer) throw new NotFoundException('客户不存在');
    }
    // P1-14 同款: count+1 撞号顺延重试
    const fyDay = bizDayStamp();
    let expense: Awaited<ReturnType<typeof this.prisma.expense.create>> | null = null;
    for (let attempt = 0; attempt < 5 && !expense; attempt++) {
      const seq = (await this.prisma.expense.count({ where: { tenantId: user.tenantId, expenseNo: { startsWith: `FY${fyDay}` } } })) + 1 + attempt;
      try {
        expense = await this.prisma.expense.create({
          data: {
            tenantId: user.tenantId,
            expenseNo: `FY${fyDay}-${String(seq).padStart(4, '0')}`,
            category: dto.category, title: dto.title.trim(), amount: new Prisma.Decimal(dto.amount),
            customerId: dto.customerId ?? null, payee: dto.payee,
            occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
            payMode: dto.payMode ?? 'CASH', status: 'PENDING_APPROVAL',
            voucherUrl: dto.voucherUrl, note: dto.note, source: dto.source ?? 'MANUAL',
            createdById: user.id,
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!expense) throw new ConflictException('单号生成冲突, 请重试');
    // 进 EXPENSE 审批线(M4-3: 出纳审批; D01 金额路由 >阈值 转老板)
    const approval = await this.approvals.create(user, {
      line: 'EXPENSE', entityType: 'EXPENSE', entityId: expense.id,
      title: `费用单 ${expense.expenseNo} ${EXPENSE_CATEGORY_LABELS[dto.category]}·${dto.title.trim()}`,
      amount: dto.amount, reason: dto.note?.trim() || dto.title.trim(),
      payload: { expenseNo: expense.expenseNo, category: dto.category, payMode: expense.payMode, customerName: customer?.name },
    });
    const updated = await this.prisma.expense.update({ where: { id: expense.id, tenantId: user.tenantId }, data: { approvalId: approval.id } });
    await this.audit.log({ user, action: 'EXPENSE_CREATE', entityType: 'Expense', entityId: expense.id, after: { expenseNo: expense.expenseNo, category: dto.category, amount: dto.amount, payMode: expense.payMode, customerId: dto.customerId, approvalId: approval.id } });
    return updated;
  }

  /** 系统直入 APPROVED(开瓶费月度自动计提: "系统自动扣减"不走人工审批, 但付款/冲抵仍由出纳执行)
   *  db 传入事务客户端时与计提锁同事务。source 唯一冲突不改单号重试（那是另一张单，不是撞号）。 */
  async createSystemApproved(user: AuthUser, dto: {
    category: 'CAP_FEE' | 'DISPLAY' | 'ENTRY'; title: string; amount: number; customerId: string;
    payMode: 'CASH' | 'AR_OFFSET'; occurredAt?: Date; note?: string; source: string;
  }, db: ExpenseWriter = this.prisma): Promise<{ id: string; expenseNo: string }> {
    const fyDay = bizDayStamp();
    let expense: { id: string; expenseNo: string } | null = null;
    for (let attempt = 0; attempt < 5 && !expense; attempt++) {
      const seq = (await db.expense.count({ where: { tenantId: user.tenantId, expenseNo: { startsWith: `FY${fyDay}` } } })) + 1 + attempt;
      try {
        expense = await db.expense.create({
          data: {
            tenantId: user.tenantId,
            expenseNo: `FY${fyDay}-${String(seq).padStart(4, '0')}`,
            category: dto.category, title: dto.title, amount: centsToDecimal(toCents(dto.amount)),
            customerId: dto.customerId, payMode: dto.payMode, status: 'APPROVED',
            occurredAt: dto.occurredAt ?? new Date(), note: dto.note, source: dto.source,
            createdById: user.id,
          },
        });
      } catch (e) {
        if (isUniqueViolation(e, 'source') || isUniqueViolation(e, 'cap_source')) throw e;
        if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!expense) throw new ConflictException('单号生成冲突, 请重试');
    return { id: expense.id, expenseNo: expense.expenseNo };
  }

  /** 瓶盖回收确认：在调用方事务里先占状态、再写费用单和审批（LQ1-008）。通知在提交后另发。 */
  async createLinkedInTx(tx: ExpenseWriter, user: AuthUser, dto: {
    category: 'CAP_FEE'; title: string; amount: Prisma.Decimal | number; customerId: string;
    payMode: 'CASH' | 'AR_OFFSET'; note?: string; source: string;
    customerName?: string;
  }): Promise<{ id: string; expenseNo: string; approvalId: string }> {
    const fyDay = bizDayStamp();
    const amount = dto.amount instanceof Prisma.Decimal ? dto.amount : centsToDecimal(toCents(dto.amount));
    let expense: { id: string; expenseNo: string; payMode: string } | null = null;
    for (let attempt = 0; attempt < 5 && !expense; attempt++) {
      const seq = (await tx.expense.count({ where: { tenantId: user.tenantId, expenseNo: { startsWith: `FY${fyDay}` } } })) + 1 + attempt;
      try {
        expense = await tx.expense.create({
          data: {
            tenantId: user.tenantId,
            expenseNo: `FY${fyDay}-${String(seq).padStart(4, '0')}`,
            category: dto.category, title: dto.title, amount,
            customerId: dto.customerId, payMode: dto.payMode, status: 'PENDING_APPROVAL',
            occurredAt: new Date(), note: dto.note, source: dto.source, createdById: user.id,
          },
        });
      } catch (e) {
        if (isUniqueViolation(e, 'source') || isUniqueViolation(e, 'cap_source')) {
          throw new ConflictException('该回收单已生成费用单');
        }
        if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!expense) throw new ConflictException('单号生成冲突, 请重试');
    const approval = await tx.approvalRecord.create({
      data: {
        tenantId: user.tenantId, line: 'EXPENSE', entityType: 'EXPENSE', entityId: expense.id,
        title: `费用单 ${expense.expenseNo} ${EXPENSE_CATEGORY_LABELS[dto.category]}·${dto.title}`,
        amount, reason: dto.note?.trim() || dto.title,
        payload: { expenseNo: expense.expenseNo, category: dto.category, payMode: expense.payMode, customerName: dto.customerName } as never,
        applicantId: user.id, status: 'PENDING',
      },
    });
    await tx.expense.update({ where: { id: expense.id }, data: { approvalId: approval.id } });
    return { id: expense.id, expenseNo: expense.expenseNo, approvalId: approval.id };
  }

  async announceLinked(user: AuthUser, input: { title: string; amount: number; expenseId: string; expenseNo: string; category: string; payMode: string; customerId: string; approvalId: string }): Promise<void> {
    await this.audit.log({ user, action: 'EXPENSE_CREATE', entityType: 'Expense', entityId: input.expenseId, after: { expenseNo: input.expenseNo, category: input.category, amount: input.amount, payMode: input.payMode, customerId: input.customerId, approvalId: input.approvalId } });
    await this.approvals.announcePending(user, { title: input.title, amount: input.amount, line: 'EXPENSE' });
  }

  async list(user: AuthUser, q: { category?: string; status?: string; customerId?: string; month?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 20));
    let occurredAt: Prisma.DateTimeFilter | undefined;
    if (q.month && /^\d{4}-\d{2}$/.test(q.month)) {
      const range = bizMonthRange(q.month);
      occurredAt = { gte: range.start, lte: range.end };
    }
    const where: Prisma.ExpenseWhereInput = {
      tenantId: user.tenantId,
      category: q.category as never, status: q.status as never, customerId: q.customerId, occurredAt,
    };
    const [items, total, sumAgg] = await this.prisma.$transaction([
      this.prisma.expense.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { customer: { select: { code: true, name: true } } },
      }),
      this.prisma.expense.count({ where }),
      this.prisma.expense.aggregate({ where: { ...where, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PAID'] } }, _sum: { amount: true } }),
    ]);
    return {
      items: items.map((e) => ({
        id: e.id, expenseNo: e.expenseNo, category: e.category, categoryLabel: EXPENSE_CATEGORY_LABELS[e.category] ?? e.category,
        title: e.title, amount: Number(e.amount), customer: e.customer ? { code: e.customer.code, name: e.customer.name } : null,
        payee: e.payee, occurredAt: e.occurredAt, payMode: e.payMode, status: e.status,
        approvalId: e.approvalId, voucherUrl: e.voucherUrl ? '已上传' : null,
        paidAt: e.paidAt, paidNote: e.paidNote, note: e.note, source: e.source, createdAt: e.createdAt,
      })),
      total, amountSum: Number(sumAgg._sum.amount ?? 0), page, pageSize,
    };
  }

  /** M10-3 费用台账汇总: 按科目×月份 */
  async summary(user: AuthUser, monthInput?: string): Promise<unknown> {
    const month = monthInput && /^\d{4}-\d{2}$/.test(monthInput) ? monthInput : bizMonthKey();
    const { start, end } = bizMonthRange(month);
    const groups = await this.prisma.expense.groupBy({
      by: ['category', 'status', 'payMode'],
      where: { tenantId: user.tenantId, occurredAt: { gte: start, lte: end }, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PAID'] } },
      _sum: { amount: true },
    });
    const byCategory: Record<string, number> = {};
    let paidTotal = 0; let pendingTotal = 0; let offsetTotal = 0;
    for (const g of groups) {
      const amt = Number(g._sum.amount ?? 0);
      byCategory[g.category] = (byCategory[g.category] ?? 0) + amt;
      if (g.status === 'PAID') { paidTotal += amt; if (g.payMode === 'AR_OFFSET') offsetTotal += amt; }
      else pendingTotal += amt;
    }
    return { month, byCategory, categoryLabels: EXPENSE_CATEGORY_LABELS, paidTotal, pendingTotal, offsetTotal, total: paidTotal + pendingTotal };
  }

  async detail(user: AuthUser, id: string): Promise<unknown> {
    const e = await this.prisma.expense.findUnique({ where: { id, tenantId: user.tenantId }, include: { customer: { select: { code: true, name: true } } } });
    if (!e) throw new NotFoundException('费用单不存在');
    return e;
  }

  /** 付款/冲抵: APPROVED → PAID。AR_OFFSET 按 FIFO 写 FEE_OFFSET 流水(最早到期优先, 与销账同序) */
  async pay(user: AuthUser, id: string, dto: { voucherUrl?: string; note?: string }, ip?: string): Promise<unknown> {
    if (user.role !== 'CLERK' && user.role !== 'OWNER') throw new ForbiddenException('仅内勤出纳/老板可执行付款');
    const expense = await this.prisma.expense.findUnique({ where: { id, tenantId: user.tenantId } });
    if (!expense) throw new NotFoundException('费用单不存在');
    if (expense.status !== 'APPROVED') throw new ConflictException(`仅已批费用可付款(当前 ${expense.status})`);
    const amount = Number(expense.amount);

    if (expense.payMode === 'CASH') {
      const claimed = await this.prisma.expense.updateMany({
        where: { id, tenantId: user.tenantId, status: 'APPROVED' },
        data: { status: 'PAID', paidAt: new Date(), paidById: user.id, voucherUrl: dto.voucherUrl ?? expense.voucherUrl, paidNote: dto.note },
      });
      if (claimed.count === 0) throw new ConflictException('费用单状态已变化, 请刷新后重试');
      await this.audit.log({ user, action: 'EXPENSE_PAY', entityType: 'Expense', entityId: id, before: { status: 'APPROVED' }, after: { expenseNo: expense.expenseNo, amount, mode: 'CASH' }, ip });
      return { expenseNo: expense.expenseNo, status: 'PAID', mode: 'CASH', amount };
    }

    // AR_OFFSET: 冲抵货款(FEE_OFFSET FIFO, 与 settleFifo 同串行化口径)
    let applied: Array<{ receivableId: string; sourceDocNo: string; amount: number }> = [];
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.expense.updateMany({ where: { id, tenantId: user.tenantId, status: 'APPROVED' }, data: { status: 'PAID', paidAt: new Date(), paidById: user.id, paidNote: dto.note } });
      if (claimed.count === 0) throw new ConflictException('费用单状态已变化, 请刷新后重试');
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "Receivable" WHERE "tenantId" = ${expense.tenantId} AND "customerId" = ${expense.customerId} AND "disputeFlag" = false ORDER BY id FOR UPDATE`);
      const ars = await tx.receivable.findMany({
        where: { customerId: expense.customerId!, disputeFlag: false },
        include: { ledger: true },
        orderBy: [{ dueDate: 'asc' }, { generatedAt: 'asc' }],
      });
      let remain = amount;
      applied = [];
      for (const ar of ars) {
        if (remain <= 0.0001) break;
        const { open } = arOpenOf(Number(ar.total), ar.ledger);
        if (open <= 0.0001) continue;
        const take = Math.min(open, remain);
        remain -= take;
        await tx.receivableLedger.create({
          data: {
            tenantId: user.tenantId, receivableId: ar.id, direction: 'FEE_OFFSET', amount: new Prisma.Decimal(take.toFixed(2)),
            note: `费用冲抵 ${expense.expenseNo}: ${expense.title}`, createdBy: user.id,
          },
        });
        applied.push({ receivableId: ar.id, sourceDocNo: ar.sourceDocNo, amount: Number(take.toFixed(2)) });
      }
      if (remain > 0.0001) throw new ConflictException(`客户未结余额不足冲抵 ¥${(amount - remain).toFixed(2)}(差 ¥${remain.toFixed(2)}), 请改现金支付或先收款`);
    });
    await this.audit.log({ user, action: 'EXPENSE_OFFSET', entityType: 'Expense', entityId: id, before: { status: 'APPROVED' }, after: { expenseNo: expense.expenseNo, amount, applied }, ip });
    return { expenseNo: expense.expenseNo, status: 'PAID', mode: 'AR_OFFSET', amount, applied };
  }

  /** 取消(仅待审批): 审批单由实体状态闸拦截决策(409), 24h 过期自然退回 */
  async cancel(user: AuthUser, id: string, reason: string, ip?: string): Promise<unknown> {
    if (user.role !== 'CLERK' && user.role !== 'OWNER') throw new ForbiddenException('仅内勤出纳/老板可取消');
    if (!reason?.trim()) throw new BadRequestException('取消原因必填');
    const existing = await this.prisma.expense.findUnique({ where: { id, tenantId: user.tenantId }, select: { id: true } });
    if (!existing) throw new NotFoundException('费用单不存在');
    const claimed = await this.prisma.expense.updateMany({ where: { id, tenantId: user.tenantId, status: 'PENDING_APPROVAL' }, data: { status: 'CANCELLED', note: reason } });
    if (claimed.count === 0) throw new ConflictException('仅待审批费用可取消');
    await this.audit.log({ user, action: 'EXPENSE_CANCEL', entityType: 'Expense', entityId: id, after: { reason }, ip });
    return { id, status: 'CANCELLED' };
  }
}
