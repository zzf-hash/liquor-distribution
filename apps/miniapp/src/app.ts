import { PropsWithChildren } from 'react'
import { useDidShow, useError, useLaunch } from '@tarojs/taro'
import { ApiError, LOGIN_PAGE, authApi, clearSession, readSession, writeSession } from './services/api'
import { sessionAfterMe } from './services/session-cache'
import { enforceCurrentRoute, installRouteGuard, relaunchWhenRouterReady } from './services/route-guard-runtime'
import { reportError } from './services/telemetry'

import './app.scss'

async function validateCachedToken(): Promise<void> {
  const cached = readSession()
  if (!cached.token) {
    enforceCurrentRoute()
    return
  }
  try {
    const me = await authApi.me()
    const next = sessionAfterMe(cached, { ok: true, user: me })
    if (next.redirectToLogin) {
      clearSession()
      relaunchWhenRouterReady(LOGIN_PAGE)
      return
    }
    writeSession(next.session)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    // 网络失败留着缓存，下面仍按缓存角色守门。
  }
  enforceCurrentRoute()
}

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    installRouteGuard()
    void validateCachedToken()
  })

  useDidShow(() => {
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
