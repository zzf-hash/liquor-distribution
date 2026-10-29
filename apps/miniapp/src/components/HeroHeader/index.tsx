import type { ReactNode } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { homeForRole } from '../../services/route-guard'
import { confirmedRoleForGuard } from '../../services/session-cache'
import { openAppPage } from '../../services/navigation'
import Icon from '../Icon'
import './index.scss'

export type HeroInsets = { statusBar: number; navRow: number; rightGap: number }

/** H5 没有胶囊按钮。状态栏按 0，导航行按 44px（750 稿里的 88）。 */
export function readHeroInsets(): HeroInsets {
  try {
    const sys = Taro.getSystemInfoSync()
    const statusBar = Number(sys.statusBarHeight) || 0
    const menu = typeof Taro.getMenuButtonBoundingClientRect === 'function'
      ? Taro.getMenuButtonBoundingClientRect()
      : null
    if (menu && menu.width > 0 && menu.height > 0 && menu.top >= statusBar) {
      return {
        statusBar,
        navRow: (menu.top - statusBar) * 2 + menu.height,
        rightGap: Math.max(12, (sys.windowWidth || 0) - menu.left + 8),
      }
    }
  } catch {
    // H5 或尚未就绪
  }
  return { statusBar: 0, navRow: 44, rightGap: 12 }
}

/**
 * 员工端深色头部。左侧是返回或工作台，标题单行。
 * 右上角留给系统胶囊，不再放我们自己的胶囊按钮。
 */
export default function HeroHeader(props: {
  title: string
  sub?: string
  badge?: string
  nav?: boolean
  children?: ReactNode
}) {
  const insets = readHeroInsets()
  const showNav = props.nav !== false
  const canBack = showNav && (Taro.getCurrentPages?.() ?? []).length > 1

  function onNav() {
    if (canBack) {
      Taro.navigateBack().catch(() => goHome())
      return
    }
    goHome()
  }

  function goHome() {
    const home = homeForRole(confirmedRoleForGuard())
    if (home) openAppPage(home, 'tab')
  }

  return (
    <View className='hh' style={{ paddingTop: `${insets.statusBar}px` }}>
      <View className='hh__nav' style={{ height: `${insets.navRow}px`, paddingRight: `${insets.rightGap}px` }}>
        {showNav ? (
          <Button className='btn-hero hh__nav-btn' onClick={onNav}>
            <View className={canBack ? 'hh__icon hh__icon--back' : 'hh__icon'}>
              <Icon name={canBack ? 'arrow' : 'home'} color='#C9A46A' size={32} />
            </View>
            <Text className='btn-hero__txt'>{canBack ? '返回' : '工作台'}</Text>
          </Button>
        ) : null}
        <Text className='hh__title'>{props.title}</Text>
        {props.badge ? <Text className='hh__badge'>{props.badge}</Text> : null}
      </View>
      {props.sub ? <Text className='hh__sub'>{props.sub}</Text> : null}
      {props.children}
    </View>
  )
}
