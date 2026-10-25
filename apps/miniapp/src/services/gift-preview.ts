export interface GiftRule {
  productId: string
  giftProductId: string | null
  giftProductName: string
  buyQty: number
  giftQty: number
  unit: 'BASE' | 'MIN'
  active?: boolean
}

export interface GiftPreviewLine {
  productId: string
  name: string
  unit: 'BASE' | 'MIN'
  qty: number
}

/** 与后端 computeGiftLines 相同：按商品+单位合并，买满 buyQty 的整数倍送 giftQty。 */
export function previewGiftLines(
  buys: Array<{ productId: string; unit: 'BASE' | 'MIN'; qty: number }>,
  rules: GiftRule[],
): GiftPreviewLine[] {
  const qtyByProduct = new Map<string, number>()
  for (const b of buys) {
    const key = `${b.productId}|${b.unit}`
    qtyByProduct.set(key, (qtyByProduct.get(key) ?? 0) + b.qty)
  }
  const out: GiftPreviewLine[] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    if (rule.active === false) continue
    if (seen.has(rule.productId)) continue
    const qty = qtyByProduct.get(`${rule.productId}|${rule.unit}`)
    if (!qty || qty < rule.buyQty || rule.buyQty < 1) continue
    const times = Math.floor(qty / rule.buyQty)
    out.push({
      productId: rule.giftProductId ?? rule.productId,
      name: rule.giftProductName,
      unit: rule.unit,
      qty: times * rule.giftQty,
    })
    seen.add(rule.productId)
  }
  return out
}
