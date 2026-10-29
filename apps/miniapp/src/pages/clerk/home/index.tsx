import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { IconName } from '../../../components/Icon'
import { LOGIN_PAGE, getToken, getUserName, ordersApi, signOut } from '../../../services/api'
import { openAppPage } from '../../../services/navigation'
import EntryCard from '../../../components/EntryCard'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'
import HeroHeader from '../../../components/HeroHeader'

const TILES: Array<{ icon: IconName; title: string; desc: string; url: string; badge?: boolean }> = [
  { icon: 'list', title: '订单池', desc: '确认、取消、特批', url: '/pages/clerk/orders/index', badge: true },
  { icon: 'coin', title: '收款登记', desc: '直录即销账', url: '/pages/clerk/payments/index' },
  { icon: 'wallet', title: '应收台账', desc: '账龄分档', url: '/pages/clerk/receivables/index' },
  { icon: 'box', title: '全部库存', desc: '各库位在库和合计', url: '/pages/boss/inventory/index' },
]

/** 内勤工作台：列表入口卡。订单池角标只读待确认数量。 */
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
      <HeroHeader title={`您好，${name || '内勤'}`} sub="订单、收款、应收" badge="内勤" nav={false} />
      <View className='entry-list'>
        {TILES.map((t) => (
          <EntryCard
            key={t.title}
            icon={t.icon}
            title={t.title}
            desc={t.desc}
            badge={t.badge && pending != null && pending > 0 ? `待确认 ${pending}` : undefined}
            onClick={() => openAppPage(t.url)}
          />
        ))}
      </View>
      <Button className='btn-neutral btn-md home-logout' onClick={logout}>
        <Text className='btn-label'>退出登录</Text>
      </Button>
      <RoleTabBar />
    </View>
  )
}
