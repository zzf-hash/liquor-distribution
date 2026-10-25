import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../../components/Icon'
import type { IconName } from '../../../components/Icon'
import { LOGIN_PAGE, clearSession, getToken, getUserName, ordersApi, outboundsApi } from '../../../services/api'
import { openAppPage } from '../../../services/navigation'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

const TILES: Array<{ icon: IconName; title: string; desc: string; url: string; key: 'pick' | 'ship' | 'sign' }> = [
  { icon: 'box', title: '拣货复核', desc: '按 FIFO 批次拣货', url: '/pages/warehouse/outbounds/index', key: 'pick' },
  { icon: 'bag', title: '发运', desc: '待发运订单', url: '/pages/warehouse/delivering/index', key: 'ship' },
  { icon: 'check', title: '签收', desc: '配送中的单', url: '/pages/warehouse/delivering/index?tab=delivering', key: 'sign' },
]

/** 仓配工作台：横向主任务卡，角标来自已有列表接口的 total。 */
export default function WarehouseHomePage() {
  const [name, setName] = useState('')
  const [counts, setCounts] = useState<Partial<Record<'pick' | 'ship' | 'sign', number>>>({})
  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    setName(getUserName())
    Promise.all([
      outboundsApi.list('PICKING').then((r) => r.total).catch(() => null),
      ordersApi.staffList({ status: 'OUTBOUND', page: 1, pageSize: 1 }).then((r) => r.total).catch(() => null),
      ordersApi.staffList({ status: 'DELIVERING', page: 1, pageSize: 1 }).then((r) => r.total).catch(() => null),
    ]).then(([pick, ship, sign]) => {
      setCounts({
        ...(pick != null ? { pick } : {}),
        ...(ship != null ? { ship } : {}),
        ...(sign != null ? { sign } : {}),
      })
    })
  })

  function logout() {
    clearSession()
    Taro.reLaunch({ url: LOGIN_PAGE })
  }

  return (
    <View className='grid-home'>
      <View className='page-head'>
        <View className='page-head__main'>
          <Text className='page-head__title'>您好，{name || '仓配'}</Text>
          <Text className='page-head__sub'>拣货、发运、签收</Text>
        </View>
        <Text className='tag tag--brand'>仓配</Text>
      </View>
      <View className='task-list'>
        {TILES.map((t) => {
          const n = counts[t.key]
          return (
            <Button key={t.title} className='task-card' onClick={() => openAppPage(t.url)}>
              <View className='tile__icon'><Icon name={t.icon} color='#7A1F2B' size={44} /></View>
              <View>
                <Text className='task-card__title'>
                  {t.title}
                  {n != null && n > 0 ? <Text className='badge'>{n}</Text> : null}
                </Text>
                <Text className='task-card__desc'>{t.desc}</Text>
              </View>
            </Button>
          )
        })}
      </View>
      <Text className='grid-home__out grid-home__logout' onClick={logout}>退出登录</Text>
      <RoleTabBar />
    </View>
  )
}
