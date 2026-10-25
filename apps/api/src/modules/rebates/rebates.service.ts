import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { centsToDecimal, centsToNumber, percentOfCents, toCents } from '../../common/money';
import { arOpenCents } from '../receivables/aging';
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

  /** 建方案(D02 互斥硬校验: 同客户存在生效中方案→409)。
   *  C组 M3-2: tiers 坎级阶梯——按月累计基数取最高命中档(minAmount ≤ 基数), 未达最低坎=无返利;
   *  不传 tiers 时 rate 为单一费率(旧行为不变)。 */
  async createScheme(user: AuthUser, dto: {
    customerId: string; type: 'B' | 'C'; rate: number; note?: string; validTo?: string;
    tiers?: Array<{ minAmount: number; rate: number }>;
  }): Promise<unknown> {
    const rate = Number(dto.rate);
    // 2026-10 口径修订(需求 v1.1 M3-2): 客户明确返利比例 1%-50% 可配, 原 5% 下限排除小额月返
    if (!(rate >= 0.01 && rate <= 0.5)) throw new BadRequestException('费率须在 1%-50% 之间(D02)');
    let tiers: Array<{ minAmount: number; rate: number }> | undefined;
    if (dto.tiers?.length) {
      tiers = dto.tiers.map((t) => ({ minAmount: Number(t.minAmount), rate: Number(t.rate) }))
        .sort((a, b) => a.minAmount - b.minAmount);
      if (tiers.some((t) => !(t.minAmount > 0))) throw new BadRequestException('坎级门槛必须大于 0');
      if (tiers.some((t) => !(t.rate >= 0.01 && t.rate <= 0.5))) throw new BadRequestException('每档费率须在 1%-50% 之间');
      for (let i = 1; i < tiers.length; i++) {
        if (tiers[i].minAmount <= tiers[i - 1].minAmount) throw new BadRequestException('坎级门槛须严格递增');
      }
    }
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
        rate: new Prisma.Decimal(rate), tiers: (tiers ?? undefined) as never, note: dto.note,
        validTo: dto.validTo ? new Date(dto.validTo) : undefined, createdById: user.id,
      },
    });
    await this.audit.log({ user, action: 'REBATE_SCHEME_CREATE', entityType: 'RebateScheme', entityId: created.id, after: { customer: customer.name, type: dto.type, rate, tiers } });
    return created;
  }

  /** 坎级解析: 基数命中最高 minAmount 档 → 该档费率; 未达最低坎 → 0(无返利); 无 tiers → 单一费率 */
  private effectiveRate(scheme: { rate: unknown; tiers: unknown }, baseAmount: number): { rate: number; tierHit: number | null; tiers: Array<{ minAmount: number; rate: number }> | null } {
    const tiers = Array.isArray(scheme.tiers) ? (scheme.tiers as Array<{ minAmount: number; rate: number }>) : null;
    if (!tiers || tiers.length === 0) return { rate: Number(scheme.rate), tierHit: null, tiers: null };
    let hit: { minAmount: number; rate: number } | null = null;
    for (const t of tiers) if (baseAmount >= t.minAmount) hit = t;
    return { rate: hit ? Number(hit.rate) : 0, tierHit: hit ? hit.minAmount : null, tiers };
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
    // P1-13: 期间护栏——不可核算未来账期, 不可早于方案生效月追溯套利
    if (dayjs(start).isAfter(dayjs().startOf('month'))) {
      throw new ConflictException(`期间 ${period} 尚未开始, 不可核算未来账期`);
    }
    if (dayjs(start).isBefore(dayjs(scheme.validFrom).startOf('month'))) {
      throw new ConflictException(`期间 ${period} 早于方案生效月 ${dayjs(scheme.validFrom).format('YYYY-MM')}, 不可追溯核算`);
    }
    const payAgg = await this.prisma.payment.aggregate({
      where: { customerId, status: 'CONFIRMED', kind: 'PAYMENT', confirmedAt: { gte: start, lte: end } },
      _sum: { amount: true },
    });
    const pkgAgg = await this.prisma.packageRecord.aggregate({
      where: { customerId, type: 'OUT', createdAt: { gte: start, lte: end } },
      _sum: { depositPaid: true },
    });
    // LQ1-019: 基数仍是确认回款 − 瓶箱押金，不减退货 RETURN_CREDIT、不减收款冲正。
    // Q2（提货额 vs 回款额）未关闭；B 组清单把开瓶费「退货不回算」标成非缺陷。此处保持原口径。
    const paymentsCents = toCents(payAgg._sum.amount ?? 0);
    const bottlesCents = Math.abs(toCents(pkgAgg._sum.depositPaid ?? 0));
    const baseCents = Math.max(0, paymentsCents - bottlesCents);
    const payments = centsToNumber(paymentsCents);
    const bottles = centsToNumber(bottlesCents);
    const baseAmount = centsToNumber(baseCents);
    // C组 M3-2: 坎级阶梯——基数命中最高档的费率, 未达最低坎=0
    const eff = this.effectiveRate(scheme, baseAmount);
    const rebateAmount = centsToNumber(percentOfCents(baseCents, eff.rate));
    void user;
    return {
      customerId, period, schemeType: scheme.type, rate: eff.rate, flatRate: Number(scheme.rate),
      tiers: eff.tiers, tierHit: eff.tierHit, tierMissed: eff.tiers !== null && eff.tierHit === null,
      payments, bottlesDeposit: bottles, baseAmount, rebateAmount,
    };
  }

  /** 确认核算: 票折=REBATE_OFFSET 流水冲应收(FIFO 未结单); 货补=登记+走随单赠; 现金=生成 REBATE 费用单(已批待付, C组 M3-2) */
  async settle(user: AuthUser, dto: { customerId: string; period: string; settleType: 'GOODS' | 'INVOICE' | 'CASH'; note?: string }): Promise<unknown> {
    if (!/^\d{4}-\d{2}$/.test(dto.period)) throw new BadRequestException('期间格式 YYYY-MM');
    const dup = await this.prisma.rebateSettlement.findUnique({ where: { tenantId_customerId_period: { tenantId: user.tenantId, customerId: dto.customerId, period: dto.period } } });
    if (dup) throw new ConflictException(`该客户 ${dto.period} 已核算(唯一)`);
    const preview = await this.preview(user, dto.customerId, dto.period) as { schemeType: string; rate: number; baseAmount: number; rebateAmount: number; tierHit: number | null; tierMissed: boolean };
    if (preview.tierMissed) throw new ConflictException(`当月基数 ¥${preview.baseAmount.toFixed(2)} 未达坎级最低门槛, 无返利可核算`);
    const scheme = (await this.prisma.rebateScheme.findFirst({ where: { customerId: dto.customerId, closedAt: null } }))!;
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId }, select: { name: true } });
    // P1-12: 核算单与 REBATE_OFFSET 流水同事务(原实现分离, 中途失败留"已核算但应收未冲"的半截账,
    // 且 (tenantId,customerId,period) 唯一键阻止重做)
    const { created, unapplied, cashExpenseNo } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.rebateSettlement.create({
        data: {
          tenantId: user.tenantId, customerId: dto.customerId, schemeId: scheme.id, period: dto.period,
          baseAmount: new Prisma.Decimal(preview.baseAmount), rebateAmount: new Prisma.Decimal(preview.rebateAmount),
          settleType: dto.settleType, note: dto.note, createdById: user.id,
        },
      });
      let cashExpenseNo: string | null = null;
      if (dto.settleType === 'CASH' && preview.rebateAmount > 0) {
        // C组: 现金返利 → REBATE 费用单(系统直入已批, 出纳在费用中心付款)
        const fyDay = dayjs().format('YYYYMMDD');
        let expense: { id: string; expenseNo: string } | null = null;
        for (let attempt = 0; attempt < 5 && !expense; attempt++) {
          const seq = (await tx.expense.count({ where: { expenseNo: { startsWith: `FY${fyDay}` } } })) + 1 + attempt;
          try {
            expense = await tx.expense.create({
              data: {
                tenantId: user.tenantId, expenseNo: `FY${fyDay}-${String(seq).padStart(4, '0')}`,
                category: 'REBATE', title: `返利现金 ${dto.period}(${customer?.name ?? dto.customerId})`,
                amount: new Prisma.Decimal(preview.rebateAmount), customerId: dto.customerId,
                payMode: 'CASH', status: 'APPROVED',
                note: `核算单 ${created.id.slice(-6)}; 基数 ¥${preview.baseAmount.toFixed(2)}×${(preview.rate * 100).toFixed(1)}%${preview.tierHit !== null ? `(坎级≥${preview.tierHit})` : ''}`,
                source: `REBATE_SETTLE:${dto.period}:${dto.customerId}`, createdById: user.id,
              },
            });
          } catch (e) {
            if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue;
            throw e;
          }
        }
        cashExpenseNo = expense?.expenseNo ?? null;
      }
      let unapplied = preview.rebateAmount; // GOODS: 货补全额待兑付; CASH: 费用单待付
      if (dto.settleType === 'INVOICE' && preview.rebateAmount > 0) {
        // 票折: FIFO 冲未结应收(与收款核销同序, D4)。先锁客户应收，未结含 FEE_OFFSET（LQ1-002）。
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "Receivable" WHERE "tenantId" = ${user.tenantId} AND "customerId" = ${dto.customerId} AND "disputeFlag" = false ORDER BY id FOR UPDATE`);
        const ars = await tx.receivable.findMany({
          where: { customerId: dto.customerId, disputeFlag: false, archivedAt: null },
          include: { ledger: true },
          orderBy: [{ dueDate: 'asc' }, { generatedAt: 'asc' }],
        });
        let remainCents = toCents(preview.rebateAmount);
        for (const ar of ars) {
          if (remainCents <= 0) break;
          const { openCents } = arOpenCents(ar.total, ar.ledger);
          if (openCents <= 0) continue;
          const take = Math.min(openCents, remainCents);
          remainCents -= take;
          await tx.receivableLedger.create({
            data: { tenantId: user.tenantId, receivableId: ar.id, direction: 'REBATE_OFFSET', amount: centsToDecimal(take), note: `返利票折 ${dto.period}: ${dto.note ?? ''}`, createdBy: user.id },
          });
        }
        // P1-12: 未冲完的剩余不再静默蒸发, 返回给调用方并落审计
        unapplied = centsToNumber(remainCents);
      }
      return { created, unapplied, cashExpenseNo };
    });
    await this.audit.log({ user, action: 'REBATE_SETTLE', entityType: 'RebateSettlement', entityId: created.id, after: { customerId: dto.customerId, period: dto.period, ...preview, settleType: dto.settleType, unapplied, cashExpenseNo } });
    const hint = dto.settleType === 'GOODS'
      ? '货补请以随单赠下单兑付(不反改原单, D02)'
      : dto.settleType === 'CASH'
        ? `现金返利费用单 ${cashExpenseNo} 已生成(已批待付), 请到费用中心执行付款`
        : unapplied > 0 ? `未结应收不足, 返利 ¥${unapplied.toFixed(2)} 未冲减(请联系老板处理)` : undefined;
    return { ...created, unapplied, cashExpenseNo, hint };
  }

  async settlements(q: { period?: string; customerId?: string }): Promise<unknown> {
    return this.prisma.rebateSettlement.findMany({
      where: { period: q.period, customerId: q.customerId },
      orderBy: { createdAt: 'desc' },
      include: { customer: { select: { code: true, name: true } } },
    });
  }
}
