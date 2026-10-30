import type { AuthUser } from './auth';

const MOCK_USERS: Array<AuthUser & { password: string }> = [
  { token: 'mock-token-owner', username: 'owner', password: '123456', name: '老板', role: 'owner' },
  { token: 'mock-token-rep', username: 'rep', password: '123456', name: '业务员小刘', role: 'rep' },
  { token: 'mock-token-clerk', username: 'clerk', password: '123456', name: '内勤小王', role: 'clerk' },
  { token: 'mock-token-warehouse', username: 'warehouse', password: '123456', name: '仓配张姐', role: 'warehouse' },
  { token: 'mock-token-customer', username: 'customer', password: '123456', name: '客户店长', role: 'customer' },
];

/** 仅 VITE_USE_MOCK=true 时由登录动态加载，生产包不包含这张表。 */
export async function mockLogin(username: string, password: string): Promise<AuthUser> {
  await new Promise((r) => setTimeout(r, 300));
  const hit = MOCK_USERS.find((u) => u.username === username && u.password === password);
  if (!hit) throw new Error('账号或密码错误');
  const { token, name, role } = hit;
  return { token, username, name, role };
}
