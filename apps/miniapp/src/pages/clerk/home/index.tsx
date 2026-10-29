import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../../components/Icon'
import type { IconName } from '../../../components/Icon'
import { LOGIN_PAGE, getToken, getUserName, ordersApi, signOut } from '../../../services/api'
import { openAppPage } from '../../../services/navigation'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

const TILES: Array<{ icon: IconName; title: string; desc: string; url: string; badge?: boolean }> = [
  { icon: 'list', title: '订单池', desc: '确认、取消、特批', url: '/pages/clerk/orders/index', badge: true },
  { icon: 'coin', title: '收款登记', desc: '直录即销账', url: '/pages/clerk/payments/index' },
  { icon: 'wallet', title: '应收台账', desc: '账龄分档', url: '/pages/clerk/receivables/index' },
  { icon: 'box', title: '全部库存', desc: '各库位在库和合计', url: '/pages/boss/inventory/index' },
]

/** 内勤工作台：横向主任务卡。订单池角标只读待确认数量。 */
export default function ClerkHomePage() {
  const [name, setName] = useState('')
  const [pending, setPending] = useState<number | null>(null)
  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    setName(getUserName())
    ordersApi.staffList({ status: 'PENDING_CONFIRM', page: 1, pageSize: 1 })
      .then((res) => setPending(res.total))
      .catch(() => setPending(null))
  })

  function logout() {
    void signOut()
  }

  return (
    <View className='grid-home grid-home--hero'>
      <View className='hero'>
        <Text className='hero__title'>您好，{name || '内勤'}</Text>
        <Text className='hero__sub'>订单、收款、应收</Text>
      </View>
      <View className='task-list'>
        {TILES.map((t) => (
          <Button key={t.title} className='task-card' onClick={() => openAppPage(t.url)}>
            <View className='tile__icon'><Icon name={t.icon} color='#7A1F2B' size={44} /></View>
            <View>
              <Text className='task-card__title'>
                {t.title}
                {t.badge && pending != null && pending > 0 ? <Text className='badge'>{pending}</Text> : null}
              </Text>
              <Text className='task-card__desc'>{t.desc}</Text>
            </View>
            <Text className='frow__arrow'>›</Text>
          </Button>
        ))}
      </View>
      <Button className='btn-neutral' onClick={logout}>
        <Text className='btn-label'>退出登录</Text>
      </Button>
      <RoleTabBar />
    </View>
  )
}
