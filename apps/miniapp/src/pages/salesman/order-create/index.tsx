import { useRef, useState } from 'react'
import { Button, Input, Picker, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../../components/Icon'
import { rememberIdemKey } from '../../../services/idempotency'
import type { IdemSlot } from '../../../services/idempotency'
import {
  LOGIN_PAGE,
  PRICE_TYPE_LABELS,
  UNIT_LABELS,
  cartKeyOf,
  customersApi,
  fmtMoney,
  getToken,
  ordersApi,
  pricesApi,
  productsApi,
  toNum,
} from '../../../services/api'
import type { CustomerRowDTO, ProductRowDTO, ShopUnit } from '../../../services/api'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'
import HeroHeader from '../../../components/HeroHeader'

interface DraftLine {
  productId: string
  name: string
  unit: ShopUnit
  qty: number
  price: number
  priceType: string
}

/**
 * 代下单（P1 全员端，rep）：选客户（名下）→ 搜商品（GET /products?q=，rep 无 /shop 通道）
 * → 按箱/瓶取价（GET /prices/resolve?customerId&productId&unit）加行 → POST /orders
 * {customerId, source:'REP', lines}。价格仅作展示参考，服务端下单时重新取价快照。
 */
export default function SalesmanOrderCreatePage() {
  const idemRef = useRef<IdemSlot | null>(null)
  const [customers, setCustomers] = useState<CustomerRowDTO[]>([])
  const [customerId, setCustomerId] = useState('')
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<ProductRowDTO[]>([])
  const [searched, setSearched] = useState(false)
  const [lines, setLines] = useState<DraftLine[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void loadCustomers()
  })

  async function loadCustomers() {
    setLoading(true)
    setError('')
    try {
      const res = await customersApi.list({ pageSize: 200 })
      setCustomers(res.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载客户失败')
    } finally {
      setLoading(false)
    }
  }

  async function search() {
    setSearched(true)
    try {
      const res = await productsApi.search(keyword.trim() || undefined)
      setResults(res.items ?? [])
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '搜索失败', icon: 'none' })
    }
  }

  /** 加购：取价成功才入行（无生效价不入，避免下单失败歧义） */
  async function addLine(p: ProductRowDTO, unit: ShopUnit) {
    if (!customerId) {
      Taro.showToast({ title: '请先选择客户（按客户价取价）', icon: 'none' })
      return
    }
    const key = `${p.id}|${unit}`
    if (adding === key) return
    setAdding(key)
    try {
      const price = await pricesApi.resolve(customerId, p.id, unit)
      if (!price || price.price === null || price.price === undefined) {
        Taro.showToast({ title: `${p.name} 无生效价，请联系内勤定价`, icon: 'none' })
        return
      }
      const amt = toNum(price.price)
      setLines((prev) => {
        const idx = prev.findIndex((l) => cartKeyOf(l.productId, l.unit) === key)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = { ...next[idx], qty: next[idx].qty + 1, price: amt, priceType: price.priceType }
          return next
        }
        return [...prev, { productId: p.id, name: p.name, unit, qty: 1, price: amt, priceType: price.priceType }]
      })
      Taro.showToast({ title: `已加 ${p.name}（${UNIT_LABELS[unit]}）`, icon: 'none' })
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '取价失败', icon: 'none' })
    } finally {
      setAdding('')
    }
  }

  function step(line: DraftLine, delta: number) {
    setLines((prev) =>
      prev
        .map((l) => (cartKeyOf(l.productId, l.unit) === cartKeyOf(line.productId, line.unit) ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    )
  }

  async function submit() {
    if (submitting) return
    if (!customerId) {
      Taro.showToast({ title: '请选择客户', icon: 'none' })
      return
    }
    if (lines.length === 0) {
      Taro.showToast({ title: '请先加购商品行', icon: 'none' })
      return
    }
    setSubmitting(true)
    try {
      const payload = {
        customerId,
        lines: lines.map((l) => ({ productId: l.productId, unit: l.unit, qty: l.qty })),
      }
      const res = await ordersApi.repCreate(payload, rememberIdemKey(idemRef, payload))
      idemRef.current = null
      Taro.showModal({
        title: `下单成功 ${res.orderNo}`,
        content: `订单已进入订单池（待内勤确认），金额 ${fmtMoney(res.totalAmount)}。`,
        showCancel: false,
      })
      setLines([])
    } catch (e) {
      Taro.showModal({
        title: '下单失败',
        content: e instanceof Error ? e.message : '请稍后重试',
        showCancel: false,
      })
    } finally {
      setSubmitting(false)
    }
  }

  const selected = customers.find((c) => c.id === customerId)
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0)

  return (
    <View className='page'>
            <HeroHeader title='代下单' />

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void loadCustomers() }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='tip'>正在加载…</Text>
      ) : (
        <>
          {/* 选客户 */}
          <View className='card'>
            <Text className='card__title'>① 选择客户（按客户价取价）</Text>
            <Picker
              mode='selector'
              range={customers.map((c) => `${c.name}${c.code ? `（${c.code}）` : ''}`)}
              onChange={(e) => setCustomerId(customers[Number(e.detail.value)]?.id ?? '')}
            >
              <View className='frow'>
                <Text className='frow__label'>客户<Text className='frow__req'>*</Text></Text>
                <Text className={selected ? 'frow__value' : 'frow__placeholder'}>
                  {selected ? selected.name : '点此选择客户'}
                </Text>
                <Text className='frow__arrow'>›</Text>
              </View>
            </Picker>
          </View>

          {/* 搜商品加行 */}
          <View className='card'>
            <Text className='card__title'>② 搜索商品加行</Text>
            <View className='search-pill oc__search'>
              <Icon name='search' color='#6B5F5A' size={44} />
              <Input
                className='search-pill__input'
                placeholder='品名 / 编码 / 拼音首字母'
                value={keyword}
                confirmType='search'
                onInput={(e) => setKeyword(e.detail.value)}
                onConfirm={search}
              />
              <Button className='btn-ghost btn-sm oc__search-btn' onClick={() => { void search() }}>
                <Text className='btn-label'>搜索</Text>
              </Button>
            </View>
            {searched && results.length === 0 && <Text className='tip'>没有匹配的商品</Text>}
            {results.map((p) => (
              <View key={p.id} className='oc__prod'>
                <View className='oc__prod-main'>
                  <Text className='oc__prod-name'>{p.name}</Text>
                  <Text className='oc__prod-sub'>
                    {p.specText ? `${p.specText} · ` : ''}{p.skuCode ?? ''}
                    {p.packSize && p.packSize > 1 ? ` · 1${p.baseUnit ?? '箱'}=${p.packSize}${p.minUnit ?? '瓶'}` : ''}
                  </Text>
                </View>
                <View className='oc__prod-ops'>
                  <Button
                    className='btn-inline btn-inline--ghost oc__add'
                    disabled={adding === `${p.id}|BASE`}
                    onClick={() => { void addLine(p, 'BASE') }}
                  >
                    +箱
                  </Button>
                  <Button
                    className='btn-inline btn-inline--ghost oc__add'
                    disabled={adding === `${p.id}|MIN`}
                    onClick={() => { void addLine(p, 'MIN') }}
                  >
                    +瓶
                  </Button>
                </View>
              </View>
            ))}
          </View>

          {/* 已加行 */}
          <View className='card'>
            <Text className='card__title'>③ 已加行（{lines.length}）</Text>
            {lines.length === 0 ? (
              <Text className='tip'>还没有加购商品</Text>
            ) : (
              lines.map((l) => (
                <View key={cartKeyOf(l.productId, l.unit)} className='oc__line'>
                  <View className='oc__line-main'>
                    <Text className='oc__prod-name'>{l.name}</Text>
                    <Text className='oc__prod-sub'>
                      {fmtMoney(l.price)}/{UNIT_LABELS[l.unit] ?? l.unit} · {PRICE_TYPE_LABELS[l.priceType] ?? l.priceType}
                    </Text>
                  </View>
                  <View className='stepper'>
                    <Button className='stepper__btn' onClick={() => step(l, -1)}>−</Button>
                    <Text className='stepper__num'>{l.qty}</Text>
                    <Button className='stepper__btn' onClick={() => step(l, 1)}>＋</Button>
                  </View>
                </View>
              ))
            )}
          </View>

          <View className='settle'>
            <View>
              <Text className='settle__sum'>{fmtMoney(total)}</Text>
              <Text className='settle__meta'>预估金额，以服务端快照为准</Text>
            </View>
            <Button
              className='btn-primary settle__go'
              loading={submitting}
              disabled={submitting || lines.length === 0}
              onClick={() => { void submit() }}
            >
              <Text className='btn-label'>提交订单</Text>
            </Button>
          </View>
        </>
      )}
      <RoleTabBar />
    </View>
  )
}
