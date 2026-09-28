import { View, Text, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { APP_TITLE } from '../../config/app-role'
import { getToken } from '../../services/api'
import './index.scss'

/**
 * 客户首页——三主入口壳（task d0974541, 计划书§2.1易用性红线）
 *
 * §2.1 原文约束：客户订货主路径=语音/拍照/文字三入口，首次下单≤3分钟。
 * 本壳只做入口路由，不做业务逻辑：
 *   语音 → P0-02+ 接 ASR；拍照 → P0-02+ 接拍照识单；
 *   文字 → P0-T50/T51 已开通：进商品浏览/购物车下单通道。
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
    if (getToken()) Taro.switchTab({ url: '/pages/customer/products/index' })
    else Taro.navigateTo({ url: '/pages/customer/login/index' })
    return
  }
  // 语音/拍照通道待 P0-02 接 ASR / 拍照识单
  Taro.showToast({ title: kind === 'voice' ? '语音通道建设中' : '拍照通道建设中', icon: 'none' })
}

export default function Index() {
  return (
    <View className='home'>
      <View className='home__header'>
        <Text className='home__title'>{APP_TITLE.customer}</Text>
        <Text className='home__subtitle'>三种方式订酒，选您顺手的</Text>
      </View>

      <View className='home__entries'>
        {ENTRIES.map((it) => (
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
