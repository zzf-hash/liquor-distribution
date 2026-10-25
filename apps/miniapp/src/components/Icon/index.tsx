import { Image } from '@tarojs/components'
import Taro from '@tarojs/taro'

/** 线性图标。路径与设计规范组件库一致（24 网格、线宽 1.8）。 */
export const ICON_PATHS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  bag: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  list: 'M6 4h12v16H6zM9 9h6M9 13h6M9 17h4',
  wallet: 'M3 7h18v12H3zM16 13h2M3 7l12-3v3',
  pen: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4',
  cam: 'M4 7h4l2-2h4l2 2h4v12H4zM12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l4 4',
  cart: 'M3 4h3l2 11h11l2-8H7M9 20a1 1 0 1 0 0-.01M18 20a1 1 0 1 0 0-.01',
  pin: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zM12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c0-4 3-6 7-6s7 2 7 6M17 3a4 4 0 0 1 0 8M22 21c0-3-2-5-4-5.5',
  coin: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9h6M9 13h6M12 9v8',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  cap: 'M7 4h10v4H7zM6 8h12l-1 12H7z',
  order: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  bottle: 'M10 2h4v3l2 2v13a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V7l2-2zM10 2h4',
  check: 'M5 12l5 5 9-10',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20h4',
  out: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5',
  x: 'M6 6l12 12M18 6L6 18',
  arrow: 'M9 6l6 6-6 6',
  phone: 'M6 3h4l2 5-3 2a12 12 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z',
} as const

export type IconName = keyof typeof ICON_PATHS

const TAB_ICON: Record<string, IconName> = {
  'pages/index/index': 'home',
  'pages/customer/products/index': 'bag',
  'pages/customer/orders/index': 'list',
  'pages/customer/receivables/index': 'wallet',
  'pages/salesman/home/index': 'home',
  'pages/salesman/visit/index': 'pin',
  'pages/salesman/voice-order/index': 'mic',
  'pages/salesman/customers/index': 'users',
  'pages/salesman/order-create/index': 'order',
  'pages/clerk/home/index': 'home',
  'pages/clerk/orders/index': 'list',
  'pages/clerk/payments/index': 'coin',
  'pages/clerk/receivables/index': 'wallet',
  'pages/warehouse/home/index': 'home',
  'pages/warehouse/outbounds/index': 'box',
  'pages/warehouse/delivering/index': 'bag',
  'pages/boss/home/index': 'home',
  'pages/boss/dashboard/index': 'chart',
  'pages/boss/approvals/index': 'check',
}

export function iconForTab(pagePath: string): IconName {
  return TAB_ICON[pagePath] ?? 'list'
}

export default function Icon(props: { name: IconName; color?: string; size?: number }) {
  const { name, color = '#2B2422', size = 44 } = props
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[name]}"/></svg>`
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const px = Taro.pxTransform(size)
  // H5 的 aspectFit 把内部 img 做成 absolute + top:50% + translateY(-50%)。
  // 宫格按钮默认 overflow:hidden，下半截被切掉，底栏里同一张图因为不裁切所以是完整的。
  // 图标是正方形，scaleToFill 按宿主宽高铺满，不再位移。
  return (
    <Image
      className='ld-icon'
      src={src}
      mode='scaleToFill'
      style={{ width: px, height: px }}
    />
  )
}
