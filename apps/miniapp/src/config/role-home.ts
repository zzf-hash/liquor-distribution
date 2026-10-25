/**
 * 登录后的角色首页。与 services/api.ts 的 re-export 是同一张表，
 * 抽到这里是为了客户页回跳单测不必加载 Taro。
 */
export const ROLE_HOME_PAGE: Record<string, string> = {
  CUSTOMER: '/pages/customer/products/index',
  REP: '/pages/salesman/home/index',
  WAREHOUSE: '/pages/warehouse/outbounds/index',
  CLERK: '/pages/clerk/orders/index',
  OWNER: '/pages/boss/dashboard/index',
}
