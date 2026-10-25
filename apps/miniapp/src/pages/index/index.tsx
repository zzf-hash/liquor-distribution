import { useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { APP_TITLE } from '../../config/app-role'
import { homeEntriesForRole } from '../../config/home-entries'
import { getRole, getToken } from '../../services/api'
import { openAppPage } from '../../services/navigation'
import RoleTabBar from '../../components/RoleTabBar'
import './index.scss'

/**
 * 客户首页——三主入口壳（task d0974541, 计划书§2.1易用性红线）
 *
 * 文字下单进商城。语音仅在当前角色能调草稿接口时出现，并进入已有语音报单页。
 * 拍照识单没有后端接口，入口不展示。
 * 每个入口整卡可点（≥88px 计量 = 44px 物理），适配老年用户。
 */

type EntryKind = 'voice' | 'photo' | 'text'

const ENTRIES: Array<{
  kind: EntryKind
  icon: string
  title: string
  desc: string
}> = [
  { kind: 'voice', icon: '🎙️', title: '语音下单', desc: '说出要订的酒，一键下单' },
  { kind: 'photo', icon: '📷', title: '拍照下单', desc: '拍下进货单/货架，自动识别' },
  { kind: 'text', icon: '📝', title: '文字下单', desc: '搜索或输入品名快速下单' },
]

function goEntry(kind: EntryKind) {
  if (kind === 'text') {
    // 文字下单（P0-T50/T51）：直达选酒页；未登录先走登录页
    if (getToken()) openAppPage('/pages/customer/products/index')
    else Taro.navigateTo({ url: '/pages/customer/login/index' })
    return
  }
  if (kind === 'voice') {
    // 草稿语音只对业务员/内勤/老板开放，接到已有语音报单页
    openAppPage('/pages/salesman/voice-order/index')
  }
}

export default function Index() {
  const [role, setRole] = useState('')
  useDidShow(() => setRole(getRole()))
  const visible = new Set(homeEntriesForRole(role))
  const entries = ENTRIES.filter((it) => visible.has(it.kind))

  return (
    <View className='home'>
      <View className='home__header'>
        <Text className='home__title'>{APP_TITLE.customer}</Text>
        <Text className='home__subtitle'>
          {visible.has('voice') ? '语音或文字订酒，选您顺手的' : '搜索品名，按箱或按页面给出的单位下单'}
        </Text>
      </View>

      <View className='home__entries'>
        {entries.map((it) => (
          <Button
            key={it.kind}
            className='entry'
            onClick={() => goEntry(it.kind)}
          >
            <Text className='entry__icon'>{it.icon}</Text>
            <View className='entry__body'>
              <Text className='entry__title'>{it.title}</Text>
              <Text className='entry__desc'>{it.desc}</Text>
            </View>
          </Button>
        ))}
      </View>
      <RoleTabBar />

      <View className='home__footer'>
        <Text className='home__footer-tip'>下单后由商家确认送货，首次下单预计3分钟内完成</Text>
        <Text
          className='home__staff-entry'
          onClick={() => Taro.navigateTo({ url: '/pages/staff/login/index' })}
        >
          员工入口（业务员/内勤/仓配/老板）
        </Text>
      </View>
    </View>
  )
}
