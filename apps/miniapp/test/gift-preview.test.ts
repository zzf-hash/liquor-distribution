import { describe, expect, it } from 'vitest'
import { previewGiftLines } from '../src/services/gift-preview'

describe('gift preview', () => {
  it('counts bottles separately from cases', () => {
    const rules = [{
      productId: 'beer',
      giftProductId: null,
      giftProductName: '青岛啤酒',
      buyQty: 10,
      giftQty: 1,
      unit: 'MIN' as const,
      active: true,
    }]
    expect(previewGiftLines([{ productId: 'beer', unit: 'BASE', qty: 10 }], rules)).toEqual([])
    expect(previewGiftLines([{ productId: 'beer', unit: 'MIN', qty: 25 }], rules)).toEqual([
      { productId: 'beer', name: '青岛啤酒', unit: 'MIN', qty: 2 },
    ])
  })
})