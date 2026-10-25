/**
 * 毛利成本回退（LQ-FE-004）。
 *
 * 与已开 PR #2（cursor/fund-inventory-defects-2e37）的 LQ1-006 `fallbackCostCents` 同一套换算，
 * 这里用元而不是分，避免再引入那条分支的 money.ts / gross-profit.ts：
 * - 行单位与价目单位一致：数量 × 该单位成本
 * - 只有瓶价 MIN、行是箱 BASE：瓶价 × 换算率
 * - 只有箱价 BASE、行是瓶 MIN：箱价 ÷ 换算率
 * - 两种都有时用与行单位相同的那条，不再把瓶价除一次换算率
 * - 实收数量为 0 → 成本 0；有实收但两种成本都没有 → null（调用方不要当成 100% 毛利）
 */
export function fallbackLineCost(args: {
  qty: number;
  unit: 'BASE' | 'MIN';
  conversionRate: number;
  ratio: number;
  basePrice: number | null;
  minPrice: number | null;
}): number | null {
  const conv = args.conversionRate > 0 ? args.conversionRate : 1;
  const accepted = args.qty * args.ratio;
  if (!(accepted > 0)) return 0;
  const unitPrice = args.unit === 'BASE'
    ? (args.basePrice !== null ? args.basePrice : args.minPrice !== null ? args.minPrice * conv : null)
    : (args.minPrice !== null ? args.minPrice : args.basePrice !== null ? args.basePrice / conv : null);
  if (unitPrice === null) return null;
  return Number((accepted * unitPrice).toFixed(2));
}
