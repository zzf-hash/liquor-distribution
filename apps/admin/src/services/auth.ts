import type { Role } from '../constants/roles';
import { apiBase } from './api-base';

export interface AuthUser {
  token: string;
  username: string;
  name: string;
  role: Role;
}

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';
const STORE_KEY = 'ld_admin_auth';

const ROLES: Role[] = ['owner', 'rep', 'clerk', 'warehouse', 'customer'];

/** 后端 Prisma Role 枚举序列化为大写（OWNER/REP/...），前端统一小写 */
function normalizeRole(raw: unknown): Role {
  const r = String(raw ?? '').toLowerCase() as Role;
  return ROLES.includes(r) ? r : 'clerk';
}

export async function login(username: string, password: string, tenantCode?: string): Promise<AuthUser> {
  if (USE_MOCK) {
    const { mockLogin } = await import('./auth-mock');
    const user = await mockLogin(username, password);
    assertAdminRole(user.role);
    return user;
  }
  // 真实通道：POST {API_BASE}/api/auth/login → {code:0,data:{token,user:{...,role}}}
  const res = await fetch(`${apiBase()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, ...(tenantCode?.trim() ? { tenantCode: tenantCode.trim() } : {}) }),
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
  const role = normalizeRole(user?.role);
  assertAdminRole(role);
  return {
    token,
    username: user?.username ?? username,
    name: user?.name ?? username,
    role,
  };
}

function assertAdminRole(role: Role): void {
  if (role === 'customer') {
    throw new Error('客户账号请使用订货小程序，不能进入内勤后台');
  }
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
