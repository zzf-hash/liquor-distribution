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

const ROLES: Role[] = ['owner', 'rep', 'clerk', 'warehouse', 'customer'];

// mock 账户表：仅 VITE_USE_MOCK 未显式关闭时启用（联调/演示回退），角色对齐后端五角色
const MOCK_USERS: Array<AuthUser & { password: string }> = [
  { token: 'mock-token-owner', username: 'owner', password: '123456', name: '老板', role: 'owner' },
  { token: 'mock-token-rep', username: 'rep', password: '123456', name: '业务员小刘', role: 'rep' },
  { token: 'mock-token-clerk', username: 'clerk', password: '123456', name: '内勤小王', role: 'clerk' },
  { token: 'mock-token-warehouse', username: 'warehouse', password: '123456', name: '仓配张姐', role: 'warehouse' },
  { token: 'mock-token-customer', username: 'customer', password: '123456', name: '客户店长', role: 'customer' },
];

/** 后端 Prisma Role 枚举序列化为大写（OWNER/REP/...），前端统一小写 */
function normalizeRole(raw: unknown): Role {
  const r = String(raw ?? '').toLowerCase() as Role;
  return ROLES.includes(r) ? r : 'clerk';
}

export async function login(username: string, password: string): Promise<AuthUser> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 300)); // 模拟网络延迟
    const hit = MOCK_USERS.find((u) => u.username === username && u.password === password);
    if (!hit) throw new Error('账号或密码错误（mock账户: owner/rep/clerk/warehouse/customer, 密码 123456）');
    const { token, name, role } = hit;
    return { token, username, name, role };
  }
  // 真实通道：POST {API_BASE}/api/auth/login → {code:0,data:{token,user:{...,role}}}
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  let body: { code?: number; message?: string; data?: { token: string; user?: { username?: string; name?: string; role?: string } } } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || body.code !== 0 || !body.data?.token) {
    throw new Error(body?.message || `登录失败: HTTP ${res.status}`);
  }
  const { token, user } = body.data;
  return {
    token,
    username: user?.username ?? username,
    name: user?.name ?? username,
    role: normalizeRole(user?.role),
  };
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
