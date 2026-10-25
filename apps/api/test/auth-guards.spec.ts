import 'reflect-metadata';
/**
 * P0-02 越权/禁用 单元测试 —— 验收项「越权用例全绿(≥3 正常 + 2 异常)」
 *
 * 覆盖两个全局守卫(安全评审-01 B1/B5 + P1-1 信道分离):
 *   AuthGuard  : 每请求回库校验 token_version(即时吊销) + 账号禁用即时生效 + 租户上下文
 *   RolesGuard : 接口级 RBAC(role 能力面) + 客户信道 vs 内勤信道分离(403)
 *
 * 设计: 纯单测, 不依赖 DB。PrismaClient 被 jest.mock 掉(prisma.service.ts 在模块加载
 *       时 new PrismaClient(), 真实引擎不触网); AuthGuard 的 prisma 由测试注入的
 *       { user: { findUnique } } mock 顶替——守卫逻辑只读该对象, 行为与生产一致。
 *
 * 运行: pnpm --filter @liquor/api test
 */
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// 屏蔽 @prisma/client 真实引擎(仅防止 prisma.service.ts 模块加载时
// `new PrismaClient().$extends(...)` 触网; 守卫逻辑只读注入的 mock, 行为与生产一致)
jest.mock('@prisma/client', () => {
  const stub = {
    $extends: jest.fn().mockReturnValue({
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    }),
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { PrismaClient: jest.fn().mockImplementation(() => stub), Prisma: {} };
});

import { AuthGuard } from '../src/common/auth.guard';
import { RolesGuard, ROLES_KEY } from '../src/common/roles.guard';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';

type Req = { path?: string; headers?: Record<string, string>; user?: any };

function makeContext(req: Req): any {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  };
}

function makeJwt(behavior: (token: string) => any) {
  return { verifyAsync: jest.fn(behavior) } as any;
}

function makeReflector(requiredRoles?: any[]) {
  return { getAllAndOverride: jest.fn().mockReturnValue(requiredRoles) } as unknown as Reflector;
}

/* ─────────────────────────── AuthGuard ─────────────────────────── */

describe('AuthGuard (B1 即时吊销 / B1 禁用 / B5 租户上下文)', () => {
  const bearer = (tv: number, sub = 'u1') => ({ authorization: `Bearer ${JSON.stringify({ sub, tv })}` });

  it('正常①: /api/health 免鉴权直通(不触 JWT/库)', async () => {
    const jwt = makeJwt(jest.fn());
    const guard = new AuthGuard(jwt, { user: { findUnique: jest.fn() } } as any);
    expect(await guard.canActivate(makeContext({ path: '/api/health' }))).toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('正常②: /api/auth/login 免鉴权直通', async () => {
    const jwt = makeJwt(jest.fn());
    const guard = new AuthGuard(jwt, { user: { findUnique: jest.fn() } } as any);
    expect(await guard.canActivate(makeContext({ path: '/api/auth/login' }))).toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('正常③: 有效令牌 + 账号 ACTIVE + tokenVersion 一致 → 放行并建立租户上下文(req.user)', async () => {
    const jwt = makeJwt(async () => ({ sub: 'u-owner', tv: 3 }));
    const findUnique = jest.fn(async () => ({
      id: 'u-owner', tenantId: 't1', username: 'owner', name: '朱总',
      role: 'OWNER', dataScope: 'ALL', status: 'ACTIVE', tokenVersion: 3, customerId: null,
    }));
    const guard = new AuthGuard(jwt, { user: { findUnique } } as any);
    const req: Req = { path: '/api/products', headers: bearer(3, 'u-owner') };
    expect(await guard.canActivate(makeContext(req))).toBe(true);
    expect(req.user).toMatchObject({ tenantId: 't1', role: 'OWNER', aud: 'staff' });
  });

  it('正常④: 客户角色(CUSTOMER)令牌 → 放行且信道标记 aud=customer', async () => {
    const jwt = makeJwt(async () => ({ sub: 'u-cust', tv: 0 }));
    const findUnique = jest.fn(async () => ({
      id: 'u-cust', tenantId: 't1', username: 'cust-c0001', name: '张三',
      role: 'CUSTOMER', dataScope: 'SELF_ORDER', status: 'ACTIVE', tokenVersion: 0, customerId: 'C0001',
    }));
    const guard = new AuthGuard(jwt, { user: { findUnique } } as any);
    const req: Req = { path: '/api/shop/products', headers: bearer(0, 'u-cust') };
    expect(await guard.canActivate(makeContext(req))).toBe(true);
    expect(req.user).toMatchObject({ role: 'CUSTOMER', aud: 'customer', customerId: 'C0001' });
  });

  it('异常①: 缺 Authorization 头 → 401 未登录', async () => {
    const guard = new AuthGuard(makeJwt(jest.fn()), { user: { findUnique: jest.fn() } } as any);
    await expect(guard.canActivate(makeContext({ path: '/api/products', headers: {} })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('异常②: 无效/过期令牌 → 401 令牌无效或已过期', async () => {
    const jwt = makeJwt(async () => { throw new Error('jwt expired'); });
    const guard = new AuthGuard(jwt, { user: { findUnique: jest.fn() } } as any);
    await expect(guard.canActivate(makeContext({ path: '/api/products', headers: bearer(3) })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('异常③: 令牌指向已删除账号 → 401 账号不存在', async () => {
    const jwt = makeJwt(async () => ({ sub: 'ghost', tv: 1 }));
    const guard = new AuthGuard(jwt, { user: { findUnique: jest.fn(async () => null) } } as any);
    await expect(guard.canActivate(makeContext({ path: '/api/products', headers: bearer(1, 'ghost') })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('异常④: 账号已被禁用(status=DISABLED) → 401 账号已禁用 (B1 即时生效)', async () => {
    const jwt = makeJwt(async () => ({ sub: 'u-clerk', tv: 0 }));
    const findUnique = jest.fn(async () => ({
      id: 'u-clerk', tenantId: 't1', username: 'clerk', name: '小王',
      role: 'CLERK', dataScope: 'ALL', status: 'DISABLED', tokenVersion: 0, customerId: null,
    }));
    const guard = new AuthGuard(jwt, { user: { findUnique } } as any);
    await expect(guard.canActivate(makeContext({ path: '/api/receivables', headers: bearer(0, 'u-clerk') })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('异常⑤: tokenVersion 被吊销(JWT.tv 落后于库) → 401 令牌已失效 (B1 即时吊销)', async () => {
    const jwt = makeJwt(async () => ({ sub: 'u-owner', tv: 0 })); // 旧令牌 tv=0
    const findUnique = jest.fn(async () => ({
      id: 'u-owner', tenantId: 't1', username: 'owner', name: '朱总',
      role: 'OWNER', dataScope: 'ALL', status: 'ACTIVE', tokenVersion: 5, // 库已升到 5
      customerId: null,
    }));
    const guard = new AuthGuard(jwt, { user: { findUnique } } as any);
    await expect(guard.canActivate(makeContext({ path: '/api/products', headers: bearer(0, 'u-owner') })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/* ─────────────────────────── RolesGuard ─────────────────────────── */

describe('RolesGuard (RBAC 角色面 + P1-1 客户/内勤信道分离)', () => {
  const userOf = (role: any, aud: any) => ({ role, aud, tenantId: 't1', id: 'u' });

  it('正常①: 接口未声明角色约束 → 放行(登录态由 AuthGuard 负责)', () => {
    const guard = new RolesGuard(makeReflector(undefined));
    const req: Req = { user: userOf('REP', 'staff') };
    expect(guard.canActivate(makeContext(req))).toBe(true);
  });

  it('正常②: 角色在约束集合内(OWNER 调 @Roles(OWNER) 接口) → 放行', () => {
    const guard = new RolesGuard(makeReflector(['OWNER']));
    const req: Req = { user: userOf('OWNER', 'staff') };
    expect(guard.canActivate(makeContext(req))).toBe(true);
  });

  it('正常③: 客户(CUSTOMER)调 @Roles(CUSTOMER) 客户接口 → 放行', () => {
    const guard = new RolesGuard(makeReflector(['CUSTOMER']));
    const req: Req = { user: userOf('CUSTOMER', 'customer') };
    expect(guard.canActivate(makeContext(req))).toBe(true);
  });

  it('异常①: 越权角色(REP 调 @Roles(OWNER) 接口) → 403', () => {
    const guard = new RolesGuard(makeReflector(['OWNER']));
    const req: Req = { user: userOf('REP', 'staff') };
    expect(() => guard.canActivate(makeContext(req))).toThrow(ForbiddenException);
  });

  it('异常②: 客户令牌调内勤接口(@Roles(CLERK), 无 CUSTOMER) → 403 信道分离', () => {
    const guard = new RolesGuard(makeReflector(['CLERK']));
    const req: Req = { user: userOf('CUSTOMER', 'customer') };
    expect(() => guard.canActivate(makeContext(req))).toThrow(ForbiddenException);
  });

  it('异常③: 有角色约束但 req.user 缺失(AuthGuard 未通过) → 拒绝(false)', () => {
    const guard = new RolesGuard(makeReflector(['OWNER']));
    const req: Req = { user: undefined };
    expect(guard.canActivate(makeContext(req))).toBe(false);
  });

  it('机制锚: ROLES_KEY 元数据键名稳定(@Roles 装饰器依赖)', () => {
    expect(ROLES_KEY).toBe('roles');
  });

  it('异常④: 客户令牌调未声明角色的内勤接口 → 403', () => {
    const guard = new RolesGuard(makeReflector(undefined));
    const req: Req = { path: '/api/products', user: userOf('CUSTOMER', 'customer') };
    expect(() => guard.canActivate(makeContext(req))).toThrow(ForbiddenException);
  });

  it('正常④: 客户令牌调 /api/auth/me 与 /api/auth/logout（无 @Roles 也放行）', () => {
    const guard = new RolesGuard(makeReflector(undefined));
    expect(guard.canActivate(makeContext({ path: '/api/auth/me', user: userOf('CUSTOMER', 'customer') }))).toBe(true);
    expect(guard.canActivate(makeContext({ path: '/api/auth/logout', user: userOf('CUSTOMER', 'customer') }))).toBe(true);
  });
});

describe('客户 me / logout (PR14-1)', () => {
  const customer = {
    id: 'u-cust', tenantId: 't1', username: 'cust-c0001', name: '张三',
    role: 'CUSTOMER' as const, dataScope: 'SELF_ORDER' as const, customerId: 'C0001', aud: 'customer' as const,
  };

  function handlerContext(req: Req, handler: (...args: never[]) => unknown) {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => AuthController,
    };
  }

  it('客户调 me 放行并返回身份（HTTP 200）', async () => {
    const reflector = new Reflector();
    const roles = reflector.get<string[]>(ROLES_KEY, AuthController.prototype.me);
    expect(roles).toEqual(expect.arrayContaining(['OWNER', 'REP', 'CLERK', 'WAREHOUSE', 'CUSTOMER']));
    const guard = new RolesGuard(reflector);
    const req: Req = { path: '/api/auth/me', method: 'GET', user: customer };
    expect(guard.canActivate(handlerContext(req, AuthController.prototype.me) as any)).toBe(true);
    const controller = new AuthController({ revokeTokens: jest.fn() } as any, {} as any);
    await expect(controller.me(customer)).resolves.toEqual(customer);
  });

  it('客户 logout 后 tokenVersion + 1，旧 token 调 shop/products 为 401', async () => {
    let tokenVersion = 0;
    const row = () => ({
      id: customer.id, tenantId: customer.tenantId, username: customer.username, name: customer.name,
      role: customer.role, dataScope: customer.dataScope, status: 'ACTIVE', tokenVersion, customerId: customer.customerId,
    });
    const prisma = {
      user: {
        findUnique: jest.fn(async () => row()),
        update: jest.fn(async (args: { data: { tokenVersion: { increment: number } } }) => {
          tokenVersion += args.data.tokenVersion.increment;
          return row();
        }),
      },
    };
    const audit = { log: jest.fn(async () => undefined) };
    const auth = new AuthService(prisma as any, { signAsync: jest.fn() } as any, audit as any);
    const controller = new AuthController(auth, prisma as any);
    const reflector = new Reflector();
    const rolesGuard = new RolesGuard(reflector);
    const logoutReq: Req = { path: '/api/auth/logout', method: 'POST', user: customer };
    expect(rolesGuard.canActivate(handlerContext(logoutReq, AuthController.prototype.logout) as any)).toBe(true);

    await expect(controller.logout(customer, {})).resolves.toEqual({ ok: true });
    expect(tokenVersion).toBe(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: customer.id },
      data: { tokenVersion: { increment: 1 } },
    });

    const jwt = makeJwt(async () => ({ sub: customer.id, tv: 0 }));
    const authGuard = new AuthGuard(jwt, prisma as any);
    const shopReq: Req = {
      path: '/api/shop/products',
      method: 'GET',
      headers: { authorization: 'Bearer old-customer-token' },
    };
    await expect(authGuard.canActivate(makeContext(shopReq))).rejects.toMatchObject({
      status: 401,
      message: '令牌已失效, 请重新登录',
    });
  });
});
