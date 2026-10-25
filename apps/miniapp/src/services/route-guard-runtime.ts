import Taro from '@tarojs/taro'
import { getRole } from './api'
import { guardRedirect } from './route-guard'

type NavOption = { url: string }

function currentRoute(): string {
  // H5 直接改地址时，页面栈可能还是上一页。hash 才是用户正在打开的路径。
  if (typeof window !== 'undefined') {
    const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0]
    if (hash.startsWith('pages/')) return hash
  }
  const pages = Taro.getCurrentPages()
  const page = pages[pages.length - 1] as { route?: string; path?: string } | undefined
  const fromPage = page?.route || page?.path || ''
  if (fromPage) return fromPage
  return Taro.getCurrentInstance()?.router?.path ?? ''
}

export function relaunchWhenRouterReady(url: string): void {
  const target = url.replace(/^\//, '').split('?')[0]
  const go = () => {
    void Taro.reLaunch({ url })
  }
  if (typeof window === 'undefined') {
    if (currentRoute().replace(/^\//, '').split('?')[0] === target) return
    go()
    return
  }
  // 在 history.listen 里同步 reLaunch，H5 只会改 hash，页面组件还停在越权页。
  // 等这次跳转提交完再发一次，路由才真的换页。
  window.setTimeout(go, 40)
}

export function enforceCurrentRoute(): void {
  const redirect = guardRedirect(getRole(), currentRoute())
  if (redirect) relaunchWhenRouterReady(redirect)
}

let installed = false

/**
 * 拦住 navigateTo / redirectTo / reLaunch / switchTab，以及 H5 直接改 hash。
 * 统一包没有原生 tab，switchTab 改走 reLaunch。
 */
export function installRouteGuard(): void {
  if (installed) return
  installed = true
  const taro = Taro as unknown as Record<string, (option: NavOption) => unknown>
  const original = {
    navigateTo: taro.navigateTo.bind(Taro),
    redirectTo: taro.redirectTo.bind(Taro),
    reLaunch: taro.reLaunch.bind(Taro),
  }
  const retarget = (url: string) => guardRedirect(getRole(), url) ?? url
  taro.navigateTo = (option) => original.navigateTo({ ...option, url: retarget(option.url) })
  taro.redirectTo = (option) => original.redirectTo({ ...option, url: retarget(option.url) })
  taro.reLaunch = (option) => original.reLaunch({ ...option, url: retarget(option.url) })
  taro.switchTab = (option) => original.reLaunch({ ...option, url: retarget(option.url) })
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => {
      enforceCurrentRoute()
    })
  }
}
