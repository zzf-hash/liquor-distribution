import type { AppRole } from './config/app-role'

// 四端复用：页面按端分组注册，编译时按 APP_ROLE 决定首页与页面集合
// （task d0974541；P1 全员端起各员工端页面全部挂入，登录统一按 role 分发）

export const CUSTOMER_PAGES = [
  'pages/index/index',
  'pages/customer/login/index',
  'pages/staff/login/index',
  'pages/customer/products/index',
  'pages/customer/cart/index',
  'pages/customer/orders/index',
  'pages/customer/receivables/index',
  'pages/customer/statements/index',
] as const

// 业务员端页面（P1-T12/T13 + P1 全员端补齐 home/customers/order-create/payment-report/performance + B组瓶盖回收）
export const SALESMAN_PAGES = [
  'pages/salesman/home/index',
  'pages/salesman/visit/index',
  'pages/salesman/voice-order/index',
  'pages/salesman/customers/index',
  'pages/salesman/order-create/index',
  'pages/salesman/payment-report/index',
  'pages/salesman/performance/index',
  'pages/salesman/cap-recycle/index',
] as const

// 内勤端页面（P1 全员端）：订单池/收款/应收
export const CLERK_PAGES = [
  'pages/clerk/home/index',
  'pages/clerk/orders/index',
  'pages/clerk/order-detail/index',
  'pages/clerk/payments/index',
  'pages/clerk/receivables/index',
] as const

// 仓配端页面（P1 全员端）：拣货/发运/签收
export const WAREHOUSE_PAGES = [
  'pages/warehouse/home/index',
  'pages/warehouse/outbounds/index',
  'pages/warehouse/outbound/index',
  'pages/warehouse/delivering/index',
  'pages/warehouse/sign/index',
] as const

// 老板端页面（P1 全员端）：看板/审批（订单池复用 clerk/orders）
export const BOSS_PAGES = [
  'pages/boss/home/index',
  'pages/boss/dashboard/index',
  'pages/boss/approvals/index',
] as const

export const RESERVED_PAGES: Record<Exclude<AppRole, 'customer'>, string[]> = {
  salesman: [...SALESMAN_PAGES],
  clerk: [...CLERK_PAGES],
  warehouse: [...WAREHOUSE_PAGES],
  boss: [...BOSS_PAGES],
}

const pageConfig = {
  pages: [...CUSTOMER_PAGES, ...SALESMAN_PAGES, ...CLERK_PAGES, ...WAREHOUSE_PAGES, ...BOSS_PAGES],
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
