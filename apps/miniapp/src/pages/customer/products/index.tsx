import { useEffect, useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../../components/Icon'
import RoleTabBar from '../../../components/RoleTabBar'
import TabsScroll from '../../../components/TabsScroll'
import {
  UNIT_LABELS,
  cartKeyOf,
  cartQty,
  fmtMoney,
  LOGIN_PAGE,
  getToken,
  labelOf,
  loadCart,
  saveCart,
  shopApi,
  signOut,
  toNum,
} from '../../../services/api'
import { redirectIfStaffOnCustomerPage } from '../../../services/customer-page-redirect'
import { productSearchOnConfirm, productSearchOnInput } from '../../../services/product-search'
import type { CartItem, ShopProductDTO } from '../../../services/api'
import './index.scss'

/**
 * 客户商品浏览：GET /shop/products。步进器直写本地购物车。
 * 接口没有分类字段，横滑只保留「全部」，避免编造筛选结果。
 */
export default function CustomerProductsPage() {
  const [items, setItems] = useState<ShopProductDTO[]>([])
  const [keyword, setKeyword] = useState('')
  const [focus, setFocus] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cart, setCart] = useState<CartItem[]>([])
  const [capped, setCapped] = useState(false)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    if (redirectIfStaffOnCustomerPage('pages/customer/products/index')) return
    setCart(loadCart())
  })

  useEffect(() => {
    if (!getToken()) return
    if (redirectIfStaffOnCustomerPage('pages/customer/products/index')) return
    void load('')
  }, [])

  async function load(q: string) {
    setLoading(true)
    setError('')
    try {
      const res = await shopApi.products(q)
      const next = res.items ?? []
      setItems(next)
      setCapped(next.length >= 100)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载商品失败')
    } finally {
      setLoading(false)
    }
  }

  function qtyOf(p: ShopProductDTO): number {
    return cart.find((c) => cartKeyOf(c.productId, c.unit) === cartKeyOf(p.productId, p.unit))?.qty ?? 0
  }

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

  function unitName(p: ShopProductDTO): string {
    if (p.unit === 'MIN') return p.minUnit || labelOf(UNIT_LABELS, 'MIN')
    return p.baseUnit || labelOf(UNIT_LABELS, p.unit)
  }

  const total = cart.reduce((sum, row) => sum + toNum(row.price) * row.qty, 0)
  const count = cartQty(cart)

  return (
    <View className='plist'>
      <View className='page-head'>
        <View className='page-head__main'>
          <Text className='page-head__title'>选酒下单</Text>
          <Text className='page-head__sub'>价格为参考价，以商家确认为准</Text>
        </View>
        <Text className='grid-home__out' onClick={() => { void signOut() }}>退出登录</Text>
      </View>

      <View className={`plist__search ${focus ? 'plist__search--focus' : ''}`}>
        <Icon name='search' color='#6B5F5A' size={44} />
        <Input
          className='plist__input'
          placeholder='搜索品名、规格'
          confirmType='search'
          value={keyword}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onInput={(e) => {
            const next = productSearchOnInput(e.detail.value)
            setKeyword(next.keyword)
            if (next.loadNow !== null) void load(next.loadNow)
          }}
          onConfirm={(e) => { void load(productSearchOnConfirm(e.detail.value)) }}
        />
        <Button className='plist__go' onClick={() => { void load(keyword) }}>
          <Text className='btn-label'>搜索</Text>
        </Button>
      </View>

      <TabsScroll>
        <Button className='tabs__btn tabs__btn--on'>全部</Button>
      </TabsScroll>

      {error ? (
        <View className='state'>
          <Text className='state__title'>没加载出来</Text>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-ghost' onClick={() => { void load(keyword) }}>重新加载</Button>
        </View>
      ) : loading ? (
        <View className='state'>
          <Text className='state__txt'>正在加载商品…</Text>
        </View>
      ) : items.length === 0 ? (
        <View className='card state'>
          <View className='state__icon'>
            <Icon name='bottle' color='#B3A9A4' size={72} />
          </View>
          <Text className='state__title'>{keyword.trim() ? '没有找到相关商品' : '商家还没有上架商品'}</Text>
          <Text className='state__txt'>
            {keyword.trim() ? '换个品名再搜一次' : '可以稍后再来看看'}
          </Text>
          <Text className='state__txt'>找不到想要的酒？请联系您的专属业务员</Text>
        </View>
      ) : (
        <View className='plist__body'>
          {capped ? <Text className='tip'>只返回前 100 条，请用品名继续搜索。搜索只匹配品名。</Text> : null}
          {items.map((p) => {
            const qty = qtyOf(p)
            return (
              <View key={cartKeyOf(p.productId, p.unit)} className='pcard'>
                <View className='pcard__pic'>
                  <Icon name='bottle' color='#7A1F2B' size={64} />
                </View>
                <View className='pcard__info'>
                  <Text className='pcard__name'>{p.name}</Text>
                  <Text className='pcard__spec'>{p.specText || '—'} · 按{unitName(p)}订</Text>
                  <View className='pcard__row'>
                    <Text className='pcard__price'>
                      {fmtMoney(p.price)}
                      <Text className='pcard__unit'> /{unitName(p)}</Text>
                    </Text>
                    {qty <= 0 ? (
                      <Button className='btn-primary btn-sm pcard__add' onClick={() => changeQty(p, 1)}>加入</Button>
                    ) : (
                      <View className='stepper'>
                        <Button className='stepper__btn' disabled={qty <= 0} onClick={() => changeQty(p, -1)}>−</Button>
                        <Text className='stepper__num'>{qty}</Text>
                        <Button className='stepper__btn' onClick={() => changeQty(p, 1)}>＋</Button>
                      </View>
                    )}
                  </View>
                </View>
              </View>
            )
          })}
          <Text className='tip'>成交价以商家核算为准。</Text>
        </View>
      )}

      <View className='settle'>
        <View>
          <Text className='settle__sum'>{count > 0 ? fmtMoney(total) : '¥0.00'}</Text>
          <Text className='settle__meta'>{count > 0 ? `已选 ${count}` : '还没有加购'}</Text>
        </View>
        <Button
          className='btn-primary'
          disabled={count <= 0}
          onClick={() => Taro.navigateTo({ url: '/pages/customer/cart/index' })}
        >
          <Text className='btn-label'>去结算</Text>
        </Button>
      </View>
      <RoleTabBar />
    </View>
  )
}
