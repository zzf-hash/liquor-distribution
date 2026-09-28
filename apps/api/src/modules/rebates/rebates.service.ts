import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T08 优惠三式 (D02 冻结口径) ═══════════════
// b(除瓶箱后5%-50%月末核算) 与 c(定扣) 互斥——同客户同期仅一种生效
// c/票折 = REBATE_OFFSET 流水直接冲应收; 货补 = 登记后走随单赠下单(不反改原单)
// 基数口径: 当月确认回款 − 当月瓶箱押金支出(近似除瓶箱)

@Injectable()
export class RebatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 建方案(D02 互斥硬校验: 同客户存在生效中方案→409) */
  async createScheme(user: AuthUser, dto: { customerId: string; type: 'B' | 'C'; rate: number; note?: string; validTo?: string }): Promise<unknown> {
    const rate = Number(dto.rate);
    if (!(rate >= 0.05 && rate <= 0.5)) throw new BadRequestException('费率须在 5%-50% 之间(D02)');
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('客户不存在');
    const active = await this.prisma.rebateScheme.findFirst({
      where: { customerId: dto.customerId, closedAt: null, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
    });
    if (active) {
      throw new ConflictException(`该客户已有生效中 ${active.type} 方案(${dayjs(active.validFrom).format('YYYY-MM-DD')}起), b/c 互斥(D02); 请先关闭`);
    }
    const created = await this.prisma.rebateScheme.create({
      data: {
        tenantId: user.tenantId, customerId: dto.customerId, type: dto.type,
        rate: new Prisma.Decimal(rate), note: dto.note,
        validTo: dto.validTo ? new Date(dto.validTo) : undefined, createdById: user.id,
      },
    });
    await this.audit.log({ user, action: 'REBATE_SCHEME_CREATE', entityType: 'RebateScheme', entityId: created.id, after: { customer: customer.name, type: dto.type, rate } });
    return created;
  }

  async closeScheme(user: AuthUser, id: string): Promise<unknown> {
    const s = await this.prisma.rebateScheme.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('方案不存在');
    if (s.closedAt) throw new ConflictException('方案已关闭');
    await this.prisma.rebateScheme.update({ where: { id }, data: { closedAt: new Date() } });
    await this.audit.log({ user, action: 'REBATE_SCHEME_CLOSE', entityType: 'RebateScheme', entityId: id });
    return { id, closed: true };
  }

  async schemes(q: { customerId?: string }): Promise<unknown> {
    return this.prisma.rebateScheme.findMany({
      where: { customerId: q.customerId },
      orderBy: { createdAt: 'desc' },
      include: { customer: { select: { code: true, name: true } } },
    });
  }

  /** 月末核算预览: 基数=当月确认回款−当月瓶箱押金支出; 返利=基数×费率 */
  async preview(user: AuthUser, customerId: string, period: string): Promise<unknown> {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException('期间格式 YYYY-MM');
    const scheme = await this.prisma.rebateScheme.findFirst({
      where: { customerId, closedAt: null, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
    });
    if (!scheme) throw new ConflictException('该客户无生效中返利方案');
    const start = dayjs(`${period}-01`).startOf('month').toDate();
    const end = dayjs(`${period}-01`).endOf('month').toDate();
    const payAgg = await this.prisma.payment.aggregate({
      where: { customerId, status: 'CONFIRMED', kind: 'PAYMENT', confirmedAt: { gte: start, lte: end } },
      _sum: { amount: true },
    });
    const pkgAgg = await this.prisma.packageRecord.aggregate({
      where: { customerId, type: 'OUT', createdAt: { gte: start, lte: end } },
      _sum: { depositPaid: true },
    });
    const payments = Number(payAgg._sum.amount ?? 0);
    const bottles = Math.abs(Number(pkgAgg._sum.depositPaid ?? 0));
    const baseAmount = Number(Math.max(0, payments - bottles).toFixed(2));
    const rebateAmount = Number((baseAmount * Number(scheme.rate)).toFixed(2));
    void user;
    return { customerId, period, schemeType: scheme.type, rate: Number(scheme.rate), payments, bottlesDeposit: bottles, baseAmount, rebateAmount };
  }

  /** 确认核算: 票折=REBATE_OFFSET 流水冲应收(FIFO 未结单); 货补=登记+走随单赠 */
  async settle(user: AuthUser, dto: { customerId: string; period: string; settleType: 'GOODS' | 'INVOICE'; note?: string }): Promise<unknown> {
    if (!/^\d{4}-\d{2}$/.test(dto.period)) throw new BadRequestException('期间格式 YYYY-MM');
    const dup = await this.prisma.rebateSettlement.findUnique({ where: { tenantId_customerId_period: { tenantId: user.tenantId, customerId: dto.customerId, period: dto.period } } });
    if (dup) throw new ConflictException(`该客户 ${dto.period} 已核算(唯一)`);
    const preview = await this.preview(user, dto.customerId, dto.period) as { schemeType: string; rate: number; baseAmount: number; rebateAmount: number };
    const scheme = (await this.prisma.rebateScheme.findFirst({ where: { customerId: dto.customerId, closedAt: null } }))!;
    const created = await this.prisma.rebateSettlement.create({
      data: {
        tenantId: user.tenantId, customerId: dto.customerId, schemeId: scheme.id, period: dto.period,
        baseAmount: new Prisma.Decimal(preview.baseAmount), rebateAmount: new Prisma.Decimal(preview.rebateAmount),
        settleType: dto.settleType, note: dto.note, createdById: user.id,
      },
    });
    if (dto.settleType === 'INVOICE' && preview.rebateAmount > 0) {
      // 票折: FIFO 冲未结应收(与收款核销同序, D4)
      const ars = await this.prisma.receivable.findMany({
        where: { customerId: dto.customerId, disputeFlag: false, archivedAt: null },
        include: { ledger: true },
        orderBy: [{ dueDate: 'asc' }, { generatedAt: 'asc' }],
      });
      let remain = preview.rebateAmount;
      for (const ar of ars) {
        if (remain <= 0.0001) break;
        let settled = 0; let revNoPay = 0; let waived = 0; let writtenOff = 0; let returnCredit = 0;
        for (const l of ar.ledger) {
          const amt = Number(l.amount);
          if (l.direction === 'SETTLE' || l.direction === 'REBATE_OFFSET') settled += amt;
          else if (l.direction === 'WAIVE') waived += amt;
          else if (l.direction === 'WRITEOFF') writtenOff += amt;
          else if (l.direction === 'RETURN_CREDIT') returnCredit += amt;
          else if (l.direction === 'REVERSAL') { if (l.paymentId) settled -= amt; else revNoPay += amt; }
        }
        const open = Number(ar.total) - settled - waived - writtenOff - returnCredit - revNoPay;
        if (open <= 0.0001) continue;
        const take = Math.min(open, remain);
        remain -= take;
        await this.prisma.receivableLedger.create({
          data: { tenantId: user.tenantId, receivableId: ar.id, direction: 'REBATE_OFFSET', amount: new Prisma.Decimal(take), note: `返利票折 ${dto.period}: ${dto.note ?? ''}`, createdBy: user.id },
        });
      }
    }
    await this.audit.log({ user, action: 'REBATE_SETTLE', entityType: 'RebateSettlement', entityId: created.id, after: { customerId: dto.customerId, period: dto.period, ...preview, settleType: dto.settleType } });
    return { ...created, unapplied: dto.settleType === 'INVOICE' ? undefined : preview.rebateAmount, hint: dto.settleType === 'GOODS' ? '货补请以随单赠下单兑付(不反改原单, D02)' : undefined };
  }

  async settlements(q: { period?: string; customerId?: string }): Promise<unknown> {
    return this.prisma.rebateSettlement.findMany({
      where: { period: q.period, customerId: q.customerId },
      orderBy: { createdAt: 'desc' },
      include: { customer: { select: { code: true, name: true } } },
    });
  }
}
