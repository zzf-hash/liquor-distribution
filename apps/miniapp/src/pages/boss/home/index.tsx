import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../../components/Icon'
import type { IconName } from '../../../components/Icon'
import { LOGIN_PAGE, approvalsApi, dashboardApi, fmtMoney, getToken, getUserName, signOut } from '../../../services/api'
import { deniedHomeForConfirmedRole } from '../../../services/route-guard'
import { confirmedRoleForGuard } from '../../../services/session-cache'
import { openAppPage } from '../../../services/navigation'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

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
    approvalsApi.list('PENDING')
      .then((r) => setPending(r.total))
      .catch(() => setPending(null))
  })

  function logout() {
    void signOut()
  }

  return (
    <View className='grid-home'>
      <View className='page-head'>
        <View className='page-head__main'>
          <Text className='page-head__title'>您好，{name || '老板'}</Text>
          <Text className='page-head__sub'>今天生意怎么样</Text>
        </View>
        <Text className='tag tag--brand'>老板</Text>
      </View>
      <View className='brand-card' onClick={() => openAppPage('/pages/boss/dashboard/index')}>
        <Text className='brand-card__k'>今日销售</Text>
        <Text className='brand-card__v'>{sales ?? '—'}</Text>
        <Text className='brand-card__k'>点进四问看板看回款、欠款和库存</Text>
      </View>
      <View className='task-list'>
        {TILES.map((t) => (
          <Button key={t.title} className='task-card' onClick={() => openAppPage(t.url)}>
            <View className='tile__icon'><Icon name={t.icon} color='#7A1F2B' size={44} /></View>
            <View>
              <Text className='task-card__title'>
                {t.title}
                {t.title === '审批中心' && pending != null && pending > 0 ? <Text className='badge'>{pending}</Text> : null}
              </Text>
              <Text className='task-card__desc'>{t.desc}</Text>
            </View>
          </Button>
        ))}
      </View>
      <Text className='grid-home__out grid-home__logout' onClick={logout}>退出登录</Text>
      <RoleTabBar />
    </View>
  )
}
