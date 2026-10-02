import { PropsWithChildren } from 'react'
import { useError, useLaunch } from '@tarojs/taro'
import { reportError } from './services/telemetry'

import './app.scss'

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    console.log('App launched.')
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
