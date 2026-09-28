import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro'
import { LOGIN_PAGE, fmtDateTime, getToken, outboundsApi, toNum } from '../../../services/api'
import type { OutboundRowDTO } from '../../../services/api'
import './index.scss'

/**
 * 拣货工作台（P1 全员端，仓配）：GET /orders/outbounds?status=PICKING 待拣货复核列表，
 * 行=outboundNo/客户/地址/行数；点击进出库单详情按 FIFO 批次建议拣货并「复核确认出库」。
 */
export default function WarehouseOutboundsPage() {
  const [items, setItems] = useState<OutboundRowDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void load()
  })

  usePullDownRefresh(() => {
    void load().finally(() => Taro.stopPullDownRefresh())
  })

  async function load() {
    setLoading(true)
    setError('')
    try {
      const res = await outboundsApi.list('PICKING')
      setItems(res.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载拣货任务失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <View className='page'>
      <View className='topbar'>
        <Text className='topbar__title'>拣货工作台</Text>
        <Text className='topbar__link' onClick={() => Taro.navigateTo({ url: '/pages/warehouse/home/index' })}>工作台</Text>
      </View>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='tip'>正在加载拣货任务…</Text>
      ) : items.length === 0 ? (
        <View className='state'>
          <Text className='state__txt'>当前没有待拣货的出库单</Text>
        </View>
      ) : (
        items.map((ob) => (
          <View
            key={ob.id}
            className='card obcard'
            onClick={() => Taro.navigateTo({ url: `/pages/warehouse/outbound/index?no=${encodeURIComponent(ob.outboundNo)}` })}
          >
            <View className='obcard__row'>
              <Text className='obcard__no'>{ob.outboundNo}</Text>
              <Text className='tag tag--info'>{(ob.lines ?? []).length} 行</Text>
            </View>
            <View className='obcard__row'>
              <Text className='obcard__cust'>{ob.order?.customerName ?? '-'}</Text>
              <Text className='obcard__meta'>订单 {ob.order?.orderNo ?? '-'}</Text>
            </View>
            <View className='obcard__row'>
              <Text className='obcard__addr'>{ob.order?.addressSnapshot || '无地址备注'}</Text>
            </View>
            <View className='obcard__row'>
              <Text className='obcard__meta'>
                建议拣货 {(ob.lines ?? []).reduce((s, l) => s + toNum(l.qty), 0)} 件（最小单位）· {fmtDateTime(ob.createdAt)}
              </Text>
              <Text className='obcard__go'>去复核 ›</Text>
            </View>
          </View>
        ))
      )}

      {items.length > 0 && <Text className='tip'>按系统给出的 FIFO 批次建议拣货，复核无误后确认出库</Text>}
    </View>
  )
}
