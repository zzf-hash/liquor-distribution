import { normalizeRoute } from '../config/role-tabs'
import { ROLE_HOME_PAGE } from './api'

/**
 * 员工落在客户业务页时，回到该角色已有首页。
 * 客户、未登录（空角色）、客户登录页、映射里没有的角色都不跳。
 */
export function staffHomeOffCustomerPage(role: string | null | undefined, route: string): string | null {
  const normalized = (role ?? '').trim().toUpperCase()
  if (!normalized || normalized === 'CUSTOMER') return null
  const path = normalizeRoute(route)
  if (!path.startsWith('pages/customer/') || path === 'pages/customer/login/index') return null
  return ROLE_HOME_PAGE[normalized] || null
}
