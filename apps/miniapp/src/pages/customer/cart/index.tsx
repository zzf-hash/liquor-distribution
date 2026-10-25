import { useRef, useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { rememberIdemKey } from '../../../services/idempotency'
import type { IdemSlot } from '../../../services/idempotency'
import { openAppPage } from '../../../services/navigation'
import { previewGiftLines } from '../../../services/gift-preview'
import type { GiftPreviewLine, GiftRule } from '../../../services/gift-preview'
import {
  UNIT_LABELS,
  cartQty,
  fmtMoney,
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
      Taro.reLaunch({ url: '/pages/customer/login/index' })
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
    : giftNote || '当前没有命中的买赠。'

  function changeQty(idx: number, delta: number) {
    const next = cart.map((c) => ({ ...c }))
    const q = next[idx].qty + delta
    if (q <= 0) next.splice(idx, 1)
    else next[idx].qty = q
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
        content: `共 ${cartQty(cart)} 件商品，合计约 ${fmtMoney(total)}。${giftText}提交后商家会尽快确认安排送货。`,
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

  if (cart.length === 0) {
    return (
      <View className='state'>
        <Text className='state__txt'>购物车是空的</Text>
        <Button className='btn-primary' onClick={() => openAppPage('/pages/customer/products/index')}>
          去选酒
        </Button>
      </View>
    )
  }

  return (
    <View className='cart'>
      <View className='cart__list'>
        {cart.map((it, idx) => (
          <View key={`${it.productId}-${it.unit}`} className='crow'>
            <View className='crow__info'>
              <Text className='crow__name'>{it.name}</Text>
              <Text className='crow__spec'>{it.specText || '—'} · 按{labelOf(UNIT_LABELS, it.unit)}订</Text>
              <Text className='crow__line'>{fmtMoney(it.price)} × {it.qty} ＝ {fmtMoney(toNum(it.price) * it.qty)}</Text>
            </View>
            <View className='stepper'>
              <Button className='stepper__btn' onClick={() => changeQty(idx, -1)}>−</Button>
              <Text className='stepper__num'>{it.qty}</Text>
              <Button className='stepper__btn stepper__btn--plus' onClick={() => changeQty(idx, 1)}>＋</Button>
            </View>
          </View>
        ))}
        <Text className='cart__tip'>{giftText}</Text>
        <Text className='cart__tip'>减到 0 即移除该商品；金额为参考，成交价以商家核算为准</Text>
      </View>

      <View className='cartbar'>
        <View className='cartbar__sum'>
          <Text className='cartbar__label'>合计约</Text>
          <Text className='cartbar__amount'>{fmtMoney(total)}</Text>
        </View>
        <Button
          className='cartbar__btn'
          loading={submitting}
          disabled={submitting}
          onClick={() => { void checkout() }}
        >
          去结算
        </Button>
      </View>
    </View>
  )
}
