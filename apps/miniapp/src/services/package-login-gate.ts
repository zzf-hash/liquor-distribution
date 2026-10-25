import type { AppRole } from '../config/app-role'

/** 员工包拒绝客户账号时的提示。客户包拒绝员工账号的文案见 CUSTOMER_PACKAGE_STAFF_TOAST。 */
export const STAFF_PACKAGE_CUSTOMER_TOAST = '请使用客户端'

/** 客户登录页拒绝非客户账号的现有文案。 */
export const CUSTOMER_PACKAGE_STAFF_TOAST = '该账号不是客户账号，请联系商家开通'

export interface LoginBlock {
  toast: string
  /** 员工包拒绝客户时清掉已写入的会话。客户包拒绝员工时不动已有会话。 */
  clearSession: boolean
}

/**
 * 登录能不能进当前包。
 * 客户包的客户登录门只收 CUSTOMER，和 pages/customer/login 原来的判断一致。
 * 员工包的统一登录门拒绝 CUSTOMER，避免进到没有原生 tab 的订货页。
 * 客户包里的统一登录仍允许客户账号，返回 null。
 */
export function loginBlock(
  appRole: AppRole,
  role: string | null | undefined,
  door: 'customer' | 'staff',
): LoginBlock | null {
  const normalized = (role ?? '').trim().toUpperCase()
  if (appRole === 'staff' && normalized === 'CUSTOMER') {
    return { toast: STAFF_PACKAGE_CUSTOMER_TOAST, clearSession: true }
  }
  if (door === 'customer' && normalized !== 'CUSTOMER') {
    return { toast: CUSTOMER_PACKAGE_STAFF_TOAST, clearSession: false }
  }
  return null
}

/** 员工包启动时，本地已存的客户角色会话要清掉。客户包和其他角色返回 false。 */
export function storedCustomerOnStaffPackage(appRole: AppRole, role: string | null | undefined): boolean {
  return appRole === 'staff' && (role ?? '').trim().toUpperCase() === 'CUSTOMER'
}

export const STAFF_LOGIN_PAGE = '/pages/staff/login/index'
export const CUSTOMER_LOGIN_PAGE = '/pages/customer/login/index'

/** 未登录时去哪个登录页。员工包没有客户 tab，不能落到客户登录页。 */
export function loggedOutLoginPage(appRole: AppRole): string {
  return appRole === 'staff' ? STAFF_LOGIN_PAGE : CUSTOMER_LOGIN_PAGE
}
