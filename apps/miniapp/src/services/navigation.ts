import Taro from '@tarojs/taro'
import { APP_ROLE } from '../config/app-role'
import { normalizeRoute, tabsForAppRole } from '../config/role-tabs'

const COMPILED_TABS = new Set(tabsForAppRole(APP_ROLE).map((tab) => tab.pagePath))

/** tabBar 页只能 switchTab；其余页按 push 用 navigateTo，按 tab 切换用 reLaunch。 */
export function openAppPage(url: string, mode: 'push' | 'tab' = 'push'): void {
  const path = normalizeRoute(url)
  if (COMPILED_TABS.has(path)) {
    void Taro.switchTab({ url: `/${path}` })
    return
  }
  if (mode === 'tab') void Taro.reLaunch({ url })
  else void Taro.navigateTo({ url })
}
