// 客户和员工合成一个包。页面全部注册，登录后按后端 user.role 分发。
// 不写原生 tabBar：两套页面放不进微信那一份 tabBar.list。RoleTabBar 按角色画底部导航。

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
  'pages/boss/inventory/index',
] as const

export const RESERVED_PAGES = {
  salesman: [...SALESMAN_PAGES],
  clerk: [...CLERK_PAGES],
  warehouse: [...WAREHOUSE_PAGES],
  boss: [...BOSS_PAGES],
}

const pageConfig = {
  pages: [...CUSTOMER_PAGES, ...SALESMAN_PAGES, ...CLERK_PAGES, ...WAREHOUSE_PAGES, ...BOSS_PAGES],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#FFFFFF',
    navigationBarTitleText: '酒类分销',
    navigationBarTextStyle: 'black',
  },
  // 微信定位权限声明（P1-T13 拜访打卡；H5 构建忽略）。getLocation 失败可跳过（页面已兜底）。
  permission: {
    'scope.userLocation': {
      desc: '用于拜访打卡时记录您的位置',
    },
  },
  requiredPrivateInfos: ['getLocation' as const],
}

export default defineAppConfig(pageConfig)
