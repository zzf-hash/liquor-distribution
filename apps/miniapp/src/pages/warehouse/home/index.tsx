import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { LOGIN_PAGE, clearSession, getToken, getUserName } from '../../../services/api'
import { openAppPage } from '../../../services/navigation'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

// 宫格磁贴（P1 全员端）：签收磁带进「发运签收」页的配送中 tab，再选单签收
const TILES: Array<{ icon: string; title: string; desc: string; url: string }> = [
  { icon: '🧺', title: '拣货复核', desc: 'FIFO 批次建议·确认出库', url: '/pages/warehouse/outbounds/index' },
  { icon: '🚚', title: '发运签收', desc: '待发运/配送中管理', url: '/pages/warehouse/delivering/index' },
  { icon: '✍️', title: '去签收', desc: '实收/拒收·回包装', url: '/pages/warehouse/delivering/index?tab=delivering' },
]

/** 仓配宫格首页：拣货/发运/签收 */
export default function WarehouseHomePage() {
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
        <Text className='grid-home__hi'>您好，{name || '仓配'}</Text>
        <Text className='grid-home__out' onClick={logout}>退出登录</Text>
      </View>
      <Text className='grid-home__sub'>按单拣货、复核出库、送货签收</Text>
      <View className='grid-home__grid'>
        {TILES.map((t) => (
          <Button key={t.title} className='tile' onClick={() => openAppPage(t.url)}>
            <Text className='tile__icon'>{t.icon}</Text>
            <Text className='tile__title'>{t.title}</Text>
            <Text className='tile__desc'>{t.desc}</Text>
          </Button>
        ))}
      </View>
      <RoleTabBar />
    </View>
  )
}
