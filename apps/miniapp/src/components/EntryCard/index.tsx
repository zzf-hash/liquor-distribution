import { Button, Text, View } from '@tarojs/components'
import Icon from '../Icon'
import type { IconName } from '../Icon'

/** 工作台列表入口卡。整卡可点，标题和说明分两行，角标和箭头在右侧。 */
export default function EntryCard(props: {
  icon: IconName
  title: string
  desc: string
  badge?: string
  onClick: () => void
}) {
  return (
    <Button className='entry-card' onClick={props.onClick}>
      <View className='entry-card__icon'>
        <Icon name={props.icon} color='#7A1F2B' size={44} />
      </View>
      <View className='entry-card__main'>
        <Text className='entry-card__title'>{props.title}</Text>
        <Text className='entry-card__desc'>{props.desc}</Text>
      </View>
      <View className='entry-card__side'>
        {props.badge ? <Text className='entry-card__badge'>{props.badge}</Text> : null}
        <Text className='entry-card__arrow'>›</Text>
      </View>
    </Button>
  )
}
