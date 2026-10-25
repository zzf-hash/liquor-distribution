import { AsyncLocalStorage } from 'node:async_hooks';

// B5: 请求级租户上下文(由中间件 / AuthGuard / 定时任务写入), PrismaService $extends 读取后
// 强制注入 where.tenantId, 并在事务内 set_config('app.tenant_id', …, true)。
export const tenantContext = new AsyncLocalStorage<{ tenantId: string }>();

// 显式绕过 RLS(事务局部 app.rls_bypass=on)。只给「还没有租户」的路径:
// 登录前按用户名判断是否全局唯一、seed。请求路径和已进入租户的定时任务不要开。
export const rlsBypassContext = new AsyncLocalStorage<true>();

const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// 事务内 SET LOCAL ROLE。生产连接本身就是非超级用户的业务账号时不要设。
// 集成测试用超级用户连接时, 靠它在本事务里降权, 才能观察到 FORCE RLS。
export const rlsRoleContext = new AsyncLocalStorage<string>();

export function currentRlsRole(): string | undefined {
  const role = rlsRoleContext.getStore();
  if (!role) return undefined;
  if (!ROLE_NAME.test(role)) throw new Error(`非法的 RLS 角色名: ${role}`);
  return role;
}
