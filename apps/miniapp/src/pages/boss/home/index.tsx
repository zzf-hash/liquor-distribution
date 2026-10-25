import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../../components/Icon'
import type { IconName } from '../../../components/Icon'
import { LOGIN_PAGE, clearSession, getToken, getUserName } from '../../../services/api'
import { openAppPage } from '../../../services/navigation'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

// 宫格磁贴（P1 全员端；订单池复用内勤订单页，只读视角+特批入口在详情页按角色显隐）
const TILES: Array<{ icon: IconName; title: string; desc: string; url: string }> = [
  { icon: 'chart', title: '四问看板', desc: '今日销售/回款·欠款·库存', url: '/pages/boss/dashboard/index' },
  { icon: 'check', title: '审批中心', desc: '特批/调价/采购待办', url: '/pages/boss/approvals/index' },
  { icon: 'box', title: '订单池', desc: '全部订单·只读监控', url: '/pages/clerk/orders/index' },
]

/** 老板宫格首页：看板/审批/订单池 */
export default function BossHomePage() {
  const [name, setName] = useState('')
  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    setName(getUserName())
  })

  function logout() {
    clearSession()
    Taro.reLaunch({ url: LOGIN_PAGE })
  }

  return (
    <View className='grid-home'>
      <View className='grid-home__hd'>
        <Text className='grid-home__hi'>您好，{name || '老板'}</Text>
        <Text className='grid-home__out' onClick={logout}>退出登录</Text>
      </View>
      <Text className='grid-home__sub'>今天生意怎么样，一眼看全</Text>
      <View className='grid-home__grid'>
        {TILES.map((t) => (
          <Button key={t.title} className='tile' onClick={() => openAppPage(t.url)}>
            <View className='tile__icon'><Icon name={t.icon} /></View>
            <Text className='tile__title'>{t.title}</Text>
            <Text className='tile__desc'>{t.desc}</Text>
          </Button>
        ))}
      </View>
      <RoleTabBar />
    </View>
  )
}
