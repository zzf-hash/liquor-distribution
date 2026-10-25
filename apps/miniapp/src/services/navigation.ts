import Taro from '@tarojs/taro'

/** 统一包没有原生 tab。底部切换用 reLaunch 清栈，其余页面 navigateTo。路由守卫会改掉越权地址。 */
export function openAppPage(url: string, mode: 'push' | 'tab' = 'push'): void {
  if (mode === 'tab') void Taro.reLaunch({ url })
  else void Taro.navigateTo({ url })
}
