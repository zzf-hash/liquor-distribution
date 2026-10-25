/**
 * 编译期包别（task d0974541, 计划书§4.1移动选型）
 *
 * 一套 Taro 工程，用 TARO_APP_ROLE 决定原生 tabBar 和窗口标题。页面仍全部注册。
 *   customer   客户包（默认）。原生 tab 是首页 / 订货 / 我的订单 / 待结金额。
 *   staff      员工包。不生成原生 tabBar，登录后由 RoleTabBar 按 user.role 显示。
 *   salesman / clerk / warehouse / boss
 *              按单一角色出包，原生 tab 就是该角色的 tab。
 *
 * 未设置或无法识别时是 customer。员工包必须显式设 staff。
 * 若仍用客户包给员工登录，app.json 里写死了客户 tabBar，非 tab 页上
 * hideTabBar 盖不住 H5 的 taro-tabbar，底部会露出客户导航再叠一层 RoleTabBar。
 */
export type AppRole = 'customer' | 'staff' | 'salesman' | 'clerk' | 'warehouse' | 'boss'

const APP_ROLES: readonly AppRole[] = ['customer', 'staff', 'salesman', 'clerk', 'warehouse', 'boss']

export function readAppRole(raw: string | undefined): AppRole {
  const value = String(raw ?? '').trim()
  return (APP_ROLES as readonly string[]).includes(value) ? (value as AppRole) : 'customer'
}

/**
 * 编译期包别。未设置 TARO_APP_ROLE 时是客户包。
 * 不要用 typeof process 守卫：H5 里没有 process，守卫会把已经编进包里的值丢掉。
 */
export const APP_ROLE: AppRole = readAppRole(process.env.TARO_APP_ROLE)

export const APP_TITLE: Record<AppRole, string> = {
  customer: '酒类分销·客户订货',
  staff: '酒类分销·员工',
  salesman: '酒类分销·业务员',
  clerk: '酒类分销·内勤',
  warehouse: '酒类分销·仓配',
  boss: '酒类分销·老板',
}
