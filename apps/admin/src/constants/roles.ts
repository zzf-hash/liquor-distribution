// 角色与菜单显隐矩阵
// 角色枚举对齐后端 Prisma Role（序列化为小写）：owner/rep/clerk/warehouse/customer，
// 后端接口上线后登录映射在 services/auth.ts 单点归一（toLowerCase）。
export type Role = 'owner' | 'rep' | 'clerk' | 'warehouse' | 'customer';

export const ROLE_LABELS: Record<Role, string> = {
  owner: '老板',
  rep: '业务员',
  clerk: '内勤出纳',
  warehouse: '仓配',
  customer: '客户',
};

const ADMIN_ROLES = new Set<Role>(['owner', 'rep', 'clerk', 'warehouse']);

/** 客户和没有角色的会话不能进后台。 */
export function isAdminRole(role: string | null | undefined): role is Role {
  return !!role && ADMIN_ROLES.has(role as Role);
}

// 五模块菜单 × 可见角色（计划书§4.1 内勤后台 + §3.2 岗位分工）
// /orders 全部内勤角色(owner/clerk/warehouse)+owner；主数据/应收=老板+内勤；报表/配置=老板
// P1 新增：审批中心=老板+内勤；特单=F8 全员下单(owner/clerk/rep)；退货=内勤+仓配
// P1 第二批：调价=老板+内勤(成本价仅老板发起)；回包装/采购=内勤+仓配
// P1 第三批：盘点=内勤+仓配+老板(仓管盘/内勤核双签)；优惠返利/绩效工资=老板+内勤
// P1 收尾批：对账=老板+内勤(推送客户/差异处理)；报表=老板+内勤(一键出表)
// P1-T12：转单草稿=owner+clerk+rep(业务员语音入口的确认工作台)
export const MENU_ROLES: Record<string, Role[]> = {
  '/orders': ['owner', 'clerk', 'warehouse'],
  '/approvals': ['owner', 'clerk'],
  '/special-orders': ['owner', 'clerk', 'rep'],
  '/drafts': ['owner', 'clerk', 'rep'],
  '/returns': ['owner', 'clerk', 'warehouse'],
  '/price-changes': ['owner', 'clerk'],
  '/packages': ['owner', 'clerk', 'warehouse'],
  '/purchases': ['owner', 'clerk', 'warehouse'],
  '/stocktakes': ['owner', 'clerk', 'warehouse'],
  '/rebates': ['owner', 'clerk'],
  '/expenses': ['owner', 'clerk'],
  '/payroll': ['owner', 'clerk'],
  '/master-data': ['owner', 'clerk'],
  '/receivables': ['owner', 'clerk'],
  '/statements': ['owner', 'clerk'],
  '/reports': ['owner', 'clerk'],
  '/stock-alert': ['owner', 'clerk'],
  '/settings': ['owner'],
};

export interface RouteDef {
  path: string;
  name: string;
  icon: string;
  taskId: string;
}

// 五模块路由（task 7bb5e0eb：订单池/主数据/应收/报表 + 配置）+ P1 第一批（审批中心/特单/退货）
// + P1 第二批（调价/回包装/采购）+ P1 第三批（盘点/优惠返利/绩效工资）+ P1 收尾批（对账/报表增强）
// + P1-T12（转单草稿：语音/拍照/文字接单）
export const ADMIN_ROUTES: RouteDef[] = [
  { path: '/orders', name: '订单池', icon: 'ProfileOutlined', taskId: 'P0-T20~T25 订单主线' },
  { path: '/approvals', name: '审批中心', icon: 'AuditOutlined', taskId: 'P1-T01 五条审批线统一' },
  { path: '/special-orders', name: '特单', icon: 'GoldOutlined', taskId: 'P1-T02 F8 全员下单·婚宴宴席' },
  { path: '/drafts', name: '转单草稿', icon: 'AudioOutlined', taskId: 'P1-T12 语音/拍照/文字·可编辑草稿' },
  { path: '/returns', name: '退货', icon: 'RollbackOutlined', taskId: 'P1-T03 F10 退货·只多不少' },
  { path: '/price-changes', name: '调价', icon: 'RiseOutlined', taskId: 'P1-T05 F7 调价·版本不覆盖' },
  { path: '/packages', name: '回包装', icon: 'InboxOutlined', taskId: 'P1-T04 F11 无单回收·押金台账' },
  { path: '/purchases', name: '采购', icon: 'ShoppingCartOutlined', taskId: 'P1-T06 F3/F4 采购双流程' },
  { path: '/stocktakes', name: '盘点', icon: 'ReconciliationOutlined', taskId: 'P1-T07 Q11 抽盘·月末大盘·双签' },
  { path: '/rebates', name: '优惠返利', icon: 'GiftOutlined', taskId: 'P1-T08 D02 优惠三式·月末核算' },
  { path: '/expenses', name: '费用中心', icon: 'PayCircleOutlined', taskId: 'B组 费用台账·开瓶费·陈列进店冲抵' },
  { path: '/payroll', name: '绩效工资', icon: 'MoneyCollectOutlined', taskId: 'P1-T09 D5 三指标·一键工资表' },
  { path: '/master-data', name: '主数据', icon: 'DatabaseOutlined', taskId: 'P0-T10~T13 商品·客户·价格·导入' },
  { path: '/receivables', name: '应收', icon: 'AccountBookOutlined', taskId: 'P0-T30~T31 应收·销账·提醒' },
  { path: '/statements', name: '对账', icon: 'FileSyncOutlined', taskId: 'P1-T10 月结对账·差异四类' },
  { path: '/reports', name: '报表', icon: 'BarChartOutlined', taskId: 'P0-T40 四问看板 + P1-T11 月度/库存报表' },
  { path: '/stock-alert', name: '库存预警', icon: 'AlertOutlined', taskId: 'P2 每日库存报表+动态阈值预警+自动报货' },
  { path: '/settings', name: '配置', icon: 'SettingOutlined', taskId: 'M0-01 业务规则配置' },
];

/** 当前角色在菜单矩阵里看得到的路由，顺序与 ADMIN_ROUTES 一致。 */
export function routesForRole(role: string | null | undefined): RouteDef[] {
  if (!role) return [];
  return ADMIN_ROUTES.filter((route) => (MENU_ROLES[route.path] ?? []).includes(role as Role));
}

/**
 * 登录后的落点。没有角色回登录页；有角色但一项菜单都没有，停在无权限页。
 * 不把缺省角色当成老板。
 */
export function shellEntry(role: string | null | undefined): { kind: 'login' } | { kind: 'denied' } | { kind: 'home'; path: string } {
  if (!role) return { kind: 'login' };
  const path = routesForRole(role)[0]?.path;
  if (!path) return { kind: 'denied' };
  return { kind: 'home', path };
}
