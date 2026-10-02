/**
 * 遥测上报（内建，零外部依赖）：POST /telemetry/events 批量报前端错误/事件。
 * - reportError: 页面级 onError / request 失败调用；fire-and-forget，绝不影响主流程
 * - 上报本身失败静默丢弃（不回灌，避免错误风暴死循环）
 * - 用户身份取 api.ts 已存键（uid/role），取不到就空
 */
import Taro from '@tarojs/taro'
import { BASE, getToken, getRole, getUserId } from './api'

type TelemetryLevel = 'info' | 'warn' | 'error'

interface TelemetryEvent {
  source: 'miniapp'
  kind: 'error' | 'custom'
  name: string
  level?: TelemetryLevel
  path?: string
  status?: number
  userId?: string
  role?: string
  detail?: Record<string, unknown>
}

let buffer: TelemetryEvent[] = []
let flushing = false

function flush(): void {
  if (flushing || buffer.length === 0) return
  const events = buffer.splice(0, 20)
  flushing = true
  Taro.request({
    url: `${BASE}/telemetry/events`,
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    data: { events },
    timeout: 8000,
  })
    .catch(() => { /* 上报失败静默丢弃 */ })
    .finally(() => { flushing = false })
}

function currentRoute(): string | undefined {
  try {
    const pages = Taro.getCurrentPages()
    return pages[pages.length - 1]?.route
  } catch {
    return undefined
  }
}

/** 记录前端错误（页面未捕获/请求失败/业务异常）。批量+缓冲收敛防风暴。 */
export function reportError(name: string, detail?: Record<string, unknown>, level: TelemetryLevel = 'error'): void {
  buffer.push({
    source: 'miniapp',
    kind: 'error',
    name: name.slice(0, 300),
    level,
    path: currentRoute(),
    userId: getUserId(),
    role: getRole(),
    detail: { ...detail, hasToken: getToken() ? 'yes' : 'no' },
  })
  if (buffer.length >= 20) flush()
  else setTimeout(flush, 3000)
}

/** 自定义业务事件（如下单成功、确认出库）——按需埋，别滥用。 */
export function trackEvent(name: string, detail?: Record<string, unknown>): void {
  buffer.push({ source: 'miniapp', kind: 'custom', name: name.slice(0, 300), level: 'info', path: currentRoute(), userId: getUserId(), role: getRole(), detail })
  flush()
}
