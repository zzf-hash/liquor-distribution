import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { IconName } from '../../../components/Icon'
import { LOGIN_PAGE, getToken, getUserName, ordersApi, outboundsApi, signOut } from '../../../services/api'
import { openAppPage } from '../../../services/navigation'
import EntryCard from '../../../components/EntryCard'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'
import HeroHeader from '../../../components/HeroHeader'

const TILES: Array<{ icon: IconName; title: string; desc: string; url: string; key: 'pick' | 'ship' | 'sign' | 'stock'; badge: (n: number) => string }> = [
  { icon: 'box', title: '拣货复核', desc: '按 FIFO 批次拣货', url: '/pages/warehouse/outbounds/index', key: 'pick', badge: (n) => `待拣货 ${n}` },
  { icon: 'bag', title: '发运', desc: '待发运订单', url: '/pages/warehouse/delivering/index', key: 'ship', badge: (n) => `待发运 ${n}` },
  { icon: 'check', title: '签收', desc: '配送中的单', url: '/pages/warehouse/delivering/index?tab=delivering', key: 'sign', badge: (n) => `配送中 ${n}` },
  { icon: 'list', title: '全部库存', desc: '各库位在库和合计', url: '/pages/boss/inventory/index', key: 'stock', badge: () => '' },
]

/** 仓配工作台：列表入口卡。角标只在已有列表接口 total > 0 时出现。 */
export default function WarehouseHomePage() {
  const [name, setName] = useState('')
  const [counts, setCounts] = useState<Partial<Record<'pick' | 'ship' | 'sign' | 'stock', number>>>({})
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
    void signOut()
  }

  return (
    <View className='grid-home grid-home--hero'>
      <HeroHeader title={`您好，${name || '仓配'}`} sub="拣货、发运、签收" badge="仓配" nav={false} />
      <View className='entry-list'>
        {TILES.map((t) => {
          const n = counts[t.key]
          return (
            <EntryCard
              key={t.title}
              icon={t.icon}
              title={t.title}
              desc={t.desc}
              badge={n != null && n > 0 ? t.badge(n) : undefined}
              onClick={() => openAppPage(t.url)}
            />
          )
        })}
      </View>
      <Button className='btn-neutral btn-md home-logout' onClick={logout}>
        <Text className='btn-label'>退出登录</Text>
      </Button>
      <RoleTabBar />
    </View>
  )
}
