import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T09 绩效工资 (D5 冻结口径) ═══════════════
// 三指标权重 回款70/拜访20/新客10(默认, cfg 可调); 回款=当月确认收款×客户归属(D5)
// 退货/拒收: 冲减当期业绩, 不回算历史工资(可复算); 赠品/返利抵扣/争议款/协助单不计基数
// 拜访数: T13 未接入前计 0(字段预留); 归属 owner=客户 salespersonId(变更不回溯)

@Injectable()
export class PerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async cfgNumber(key: string, dflt: number): Promise<number> {
    const row = await this.prisma.systemConfig.findFirst({ where: { key } });
    const v = row ? Number((row.value as { v?: unknown })?.v ?? row.value) : NaN;
    return Number.isFinite(v) ? v : dflt;
  }

  /** 月度绩效明细(按业务员) */
  async monthly(user: AuthUser, month: string): Promise<unknown> {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ConflictException('月份格式 YYYY-MM');
    const start = dayjs(`${month}-01`).startOf('month').toDate();
    const end = dayjs(`${month}-01`).endOf('month').toDate();
    const reps = await this.prisma.user.findMany({ where: { role: 'REP', status: 'ACTIVE' }, select: { id: true, name: true } });
    // 回款: 当月确认 PAYMENT, 按客户归属
    const payments = await this.prisma.payment.findMany({
      where: { status: 'CONFIRMED', kind: 'PAYMENT', confirmedAt: { gte: start, lte: end } },
      select: { customerId: true, amount: true, method: true },
    });
    const customers = await this.prisma.customer.findMany({ select: { id: true, salespersonId: true } });
    const ownerOf = new Map(customers.map((c) => [c.id, c.salespersonId]));
    // 新客: 当月 onboarding→ACTIVE 的归属
    const newCustomers = await this.prisma.customer.findMany({
      where: { onboarding: 'ACTIVE', updatedAt: { gte: start, lte: end } },
      select: { id: true, salespersonId: true },
    });
    // 退货冲减: 当月 RECEIVED 的退货金额按客户归属
    const returns = await this.prisma.returnOrder.findMany({
      where: { status: 'RECEIVED', receivedAt: { gte: start, lte: end } },
      select: { customerId: true, lines: { include: { orderLine: true } } },
    });
    const wPayment = await this.cfgNumber('perf_weight_payment', 0.7);
    const wVisit = await this.cfgNumber('perf_weight_visit', 0.2);
    const wNewCust = await this.cfgNumber('perf_weight_new_customer', 0.1);
    const commissionRate = await this.cfgNumber('perf_commission_rate', 0.01); // 提成比例默认 1% 回款
    const visitTarget = await this.cfgNumber('perf_visit_month_target', 20); // 月拜访目标(T13 接入后生效)
    const newCustUnit = await this.cfgNumber('perf_new_customer_unit', 200); // 新客单价(绩效额)

    const items = reps.map((rep) => {
      let paymentAmount = 0;
      for (const p of payments) if (ownerOf.get(p.customerId) === rep.id) paymentAmount += Number(p.amount);
      let returnDeduction = 0;
      for (const r of returns) {
        if (ownerOf.get(r.customerId) !== rep.id) continue;
        returnDeduction += r.lines.reduce((s, l) => s + Number(l.orderLine?.unitPrice ?? 0) * Number(l.qty), 0);
      }
      const newCustomerCount = newCustomers.filter((c) => c.salespersonId === rep.id).length;
      const visitCount = 0; // T13 拜访管理接入后回填
      const commission = Number((
        paymentAmount * wPayment * commissionRate * 100 // 回款提成
        + visitCount * (wVisit * 1000 / visitTarget) // 拜访达成(占位公式, T13 后按实际)
        + newCustomerCount * newCustUnit * wNewCust * 10
      ).toFixed(2));
      return {
        repId: rep.id, name: rep.name,
        paymentAmount: Number(paymentAmount.toFixed(2)),
        newCustomers: newCustomerCount,
        visitCount, visitTarget,
        returnDeduction: Number(returnDeduction.toFixed(2)),
        commission, weights: { payment: wPayment, visit: wVisit, newCustomer: wNewCust },
      };
    });
    void user;
    return { month, items, generatedAt: new Date().toISOString() };
  }

  /** 一键生成工资表(月唯一; 可复算=DRAFT 可重新生成覆盖) */
  async generatePayroll(user: AuthUser, month: string): Promise<unknown> {
    const perf = (await this.monthly(user, month)) as { items: Array<{ repId: string; name: string; paymentAmount: number; newCustomers: number; visitCount: number; returnDeduction: number; commission: number }> };
    const baseSalary = await this.cfgNumber('perf_base_salary', 3000);
    const items = perf.items.map((i) => ({ ...i, baseSalary, total: Number((baseSalary + i.commission).toFixed(2)) }));
    const totalAmount = Number(items.reduce((s, i) => s + i.total, 0).toFixed(2));
    const existing = await this.prisma.payroll.findUnique({ where: { tenantId_month: { tenantId: user.tenantId, month } } });
    const data = { items: items as never, totalAmount: new Prisma.Decimal(totalAmount), generatedBy: user.id, status: 'DRAFT', confirmedAt: null };
    const payroll = existing
      ? await this.prisma.payroll.update({ where: { id: existing.id }, data })
      : await this.prisma.payroll.create({ data: { tenantId: user.tenantId, month, ...data } });
    await this.audit.log({ user, action: 'PAYROLL_GENERATE', entityType: 'Payroll', entityId: payroll.id, after: { month, reps: items.length, totalAmount } });
    return payroll;
  }

  async payroll(user: AuthUser, month: string): Promise<unknown> {
    const p = await this.prisma.payroll.findUnique({ where: { tenantId_month: { tenantId: user.tenantId, month } } });
    if (!p) throw new NotFoundException(`${month} 工资表未生成`);
    return p;
  }

  async confirmPayroll(user: AuthUser, id: string): Promise<unknown> {
    const p = await this.prisma.payroll.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('工资表不存在');
    if (p.status === 'CONFIRMED') throw new ConflictException('该工资表已确认发放');
    const updated = await this.prisma.payroll.update({ where: { id }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });
    await this.audit.log({ user, action: 'PAYROLL_CONFIRM', entityType: 'Payroll', entityId: id, after: { month: p.month, total: Number(p.totalAmount) } });
    return updated;
  }
}
