import type { AppRole } from './app-role'

/** 底部导航一项。pagePath 不带前导斜杠，与 app.config tabBar.list 一致。 */
export interface RoleTab {
  pagePath: string
  text: string
}

export const CUSTOMER_TABS: RoleTab[] = [
  { pagePath: 'pages/index/index', text: '首页' },
  { pagePath: 'pages/customer/products/index', text: '订货' },
  { pagePath: 'pages/customer/orders/index', text: '我的订单' },
  { pagePath: 'pages/customer/receivables/index', text: '待结金额' },
]

export const SALESMAN_TABS: RoleTab[] = [
  { pagePath: 'pages/salesman/home/index', text: '首页' },
  { pagePath: 'pages/salesman/visit/index', text: '拜访' },
  { pagePath: 'pages/salesman/voice-order/index', text: '语音' },
  { pagePath: 'pages/salesman/customers/index', text: '客户' },
  { pagePath: 'pages/salesman/order-create/index', text: '代下单' },
]

export const CLERK_TABS: RoleTab[] = [
  { pagePath: 'pages/clerk/home/index', text: '首页' },
  { pagePath: 'pages/clerk/orders/index', text: '订单' },
  { pagePath: 'pages/clerk/payments/index', text: '收款' },
  { pagePath: 'pages/clerk/receivables/index', text: '应收' },
]

export const WAREHOUSE_TABS: RoleTab[] = [
  { pagePath: 'pages/warehouse/home/index', text: '首页' },
  { pagePath: 'pages/warehouse/outbounds/index', text: '拣货' },
  { pagePath: 'pages/warehouse/delivering/index', text: '发运' },
]

export const BOSS_TABS: RoleTab[] = [
  { pagePath: 'pages/boss/home/index', text: '首页' },
  { pagePath: 'pages/boss/dashboard/index', text: '看板' },
  { pagePath: 'pages/boss/approvals/index', text: '审批' },
  { pagePath: 'pages/clerk/orders/index', text: '订单' },
]

const BY_APP_ROLE: Record<AppRole, RoleTab[]> = {
  customer: CUSTOMER_TABS,
  salesman: SALESMAN_TABS,
  clerk: CLERK_TABS,
  warehouse: WAREHOUSE_TABS,
  boss: BOSS_TABS,
}

export function tabsForAppRole(role: AppRole): RoleTab[] {
  return BY_APP_ROLE[role] ?? CUSTOMER_TABS
}

/** 登录后的后端角色（OWNER/CLERK/REP/WAREHOUSE/CUSTOMER）。未登录返回 null。 */
export function tabsForRuntimeRole(role: string | null | undefined): RoleTab[] | null {
  switch ((role ?? '').toUpperCase()) {
    case 'CUSTOMER':
      return CUSTOMER_TABS
    case 'REP':
      return SALESMAN_TABS
    case 'CLERK':
      return CLERK_TABS
    case 'WAREHOUSE':
      return WAREHOUSE_TABS
    case 'OWNER':
      return BOSS_TABS
    default:
      return null
  }
}

export function normalizeRoute(route: string): string {
  return route.replace(/^\//, '').split('?')[0]
}

/** 客户订货页（不含客户登录页，避免把登录流程踢走）。 */
export function isCustomerFacingPath(route: string): boolean {
  const path = normalizeRoute(route)
  if (path === 'pages/index/index') return true
  return path.startsWith('pages/customer/') && path !== 'pages/customer/login/index'
}

/** 员工工作台页面。登录页不算。 */
export function isStaffWorkspacePath(route: string): boolean {
  const path = normalizeRoute(route)
  return (
    path.startsWith('pages/salesman/')
    || path.startsWith('pages/clerk/')
    || path.startsWith('pages/warehouse/')
    || path.startsWith('pages/boss/')
  )
}

export function sameTabSet(a: RoleTab[], b: RoleTab[]): boolean {
  return a.length === b.length && a.every((tab, i) => tab.pagePath === b[i].pagePath)
}

export type TabBarAction = 'show-native' | 'hide-native' | 'redirect-staff-home' | 'redirect-customer-home'

/**
 * 编译期 tab（APP_ROLE）与登录角色不一致时：
 * 员工离开客户页；客户离开员工页；底部原生 tab 只在两边一致时保留。
 */
export function tabBarAction(appRole: AppRole, runtimeRole: string | null | undefined, route: string): TabBarAction {
  const role = (runtimeRole ?? '').toUpperCase()
  if (role && role !== 'CUSTOMER' && isCustomerFacingPath(route)) return 'redirect-staff-home'
  if (role === 'CUSTOMER' && isStaffWorkspacePath(route)) return 'redirect-customer-home'
  const runtimeTabs = tabsForRuntimeRole(role)
  if (!runtimeTabs) return 'show-native'
  return sameTabSet(runtimeTabs, tabsForAppRole(appRole)) ? 'show-native' : 'hide-native'
}
