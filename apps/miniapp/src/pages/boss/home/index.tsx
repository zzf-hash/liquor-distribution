import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import type { IconName } from '../../../components/Icon'
import { LOGIN_PAGE, approvalsApi, dashboardApi, fmtMoney, getToken, getUserName, signOut } from '../../../services/api'
import { deniedHomeForConfirmedRole } from '../../../services/route-guard'
import { confirmedRoleForGuard } from '../../../services/session-cache'
import { openAppPage } from '../../../services/navigation'
import EntryCard from '../../../components/EntryCard'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'
import HeroHeader from '../../../components/HeroHeader'

const TILES: Array<{ icon: IconName; title: string; desc: string; url: string }> = [
  { icon: 'chart', title: '四问看板', desc: '销售、回款、欠款、库存预警', url: '/pages/boss/dashboard/index' },
  { icon: 'box', title: '全部库存', desc: '各库位在库和合计', url: '/pages/boss/inventory/index' },
  { icon: 'check', title: '审批中心', desc: '特批、调价、采购', url: '/pages/boss/approvals/index' },
  { icon: 'users', title: '客户', desc: '建档后走开户审批', url: '/pages/salesman/customers/index' },
  { icon: 'list', title: '订单池', desc: '全部订单', url: '/pages/clerk/orders/index' },
]

/** 老板工作台：看板摘要 + 审批待办数。数字来自已有只读接口。 */
export default function BossHomePage() {
  const [name, setName] = useState('')
  const [sales, setSales] = useState<string | null>(null)
  const [salesReady, setSalesReady] = useState(false)
  const [pending, setPending] = useState<number | null>(null)
  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    const home = deniedHomeForConfirmedRole(confirmedRoleForGuard(), '/pages/boss/home/index')
    if (home) {
      Taro.reLaunch({ url: home })
      return
    }
    setName(getUserName())
    dashboardApi.fourQuestions()
      .then((d) => setSales(fmtMoney(d.salesToday?.amount)))
      .catch(() => setSales(null))
      .finally(() => setSalesReady(true))
    approvalsApi.list('PENDING')
      .then((r) => setPending(r.total))
      .catch(() => setPending(null))
  })

  function logout() {
    void signOut()
  }

  return (
    <View className='grid-home grid-home--hero'>
      <HeroHeader title={`您好，${name || '老板'}`} sub="今天生意怎么样" badge="老板" nav={false}>
        <Text className='hero__k'>今日销售</Text>
        <Text className='hero__num'>{sales ?? '—'}</Text>
        {!salesReady ? <Text className='hero__k'>加载中</Text> : null}
      </HeroHeader>
      <View className='entry-list'>
        {TILES.map((t) => (
          <EntryCard
            key={t.title}
            icon={t.icon}
            title={t.title}
            desc={t.desc}
            badge={t.title === '审批中心' && pending != null && pending > 0 ? `待审批 ${pending}` : undefined}
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
