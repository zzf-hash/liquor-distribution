import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../../components/Icon'
import type { IconName } from '../../../components/Icon'
import { LOGIN_PAGE, fmtMoney, getToken, getUserId, getUserName, performanceApi, signOut } from '../../../services/api'
import type { PerfItemDTO } from '../../../services/api'
import { openAppPage } from '../../../services/navigation'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

const PRIMARY: Array<{ icon: IconName; title: string; desc: string; url: string }> = [
  { icon: 'pin', title: '拜访打卡', desc: '八步骤 · 定位', url: '/pages/salesman/visit/index' },
  { icon: 'order', title: '代下单', desc: '选客户直接进单', url: '/pages/salesman/order-create/index' },
]

const REST: Array<{ icon: IconName; title: string; url: string }> = [
  { icon: 'mic', title: '语音报单', url: '/pages/salesman/voice-order/index' },
  { icon: 'users', title: '我的客户', url: '/pages/salesman/customers/index' },
  { icon: 'coin', title: '收款上报', url: '/pages/salesman/payment-report/index' },
  { icon: 'chart', title: '我的绩效', url: '/pages/salesman/performance/index' },
  { icon: 'cap', title: '瓶盖回收', url: '/pages/salesman/cap-recycle/index' },
]

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 业务员工作台：业绩卡 + 两张主任务 + 五个入口。待办没有列表接口，不编造条目。 */
export default function SalesmanHomePage() {
  const [name, setName] = useState('')
  const [perf, setPerf] = useState<PerfItemDTO | null>(null)
  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    setName(getUserName())
    performanceApi.monthly(currentMonth())
      .then((data) => {
        const items = data.items ?? []
        const mine = items.find((it) => it.repId === getUserId()) ?? (items.length === 1 ? items[0] : undefined)
        setPerf(mine ?? null)
      })
      .catch(() => setPerf(null))
  })

  function logout() {
    void signOut()
  }

  return (
    <View className='grid-home'>
      <View className='page-head'>
        <View className='page-head__main'>
          <Text className='page-head__title'>你好，{name || '业务员'}</Text>
          <Text className='page-head__sub'>跑店、报单、收款</Text>
        </View>
        <Text className='tag tag--brand'>业务员</Text>
      </View>

      <View className='brand-card'>
        <Text className='brand-card__k'>本月回款</Text>
        <Text className='brand-card__v'>{perf ? fmtMoney(perf.paymentAmount) : '—'}</Text>
        <View className='brand-card__stats'>
          <View className='brand-card__stat'>
            <Text className='brand-card__stat-k'>拜访</Text>
            <Text className='brand-card__stat-v'>{perf ? `${perf.visitCount}${perf.visitTarget ? `/${perf.visitTarget}` : ''}` : '—'}</Text>
          </View>
          <View className='brand-card__stat'>
            <Text className='brand-card__stat-k'>新客</Text>
            <Text className='brand-card__stat-v'>{perf ? perf.newCustomers : '—'}</Text>
          </View>
          <View className='brand-card__stat'>
            <Text className='brand-card__stat-k'>提成</Text>
            <Text className='brand-card__stat-v'>{perf ? fmtMoney(perf.commission) : '—'}</Text>
          </View>
        </View>
      </View>

      <View className='task-row'>
        {PRIMARY.map((t) => (
          <Button key={t.title} className='task-card' onClick={() => openAppPage(t.url)}>
            <View className='tile__icon'><Icon name={t.icon} color='#7A1F2B' size={44} /></View>
            <View>
              <Text className='task-card__title'>{t.title}</Text>
              <Text className='task-card__desc'>{t.desc}</Text>
            </View>
          </Button>
        ))}
      </View>

      <View className='mini-grid'>
        {REST.map((t) => (
          <Button key={t.title} className='mini-grid__item' onClick={() => openAppPage(t.url)}>
            <View className='tile__icon'><Icon name={t.icon} size={44} /></View>
            <Text className='mini-grid__label'>{t.title}</Text>
          </Button>
        ))}
      </View>

      <View className='card'>
        <Text className='card__title'>待办</Text>
        <Text className='state__txt'>今天没有新的待办。拜访和收款进度在对应入口里查看。</Text>
      </View>

      <Text className='grid-home__out grid-home__logout' onClick={logout}>退出登录</Text>
      <RoleTabBar />
    </View>
  )
}
