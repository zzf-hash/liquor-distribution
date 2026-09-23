// 角色与菜单显隐矩阵
// ⚠️ 角色枚举为 P0-02 契约假设（admin/clerk/cashier/warehouse/boss），
// backend 接口上线后只需改本文件与 services/auth.ts 两处单点。
export type Role = 'admin' | 'clerk' | 'cashier' | 'warehouse' | 'boss';

export const ROLE_LABELS: Record<Role, string> = {
  admin: '系统管理员',
  clerk: '内勤',
  cashier: '出纳',
  warehouse: '仓配',
  boss: '老板',
};

// 五模块菜单 × 可见角色（计划书§4.1 内勤后台 + §3.2 岗位分工）
export const MENU_ROLES: Record<string, Role[]> = {
  '/orders': ['admin', 'clerk', 'cashier', 'warehouse', 'boss'],
  '/master-data': ['admin', 'clerk'],
  '/receivables': ['admin', 'cashier', 'boss'],
  '/reports': ['admin', 'boss'],
  '/settings': ['admin'],
};

export interface RouteDef {
  path: string;
  name: string;
  icon: string;
  taskId: string;
}

// 五模块路由（task 7bb5e0eb：订单池/主数据/应收/报表 + 配置）
export const ADMIN_ROUTES: RouteDef[] = [
  { path: '/orders', name: '订单池', icon: 'ProfileOutlined', taskId: 'P0-08 三入口订单' },
  { path: '/master-data', name: '主数据', icon: 'DatabaseOutlined', taskId: 'P0-04/06/07 商品·客户·导入' },
  { path: '/receivables', name: '应收', icon: 'AccountBookOutlined', taskId: 'P0-13/14 应收·销账·提醒' },
  { path: '/reports', name: '报表', icon: 'BarChartOutlined', taskId: 'P0-15 老板四问看板' },
  { path: '/settings', name: '配置', icon: 'SettingOutlined', taskId: 'M0-01 业务规则配置' },
];
