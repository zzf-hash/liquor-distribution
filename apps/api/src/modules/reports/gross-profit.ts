import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';

/**
 * LQ1-021 / LQ1-051 毛利与净贡献（C组清单 3.3）
 *
 * 毛利 = 签收实收收入 − 销售成本
 * 净贡献 = 毛利 − 归入本月的返利冲抵 − 归入本月的费用冲抵
 * 收入 = 期间签收实收（拒收剔除，赠品行金额为 0）
 * 销售成本 = 出库批次成本；无出库时回退 COST 价（见 fallbackCostCents，LQ1-006）
 * 冲抵不按流水 createdAt：订单应收取原单签收月，期初及其他单据取应收 generatedAt；
 * 现金返利费用 source=REBATE_SETTLE:YYYY-MM:客户 时取核算期间，否则取 occurredAt。
 * 货补不再扣：随单赠品成本已在销售成本里，收入为 0
 * 毛利率 = 毛利 / 收入；任一计入行缺少成本时毛利率为空，不显示 100%
 * 客户维度按客户归集冲抵；其他维度按该行收入占期间收入的比例分摊到净贡献（最大余数）
 */
export const GROSS_PROFIT_CALIBER = [
  '毛利 = 签收实收收入 − 销售成本。',
  '净贡献 = 毛利 − 归入本月的返利冲抵 − 归入本月的费用冲抵。',
  '收入 = 期间签收实收(拒收剔除, 赠品行金额为 0)。',
  '销售成本 = 出库批次成本; 无出库时回退 COST 价: 行单位与价目单位一致则直接相乘; 仅有箱(BASE)成本而行为瓶(MIN)时按箱价÷换算率; 仅有瓶(MIN)成本而行为箱(BASE)时按瓶价×换算率。',
  '返利冲抵 = 业务月属于本月的 REBATE_OFFSET + 业务月属于本月的已批/已付现金返利费用(REBATE)。货补不重复扣(赠品成本已在销售成本, 收入为 0)。',
  '费用冲抵 = 业务月属于本月的 FEE_OFFSET(陈列/进店/开瓶费冲货款)。',
  '冲抵归属不看流水 createdAt: 冲订单应收时业务月取原订单签收月(signedAt); 冲期初应收或其他非订单单据时业务月取应收 generatedAt。',
  '现金返利费用 source 为 REBATE_SETTLE:YYYY-MM:客户 时业务月取该核算期间, 否则取 occurredAt。',
  '毛利率 = 毛利 / 收入; 任一计入行缺少成本时毛利率为空, 不按 100% 显示。',
  '客户维度按客户归集冲抵; 其他维度按该行收入占期间收入的比例把冲抵分摊进净贡献。',
].join('');

export function offsetBusinessMonth(doc: {
  sourceType: string;
  signedAt?: Date | null;
  generatedAt: Date;
}): string {
  if (doc.sourceType === 'ORDER' && doc.signedAt) return dayjs(doc.signedAt).format('YYYY-MM');
  return dayjs(doc.generatedAt).format('YYYY-MM');
}

/** 现金返利费用的业务月。REBATE_SETTLE 期间优先于费用行 occurredAt。 */
export function cashRebateBusinessMonth(source: string | null | undefined, occurredAt: Date): string {
  const matched = source?.match(/^REBATE_SETTLE:(\d{4}-\d{2}):/);
  if (matched) return matched[1];
  return dayjs(occurredAt).format('YYYY-MM');
}

export interface CostQuote {
  baseCents: number | null;
  minCents: number | null;
}

/**
 * Accepted quantity × cost, in cents.
 * Returns null when neither BASE nor MIN cost exists and some quantity was accepted.
 * Returns 0 when the accepted quantity is 0 (nothing to cost).
 * A MIN price is never divided by conversionRate again.
 */
export function fallbackCostCents(args: {
  qty: Prisma.Decimal.Value;
  unit: 'BASE' | 'MIN';
  conversionRate: number;
  ratio: Prisma.Decimal.Value;
  quote: CostQuote;
}): number | null {
  const conv = args.conversionRate > 0 ? args.conversionRate : 1;
  const accepted = new Prisma.Decimal(args.qty).mul(args.ratio);
  if (accepted.lte(0)) return 0;
  const { baseCents, minCents } = args.quote;
  if (args.unit === 'BASE') {
    if (baseCents !== null) return accepted.mul(baseCents).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
    if (minCents !== null) return accepted.mul(minCents).mul(conv).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
    return null;
  }
  if (minCents !== null) return accepted.mul(minCents).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
  if (baseCents !== null) return accepted.mul(baseCents).div(conv).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
  return null;
}

export function marginPercent(profitCents: number, revenueCents: number, costKnown: boolean): number | null {
  if (!costKnown || revenueCents <= 0) return null;
  return new Prisma.Decimal(profitCents).div(revenueCents).mul(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

export interface GrossRowIn {
  key: string;
  name: string;
  revenueCents: number;
  costCents: number;
  costKnown: boolean;
}

export interface CustomerErosion {
  customerId: string;
  rebateCents: number;
  feeCents: number;
}

export interface GrossRowOut extends GrossRowIn {
  rebateCents: number;
  feeCents: number;
  /** 毛利 = 收入 − 成本 */
  profitCents: number;
  /** 净贡献 = 毛利 − 本月冲抵 */
  netContributionCents: number;
  margin: number | null;
}

function allocateByWeight(total: number, weights: number[]): number[] {
  if (total === 0 || weights.length === 0 || weights.every((w) => w <= 0)) return weights.map(() => 0);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  const raw = weights.map((w) => new Prisma.Decimal(total).mul(w).div(weightSum));
  const floors = raw.map((x) => x.toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN).toNumber());
  let left = total - floors.reduce((s, n) => s + n, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x.sub(floors[i]).toNumber() }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i] += 1;
    left -= 1;
  }
  return floors;
}

export function assembleGrossProfit(args: {
  dimension: 'category' | 'customer' | 'rep' | 'product';
  rows: GrossRowIn[];
  erosions: CustomerErosion[];
  customerNames?: ReadonlyMap<string, string>;
}): { rows: GrossRowOut[]; totals: { revenueCents: number; costCents: number; rebateCents: number; feeCents: number; profitCents: number; netContributionCents: number; costKnown: boolean } } {
  const rebateTotal = args.erosions.reduce((s, e) => s + e.rebateCents, 0);
  const feeTotal = args.erosions.reduce((s, e) => s + e.feeCents, 0);
  const rows = args.rows.map((r) => ({ ...r }));

  if (args.dimension === 'customer') {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const e of args.erosions) {
      if (e.rebateCents === 0 && e.feeCents === 0) continue;
      if (!byKey.has(e.customerId)) {
        const extra: GrossRowIn = {
          key: e.customerId,
          name: args.customerNames?.get(e.customerId) ?? e.customerId,
          revenueCents: 0,
          costCents: 0,
          costKnown: true,
        };
        rows.push(extra);
        byKey.set(e.customerId, extra);
      }
    }
    const out = rows.map((r) => {
      const e = args.erosions.find((x) => x.customerId === r.key);
      return finishRow(r, e?.rebateCents ?? 0, e?.feeCents ?? 0);
    });
    return { rows: out, totals: finishTotals(out, rebateTotal, feeTotal) };
  }

  const rebateParts = allocateByWeight(rebateTotal, rows.map((r) => r.revenueCents));
  const feeParts = allocateByWeight(feeTotal, rows.map((r) => r.revenueCents));
  const out = rows.map((r, i) => finishRow(r, rebateParts[i] ?? 0, feeParts[i] ?? 0));
  return { rows: out, totals: finishTotals(out, rebateTotal, feeTotal) };
}

function finishRow(r: GrossRowIn, rebateCents: number, feeCents: number): GrossRowOut {
  const profitCents = r.revenueCents - r.costCents;
  const netContributionCents = profitCents - rebateCents - feeCents;
  return {
    ...r,
    rebateCents,
    feeCents,
    profitCents,
    netContributionCents,
    margin: marginPercent(profitCents, r.revenueCents, r.costKnown),
  };
}

function finishTotals(rows: GrossRowOut[], rebateCents: number, feeCents: number) {
  const revenueCents = rows.reduce((s, r) => s + r.revenueCents, 0);
  const costCents = rows.reduce((s, r) => s + r.costCents, 0);
  const profitCents = revenueCents - costCents;
  const costKnown = rows.every((r) => r.costKnown);
  return {
    revenueCents,
    costCents,
    rebateCents,
    feeCents,
    profitCents,
    netContributionCents: profitCents - rebateCents - feeCents,
    costKnown,
  };
}
