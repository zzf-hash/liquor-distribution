import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { LOGIN_PAGE, clearSession, getToken, getUserName } from '../../../services/api'
import './index.scss'

// 宫格磁贴（P1 全员端）：拜访/语音已有页面，本批补 customers/order-create/payment-report/performance
const TILES: Array<{ icon: string; title: string; desc: string; url: string }> = [
  { icon: '📍', title: '拜访打卡', desc: '八步骤·定位·水印照', url: '/pages/salesman/visit/index' },
  { icon: '🎙️', title: '语音下单', desc: '口述转草稿', url: '/pages/salesman/voice-order/index' },
  { icon: '📝', title: '代下单', desc: '选客户加行直接进单', url: '/pages/salesman/order-create/index' },
  { icon: '👥', title: '我的客户', desc: '名下客户·搜索·电话', url: '/pages/salesman/customers/index' },
  { icon: '💰', title: '收款上报', desc: '代收货款·内勤确认', url: '/pages/salesman/payment-report/index' },
  { icon: '📈', title: '我的绩效', desc: '回款·新客·拜访·提成', url: '/pages/salesman/performance/index' },
  { icon: '🍾', title: '瓶盖回收', desc: '回收登记·兑付开瓶费', url: '/pages/salesman/cap-recycle/index' },
]

/** 业务员宫格首页：拜访打卡/语音下单/代下单/我的客户/收款上报/我的绩效 */
export default function SalesmanHomePage() {
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
        <Text className='grid-home__hi'>您好，{name || '业务员'}</Text>
        <Text className='grid-home__out' onClick={logout}>退出登录</Text>
      </View>
      <Text className='grid-home__sub'>跑店、报单、收款，一部手机搞定</Text>
      <View className='grid-home__grid'>
        {TILES.map((t) => (
          <Button key={t.title} className='tile' onClick={() => Taro.navigateTo({ url: t.url })}>
            <Text className='tile__icon'>{t.icon}</Text>
            <Text className='tile__title'>{t.title}</Text>
            <Text className='tile__desc'>{t.desc}</Text>
          </Button>
        ))}
      </View>
    </View>
  )
}
