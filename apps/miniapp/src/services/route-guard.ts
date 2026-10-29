import { ROLE_HOME_PAGE } from '../config/role-home'
import { normalizeRoute } from '../config/role-tabs'

/** 统一登录页。客户旧登录地址会转到这里。 */
export const LOGIN_PATH = '/pages/staff/login/index'

const STAFF_ROLES = new Set(['REP', 'CLERK', 'WAREHOUSE', 'OWNER'])

/** 新建客户只给老板和业务员。小程序不给内勤这条页面。 */
const CREATE_CUSTOMER_ROLES = new Set(['OWNER', 'REP'])

/** 全量库存的接口角色。业务员不在里面。 */
const INVENTORY_ROLES = new Set(['OWNER', 'CLERK', 'WAREHOUSE'])

/**
 * 老板首页、看板、审批的接口是 OWNER + CLERK。
 * 仓管只进库存页，不进这三页。
 */
const BOSS_DESK_ROLES = new Set(['OWNER', 'CLERK'])

/**
 * 比「任意员工」更窄的页面。
 * 库存单独列出，避免被后面的 pages/boss/ 收成老板和内勤。
 */
export function rolesForStaffPage(path: string): ReadonlySet<string> | null {
  if (path === 'pages/salesman/customer-create/index' || path.startsWith('pages/salesman/customer-create/')) {
    return CREATE_CUSTOMER_ROLES
  }
  if (path === 'pages/boss/inventory/index' || path.startsWith('pages/boss/inventory/')) return INVENTORY_ROLES
  if (path.startsWith('pages/boss/')) return BOSS_DESK_ROLES
  return null
}

export function normalizeRole(role: string | null | undefined): string {
  return (role ?? '').trim().toUpperCase()
}

/** 登录响应里的 role 决定首页。不认识的角色返回 null，调用方不要自己猜。 */
export function homeForRole(role: string | null | undefined): string | null {
  const key = normalizeRole(role)
  return ROLE_HOME_PAGE[key] ?? null
}

export type PageSide = 'public' | 'customer' | 'staff' | 'other'

/** 客户页和员工页。两个登录页是公共入口，用来切换账号。 */
export function pageSide(route: string): PageSide {
  const path = normalizeRoute(route)
  if (!path) return 'other'
  if (path === 'pages/staff/login/index' || path === 'pages/customer/login/index') return 'public'
  if (path === 'pages/index/index' || path.startsWith('pages/customer/')) return 'customer'
  if (
    path.startsWith('pages/salesman/')
    || path.startsWith('pages/clerk/')
    || path.startsWith('pages/warehouse/')
    || path.startsWith('pages/boss/')
  ) return 'staff'
  return 'other'
}

/**
 * 越权时返回该角色自己的首页。
 * 未登录可以停在客户首页和登录页；其余客户页、全部员工页回到登录页。
 * 客户进员工页回订货页，员工进客户页回自己的工作台。
 */
export function guardRedirect(role: string | null | undefined, route: string): string | null {
  const path = normalizeRoute(route)
  if (!path) return null
  const side = pageSide(path)
  if (side === 'public' || side === 'other') return null
  const normalized = normalizeRole(role)
  if (!normalized) {
    if (side === 'staff') return LOGIN_PATH
    if (side === 'customer' && path !== 'pages/index/index') return LOGIN_PATH
    return null
  }
  if (normalized === 'CUSTOMER') {
    return side === 'staff' ? ROLE_HOME_PAGE.CUSTOMER : null
  }
  if (STAFF_ROLES.has(normalized)) {
    if (side === 'customer') return ROLE_HOME_PAGE[normalized] ?? null
    const allowed = rolesForStaffPage(path)
    if (allowed && !allowed.has(normalized)) return ROLE_HOME_PAGE[normalized] ?? LOGIN_PATH
    return null
  }
  return LOGIN_PATH
}

/**
 * 身份已经确认、且这个角色不能停在该页时，返回他的首页。
 * 角色还没对上时返回 null，刷新不因空角色被送去登录。
 */
export function deniedHomeForConfirmedRole(role: string | null | undefined, route: string): string | null {
  if (!normalizeRole(role)) return null
  return guardRedirect(role, route)
}

/**
 * H5 越权跳转要先盖住画面，再排队换页。
 * 同步 reLaunch 只改 hash，页面还会画出对方角色的壳。
 */
export function deferGuardedRelaunch(
  url: string,
  effects: {
    cover: () => void
    schedule: (fn: () => void) => void
    relaunch: (url: string) => void
  },
): void {
  effects.cover()
  effects.schedule(() => effects.relaunch(url))
}
