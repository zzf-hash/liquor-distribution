import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import TabsScroll from '../../../components/TabsScroll'
import Taro, { useDidShow } from '@tarojs/taro'
import {
  LOGIN_PAGE,
  ORDER_SOURCE_LABELS,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONES,
  fmtDateTime,
  fmtMoney,
  getToken,
  ordersApi,
} from '../../../services/api'
import type { StaffOrderRowDTO } from '../../../services/api'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'
import HeroHeader from '../../../components/HeroHeader'

// 订单池 tab（与后端 OrderStatus 对齐；已取消/已拒收走服务端历史，不单设 tab）
const TABS: Array<{ key: string; label: string }> = [
  { key: 'PENDING_CONFIRM', label: '待确认' },
  { key: 'CONFIRMED', label: '已确认' },
  { key: 'OUTBOUND', label: '出库' },
  { key: 'DELIVERING', label: '配送' },
  { key: 'SIGNED', label: '签收' },
  { key: 'SETTLED', label: '已销账' },
]

/**
 * 订单池（P1 全员端，内勤/老板共用）：GET /orders?status= 分状态 tab；
 * 行点击进详情（确认/取消/特批在详情页，按角色显隐）。仓库端也可查单跟踪。
 */
export default function ClerkOrdersPage() {
  const [tab, setTab] = useState('PENDING_CONFIRM')
  const [items, setItems] = useState<StaffOrderRowDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void load()
  })

  async function load(status?: string) {
    setLoading(true)
    setError('')
    try {
      const res = await ordersApi.staffList({ status: status ?? tab, pageSize: 50 })
      setItems(res.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载订单失败')
    } finally {
      setLoading(false)
    }
  }

  function switchTab(next: string) {
    if (tab === next) return
    setTab(next)
    void load(next)
  }

  return (
    <View className='page'>
            <HeroHeader title='订单' />

      <TabsScroll intoView={`tab-${tab}`}>
        {TABS.map((t) => (
          <Button
            id={`tab-${t.key}`}
            key={t.key}
            className={`tabs__btn ${tab === t.key ? 'tabs__btn--on' : ''}`}
            onClick={() => switchTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </TabsScroll>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='tip'>正在加载订单…</Text>
      ) : items.length === 0 ? (
        <View className='state'>
          <Text className='state__title'>这个状态下没有订单</Text>
          <Text className='state__txt'>
            {TABS.find((t) => t.key === tab)?.label ?? '当前'}的订单会显示在这里
          </Text>
        </View>
      ) : (
        items.map((o) => (
          <View
            key={o.id}
            className='card ocard'
            onClick={() => Taro.navigateTo({ url: `/pages/clerk/order-detail/index?id=${o.id}` })}
          >
            <View className='ocard__row'>
              <Text className='ocard__no'>{o.orderNo}</Text>
              <Text className={`tag tag--${ORDER_STATUS_TONES[o.status] ?? 'muted'}`}>
                {ORDER_STATUS_LABELS[o.status] ?? o.status}
              </Text>
            </View>
            <View className='ocard__row'>
              <Text className='ocard__cust'>{o.customerName}</Text>
              <Text className='ocard__amount'>{fmtMoney(o.totalAmount)}</Text>
            </View>
            <View className='ocard__row'>
              <Text className='ocard__meta'>
                {ORDER_SOURCE_LABELS[o.source] ?? o.source} · {o.lineCount ?? 0} 种 · {fmtDateTime(o.createdAt)}
              </Text>
              {o.specialApproved ? <Text className='tag tag--warn'>已特批</Text> : null}
            </View>
          </View>
        ))
      )}

      {items.length > 0 && <Text className='tip'>点击订单查看明细与操作 · 已取消/已拒收单据见后台</Text>}
      <RoleTabBar />
    </View>
  )
}
