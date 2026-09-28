import type { AppRole } from './config/app-role'

// 四端复用：页面按端分组注册，编译时按 APP_ROLE 决定首页与页面集合
// （task d0974541；业务员/仓配/老板端页面在后续里程碑挂入）

export const CUSTOMER_PAGES = [
  'pages/index/index',
  'pages/customer/login/index',
  'pages/customer/products/index',
  'pages/customer/cart/index',
  'pages/customer/orders/index',
  'pages/customer/receivables/index',
] as const

// 业务员端页面（P1-T13 起挂入）：拜访打卡等；随本构建一并注册编译，
// 独立业务员端入口（首页/tabBar 按 APP_ROLE 切换）后续任务接入。
export const SALESMAN_PAGES = [
  'pages/salesman/visit/index',
] as const

export const RESERVED_PAGES: Record<Exclude<AppRole, 'customer'>, string[]> = {
  salesman: [...SALESMAN_PAGES],
  warehouse: [],
  boss: [],
}

const pageConfig = {
  pages: [...CUSTOMER_PAGES, ...SALESMAN_PAGES],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#8b1e24',
    navigationBarTitleText: '酒类分销·客户订货',
    navigationBarTextStyle: 'white',
  },
  // 微信定位权限声明（P1-T13 拜访打卡；H5 构建忽略）。getLocation 失败可跳过（页面已兜底）。
  permission: {
    'scope.userLocation': {
      desc: '用于拜访打卡时记录您的位置',
    },
  },
  requiredPrivateInfos: ['getLocation' as const],
  // 底部导航（P0-T50/T51 客户端）：文字 tabBar，色值与 styles/tokens.scss 对齐；
  // 首页保持三入口硬约束，tabBar 属系统级底部导航，不算首页第二排功能磁贴。
  tabBar: {
    color: '#8a7f7a', // = $color-text-sub
    selectedColor: '#8b1e24', // = $color-primary
    backgroundColor: '#ffffff', // = $color-card
    borderStyle: 'black' as const,
    list: [
      { pagePath: 'pages/index/index', text: '首页' },
      { pagePath: 'pages/customer/products/index', text: '订货' },
      { pagePath: 'pages/customer/orders/index', text: '我的订单' },
      { pagePath: 'pages/customer/receivables/index', text: '待结金额' },
    ],
  },
}

export default defineAppConfig(pageConfig)
