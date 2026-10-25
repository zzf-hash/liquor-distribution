import { useRef, useState } from 'react'
import { rememberIdemKey } from '../../../services/idempotency'
import type { IdemSlot } from '../../../services/idempotency'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { readRouteQuery } from '../../../services/route-param'
import {
  LOGIN_PAGE,
  fmtDate,
  fmtDateTime,
  getToken,
  outboundsApi,
  toNum,
} from '../../../services/api'
import type { OutboundRowDTO } from '../../../services/api'
import './index.scss'

/**
 * 出库单复核（P1 全员端，仓配）：无单条详情接口，按 outboundNo 从列表接口（全量）取单；
 * FIFO 建议批次行=品名/数量/批次号；「复核确认出库」POST /orders/outbounds/:no/confirm，
 * Idempotency-Key 按出库单号保持稳定，失败重试复用，成功后下一张再换。写不可变库存流水并推进订单状态。
 */
export default function WarehouseOutboundPage() {
  const idemRef = useRef<IdemSlot | null>(null)
  const [no, setNo] = useState('')
  const [ob, setOb] = useState<OutboundRowDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    const q = readRouteQuery()
    const paramNo = q.no ?? ''
    if (paramNo && paramNo !== no) {
      setNo(paramNo)
      void load(paramNo)
    }
  })

  async function load(outboundNo: string) {
    setLoading(true)
    setError('')
    try {
      const res = await outboundsApi.list()
      const found = (res.items ?? []).find((x) => x.outboundNo === outboundNo) ?? null
      if (!found) {
        setError('出库单不存在或已被处理')
        return
      }
      setOb(found)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载出库单失败')
    } finally {
      setLoading(false)
    }
  }

  function confirm() {
    if (!ob || submitting) return
    Taro.showModal({
      title: `复核确认出库 ${ob.outboundNo}`,
      content: '确认按上述 FIFO 批次完成拣货并复核无误？出库后写入库存流水，不可撤销。',
      confirmText: '确认出库',
      confirmColor: '#7A1F2B',
      success: (res) => {
        if (res.confirm) void doConfirm()
      },
    })
  }

  async function doConfirm() {
    if (!ob) return
    setSubmitting(true)
    try {
      await outboundsApi.confirm(ob.outboundNo, rememberIdemKey(idemRef, { outboundNo: ob.outboundNo }))
      idemRef.current = null
      Taro.showToast({ title: '已出库', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 600)
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '出库失败', icon: 'none' })
      setSubmitting(false)
    }
  }

  if (error) {
    return (
      <View className='page'>
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => Taro.navigateBack()}>返回列表</Button>
        </View>
      </View>
    )
  }
  if (loading || !ob) {
    return (
      <View className='page'>
        <Text className='tip'>正在加载出库单…</Text>
      </View>
    )
  }

  const pickingTotal = (ob.lines ?? []).reduce((s, l) => s + toNum(l.qty), 0)

  return (
    <View className='page'>
      {/* 单头 */}
      <View className='card'>
        <View className='obd__row'>
          <Text className='obd__no'>{ob.outboundNo}</Text>
          <Text className={`tag tag--${ob.status === 'PICKING' ? 'warn' : 'ok'}`}>
            {ob.status === 'PICKING' ? '待复核' : '已出库'}
          </Text>
        </View>
        <View className='obd__row'>
          <Text className='obd__cust'>{ob.order?.customerName ?? '-'}</Text>
          <Text className='obd__meta'>订单 {ob.order?.orderNo ?? '-'}</Text>
        </View>
        <View className='kv'><Text className='kv__k'>送货地址</Text><Text className='kv__v'>{ob.order?.addressSnapshot || '-'}</Text></View>
        <View className='kv'><Text className='kv__k'>要求送达</Text><Text className='kv__v'>{ob.order?.deliveryDate ? fmtDate(ob.order.deliveryDate) : '-'}</Text></View>
        <View className='kv'><Text className='kv__k'>建单时间</Text><Text className='kv__v'>{fmtDateTime(ob.createdAt)}</Text></View>
      </View>

      {/* FIFO 建议批次行 */}
      <View className='card'>
        <Text className='card__title'>拣货批次（FIFO 先到期先出，共 {pickingTotal} 件最小单位）</Text>
        {(ob.lines ?? []).map((l, i) => {
          const rate = l.orderLine?.conversionRate ?? 1
          const qty = toNum(l.qty)
          return (
            <View key={l.id ?? i} className='fifo'>
              <View className='fifo__row'>
                <Text className='fifo__name'>{l.orderLine?.productName ?? '-'}</Text>
                <Text className='fifo__qty'>{qty} 件</Text>
              </View>
              <Text className='fifo__sub'>
                批次号 {l.batch?.batchNo ?? '-'}
                {rate > 1 && qty >= rate && Number.isInteger(qty / rate) ? `（≈ ${qty / rate} ${l.orderLine?.unit === 'BASE' ? '箱' : '件'}）` : ''}
                {' · '}订单量 {toNum(l.orderLine?.qty)}{l.orderLine?.unit === 'BASE' ? '箱' : '瓶'}
              </Text>
            </View>
          )
        })}
      </View>

      {ob.status === 'PICKING' ? (
        <Button
          className='btn-primary'
          loading={submitting}
          disabled={submitting}
          onClick={confirm}
        >
          复核确认出库
        </Button>
      ) : (
        <Text className='tip'>该出库单已确认，回冲/差异走签收环节处理</Text>
      )}
    </View>
  )
}
