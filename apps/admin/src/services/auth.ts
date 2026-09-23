import type { Role } from '../constants/roles';

export interface AuthUser {
  token: string;
  username: string;
  name: string;
  role: Role;
}

const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';
const API_BASE = import.meta.env.VITE_API_BASE || '';
const STORE_KEY = 'ld_admin_auth';

// mock 账户表：仅 VITE_USE_MOCK=true 时启用，P0-02 上线后整体移除
const MOCK_USERS: Array<AuthUser & { password: string }> = [
  { token: 'mock-token-admin', username: 'admin', password: '123456', name: '系统管理员', role: 'admin' },
  { token: 'mock-token-clerk', username: 'clerk', password: '123456', name: '内勤小王', role: 'clerk' },
  { token: 'mock-token-cashier', username: 'cashier', password: '123456', name: '出纳老李', role: 'cashier' },
  { token: 'mock-token-warehouse', username: 'warehouse', password: '123456', name: '仓配张姐', role: 'warehouse' },
  { token: 'mock-token-boss', username: 'boss', password: '123456', name: '老板', role: 'boss' },
];

export async function login(username: string, password: string): Promise<AuthUser> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 300)); // 模拟网络延迟
    const hit = MOCK_USERS.find((u) => u.username === username && u.password === password);
    if (!hit) throw new Error('账号或密码错误（mock账户: admin/clerk/cashier/warehouse/boss, 密码 123456）');
    const { token, name, role } = hit;
    return { token, username, name, role };
  }
  // 真实通道：P0-02 约定 POST {API_BASE}/api/auth/login → {code:0,data:{token,name,role}}
  // 字段命名以 backend 实际实现为准，对齐时仅改本函数。
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`登录失败: HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(body.message || '登录失败');
  const { token, name, role } = body.data;
  return { token, username, name, role };
}

export function saveAuth(user: AuthUser): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(user));
}

export function getAuth(): AuthUser | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function clearAuth(): void {
  localStorage.removeItem(STORE_KEY);
}
