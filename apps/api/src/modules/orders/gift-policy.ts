import { Prisma } from '@prisma/client';
import { mulQtyPriceToCents, toCents } from '../../common/money';

/**
 * LQ1-004 手工赠品 vs 买N送M（互斥，信用与库存分开记账）
 *
 * 同一商品不能既走买N送M又再挂手工 isGift（含“促销赠品 SKU = 手工赠品 SKU”）。
 * - 促销赠品：单价 0、扣库存、不占信用。数量由规则封顶（D02 赠品四不）。
 * - 手工赠品：单价仍为 0（不进应收 totalAmount）、扣库存，但信用按落单时成交价
 *   （priceVersion = gift-ref:<元>）占用。没有生效价则拒绝赠送。
 * 起送量仍只看应付额：赠品不是进货。
 */
export const MANUAL_GIFT_PRICE_PREFIX = 'gift-ref:';

export function manualGiftPriceVersion(unitPrice: Prisma.Decimal.Value): string {
  const yuan = new Prisma.Decimal(toCents(unitPrice as Prisma.Decimal)).div(100).toFixed(2);
  return `${MANUAL_GIFT_PRICE_PREFIX}${yuan}`;
}

export function manualGiftUnitCents(priceVersion: string | null | undefined): number | null {
  if (!priceVersion?.startsWith(MANUAL_GIFT_PRICE_PREFIX)) return null;
  const raw = priceVersion.slice(MANUAL_GIFT_PRICE_PREFIX.length);
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  return toCents(raw);
}

export function manualGiftCreditCents(lines: Array<{ isGift?: boolean; qty: unknown; priceVersion?: string | null }>): number {
  let cents = 0;
  for (const line of lines) {
    if (!line.isGift) continue;
    const unit = manualGiftUnitCents(line.priceVersion);
    if (unit === null) continue;
    cents += mulQtyPriceToCents(line.qty as Prisma.Decimal.Value, new Prisma.Decimal(unit).div(100));
  }
  return cents;
}

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
