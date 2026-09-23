import { View, Text, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { APP_TITLE } from '../../config/app-role'
import './index.scss'

/**
 * 客户首页——三主入口壳（task d0974541, 计划书§2.1易用性红线）
 *
 * §2.1 原文约束：客户订货主路径=语音/拍照/文字三入口，首次下单≤3分钟。
 * 本壳只做入口路由，不做业务逻辑：
 *   语音 → P0-02+ 接 ASR；拍照 → P0-02+ 接拍照识单；
 *   文字 → P0-02+ 进商品搜索/快速下单单。
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

function goPlaceholder(kind: EntryKind) {
  // 占位路由：P0-02 起替换为真实页面（pages/order/{voice|photo|text}）
  Taro.showToast({ title: `${kind}通道待P0-02开通`, icon: 'none' })
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
            onClick={() => goPlaceholder(it.kind)}
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
      </View>
    </View>
  )
}
