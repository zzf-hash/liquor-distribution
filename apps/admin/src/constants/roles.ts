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

// 五模块菜单 × 可见角色（计划书§4.1 内勤后台 + §3.2 岗位分工）
// /orders 全部内勤角色(owner/clerk/warehouse)+owner；主数据/应收=老板+内勤；报表/配置=老板
// P1 新增：审批中心=老板+内勤；特单=F8 全员下单(owner/clerk/rep)；退货=内勤+仓配
// P1 第二批：调价=老板+内勤(成本价仅老板发起)；回包装/采购=内勤+仓配
export const MENU_ROLES: Record<string, Role[]> = {
  '/orders': ['owner', 'clerk', 'warehouse'],
  '/approvals': ['owner', 'clerk'],
  '/special-orders': ['owner', 'clerk', 'rep'],
  '/returns': ['owner', 'clerk', 'warehouse'],
  '/price-changes': ['owner', 'clerk'],
  '/packages': ['owner', 'clerk', 'warehouse'],
  '/purchases': ['owner', 'clerk', 'warehouse'],
  '/master-data': ['owner', 'clerk'],
  '/receivables': ['owner', 'clerk'],
  '/reports': ['owner'],
  '/settings': ['owner'],
};

export interface RouteDef {
  path: string;
  name: string;
  icon: string;
  taskId: string;
}

// 五模块路由（task 7bb5e0eb：订单池/主数据/应收/报表 + 配置）+ P1 第一批（审批中心/特单/退货）
// + P1 第二批（调价/回包装/采购）
export const ADMIN_ROUTES: RouteDef[] = [
  { path: '/orders', name: '订单池', icon: 'ProfileOutlined', taskId: 'P0-T20~T25 订单主线' },
  { path: '/approvals', name: '审批中心', icon: 'AuditOutlined', taskId: 'P1-T01 五条审批线统一' },
  { path: '/special-orders', name: '特单', icon: 'GoldOutlined', taskId: 'P1-T02 F8 全员下单·婚宴宴席' },
  { path: '/returns', name: '退货', icon: 'RollbackOutlined', taskId: 'P1-T03 F10 退货·只多不少' },
  { path: '/price-changes', name: '调价', icon: 'RiseOutlined', taskId: 'P1-T05 F7 调价·版本不覆盖' },
  { path: '/packages', name: '回包装', icon: 'InboxOutlined', taskId: 'P1-T04 F11 无单回收·押金台账' },
  { path: '/purchases', name: '采购', icon: 'ShoppingCartOutlined', taskId: 'P1-T06 F3/F4 采购双流程' },
  { path: '/master-data', name: '主数据', icon: 'DatabaseOutlined', taskId: 'P0-T10~T13 商品·客户·价格·导入' },
  { path: '/receivables', name: '应收', icon: 'AccountBookOutlined', taskId: 'P0-T30~T31 应收·销账·提醒' },
  { path: '/reports', name: '报表', icon: 'BarChartOutlined', taskId: 'P0-T40 老板四问看板' },
  { path: '/settings', name: '配置', icon: 'SettingOutlined', taskId: 'M0-01 业务规则配置' },
];
