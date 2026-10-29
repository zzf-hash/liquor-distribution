import { PropsWithChildren } from 'react'
import Taro, { useDidShow, useError, useLaunch } from '@tarojs/taro'
import { DIGIT_FONT_FAMILY, DIGIT_FONT_SOURCE } from './assets/fonts/digit-font'
import { LOGIN_PAGE, authApi, clearSession, readSession, writeSession } from './services/api'
import { sessionAfterMe } from './services/session-cache'
import { guardRedirect, homeForRole } from './services/route-guard'
import {
  coverBlockedRoute,
  currentPageUrl,
  enforceCurrentRoute,
  holdRouteGuard,
  installRouteGuard,
  releaseRouteGuard,
  relaunchWhenRouterReady,
  uncoverBlockedRoute,
} from './services/route-guard-runtime'
import { reportError } from './services/telemetry'

import './app.scss'

let identitySettled = false

async function validateCachedToken(): Promise<void> {
  const cached = readSession()
  if (!cached.token) {
    identitySettled = true
    releaseRouteGuard()
    enforceCurrentRoute()
    return
  }
  // 身份还没对上之前先盖住，避免用本地 ld_role 画出另一个工作台。
  holdRouteGuard()
  coverBlockedRoute()
  try {
    const me = await authApi.me()
    const next = sessionAfterMe(cached, { ok: true, user: me })
    if (next.redirectToLogin) {
      clearSession()
      identitySettled = true
      releaseRouteGuard()
      relaunchWhenRouterReady(LOGIN_PAGE)
      return
    }
    writeSession(next.session)
    identitySettled = true
    releaseRouteGuard()
    const here = currentPageUrl()
    const redirected = here ? guardRedirect(next.session.role, here) : null
    const roleChanged = cached.role.trim().toUpperCase() !== next.session.role.trim().toUpperCase()
    if (redirected) {
      relaunchWhenRouterReady(redirected)
      return
    }
    if (roleChanged) {
      const home = homeForRole(next.session.role)
      if (home) {
        relaunchWhenRouterReady(home)
        return
      }
    }
    uncoverBlockedRoute()
    enforceCurrentRoute()
  } catch {
    const next = sessionAfterMe(cached, { ok: false, unauthorized: false })
    clearSession()
    identitySettled = true
    releaseRouteGuard()
    if (next.redirectToLogin) relaunchWhenRouterReady(LOGIN_PAGE)
    else uncoverBlockedRoute()
  }
}

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    try {
      Taro.loadFontFace({
        global: true,
        family: DIGIT_FONT_FAMILY,
        source: DIGIT_FONT_SOURCE,
        fail: () => undefined,
      })
    } catch {
      // 字体加载失败时回退到无衬线，不影响页面。
    }
    installRouteGuard()
    void validateCachedToken()
  })

  useDidShow(() => {
    if (!identitySettled && readSession().token) return
    enforceCurrentRoute()
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
