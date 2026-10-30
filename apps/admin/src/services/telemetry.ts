/**
 * 遥测上报（admin web 端，内建零依赖）：POST /telemetry/events 批量报错误/事件。
 * - reportError: window.onerror / request 失败调用；fire-and-forget，绝不影响主流程
 * - 缓冲+批量，失败静默丢弃不回灌
 */
import { apiBase } from './api-base'
import { getAuth } from './auth'

const BASE_URL = apiBase()

type TelemetryLevel = 'info' | 'warn' | 'error'

interface TelemetryEvent {
  source: 'admin'
  kind: 'error' | 'custom'
  name: string
  level?: TelemetryLevel
  path?: string
  username?: string
  role?: string
  detail?: Record<string, unknown>
}

let buffer: TelemetryEvent[] = []
let flushing = false

function readSession(): { username?: string; role?: string } {
  try {
    const a = getAuth()
    return a ? { username: a.username, role: a.role } : {}
  } catch {
    return {}
  }
}

function flush(): void {
  if (flushing || buffer.length === 0) return
  const events = buffer.splice(0, 20)
  flushing = true
  fetch(`${BASE_URL}/telemetry/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  })
    .catch(() => { /* 静默丢弃 */ })
    .finally(() => { flushing = false })
}

function currentPath(): string {
  try { return window.location.pathname } catch { return '' }
}

export function reportError(name: string, detail?: Record<string, unknown>, level: TelemetryLevel = 'error'): void {
  buffer.push({ source: 'admin', kind: 'error', name: name.slice(0, 300), level, path: currentPath(), ...readSession(), detail })
  if (buffer.length >= 20) flush()
  else setTimeout(flush, 3000)
}

export function trackEvent(name: string, detail?: Record<string, unknown>): void {
  buffer.push({ source: 'admin', kind: 'custom', name: name.slice(0, 300), level: 'info', path: currentPath(), ...readSession(), detail })
  flush()
}

/** 挂全局兜底（unhandled rejection / window error），main.tsx 调一次 */
export function installGlobalTelemetry(): void {
  window.addEventListener('error', (e) => {
    reportError('window_error', { message: String(e.message).slice(0, 500), file: e.filename, line: e.lineno })
  })
  window.addEventListener('unhandledrejection', (e) => {
    reportError('unhandled_rejection', { reason: String((e as PromiseRejectionEvent).reason).slice(0, 800) })
  })
}
