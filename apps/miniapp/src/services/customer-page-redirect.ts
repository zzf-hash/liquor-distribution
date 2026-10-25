import Taro from '@tarojs/taro'
import { getRole } from './api'
import { staffHomeOffCustomerPage } from './customer-page-guard'

/** 当前页是客户业务页且角色不是 CUSTOMER 时，reLaunch 到角色首页。 */
export function redirectIfStaffOnCustomerPage(route: string): boolean {
  const home = staffHomeOffCustomerPage(getRole(), route)
  if (!home) return false
  const go = () => {
    void Taro.reLaunch({ url: home })
  }
  // 与 app.ts 一致：H5 要等 history.listen 挂上，同步 reLaunch 只会改 hash。
  if (typeof window !== 'undefined') window.setTimeout(go, 0)
  else go()
  return true
}
