import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ScrollView, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

/**
 * 横滑胶囊。按钮按内容宽度排列。
 * 只有内容超出容器时才加右侧渐隐，避免遮住没溢出的选中项。
 */
export default function TabsScroll(props: { children: ReactNode; intoView?: string }) {
  const idRef = useRef(`tabs-${Math.random().toString(36).slice(2, 8)}`)
  const [over, setOver] = useState(false)

  useEffect(() => {
    let alive = true
    const apply = (next: boolean) => {
      if (!alive) return
      setOver((prev) => (prev === next ? prev : next))
    }
    const measure = () => {
      const id = idRef.current
      if (process.env.TARO_ENV === 'h5') {
        const host = document.getElementById(id)
        const inner = host?.querySelector('.tabs') as HTMLElement | null
        if (!host || !inner) return
        apply(inner.scrollWidth > host.clientWidth + 2)
        return
      }
      Taro.createSelectorQuery()
        .select(`#${id} .tabs`)
        .scrollOffset()
        .select(`#${id}`)
        .boundingClientRect()
        .exec((res) => {
          const scroll = res?.[0] as { scrollWidth?: number } | undefined
          const host = res?.[1] as { width?: number } | undefined
          if (!scroll?.scrollWidth || !host?.width) return
          apply(scroll.scrollWidth > host.width + 2)
        })
    }
    Taro.nextTick(measure)
    return () => {
      alive = false
    }
  })

  const cls = over ? 'tabs-scroll tabs-scroll--over' : 'tabs-scroll'
  const body = <View className='tabs'>{props.children}</View>
  if (props.intoView != null) {
    return (
      <View className={cls}>
        <ScrollView
          id={idRef.current}
          className='tabs-scroll__clip'
          scrollX
          scrollWithAnimation
          scrollIntoView={props.intoView}
          showScrollbar={false}
        >
          {body}
        </ScrollView>
      </View>
    )
  }
  return (
    <View className={cls}>
      <View id={idRef.current} className='tabs-scroll__clip'>
        {body}
      </View>
    </View>
  )
}
