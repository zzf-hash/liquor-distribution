import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../../components/Icon'
import type { IconName } from '../../../components/Icon'
import { LOGIN_PAGE, clearSession, getToken, getUserName } from '../../../services/api'
import { openAppPage } from '../../../services/navigation'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

// 宫格磁贴（P1 全员端）
const TILES: Array<{ icon: IconName; title: string; desc: string; url: string }> = [
  { icon: 'list', title: '订单池', desc: '确认/取消/特批', url: '/pages/clerk/orders/index' },
  { icon: 'coin', title: '收款登记', desc: '直录即销账·确认上报', url: '/pages/clerk/payments/index' },
  { icon: 'wallet', title: '应收台账', desc: '账龄分档·争议单列', url: '/pages/clerk/receivables/index' },
]

/** 内勤宫格首页：订单/收款/应收 */
export default function ClerkHomePage() {
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
        <Text className='grid-home__hi'>您好，{name || '内勤'}</Text>
        <Text className='grid-home__out' onClick={logout}>退出登录</Text>
      </View>
      <Text className='grid-home__sub'>订单、收款、应收，一天的事都在这</Text>
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
