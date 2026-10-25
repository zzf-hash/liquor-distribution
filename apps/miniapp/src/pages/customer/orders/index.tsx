import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { openAppPage } from '../../../services/navigation'
import { fmtDateTime, fmtMoney, getToken, ordersApi } from '../../../services/api'
import { redirectIfStaffOnCustomerPage } from '../../../services/customer-page-redirect'
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

// 配色档：进行中=主色 / 完成=绿 / 异常=灰或红
const STATUS_TONES: Record<string, string> = {
  PENDING_CONFIRM: 'warn',
  CONFIRMED: 'info',
  OUTBOUND: 'info',
  DELIVERING: 'info',
  SIGNED: 'ok',
  SETTLED: 'ok',
  CANCELLED: 'muted',
  REJECTED: 'danger',
}

/**
 * 我的订单（P0-T51）：GET /orders，客户 token 由服务端自动过滤为自己名下订单。
 */
export default function CustomerOrdersPage() {
  const [items, setItems] = useState<CustomerOrderDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: '/pages/customer/login/index' })
      return
    }
    if (redirectIfStaffOnCustomerPage('pages/customer/orders/index')) return
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

  return (
    <View className='olist'>
      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='olist__tip'>正在加载订单…</Text>
      ) : items.length === 0 ? (
        <View className='state'>
          <Text className='state__txt'>还没有订单，去下一单吧</Text>
          <Button className='btn-primary' onClick={() => openAppPage('/pages/customer/products/index')}>
            去选酒
          </Button>
        </View>
      ) : (
        <View className='olist__body'>
          {items.map((o) => (
            <View key={o.id} className='ocard'>
              <View className='ocard__row'>
                <Text className='ocard__no'>{o.orderNo}</Text>
                <Text className={`tag tag--${STATUS_TONES[o.status] ?? 'muted'}`}>
                  {o.statusLabel || STATUS_LABELS[o.status] || o.status}
                </Text>
              </View>
              <View className='ocard__row'>
                <Text className='ocard__meta'>{fmtDateTime(o.createdAt)} · {o.lineCount ?? 0} 种商品</Text>
                <Text className='ocard__amount'>{fmtMoney(o.totalAmount)}</Text>
              </View>
            </View>
          ))}
          <Text className='olist__tip'>展示最近 50 单；订单进度由商家更新，有疑问请联系您的业务员</Text>
        </View>
      )}
    </View>
  )
}
