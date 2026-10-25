import Taro from '@tarojs/taro'
import { getRole } from './api'
import { mountRouteGuardMask, removeRouteGuardMask } from './route-guard-cover'
import { deferGuardedRelaunch, guardRedirect } from './route-guard'

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

export function currentPageUrl(): string {
  const path = currentRoute().replace(/^\//, '').split('?')[0]
  return path ? `/${path}` : ''
}

export function coverBlockedRoute(): void {
  if (typeof document === 'undefined') return
  mountRouteGuardMask(document)
}

export function uncoverBlockedRoute(): void {
  if (typeof document === 'undefined') return
  removeRouteGuardMask(document)
}

function uncoverAfterPaint(): void {
  if (typeof window === 'undefined') return
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => uncoverBlockedRoute())
  })
}

export function relaunchWhenRouterReady(url: string): void {
  const target = url.startsWith('/') ? url.split('?')[0] : `/${url.split('?')[0]}`
  const go = () => {
    const pending = Taro.reLaunch({ url: target }) as { then?: (onOk: () => void, onErr: () => void) => unknown }
    if (pending && typeof pending.then === 'function') {
      void pending.then(uncoverAfterPaint, uncoverAfterPaint)
      return
    }
    uncoverAfterPaint()
  }
  if (typeof window === 'undefined') {
    if (currentRoute().replace(/^\//, '').split('?')[0] === target.replace(/^\//, '')) return
    go()
    return
  }
  // 先盖住再等 history 提交。同步 reLaunch 只改 hash，对方页面会在等待里画出来。
  deferGuardedRelaunch(target, {
    cover: coverBlockedRoute,
    schedule: (fn) => window.setTimeout(fn, 40),
    relaunch: () => go(),
  })
}

export function enforceCurrentRoute(): void {
  if (routeGuardHeld) return
  const redirect = guardRedirect(getRole(), currentRoute())
  if (redirect) relaunchWhenRouterReady(redirect)
}

let installed = false
// 刷新后的第一帧还没有对过 /auth/me。先按住，避免本地 ld_role 把客户送进老板页。
let routeGuardHeld = true

/** 启动校验还没对上身份时，不要用本地 ld_role 把页面送走。 */
export function holdRouteGuard(): void {
  routeGuardHeld = true
}

export function releaseRouteGuard(): void {
  routeGuardHeld = false
}

export function isRouteGuardHeld(): boolean {
  return routeGuardHeld
}

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
    // capture：赶在 H5 路由把对方页面画进 DOM 之前先盖住。
    window.addEventListener('hashchange', () => {
      if (routeGuardHeld) {
        coverBlockedRoute()
        return
      }
      if (guardRedirect(getRole(), currentRoute())) coverBlockedRoute()
      enforceCurrentRoute()
    }, true)
  }
}
