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
export const MENU_ROLES: Record<string, Role[]> = {
  '/orders': ['owner', 'clerk', 'warehouse'],
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

// 五模块路由（task 7bb5e0eb：订单池/主数据/应收/报表 + 配置）
export const ADMIN_ROUTES: RouteDef[] = [
  { path: '/orders', name: '订单池', icon: 'ProfileOutlined', taskId: 'P0-T20~T25 订单主线' },
  { path: '/master-data', name: '主数据', icon: 'DatabaseOutlined', taskId: 'P0-T10~T13 商品·客户·价格·导入' },
  { path: '/receivables', name: '应收', icon: 'AccountBookOutlined', taskId: 'P0-T30~T31 应收·销账·提醒' },
  { path: '/reports', name: '报表', icon: 'BarChartOutlined', taskId: 'P0-T40 老板四问看板' },
  { path: '/settings', name: '配置', icon: 'SettingOutlined', taskId: 'M0-01 业务规则配置' },
];
