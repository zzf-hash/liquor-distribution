import { AsyncLocalStorage } from 'node:async_hooks';

// B5: 请求级租户上下文(由中间件 / AuthGuard / 定时任务写入), PrismaService $extends 读取后
// 强制注入 where.tenantId, 并在事务内 set_config('app.tenant_id', …, true)。
export const tenantContext = new AsyncLocalStorage<{ tenantId: string }>();

// 显式绕过 RLS(事务局部 app.rls_bypass=on)。只给「还没有租户」的路径:
// 登录前按用户名判断是否全局唯一、seed。请求路径和已进入租户的定时任务不要开。
export const rlsBypassContext = new AsyncLocalStorage<true>();
