import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import TabsScroll from '../../../components/TabsScroll'
import { openAppPage } from '../../../services/navigation'
import { ORDER_STATUS_TONES, fmtDateTime, fmtMoney, getToken, ordersApi } from '../../../services/api'
import type { CustomerOrderDTO } from '../../../services/api'
import './index.scss'

// 客户视角的订单状态措辞（枚举对齐后端 OrderStatus）
const STATUS_LABELS: Record<string, string> = {
  PENDING_CONFIRM: '待商家确认',
  CONFIRMED: '商家已确认',
  OUTBOUND: '已出库',
  DELIVERING: '配送中',
  SIGNED: '已签收',
  SETTLED: '已结清',
  CANCELLED: '已取消',
  REJECTED: '已拒收',
}

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'ALL', label: '全部' },
  { key: 'PENDING_CONFIRM', label: '待确认' },
  { key: 'DELIVERING', label: '配送中' },
  { key: 'SIGNED', label: '已签收' },
  { key: 'CANCELLED', label: '已取消' },
  { key: 'REJECTED', label: '已拒收' },
]

/**
 * 我的订单（P0-T51）：GET /orders，客户 token 由服务端自动过滤为自己名下订单。
 * 状态胶囊只在已加载的列表里筛选，不另发请求。
 */
export default function CustomerOrdersPage() {
  const [items, setItems] = useState<CustomerOrderDTO[]>([])
  const [filter, setFilter] = useState('ALL')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: '/pages/customer/login/index' })
      return
    }
    void load()
  })

  async function load() {
    setLoading(true)
    setError('')
    try {
      const res = await ordersApi.mine({ page: 1, pageSize: 50 })
      setItems(res.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载订单失败')
    } finally {
      setLoading(false)
    }
  }

  const shown = filter === 'ALL' ? items : items.filter((o) => o.status === filter)

  return (
    <View className='page olist'>
      <View className='page-head'>
        <View className='page-head__main'>
          <Text className='page-head__title'>我的订单</Text>
          <Text className='page-head__sub'>最近 50 单</Text>
        </View>
      </View>

      <TabsScroll>
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            className={`tabs__btn ${filter === f.key ? 'tabs__btn--on' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
      </TabsScroll>

      {error ? (
        <View className='state'>
          <Text className='state__title'>没加载出来</Text>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-ghost' onClick={() => { void load() }}>
            <Text className='btn-label'>重新加载</Text>
          </Button>
        </View>
      ) : loading ? (
        <Text className='tip'>正在加载订单…</Text>
      ) : shown.length === 0 ? (
        <View className='card state'>
          <Text className='state__title'>{filter === 'ALL' ? '还没有订单' : '这个状态下没有订单'}</Text>
          <Text className='state__txt'>去选酒下一单，进度会显示在这里</Text>
          <Button className='btn-ghost' onClick={() => openAppPage('/pages/customer/products/index')}>
            <Text className='btn-label'>去选酒</Text>
          </Button>
        </View>
      ) : (
        <View className='olist__body'>
          {shown.map((o) => (
            <View key={o.id} className='card ocard'>
              <View className='ocard__row'>
                <Text className='num ocard__no'>{o.orderNo}</Text>
                <Text className={`tag tag--${ORDER_STATUS_TONES[o.status] ?? 'muted'}`}>
                  {o.statusLabel || STATUS_LABELS[o.status] || o.status}
                </Text>
              </View>
              <View className='ocard__row'>
                <Text className='ocard__meta'>{fmtDateTime(o.createdAt)} · {o.lineCount ?? 0} 种商品</Text>
                <Text className='num ocard__amount'>{fmtMoney(o.totalAmount)}</Text>
              </View>
              <View className='ocard__ops'>
                <Button
                  className='btn-ghost btn-sm'
                  onClick={() => openAppPage('/pages/customer/products/index')}
                >
                  <Text className='btn-label'>再来一单</Text>
                </Button>
              </View>
            </View>
          ))}
          <Text className='tip'>订单进度由商家更新，有疑问请联系您的业务员</Text>
        </View>
      )}
    </View>
  )
}
