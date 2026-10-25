import { useRef, useState } from 'react'
import { rememberIdemKey } from '../../../services/idempotency'
import type { IdemSlot } from '../../../services/idempotency'
import { Button, Input, Picker, Text, Textarea, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import {
  CAP_RECYCLE_STATUS_LABELS,
  LOGIN_PAGE,
  capFeesApi,
  fmtDateTime,
  fmtMoney,
  getToken,
} from '../../../services/api'
import type { CapPolicyDTO, CapRecycleDTO, CustomerRowDTO } from '../../../services/api'
import './index.scss'

interface RecycleLine {
  policy: CapPolicyDTO
  qty: string
}

/**
 * 瓶盖回收登记（B组 M7-7，业务员）：选客户 → 按政策商品逐行填回收瓶盖数 →
 * 提交待出纳确认兑付（确认后生成开瓶费费用单进审批，可冲抵货款）。
 * 「不回瓶盖」模式的商品无需登记（系统按月自动计提）。
 */
export default function CapRecyclePage() {
  const idemRef = useRef<IdemSlot | null>(null)
  const [customers, setCustomers] = useState<CustomerRowDTO[]>([])
  const [policies, setPolicies] = useState<CapPolicyDTO[]>([])
  const [customerIdx, setCustomerIdx] = useState(0)
  const [lines, setLines] = useState<RecycleLine[]>([])
  const [note, setNote] = useState('')
  const [history, setHistory] = useState<CapRecycleDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const capPolicies = policies.filter((p) => p.requireCap)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void load()
  })

  async function load() {
    setLoading(true)
    try {
      const { customersApi } = await import('../../../services/api')
      const [mine, policyRes, recycleRes] = await Promise.all([
        customersApi.list({ page: 1, pageSize: 200 }),
        capFeesApi.policies(),
        capFeesApi.myRecycles(),
      ])
      setCustomers(mine.items ?? [])
      setPolicies(policyRes as CapPolicyDTO[])
      setHistory((recycleRes as { items: CapRecycleDTO[] }).items ?? [])
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '加载失败', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  function setLine(i: number, patch: Partial<RecycleLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  const totalAmount = lines.reduce((s, l) => {
    const qty = Number(l.qty)
    return s + (Number.isFinite(qty) && qty > 0 ? qty * l.policy.perBottleFee : 0)
  }, 0)

  async function submit() {
    if (submitting) return
    const customer = customers[customerIdx]
    if (!customer) {
      Taro.showToast({ title: '请先选择客户', icon: 'none' })
      return
    }
    const valid = lines
      .map((l) => ({ productId: l.policy.productId, qty: Math.trunc(Number(l.qty)) }))
      .filter((l) => Number.isFinite(l.qty) && l.qty > 0)
    if (valid.length === 0) {
      Taro.showToast({ title: '至少填写一行回收数量', icon: 'none' })
      return
    }
    setSubmitting(true)
    try {
      const payload = {
        customerId: customer.id,
        lines: valid,
        note: note.trim() || undefined,
      }
      const res = await capFeesApi.createRecycle(payload, rememberIdemKey(idemRef, payload))
      idemRef.current = null
      Taro.showToast({ title: `已登记 ${res.recycleNo}`, icon: 'success' })
      setLines([])
      setNote('')
      void load()
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '提交失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <View className='page'>
        <Text className='tip'>正在加载…</Text>
      </View>
    )
  }

  return (
    <View className='page'>
      <View className='topbar'>
        <Text className='topbar__title'>瓶盖回收</Text>
        <Text className='topbar__link' onClick={() => Taro.navigateTo({ url: '/pages/salesman/home/index' })}>工作台</Text>
      </View>

      <View className='card'>
        <Text className='card__title'>客户</Text>
        <Picker
          mode='selector'
          range={customers.length ? customers.map((c) => `${c.name}（${c.code ?? ''}）`) : ['暂无名下客户']}
          value={Math.min(customerIdx, Math.max(0, customers.length - 1))}
          onChange={(e) => setCustomerIdx(Number(e.detail.value))}
        >
          <View className='frow'>
            <Text className='frow__label'>客户</Text>
            <Text className='frow__value'>{customers[customerIdx]?.name ?? '请选择'}</Text>
            <Text className='frow__arrow'>›</Text>
          </View>
        </Picker>
      </View>

      <View className='card'>
        <Text className='card__title'>回收明细（仅回瓶盖政策商品）</Text>
        {lines.map((l, i) => (
          <View key={l.policy.id} className='crline'>
            <View className='crline__row'>
              <Text className='crline__name'>{l.policy.productName}</Text>
              <Text className='crline__fee'>{fmtMoney(l.policy.perBottleFee)}/瓶</Text>
            </View>
            <View className='crline__ops'>
              <Text className='crline__label'>瓶盖数</Text>
              <Input
                className='crline__ipt'
                type='number'
                placeholder='0'
                value={l.qty}
                onInput={(e) => setLine(i, { qty: e.detail.value })}
              />
              <Text className='crline__amt'>
                {Number(l.qty) > 0 ? fmtMoney(Number(l.qty) * l.policy.perBottleFee) : '—'}
              </Text>
              <Text className='crline__del' onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}>删除</Text>
            </View>
          </View>
        ))}
        {capPolicies.length > 0 ? (
          <Picker
            mode='selector'
            range={capPolicies.map((p) => `${p.productName}（${fmtMoney(p.perBottleFee)}/瓶）`)}
            onChange={(e) => {
              const p = capPolicies[Number(e.detail.value)]
              if (p && !lines.some((l) => l.policy.id === p.id)) setLines((prev) => [...prev, { policy: p, qty: '' }])
            }}
          >
            <Button className='btn-ghost btn-sm'>＋ 添加商品</Button>
          </Picker>
        ) : (
          <View className='state'>
            <Text className='state__title'>没有可登记的瓶盖政策</Text>
            <Text className='state__txt'>不回瓶盖的商品由系统按月自动计提，无需在这里登记</Text>
          </View>
        )}
        <View className='frow'>
          <Text className='frow__label'>备注</Text>
          <Textarea
            className='crnote'
            placeholder='选填，如：本月两次到店合并回收'
            value={note}
            maxlength={100}
            onInput={(e) => setNote(e.detail.value)}
          />
        </View>
        {lines.length > 0 && (
          <View className='crtotal'>
            <Text className='crtotal__label'>预计兑付</Text>
            <Text className='crtotal__amt'>{fmtMoney(totalAmount)}</Text>
            <Text className='crtotal__note'>出纳确认后生成开瓶费费用单（进审批，可冲抵货款）</Text>
          </View>
        )}
      </View>

      <Button
        className='btn-primary'
        loading={submitting}
        disabled={submitting}
        onClick={() => { void submit() }}
      >
        提交回收登记
      </Button>

      <View className='card'>
        <Text className='card__title'>我的回收单</Text>
        {history.length === 0 ? (
          <Text className='tip'>暂无回收记录</Text>
        ) : history.map((r) => (
          <View key={r.id} className='crhist'>
            <View className='crhist__row'>
              <Text className='crhist__no'>{r.recycleNo}</Text>
              <Text className={`tag tag--${r.status === 'CONFIRMED' ? 'ok' : r.status === 'CANCELLED' ? 'muted' : 'warn'}`}>
                {CAP_RECYCLE_STATUS_LABELS[r.status] ?? r.status}
              </Text>
            </View>
            <View className='crhist__row'>
              <Text className='crhist__meta'>{r.customer.name} · {r.lines.map((l) => `${l.productName}×${l.qty}`).join('；')}</Text>
              <Text className='crhist__amt'>{fmtMoney(r.totalAmount)}</Text>
            </View>
            <View className='crhist__row'>
              <Text className='crhist__meta'>{fmtDateTime(r.createdAt)}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}
