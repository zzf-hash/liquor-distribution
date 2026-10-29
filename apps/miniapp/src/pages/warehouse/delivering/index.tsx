import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import {
  LOGIN_PAGE,
  ORDER_STATUS_LABELS,
  fmtDateTime,
  fmtMoney,
  getToken,
  ordersApi,
} from '../../../services/api'
import type { StaffOrderRowDTO } from '../../../services/api'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

type TabKey = 'OUTBOUND' | 'DELIVERING'

/**
 * 发运签收（P1 全员端，仓配）：待发运（GET /orders?status=OUTBOUND）+「发运」
 * （POST :id/deliver，OUTBOUND→DELIVERING）；配送中列表 +「去签收」进签收页。
 * 支持宫格直达：?tab=delivering。
 */
export default function WarehouseDeliveringPage() {
  const [tab, setTab] = useState<TabKey>('OUTBOUND')
  const [items, setItems] = useState<StaffOrderRowDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [shipping, setShipping] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    const pages = Taro.getCurrentPages()
    const cur = pages[pages.length - 1]
    const q = (cur as { options?: Record<string, string> })?.options ?? {}
    // 宫格「去签收」磁贴直达配送中 tab；显式传参避免 setTab 同拍取旧值
    let which: TabKey | undefined
    if (q.tab === 'delivering') {
      if (tab !== 'DELIVERING') setTab('DELIVERING')
      which = 'DELIVERING'
    }
    void load(which)
  })

  async function load(which?: TabKey) {
    setLoading(true)
    setError('')
    try {
      const res = await ordersApi.staffList({ status: which ?? tab, pageSize: 50 })
      setItems(res.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载订单失败')
    } finally {
      setLoading(false)
    }
  }

  function switchTab(next: TabKey) {
    if (tab === next) return
    setTab(next)
    void load(next)
  }

  async function deliver(o: StaffOrderRowDTO) {
    if (shipping) return
    Taro.showModal({
      title: `发运 ${o.orderNo}`,
      content: `确认货已装车发出？发运后订单进入「配送中」，司机送达后签收。`,
      confirmText: '确认发运',
      confirmColor: '#7A1F2B',
      success: (res) => {
        if (res.confirm) void doDeliver(o.id)
      },
    })
  }

  async function doDeliver(id: string) {
    setShipping(id)
    try {
      await ordersApi.deliver(id)
      Taro.showToast({ title: '已发运', icon: 'success' })
      void load()
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '发运失败', icon: 'none' })
    } finally {
      setShipping('')
    }
  }

  return (
    <View className='page'>
      <View className='topbar topbar--hero'>
        <Text className='topbar__title'>发运签收</Text>
        <Button className='btn-hero' onClick={() => Taro.navigateTo({ url: '/pages/warehouse/home/index' })}>
          <Text className='btn-hero__txt'>工作台</Text>
        </Button>
      </View>

      <View className='tabs tabs--segment'>
        <Button className={`tabs__btn ${tab === 'OUTBOUND' ? 'tabs__btn--on' : ''}`} onClick={() => switchTab('OUTBOUND')}>
          待发运
        </Button>
        <Button className={`tabs__btn ${tab === 'DELIVERING' ? 'tabs__btn--on' : ''}`} onClick={() => switchTab('DELIVERING')}>
          配送中
        </Button>
      </View>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='tip'>正在加载…</Text>
      ) : items.length === 0 ? (
        <View className='state'>
          <Text className='state__title'>{tab === 'OUTBOUND' ? '没有待发运订单' : '没有配送中订单'}</Text>
          <Text className='state__txt'>{tab === 'OUTBOUND' ? '拣货复核完成后，订单会出现在这里' : '发运之后，送达的单在这里签收'}</Text>
        </View>
      ) : (
        items.map((o) => (
          <View key={o.id} className='card dcard'>
            <View className='dcard__row'>
              <Text className='dcard__no'>{o.orderNo}</Text>
              <Text className='dcard__status'>{ORDER_STATUS_LABELS[o.status] ?? o.status}</Text>
            </View>
            <View className='dcard__row'>
              <Text className='dcard__cust'>{o.customerName}</Text>
              <Text className='dcard__amount'>{fmtMoney(o.totalAmount)}</Text>
            </View>
            <View className='dcard__row'>
              <Text className='dcard__meta'>
                {o.lineCount ?? 0} 种 · {fmtDateTime(o.createdAt)}
                {o.addressSnapshot ? ` · ${o.addressSnapshot}` : ''}
              </Text>
            </View>
            {tab === 'OUTBOUND' ? (
              <Button
                className='btn-primary btn-sm'
                loading={shipping === o.id}
                disabled={shipping !== ''}
                onClick={() => { void deliver(o) }}
              >
                <Text className='btn-label'>发运</Text>
              </Button>
            ) : (
              <Button
                className='btn-ghost btn-sm'
                onClick={() => Taro.navigateTo({
                  url: `/pages/warehouse/sign/index?id=${o.id}&no=${encodeURIComponent(o.orderNo)}`,
                })}
              >
                <Text className='btn-label'>去签收</Text>
              </Button>
            )}
          </View>
        ))
      )}
      <RoleTabBar />
    </View>
  )
}
