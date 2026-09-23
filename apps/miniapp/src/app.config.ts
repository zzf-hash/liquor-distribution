import type { AppRole } from './config/app-role'

// 四端复用：页面按端分组注册，编译时按 APP_ROLE 决定首页与页面集合
// （task d0974541；业务员/仓配/老板端页面在后续里程碑挂入）

export const CUSTOMER_PAGES = ['pages/index/index'] as const

export const RESERVED_PAGES: Record<Exclude<AppRole, 'customer'>, string[]> = {
  salesman: [],
  warehouse: [],
  boss: [],
}

const pageConfig = {
  pages: [...CUSTOMER_PAGES],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#8b1e24',
    navigationBarTitleText: '酒类分销·客户订货',
    navigationBarTextStyle: 'white',
  },
}

export default defineAppConfig(pageConfig)
