/**
 * LQ1-004 手工赠品 vs 买N送M（同一商品互斥，避免重复赠送）
 *
 * 业务适配清单 D2：赠品行 0 单价、扣库存、不占信用、不进应收。
 * 同一商品不能既走买N送M又再挂手工 isGift（含“促销赠品 SKU = 手工赠品 SKU”）。
 * 起送量仍只看应付额：赠品不是进货。
 */

export interface PromoGiftHit {
  productId: string;
  giftProductId: string;
}

export const GIFT_STACK_CONFLICT = '同一商品的手工赠品与买N送M不可叠加：去掉手工赠品行以使用促销，或不要让该商品同时命中促销规则';

/** 手工赠品商品与本单将追加的促销赠品（主商品或赠品 SKU）重叠则拒绝。 */
export function giftStackConflict(manualGiftProductIds: Iterable<string>, hits: PromoGiftHit[]): string | null {
  const manual = new Set(manualGiftProductIds);
  if (manual.size === 0 || hits.length === 0) return null;
  for (const hit of hits) {
    if (manual.has(hit.productId) || manual.has(hit.giftProductId)) return GIFT_STACK_CONFLICT;
  }
  return null;
}
