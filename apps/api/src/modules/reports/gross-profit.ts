import { Prisma } from '@prisma/client';

/**
 * LQ1-021 毛利（促销侵蚀后）
 *
 * 毛利 = 签收实收收入 − 销售成本 − 返利侵蚀 − 费用冲抵侵蚀
 * 收入 = 期间签收实收（拒收剔除，赠品行金额为 0）
 * 销售成本 = 出库批次成本；无出库时回退 COST 价（见 fallbackCostCents，LQ1-006）
 * 返利侵蚀 = 期间 REBATE_OFFSET + 期间已批/已付现金返利费用(REBATE)
 *           货补不再扣：随单赠品成本已在销售成本里，收入为 0
 * 费用冲抵侵蚀 = 期间 FEE_OFFSET（陈列 / 进店 / 开瓶费冲货款）
 * 毛利率 = 毛利 / 收入；任一计入行缺少成本时毛利率为空，不显示 100%
 * 客户维度按客户归集；其他维度按该行收入占期间收入的比例分摊（最大余数）
 */
export const GROSS_PROFIT_CALIBER = [
  '毛利 = 签收实收收入 − 销售成本 − 返利侵蚀 − 费用冲抵侵蚀。',
  '收入 = 期间签收实收(拒收剔除, 赠品行金额为 0)。',
  '销售成本 = 出库批次成本; 无出库时回退 COST 价: 行单位与价目单位一致则直接相乘; 仅有箱(BASE)成本而行为瓶(MIN)时按箱价÷换算率; 仅有瓶(MIN)成本而行为箱(BASE)时按瓶价×换算率。',
  '返利侵蚀 = 期间 REBATE_OFFSET + 期间已批/已付现金返利费用(REBATE)。货补不重复扣(赠品成本已在销售成本, 收入为 0)。',
  '费用冲抵侵蚀 = 期间 FEE_OFFSET(陈列/进店/开瓶费冲货款)。',
  '毛利率 = 毛利 / 收入; 任一计入行缺少成本时毛利率为空, 不按 100% 显示。',
  '客户维度按客户归集侵蚀; 其他维度按该行收入占期间收入的比例分摊。',
].join('');

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
  profitBeforeCents: number;
  profitCents: number;
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
}): { rows: GrossRowOut[]; totals: { revenueCents: number; costCents: number; profitBeforeCents: number; rebateCents: number; feeCents: number; profitCents: number; costKnown: boolean } } {
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
  const profitBeforeCents = r.revenueCents - r.costCents;
  const profitCents = profitBeforeCents - rebateCents - feeCents;
  return {
    ...r,
    rebateCents,
    feeCents,
    profitBeforeCents,
    profitCents,
    margin: marginPercent(profitCents, r.revenueCents, r.costKnown),
  };
}

function finishTotals(rows: GrossRowOut[], rebateCents: number, feeCents: number) {
  const revenueCents = rows.reduce((s, r) => s + r.revenueCents, 0);
  const costCents = rows.reduce((s, r) => s + r.costCents, 0);
  const profitBeforeCents = revenueCents - costCents;
  const costKnown = rows.every((r) => r.costKnown);
  return {
    revenueCents,
    costCents,
    profitBeforeCents,
    rebateCents,
    feeCents,
    profitCents: profitBeforeCents - rebateCents - feeCents,
    costKnown,
  };
}
