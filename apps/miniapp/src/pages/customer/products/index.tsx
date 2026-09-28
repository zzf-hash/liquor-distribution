import { useEffect, useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import {
  PRICE_TYPE_LABELS,
  UNIT_LABELS,
  cartKeyOf,
  cartQty,
  fmtMoney,
  getToken,
  labelOf,
  loadCart,
  saveCart,
  shopApi,
} from '../../../services/api'
import type { CartItem, ShopProductDTO } from '../../../services/api'
import './index.scss'

/**
 * 客户商品浏览（P0-T50）：GET /shop/products（CUSTOMER token，专属价已由后端解析）。
 * 步进器直写本地购物车（storage 持久化，key=productId+unit）；
 * 列表价为展示快照，成交价以下单时服务端核算为准。
 */
export default function CustomerProductsPage() {
  const [items, setItems] = useState<ShopProductDTO[]>([])
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cart, setCart] = useState<CartItem[]>([])

  useDidShow(() => {
    // 登录守卫；从购物车/订单页返回时同步购物车数量
    if (!getToken()) {
      Taro.reLaunch({ url: '/pages/customer/login/index' })
      return
    }
    setCart(loadCart())
  })

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const res = await shopApi.products()
      setItems(res.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载商品失败')
    } finally {
      setLoading(false)
    }
  }

  function qtyOf(p: ShopProductDTO): number {
    return cart.find((c) => cartKeyOf(c.productId, c.unit) === cartKeyOf(p.productId, p.unit))?.qty ?? 0
  }

  /** 步进 ±N 直写购物车；减到 0 即移除该行 */
  function changeQty(p: ShopProductDTO, delta: number) {
    const key = cartKeyOf(p.productId, p.unit)
    const next = cart.map((c) => ({ ...c }))
    const idx = next.findIndex((c) => cartKeyOf(c.productId, c.unit) === key)
    if (idx >= 0) {
      const q = next[idx].qty + delta
      if (q <= 0) next.splice(idx, 1)
      else next[idx].qty = q
    } else if (delta > 0) {
      next.push({
        productId: p.productId,
        name: p.name,
        specText: p.specText ?? '',
        unit: p.unit,
        price: p.price,
        priceType: p.priceType,
        qty: delta,
      })
    }
    setCart(next)
    saveCart(next)
  }

  const kw = keyword.trim().toLowerCase()
  const shown = kw
    ? items.filter((p) => `${p.name}${p.specText ?? ''}`.toLowerCase().includes(kw))
    : items

  return (
    <View className='plist'>
      <View className='plist__bar'>
        <Input
          className='plist__search'
          placeholder='搜品名，如：白酒'
          value={keyword}
          onInput={(e) => setKeyword(e.detail.value)}
        />
        <Button className='bar-btn' onClick={() => Taro.navigateTo({ url: '/pages/customer/cart/index' })}>
          购物车{cart.length > 0 ? `(${cartQty(cart)})` : ''}
        </Button>
      </View>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='plist__tip'>正在加载商品…</Text>
      ) : shown.length === 0 ? (
        <Text className='plist__tip'>{kw ? '没有找到相关商品' : '商家还没有上架商品'}</Text>
      ) : (
        <View className='plist__body'>
          {shown.map((p) => (
            <View key={cartKeyOf(p.productId, p.unit)} className='pcard'>
              <View className='pcard__info'>
                <Text className='pcard__name'>{p.name}</Text>
                <Text className='pcard__spec'>{p.specText || '—'} · 按{labelOf(UNIT_LABELS, p.unit)}订</Text>
                <Text className='pcard__price'>
                  {fmtMoney(p.price)}
                  <Text className='pcard__ptype'>／{labelOf(UNIT_LABELS, p.unit)} · {labelOf(PRICE_TYPE_LABELS, p.priceType)}</Text>
                </Text>
              </View>
              <View className='stepper'>
                <Button
                  className='stepper__btn'
                  disabled={qtyOf(p) <= 0}
                  onClick={() => changeQty(p, -1)}
                >
                  −
                </Button>
                <Text className='stepper__num'>{qtyOf(p)}</Text>
                <Button className='stepper__btn stepper__btn--plus' onClick={() => changeQty(p, 1)}>＋</Button>
              </View>
            </View>
          ))}
          <Text className='plist__tip'>选好后点右上角「购物车」去结算；成交价以商家核算为准</Text>
        </View>
      )}
    </View>
  )
}
