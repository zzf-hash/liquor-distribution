import { useRef, useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../../components/Icon'
import { rememberIdemKey } from '../../../services/idempotency'
import type { IdemSlot } from '../../../services/idempotency'
import { openAppPage } from '../../../services/navigation'
import { previewGiftLines } from '../../../services/gift-preview'
import type { GiftPreviewLine, GiftRule } from '../../../services/gift-preview'
import {
  UNIT_LABELS,
  cartQty,
  fmtMoney,
  LOGIN_PAGE,
  getToken,
  labelOf,
  loadCart,
  ordersApi,
  promotionsApi,
  saveCart,
  toNum,
} from '../../../services/api'
import type { CartItem } from '../../../services/api'
import { redirectIfStaffOnCustomerPage } from '../../../services/customer-page-redirect'
import './index.scss'

/**
 * 购物车（P0-T50）：本地购物车结算确认 → POST /orders {source:'CUSTOMER', lines}。
 * customerId 不传（P1-5 服务端强制 token 身份）；下单带幂等键，重试不双写。
 */
export default function CustomerCartPage() {
  const [cart, setCart] = useState<CartItem[]>([])
  const [rules, setRules] = useState<GiftRule[]>([])
  const [giftNote, setGiftNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const idemRef = useRef<IdemSlot | null>(null)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    if (redirectIfStaffOnCustomerPage('pages/customer/cart/index')) return
    setCart(loadCart())
    promotionsApi.active()
      .then((rows) => {
        setRules(Array.isArray(rows) ? rows : [])
        setGiftNote('')
      })
      .catch(() => {
        setRules([])
        setGiftNote('赠品预览暂时不可用，提交后仍由服务端计算。')
      })
  })

  const total = cart.reduce((s, it) => s + toNum(it.price) * it.qty, 0)
  const gifts: GiftPreviewLine[] = previewGiftLines(
    cart.map((it) => ({ productId: it.productId, unit: it.unit, qty: it.qty })),
    rules,
  )
  const giftText = gifts.length
    ? `预计赠品：${gifts.map((g) => `${g.name} ${g.qty}${labelOf(UNIT_LABELS, g.unit)}`).join('、')}。赠品由服务端写入，这里不另提交。`
    : giftNote
  const pieces = cartQty(cart)

  function changeQty(idx: number, delta: number) {
    const next = cart.map((c) => ({ ...c }))
    const q = next[idx].qty + delta
    if (q <= 0) next.splice(idx, 1)
    else next[idx].qty = q
    setCart(next)
    saveCart(next)
  }

  function removeAt(idx: number) {
    const next = cart.filter((_, i) => i !== idx)
    setCart(next)
    saveCart(next)
  }

  async function checkout() {
    if (submitting || cart.length === 0) return
    // 2026-10 审查修复: submitting 置位提前到弹窗之前(原实现弹窗期间可再次点结算触发第二次提交;
    // 后端已接幂等键, 此处为前端双保险)
    setSubmitting(true)
    try {
      const confirm = await Taro.showModal({
        title: '确认提交订单',
        content: `共 ${pieces} 件商品，合计约 ${fmtMoney(total)}。${giftText}提交后商家会尽快确认安排送货。`,
        confirmText: '提交订单',
        cancelText: '再看看',
      })
      if (!confirm.confirm) return
      const lines = cart.map((it) => ({ productId: it.productId, unit: it.unit, qty: it.qty }))
      const res = await ordersApi.create(lines, rememberIdemKey(idemRef, lines))
      idemRef.current = null
      saveCart([])
      setCart([])
      await Taro.showModal({
        title: '下单成功',
        content: `订单号 ${res.orderNo}\n合计 ${fmtMoney(res.totalAmount)}\n商家确认后会安排送货，可在「我的订单」查看进度`,
        showCancel: false,
        confirmText: '查看订单',
      })
      openAppPage('/pages/customer/orders/index')
    } catch (e) {
      // 审单预检拦截（起送量/价格等）直接展示后端 message
      Taro.showModal({
        title: '下单未成功',
        content: e instanceof Error ? e.message : '请稍后重试',
        showCancel: false,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className='page cart'>
      <View className='page-head'>
        <View className='page-head__main'>
          <Text className='page-head__title'>购物车</Text>
          <Text className='page-head__sub'>
            {cart.length > 0 ? `共 ${cart.length} 种 · ${pieces} 件` : '还没有加购'}
          </Text>
        </View>
      </View>

      {cart.length === 0 ? (
        <View className='card state'>
          <View className='state__icon'>
            <Icon name='bottle' color='#B3A9A4' size={72} />
          </View>
          <Text className='state__title'>购物车是空的</Text>
          <Text className='state__txt'>选好酒再来结算</Text>
          <Button className='btn-ghost' onClick={() => openAppPage('/pages/customer/products/index')}>
            <Text className='btn-label'>去选酒</Text>
          </Button>
        </View>
      ) : (
        <>
          {cart.map((it, idx) => (
            <View key={`${it.productId}-${it.unit}`} className='card crow'>
              <View className='crow__pic'>
                <Icon name='bottle' color='#7A1F2B' size={64} />
              </View>
              <View className='crow__main'>
                <View className='crow__top'>
                  <View className='crow__info'>
                    <Text className='crow__name'>{it.name}</Text>
                    <Text className='crow__spec'>{it.specText || '—'} · 按{labelOf(UNIT_LABELS, it.unit)}订</Text>
                  </View>
                  <Text className='icon-hit' onClick={() => removeAt(idx)}>
                    <Icon name='trash' color='#6B5F5A' size={40} />
                  </Text>
                </View>
                <View className='crow__bot'>
                  <Text className='num crow__price'>{fmtMoney(toNum(it.price) * it.qty)}</Text>
                  <View className='stepper'>
                    <Button className='stepper__btn' onClick={() => changeQty(idx, -1)}>−</Button>
                    <Text className='stepper__num'>{it.qty}</Text>
                    <Button className='stepper__btn' onClick={() => changeQty(idx, 1)}>＋</Button>
                  </View>
                </View>
              </View>
            </View>
          ))}
          <View className='card'>
            <View className='kv'>
              <Text className='kv__k'>商品合计</Text>
              <Text className='kv__v num'>{fmtMoney(total)}</Text>
            </View>
            {giftText ? <Text className='tip'>{giftText}</Text> : null}
            <View className='info-bar'>
              <Icon name='info' color='#3A6EA5' size={36} />
              <Text className='info-bar__txt'>价格以商家确认为准，确认后通知你</Text>
            </View>
          </View>
        </>
      )}

      <View className='settle'>
        <View>
          <Text className='settle__sum'>{cart.length > 0 ? fmtMoney(total) : '¥0.00'}</Text>
          <Text className='settle__meta'>{cart.length > 0 ? `已选 ${pieces}` : '购物车是空的'}</Text>
        </View>
        <Button
          className='btn-primary'
          loading={submitting}
          disabled={submitting || cart.length === 0}
          onClick={() => { void checkout() }}
        >
          <Text className='btn-label'>去结算</Text>
        </Button>
      </View>
    </View>
  )
}
