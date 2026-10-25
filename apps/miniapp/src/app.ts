import { PropsWithChildren } from 'react'
import Taro, { useDidShow, useError, useLaunch } from '@tarojs/taro'
import { APP_ROLE } from './config/app-role'
import { tabBarAction } from './config/role-tabs'
import { ROLE_HOME_PAGE, getRole } from './services/api'
import { reportError } from './services/telemetry'

import './app.scss'

function currentRoute(): string {
  const pages = Taro.getCurrentPages()
  const page = pages[pages.length - 1] as { route?: string; path?: string } | undefined
  const fromPage = page?.route || page?.path || ''
  if (fromPage) return fromPage
  const inst = Taro.getCurrentInstance()?.router?.path ?? ''
  if (inst) return inst
  if (typeof window !== 'undefined') {
    const hash = window.location.hash.replace(/^#\/?/, '')
    if (hash) return hash
  }
  return ''
}

function relaunchWhenRouterReady(url: string): void {
  const target = url.replace(/^\//, '').split('?')[0]
  if (currentRoute().replace(/^\//, '').split('?')[0] === target) return
  const go = () => {
    void Taro.reLaunch({ url })
  }
  // H5 的 history.listen 在 app.onShow 返回后才挂上。同步 reLaunch 只会改 hash，页面不会换。
  if (typeof window !== 'undefined') window.setTimeout(go, 0)
  else go()
}

function syncRoleNavigation(): void {
  const route = currentRoute()
  const role = getRole()
  const action = tabBarAction(APP_ROLE, role, route)
  if (action === 'redirect-staff-home') {
    const home = ROLE_HOME_PAGE[role]
    if (home) relaunchWhenRouterReady(home)
    return
  }
  if (action === 'redirect-customer-home') {
    relaunchWhenRouterReady(ROLE_HOME_PAGE.CUSTOMER)
    return
  }
  const toggle = action === 'hide-native' ? Taro.hideTabBar : Taro.showTabBar
  try {
    void Promise.resolve(toggle({ animation: false })).catch(() => undefined)
  } catch {
    // 当前页不是 tab 页时，微信会拒绝 show/hide，忽略即可。
  }
}

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    console.log('App launched.')
  })

  useDidShow(() => {
    syncRoleNavigation()
  })

  // 全局未捕获错误 → 遥测上报（内建，POST /telemetry/events）
  useError((err) => {
    reportError('app_uncaught_error', { error: String(err).slice(0, 800) })
    console.error('[telemetry] uncaught:', err)
  })

  // children 是将要会渲染的页面
  return children
}

export default App
