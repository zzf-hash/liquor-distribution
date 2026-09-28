/**
 * 四端复用角色开关（task d0974541, 计划书§4.1移动选型）
 *
 * 一套 Taro 工程按 APP_ROLE 编译出各端各自的首页与导航：
 *   customer  客户小程序（订货端，默认）
 *   salesman  业务员端（拜访/语音报单/代下单/收款上报/绩效）
 *   clerk     内勤端（订单池/收款/应收台账）
 *   warehouse 仓配端（拣货/发运/签收）
 *   boss      老板端（四问看板/审批中心）
 *
 * P1 全员端起登录统一到 pages/staff/login，按 user.role 分发到各端首页
 * （路由表见 services/api.ts ROLE_HOME_PAGE），本开关保留给"按端单独出包"的编译形态。
 * 切换方式：编译前改本常量（后续任务可升级为 env 注入 / 多 entry）。
 * 页面注册集中在 src/app.config.ts，新增端先加 pages 再改此开关。
 */
export type AppRole = 'customer' | 'salesman' | 'clerk' | 'warehouse' | 'boss'

export const APP_ROLE: AppRole = 'customer'

export const APP_TITLE: Record<AppRole, string> = {
  customer: '酒类分销·客户订货',
  salesman: '酒类分销·业务员',
  clerk: '酒类分销·内勤',
  warehouse: '酒类分销·仓配',
  boss: '酒类分销·老板',
}
