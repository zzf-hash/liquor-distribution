import { AsyncLocalStorage } from 'node:async_hooks';

// B5: 请求级租户上下文(由 TenantGuard 写入), PrismaService $extends 读取强制注入
export const tenantContext = new AsyncLocalStorage<{ tenantId: string }>();
