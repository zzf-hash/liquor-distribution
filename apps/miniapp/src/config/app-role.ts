/**
 * 四端复用角色开关（task d0974541, 计划书§4.1移动选型）
 *
 * 一套 Taro 工程按 APP_ROLE 编译出四端各自的首页与导航：
 *   customer  客户小程序（订货端，默认，本任务交付）
 *   salesman  业务员端（P0-02+ 挂 pages/salesman/*）
 *   warehouse 仓配端（P1+ 挂 pages/warehouse/*）
 *   boss      老板端（P1+ 挂 pages/boss/*）
 *
 * 切换方式：编译前改本常量（后续任务可升级为 env 注入 / 多 entry）。
 * 页面注册集中在 src/app.config.ts，新增端先加 pages 再改此开关。
 */
export type AppRole = 'customer' | 'salesman' | 'warehouse' | 'boss'

export const APP_ROLE: AppRole = 'customer'

export const APP_TITLE: Record<AppRole, string> = {
  customer: '酒类分销·客户订货',
  salesman: '酒类分销·业务员',
  warehouse: '酒类分销·仓配',
  boss: '酒类分销·老板',
}
