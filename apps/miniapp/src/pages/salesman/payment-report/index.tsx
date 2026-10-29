import HeroHeader from '../../../components/HeroHeader'
import { useRef, useState } from 'react'
import { rememberIdemKey } from '../../../services/idempotency'
import type { IdemSlot } from '../../../services/idempotency'
import { Button, Input, Picker, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import {
  LOGIN_PAGE,
  PAYMENT_METHODS,
  customersApi,
  fmtDateTime,
  fmtMoney,
  getToken,
  paymentsApi,
} from '../../../services/api'
import type { CustomerRowDTO, PaymentRowDTO } from '../../../services/api'
import './index.scss'

/**
 * 收款上报（P1 全员端，rep）：代收货款上报（客户+金额+方式+凭证 → POST /payments，
 * Idempotency-Key 幂等），状态 REPORTED 待内勤确认后才销账；
 * 下方「我上报的待确认」列表（GET /payments?status=REPORTED，rep 视角全量里自行留档）。
 */
export default function SalesmanPaymentReportPage() {
  const idemRef = useRef<IdemSlot | null>(null)
  const [customers, setCustomers] = useState<CustomerRowDTO[]>([])
  const [customerId, setCustomerId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState(PAYMENT_METHODS[0])
  const [voucher, setVoucher] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pending, setPending] = useState<PaymentRowDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void load()
  })

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [custRes, payRes] = await Promise.all([
        customersApi.list({ pageSize: 200 }),
        paymentsApi.list('REPORTED'),
      ])
      setCustomers(custRes.items ?? [])
      setPending(payRes ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载数据失败')
    } finally {
      setLoading(false)
    }
  }

  async function submit() {
    if (submitting) return
    if (!customerId) {
      Taro.showToast({ title: '请选择客户', icon: 'none' })
      return
    }
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      Taro.showToast({ title: '请输入正确的收款金额', icon: 'none' })
      return
    }
    setSubmitting(true)
    try {
      const payload = {
        customerId,
        amount: Number(amt.toFixed(2)),
        method,
        voucher: voucher.trim() || undefined,
      }
      await paymentsApi.report(payload, rememberIdemKey(idemRef, payload))
      idemRef.current = null
      Taro.showToast({ title: '已上报，待内勤确认', icon: 'success' })
      setCustomerId('')
      setAmount('')
      setVoucher('')
      void load()
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '上报失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  const selected = customers.find((c) => c.id === customerId)

  return (
    <View className='page'>
            <HeroHeader title='收款上报' />

      <View className='card'>
        <Text className='card__title'>代收货款上报</Text>
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
        <View className='frow'>
          <Text className='frow__label'>金额<Text className='frow__req'>*</Text></Text>
          <Input
            className='pr__ipt pr__ipt--num'
            type='digit'
            placeholder='实收金额'
            value={amount}
            onInput={(e) => setAmount(e.detail.value)}
          />
        </View>
        <Text className='frow__label'>方式</Text>
        <View className='seg'>
          {PAYMENT_METHODS.map((item) => (
            <View key={item} className={`seg__item ${method === item ? 'seg__item--on' : ''}`} onClick={() => setMethod(item)}>
              <Text>{item}</Text>
            </View>
          ))}
        </View>
        <View className='frow'>
          <Text className='frow__label'>凭证号</Text>
          <Input
            className='pr__ipt'
            placeholder='转账截图单号/收据号（选填）'
            value={voucher}
            onInput={(e) => setVoucher(e.detail.value)}
          />
        </View>
        <Button
          className='btn-primary'
          loading={submitting}
          disabled={submitting}
          onClick={() => { void submit() }}
        >
          <Text className='btn-label'>提交上报</Text>
        </Button>
        <Text className='pr__note'>上报后状态为「待确认」，内勤确认后才会销账；请勿重复提交同一笔收款</Text>
      </View>

      <View className='card'>
        <Text className='card__title'>待确认收款（{pending.length}）</Text>
        {error ? (
          <View className='state'>
            <Text className='state__txt'>{error}</Text>
            <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
          </View>
        ) : loading ? (
          <Text className='tip'>正在加载…</Text>
        ) : pending.length === 0 ? (
          <Text className='tip'>当前没有待确认的上报收款</Text>
        ) : (
          pending.map((p) => (
            <View key={p.id} className='pr__row'>
              <View className='pr__row-main'>
                <Text className='pr__no num'>{p.paymentNo}</Text>
                <Text className='pr__meta'>{p.customer?.name ?? '-'} · {fmtDateTime(p.createdAt)}</Text>
              </View>
              <Text className='pr__amt num'>{fmtMoney(p.amount)}</Text>
              <Text className='tag tag--warn'>待确认</Text>
            </View>
          ))
        )}
      </View>
    </View>
  )
}
