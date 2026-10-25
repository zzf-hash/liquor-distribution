import { useRef, useState } from 'react'
import { rememberIdemKey } from '../../../services/idempotency'
import type { IdemSlot } from '../../../services/idempotency'
import { Button, Input, Picker, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import {
  LOGIN_PAGE,
  PAYMENT_METHODS,
  PAYMENT_STATUS_LABELS,
  customersApi,
  fmtDateTime,
  fmtMoney,
  getToken,
  paymentsApi,
} from '../../../services/api'
import type { CustomerRowDTO, PaymentRowDTO } from '../../../services/api'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

/**
 * 收款登记（P1 全员端，内勤）：客户 picker + 金额 + 方式 + 凭证号 → POST /payments
 * （Idempotency-Key 幂等；内勤直录=即确认并 FIFO 销账）；
 * 下方待确认列表 = 业务员上报（GET /payments?status=REPORTED），「确认销账」二次确认后逐单核销。
 */
export default function ClerkPaymentsPage() {
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
      setError(e instanceof Error ? e.message : '加载收款数据失败')
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
      Taro.showToast({ title: '已登记并按先到期先结销账', icon: 'success' })
      setCustomerId('')
      setAmount('')
      setVoucher('')
      void load()
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '登记失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  /** 确认销账（业务员上报的收款）：二次确认弹层后 FIFO 核销 */
  function confirmPay(p: PaymentRowDTO) {
    Taro.showModal({
      title: `确认销账 ${p.paymentNo}`,
      content: `${p.customer?.name ?? ''} ${fmtMoney(p.amount)}（${p.method ?? '未填方式'}）。确认后按先到期先结逐单核销，不可撤销。`,
      confirmText: '确认销账',
      confirmColor: '#7A1F2B',
      success: (res) => {
        if (!res.confirm) return
        void doConfirm(p.id)
      },
    })
  }

  async function doConfirm(id: string) {
    try {
      await paymentsApi.confirm(id)
      Taro.showToast({ title: '已销账', icon: 'success' })
      void load()
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '销账失败', icon: 'none' })
    }
  }

  const selected = customers.find((c) => c.id === customerId)
  const methodIdx = Math.max(0, PAYMENT_METHODS.indexOf(method))

  return (
    <View className='page'>
      <View className='topbar'>
        <Text className='topbar__title'>收款登记</Text>
        <Text className='topbar__link' onClick={() => Taro.navigateTo({ url: '/pages/clerk/home/index' })}>工作台</Text>
      </View>

      {/* 登记表单 */}
      <View className='card'>
        <Text className='card__title'>内勤直录（即确认销账）</Text>
        <Picker
          mode='selector'
          range={customers.map((c) => `${c.name}${c.code ? `（${c.code}）` : ''}`)}
          onChange={(e) => setCustomerId(customers[Number(e.detail.value)]?.id ?? '')}
        >
          <View className='frow'>
            <Text className='frow__label'>客户</Text>
            <Text className={selected ? 'frow__value' : 'frow__placeholder'}>
              {selected ? selected.name : '点此选择客户'}
            </Text>
            <Text className='frow__arrow'>›</Text>
          </View>
        </Picker>
        <View className='frow'>
          <Text className='frow__label'>金额</Text>
          <Input
            className='pay__ipt'
            type='digit'
            placeholder='收款金额'
            value={amount}
            onInput={(e) => setAmount(e.detail.value)}
          />
        </View>
        <Picker
          mode='selector'
          range={PAYMENT_METHODS}
          value={methodIdx}
          onChange={(e) => setMethod(PAYMENT_METHODS[Number(e.detail.value)] ?? PAYMENT_METHODS[0])}
        >
          <View className='frow'>
            <Text className='frow__label'>方式</Text>
            <Text className='frow__value'>{method}</Text>
            <Text className='frow__arrow'>›</Text>
          </View>
        </Picker>
        <View className='frow'>
          <Text className='frow__label'>凭证号</Text>
          <Input
            className='pay__ipt'
            placeholder='转账单号/收据号（选填）'
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
          登记并销账
        </Button>
      </View>

      {/* 业务员上报待确认 */}
      <View className='card'>
        <Text className='card__title'>待确认收款（业务员上报 {pending.length}）</Text>
        {error ? (
          <View className='state'>
            <Text className='state__txt'>{error}</Text>
            <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
          </View>
        ) : loading ? (
          <Text className='tip'>正在加载…</Text>
        ) : pending.length === 0 ? (
          <Text className='tip'>没有待确认的上报收款</Text>
        ) : (
          pending.map((p) => (
            <View key={p.id} className='pcard'>
              <View className='pcard__row'>
                <Text className='pcard__no'>{p.paymentNo}</Text>
                <Text className='tag tag--warn'>{PAYMENT_STATUS_LABELS[p.status] ?? p.status}</Text>
              </View>
              <View className='pcard__row'>
                <Text className='pcard__cust'>{p.customer?.name ?? '-'}</Text>
                <Text className='pcard__amount'>{fmtMoney(p.amount)}</Text>
              </View>
              <View className='pcard__row'>
                <Text className='pcard__meta'>
                  {p.method ?? '未填方式'}{p.voucher ? ` · 凭证 ${p.voucher}` : ''} · {fmtDateTime(p.createdAt)}
                </Text>
              </View>
              <Button className='btn-inline' onClick={() => confirmPay(p)}>确认销账</Button>
            </View>
          ))
        )}
      </View>

      <Text className='tip'>内勤直录立即按「先到期先结」核销；业务员上报需在此确认</Text>
      <RoleTabBar />
    </View>
  )
}
