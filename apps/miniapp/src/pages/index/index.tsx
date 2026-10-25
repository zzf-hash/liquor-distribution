import { useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../components/Icon'
import RoleTabBar from '../../components/RoleTabBar'
import { homeEntriesForRole } from '../../config/home-entries'
import { getRole, getToken, getUserName, fmtMoney, ordersApi, receivablesApi } from '../../services/api'
import type { CustomerOrderDTO } from '../../services/api'
import { openAppPage } from '../../services/navigation'
import './index.scss'

/**
 * 客户首页。文字下单是唯一主入口。
 * 语音只在当前角色能调草稿接口时进入已有语音报单页，否则与拍照一样标为即将上线，不弹「建设中」。
 */

const DELIVERING = new Set(['DELIVERING'])

export default function Index() {
  const [role, setRole] = useState('')
  const [name, setName] = useState('')
  const [openAmount, setOpenAmount] = useState<number | null>(null)
  const [delivering, setDelivering] = useState<number | null>(null)
  const [recent, setRecent] = useState<CustomerOrderDTO | null>(null)

  useDidShow(() => {
    const nextRole = getRole()
    setRole(nextRole)
    if (!getToken()) {
      setName('')
      setOpenAmount(null)
      setDelivering(null)
      setRecent(null)
      return
    }
    setName(getUserName())
    void loadSummary()
  })

  async function loadSummary() {
    const [ar, orders] = await Promise.all([
      receivablesApi.mine().catch(() => null),
      ordersApi.mine({ page: 1, pageSize: 20 }).catch(() => null),
    ])
    if (ar) {
      const open = (ar.items ?? []).reduce((sum, row) => sum + (row.open > 0 ? row.open : 0), 0)
      setOpenAmount(open)
    }
    const list = orders?.items ?? []
    if (orders) {
      setDelivering(list.filter((row) => DELIVERING.has(row.status)).length)
      setRecent(list[0] ?? null)
    }
  }

  const voiceReady = homeEntriesForRole(role).includes('voice')

  function goText() {
    if (getToken()) openAppPage('/pages/customer/products/index')
    else Taro.navigateTo({ url: '/pages/customer/login/index' })
  }

  function goVoice() {
    if (!voiceReady) return
    openAppPage('/pages/salesman/voice-order/index')
  }

  return (
    <View className='home'>
      <View className='hero'>
        <Text className='hero__kicker'>{name ? `${name}（演示账号）` : '登录后查看待结与配送'}</Text>
        <Text className='hero__title'>今天订点什么？</Text>
        <Text className='hero__sub'>下单后由商家确认送货</Text>
        <View className='hero__stats'>
          <View className='hero__stat'>
            <Text className='hero__stat-k'>待结金额</Text>
            <Text className='hero__stat-v'>{openAmount === null ? '—' : fmtMoney(openAmount)}</Text>
          </View>
          <View className='hero__stat'>
            <Text className='hero__stat-k'>配送中订单</Text>
            <Text className='hero__stat-v'>{delivering === null ? '—' : `${delivering} 单`}</Text>
          </View>
        </View>
      </View>

      <View className='home-entry' onClick={goText}>
        <View className='home-entry__icon'>
          <Icon name='pen' color='#FFFFFF' size={44} />
        </View>
        <View className='home-entry__body'>
          <Text className='home-entry__title'>文字下单</Text>
          <Text className='home-entry__desc'>搜索或输入品名，快速加购</Text>
        </View>
        <Text className='home-entry__go'>去选酒</Text>
      </View>

      <View className='home-soon'>
        <View className={`home-soon__card ${voiceReady ? 'home-soon__card--on' : ''}`} onClick={goVoice}>
          <View className='home-soon__top'>
            <View className='home-soon__icon'>
              <Icon name='mic' color='#6B5F5A' size={44} />
            </View>
            {voiceReady ? null : <Text className='tag tag--muted'>即将上线</Text>}
          </View>
          <Text className='home-soon__title'>语音下单</Text>
          <Text className='home-soon__desc'>说出要订的酒</Text>
        </View>
        <View className='home-soon__card'>
          <View className='home-soon__top'>
            <View className='home-soon__icon'>
              <Icon name='cam' color='#6B5F5A' size={44} />
            </View>
            <Text className='tag tag--muted'>即将上线</Text>
          </View>
          <Text className='home-soon__title'>拍照下单</Text>
          <Text className='home-soon__desc'>拍进货单自动识别</Text>
        </View>
      </View>

      <View className='card home-recent'>
        <View className='home-recent__hd'>
          <Text className='card__title'>最近订单</Text>
          <Text className='home-recent__all' onClick={() => openAppPage('/pages/customer/orders/index')}>全部</Text>
        </View>
        {recent ? (
          <View className='home-recent__row' onClick={() => openAppPage('/pages/customer/orders/index')}>
            <View>
              <Text className='home-recent__no'>{recent.orderNo}</Text>
              <Text className='home-recent__meta'>{recent.statusLabel || '查看进度'}</Text>
            </View>
            <Text className='home-recent__amt'>{fmtMoney(recent.totalAmount)}</Text>
          </View>
        ) : (
          <View className='state'>
            <Text className='state__title'>还没有订单</Text>
            <Text className='state__txt'>选好酒下单后，可在这里查看进度</Text>
          </View>
        )}
      </View>

      <Text className='home__tip'>下单后由商家确认送货，首次下单预计 3 分钟内完成</Text>
      <Text
        className='home__staff'
        onClick={() => Taro.navigateTo({ url: '/pages/staff/login/index' })}
      >
        员工登录（业务员／内勤／仓配／老板）
      </Text>
      <RoleTabBar />
    </View>
  )
}
