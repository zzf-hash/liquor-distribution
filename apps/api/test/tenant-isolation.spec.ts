/**
 * LQ1-001 / LQ1-007 / LQ1-014 集成测试。需要已 migrate 的 PostgreSQL(DATABASE_URL)。
 * 应用连接沿用超级用户(与官方 postgres 镜像的 POSTGRES_USER 一致), RLS 对它不生效;
 * 行级策略用 SET ROLE 到非超级用户 liquor_rls_probe 验证。
 */
import { BadRequestException, HttpException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService, rawClient } from '../src/prisma/prisma.service';
import { tenantContext } from '../src/prisma/tenant-context';
import { TENANT_MODELS } from '../src/prisma/tenant-models';
import { AuthService, DUMMY_PASSWORD_HASH } from '../src/modules/auth/auth.service';
import { loginDelayMs, loginThrottle, loginUserKey } from '../src/modules/auth/login-throttle';
import { AuditService } from '../src/audit/audit.service';
import { ExpensesService } from '../src/modules/expenses/expenses.service';
import { PromotionsController } from '../src/modules/promotions/promotions.controller';
import { CapFeesService } from '../src/modules/cap-fees/cap-fees.service';
import { UsersController } from '../src/modules/users/users.controller';
import type { AuthUser } from '../src/common/current-user.decorator';

const nonce = `lq1${Date.now().toString(36)}`;
const prisma = new PrismaService();
const auditStub = { log: async () => undefined } as unknown as AuditService;

function owner(id: string, tenantId: string): AuthUser {
  return { id, tenantId, username: 'shared', name: '老板', role: 'OWNER', dataScope: 'ALL', aud: 'staff' };
}

describe('租户隔离 / RLS / 登录', () => {
  const jwt = new JwtService({ secret: 'tenant-isolation-test-secret', signOptions: { expiresIn: '1h' } });
  const auth = new AuthService(prisma, jwt, new AuditService());
  const expenses = new ExpensesService(prisma, auditStub, {} as never);
  const promotions = new PromotionsController(prisma, auditStub);
  const capFees = new CapFeesService(prisma, auditStub, expenses);

  let tenantA: { id: string; code: string };
  let tenantB: { id: string; code: string };
  let userA: { id: string };
  let userB: { id: string };
  let userDisabled: { id: string };
  let expenseA: { id: string };
  let expenseB: { id: string };
  let promoA: { id: string };
  let promoB: { id: string };
  let policyA: { id: string };
  let policyB: { id: string };
  let recycleA: { id: string };
  let recycleB: { id: string };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未设置, 无法跑租户隔离集成测试');
    await rawClient.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liquor_rls_probe') THEN
          CREATE ROLE liquor_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
    `);
    await rawClient.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO liquor_rls_probe`);
    await rawClient.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO liquor_rls_probe`);
    await rawClient.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_rls_guc_probe" (id serial PRIMARY KEY, tid text)`);
    await rawClient.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION capture_user_guc() RETURNS trigger AS $fn$
      BEGIN
        INSERT INTO "_rls_guc_probe"(tid) VALUES (current_setting('app.tenant_id', true));
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `);

    const hashA = bcrypt.hashSync('password-a', 4);
    const hashB = bcrypt.hashSync('password-b', 4);
    const hashU = bcrypt.hashSync('password-u', 4);
    const hashD = bcrypt.hashSync('password-d', 4);
    tenantA = await rawClient.tenant.create({ data: { code: `${nonce}-A`, name: '租户A' } });
    tenantB = await rawClient.tenant.create({ data: { code: `${nonce}-B`, name: '租户B' } });
    userA = await rawClient.user.create({
      data: { tenantId: tenantA.id, username: 'shared', name: '甲', role: 'OWNER', dataScope: 'ALL', passwordHash: hashA, status: 'ACTIVE' },
    });
    userB = await rawClient.user.create({
      data: { tenantId: tenantB.id, username: 'shared', name: '乙', role: 'OWNER', dataScope: 'ALL', passwordHash: hashB, status: 'ACTIVE' },
    });
    await rawClient.user.create({
      data: { tenantId: tenantA.id, username: `only-${nonce}`, name: '唯一', role: 'CLERK', dataScope: 'ALL', passwordHash: hashU, status: 'ACTIVE' },
    });
    userDisabled = await rawClient.user.create({
      data: { tenantId: tenantA.id, username: `disabled-${nonce}`, name: '停用', role: 'CLERK', dataScope: 'ALL', passwordHash: hashD, status: 'DISABLED' },
    });
    const productA = await rawClient.product.create({
      data: { tenantId: tenantA.id, skuCode: `S-${nonce}-A`, name: '酒A', category: 'BAIJIU', baseUnit: '箱', packSize: 6 },
    });
    const productB = await rawClient.product.create({
      data: { tenantId: tenantB.id, skuCode: `S-${nonce}-B`, name: '酒B', category: 'BAIJIU', baseUnit: '箱', packSize: 6 },
    });
    const customerA = await rawClient.customer.create({
      data: { tenantId: tenantA.id, code: `C-${nonce}-A`, name: '店A', type: 'YANJIUDIAN', phone: '13800000001', address: '路 1 号' },
    });
    const customerB = await rawClient.customer.create({
      data: { tenantId: tenantB.id, code: `C-${nonce}-B`, name: '店B', type: 'YANJIUDIAN', phone: '13800000002', address: '路 2 号' },
    });
    expenseA = await rawClient.expense.create({
      data: { tenantId: tenantA.id, expenseNo: `FY-${nonce}-A`, category: 'OFFICE', title: '纸', amount: new Prisma.Decimal('10.00'), createdById: userA.id },
    });
    expenseB = await rawClient.expense.create({
      data: { tenantId: tenantB.id, expenseNo: `FY-${nonce}-B`, category: 'OFFICE', title: '笔', amount: new Prisma.Decimal('20.00'), createdById: userB.id },
    });
    promoA = await rawClient.promotion.create({
      data: { tenantId: tenantA.id, productId: productA.id, buyQty: 2, giftQty: 1, createdById: userA.id, note: 'A' },
    });
    promoB = await rawClient.promotion.create({
      data: { tenantId: tenantB.id, productId: productB.id, buyQty: 3, giftQty: 1, createdById: userB.id, note: 'B' },
    });
    policyA = await rawClient.capFeePolicy.create({
      data: { tenantId: tenantA.id, productId: productA.id, perBottleFee: new Prisma.Decimal('1.0000'), createdById: userA.id },
    });
    policyB = await rawClient.capFeePolicy.create({
      data: { tenantId: tenantB.id, productId: productB.id, perBottleFee: new Prisma.Decimal('2.0000'), createdById: userB.id },
    });
    recycleA = await rawClient.capRecycleOrder.create({
      data: {
        tenantId: tenantA.id, recycleNo: `GAI-${nonce}-A`, customerId: customerA.id, createdById: userA.id,
        lines: [{ productId: productA.id, qty: 1 }], totalAmount: new Prisma.Decimal('1.00'),
      },
    });
    recycleB = await rawClient.capRecycleOrder.create({
      data: {
        tenantId: tenantB.id, recycleNo: `GAI-${nonce}-B`, customerId: customerB.id, createdById: userB.id,
        lines: [{ productId: productB.id, qty: 1 }], totalAmount: new Prisma.Decimal('2.00'),
      },
    });
    await rawClient.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_test_user_guc ON "User"`);
    await rawClient.$executeRawUnsafe(`CREATE TRIGGER zz_test_user_guc BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION capture_user_guc()`);
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_test_user_guc ON "User"`).catch(() => undefined);
    await rawClient.$executeRawUnsafe(`DROP FUNCTION IF EXISTS capture_user_guc()`).catch(() => undefined);
    await rawClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "_rls_guc_probe"`).catch(() => undefined);
    if (tenantA && tenantB) {
      const ids = [tenantA.id, tenantB.id];
      await rawClient.auditLog.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.capRecycleOrder.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.capFeePolicy.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.promotion.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.expense.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.customer.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.product.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.user.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.tenant.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
    await rawClient.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM liquor_rls_probe`).catch(() => undefined);
    await rawClient.$executeRawUnsafe(`DROP ROLE IF EXISTS liquor_rls_probe`).catch(() => undefined);
    await prisma.$disconnect();
    await rawClient.$disconnect();
  });

  it('费用列表和详情、促销列表和 close、开瓶费政策与回收单都不能跨租户', async () => {
    const asA = owner(userA.id, tenantA.id);
    await tenantContext.run({ tenantId: tenantA.id }, async () => {
      const list = await expenses.list(asA, {}) as { items: Array<{ id: string }> };
      expect(list.items.map((row) => row.id)).toContain(expenseA.id);
      expect(list.items.map((row) => row.id)).not.toContain(expenseB.id);
      await expect(expenses.detail(asA, expenseB.id)).rejects.toBeInstanceOf(NotFoundException);
      const own = await expenses.detail(asA, expenseA.id) as { id: string };
      expect(own.id).toBe(expenseA.id);

      const promos = await promotions.list(asA) as Array<{ id: string }>;
      expect(promos.map((row) => row.id)).toContain(promoA.id);
      expect(promos.map((row) => row.id)).not.toContain(promoB.id);
      await expect(promotions.close(asA, promoB.id, { reason: '跨租户' })).rejects.toBeInstanceOf(NotFoundException);

      const policies = await capFees.listPolicies(asA) as Array<{ id: string }>;
      expect(policies.map((row) => row.id)).toEqual([policyA.id]);
      await expect(capFees.closePolicy(asA, policyB.id)).rejects.toBeInstanceOf(NotFoundException);

      const recycles = await capFees.listRecycles(asA, {}) as { items: Array<{ id: string }> };
      expect(recycles.items.map((row) => row.id)).toContain(recycleA.id);
      expect(recycles.items.map((row) => row.id)).not.toContain(recycleB.id);
      await expect(capFees.cancelRecycle(asA, recycleB.id, '跨租户')).rejects.toBeInstanceOf(NotFoundException);

      // 扩展层: 调用方忘了写 tenantId 也注入, 跨租户 id 改不到。
      expect(await prisma.expense.findUnique({ where: { id: expenseB.id } })).toBeNull();
      expect((await prisma.promotion.updateMany({ where: { id: promoB.id }, data: { note: 'hacked' } })).count).toBe(0);
      expect((await prisma.capFeePolicy.updateMany({ where: { id: policyB.id }, data: { closedAt: new Date() } })).count).toBe(0);
      expect((await prisma.capRecycleOrder.updateMany({ where: { id: recycleB.id }, data: { note: 'hacked' } })).count).toBe(0);
    });

    const promoStill = await rawClient.promotion.findUnique({ where: { id: promoB.id } });
    const policyStill = await rawClient.capFeePolicy.findUnique({ where: { id: policyB.id } });
    const recycleStill = await rawClient.capRecycleOrder.findUnique({ where: { id: recycleB.id } });
    expect(promoStill?.closedAt).toBeNull();
    expect(promoStill?.note).toBe('B');
    expect(policyStill?.closedAt).toBeNull();
    expect(recycleStill?.status).toBe('PENDING_CONFIRM');
    expect(recycleStill?.note).toBeNull();
  });

  it('批量事务在设置 app.tenant_id 后仍然整体回滚', async () => {
    const code = `${nonce}-rollback`;
    await expect(tenantContext.run({ tenantId: tenantA.id }, () => prisma.$transaction([
      prisma.tenant.create({ data: { code, name: code } }),
      prisma.$queryRaw`SELECT 1/0`,
    ]))).rejects.toThrow();
    expect(await rawClient.tenant.findUnique({ where: { code } })).toBeNull();

    const plain = `${nonce}-rollback-plain`;
    await expect(prisma.$transaction([
      prisma.tenant.create({ data: { code: plain, name: plain } }),
      prisma.$queryRaw`SELECT 1/0`,
    ])).rejects.toThrow();
    expect(await rawClient.tenant.findUnique({ where: { code: plain } })).toBeNull();
  });

  it('请求事务里能读到 set_config 的 app.tenant_id, 且批量结果不被前缀语句撑大', async () => {
    const [rows] = await tenantContext.run({ tenantId: tenantA.id }, () => prisma.$transaction([
      prisma.$queryRaw<Array<{ tid: string }>>`SELECT current_setting('app.tenant_id', true) AS tid`,
    ]));
    expect(rows).toEqual([{ tid: tenantA.id }]);

    const interactive = await tenantContext.run({ tenantId: tenantB.id }, () => prisma.$transaction(async (tx) => {
      return tx.$queryRaw<Array<{ tid: string }>>`SELECT current_setting('app.tenant_id', true) AS tid`;
    }));
    expect(interactive).toEqual([{ tid: tenantB.id }]);
  });

  it('单条写入所在事务带上 app.tenant_id', async () => {
    await rawClient.$executeRawUnsafe(`TRUNCATE "_rls_guc_probe"`);
    await tenantContext.run({ tenantId: tenantA.id }, async () => {
      await prisma.user.create({
        data: { tenantId: tenantA.id, username: `guc-${nonce}`, name: '探针', role: 'CLERK', dataScope: 'ALL' },
      });
    });
    const seen = await rawClient.$queryRaw<Array<{ tid: string | null }>>`SELECT tid FROM "_rls_guc_probe"`;
    expect(seen.map((row) => row.tid)).toEqual([tenantA.id]);
  });

  it('租户表已 ENABLE 且 FORCE RLS, 非超级用户按 app.tenant_id 看不见别的租户', async () => {
    const flags = await rawClient.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    `;
    const byName = new Map(flags.map((row) => [row.relname, row]));
    for (const model of TENANT_MODELS) {
      expect(byName.get(model)).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
    expect(byName.get('TelemetryEvent')).toMatchObject({ relrowsecurity: false, relforcerowsecurity: false });
    expect(byName.get('Tenant')).toMatchObject({ relrowsecurity: false, relforcerowsecurity: false });

    const policies = await rawClient.$queryRaw<Array<{ tablename: string; policyname: string }>>`
      SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'
    `;
    for (const model of TENANT_MODELS) {
      const names = policies.filter((row) => row.tablename === model).map((row) => row.policyname);
      expect(names).toEqual(expect.arrayContaining(['tenant_isolation', 'tenant_rls_bypass']));
    }

    const visible = async (tenantId: string | null, bypass: boolean) => rawClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE liquor_rls_probe`);
      if (tenantId) await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      if (bypass) await tx.$queryRaw`SELECT set_config('app.rls_bypass', 'on', true)`;
      const expenses = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Expense" WHERE id IN (${Prisma.join([expenseA.id, expenseB.id])})`;
      const promos = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Promotion" WHERE id IN (${Prisma.join([promoA.id, promoB.id])})`;
      const policiesSeen = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "CapFeePolicy" WHERE id IN (${Prisma.join([policyA.id, policyB.id])})`;
      const recycles = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "CapRecycleOrder" WHERE id IN (${Prisma.join([recycleA.id, recycleB.id])})`;
      return {
        expenses: expenses.map((row) => row.id).sort(),
        promos: promos.map((row) => row.id).sort(),
        policies: policiesSeen.map((row) => row.id).sort(),
        recycles: recycles.map((row) => row.id).sort(),
      };
    });

    expect(await visible(tenantA.id, false)).toEqual({
      expenses: [expenseA.id].sort(),
      promos: [promoA.id].sort(),
      policies: [policyA.id].sort(),
      recycles: [recycleA.id].sort(),
    });
    expect(await visible(tenantB.id, false)).toEqual({
      expenses: [expenseB.id].sort(),
      promos: [promoB.id].sort(),
      policies: [policyB.id].sort(),
      recycles: [recycleB.id].sort(),
    });
    const none = await visible(null, false);
    expect(none.expenses).toEqual([]);
    expect(none.promos).toEqual([]);
    expect(none.policies).toEqual([]);
    expect(none.recycles).toEqual([]);
    const both = await visible(null, true);
    expect(both.expenses).toEqual([expenseA.id, expenseB.id].sort());
    expect(both.promos).toEqual([promoA.id, promoB.id].sort());

    // 已知问题: 超级用户即使 FORCE + 设置了 app.tenant_id 也绕过 RLS。
    const asSuper = await rawClient.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantA.id}, true)`;
      return tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "Expense" WHERE id IN (${Prisma.join([expenseA.id, expenseB.id])})`;
    });
    expect(Number(asSuper[0].n)).toBe(2);
  });

  it('同名账号按租户编码各自登录, 错误口令拒绝; 全局唯一的旧请求仍可登录', async () => {
    const a = await auth.login('shared', 'password-a', '10.0.0.1', tenantA.code);
    const b = await auth.login('shared', 'password-b', '10.0.0.2', tenantB.code);
    expect(jwt.decode(a.token)).toMatchObject({ tenantId: tenantA.id, sub: userA.id });
    expect(jwt.decode(b.token)).toMatchObject({ tenantId: tenantB.id, sub: userB.id });
    expect(a.user.id).toBe(userA.id);
    expect(b.user.id).toBe(userB.id);

    await expect(auth.login('shared', 'password-wrong', '10.0.0.3', tenantA.code)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.login('shared', 'password-a', '10.0.0.4', tenantB.code)).rejects.toBeInstanceOf(UnauthorizedException);
    const ambiguousKey = loginUserKey(undefined, 'shared');
    const ambiguousBefore = loginThrottle.userCount(ambiguousKey);
    await expect(auth.login('shared', 'password-a', '10.0.0.5')).rejects.toThrow('该用户名存在于多个租户, 请填写租户编码');
    expect(loginThrottle.userCount(ambiguousKey)).toBe(ambiguousBefore + 1);

    const only = await auth.login(`only-${nonce}`, 'password-u', '10.0.0.6');
    expect(jwt.decode(only.token)).toMatchObject({ tenantId: tenantA.id });

    const audits = await rawClient.auditLog.findMany({ where: { tenantId: tenantA.id, action: 'LOGIN', username: 'shared' } });
    expect(audits.length).toBeGreaterThan(0);
  });

  it('禁用账号无论口令对错响应都相同, 失败审计不写空 userId', async () => {
    const capture = async (password: string, ip: string) => {
      try {
        await auth.login(`disabled-${nonce}`, password, ip, tenantA.code);
        throw new Error('登录应当失败');
      } catch (e) {
        return e;
      }
    };
    const bodyOf = (e: unknown) => {
      expect(e).toBeInstanceOf(HttpException);
      const err = e as HttpException;
      return { status: err.getStatus(), body: err.getResponse() };
    };
    const wrong = await capture('password-wrong', '10.2.0.9');
    const right = await capture('password-d', '10.2.0.9');
    expect(bodyOf(wrong)).toEqual(bodyOf(right));
    expect((wrong as UnauthorizedException).getStatus()).toBe(401);
    expect((wrong as UnauthorizedException).message).toBe('用户名或密码错误');

    const slept: number[] = [];
    const origSleep = loginThrottle.sleep;
    loginThrottle.sleep = async (ms) => { slept.push(ms); };
    const alerts: string[] = [];
    const alertSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      alerts.push(String(message));
    });
    try {
      loginThrottle.reset();
      const captureNamed = async (username: string, password: string) => {
        try {
          await auth.login(username, password, '10.2.2.9', tenantA.code);
          throw new Error('登录应当失败');
        } catch (e) {
          return e;
        }
      };
      const wrongName = `slow-wrong-${nonce}`;
      const disabledName = `slow-disabled-${nonce}`;
      const hashSlow = bcrypt.hashSync('password-d', 4);
      await rawClient.user.create({
        data: { tenantId: tenantA.id, username: wrongName, name: '慢错', role: 'CLERK', dataScope: 'ALL', passwordHash: hashSlow, status: 'ACTIVE' },
      });
      await rawClient.user.create({
        data: { tenantId: tenantA.id, username: disabledName, name: '慢禁', role: 'CLERK', dataScope: 'ALL', passwordHash: hashSlow, status: 'DISABLED' },
      });
      for (let i = 0; i < 10; i += 1) {
        await expect(auth.login(wrongName, 'password-wrong', '10.2.2.1', tenantA.code)).rejects.toThrow('用户名或密码错误');
        await expect(auth.login(disabledName, 'password-wrong', '10.2.2.2', tenantA.code)).rejects.toThrow('用户名或密码错误');
      }
      expect(slept).toEqual([]);
      const eleventhWrong = await captureNamed(wrongName, 'password-wrong');
      const eleventhDisabled = await captureNamed(disabledName, 'password-d');
      expect(bodyOf(eleventhWrong)).toEqual(bodyOf(eleventhDisabled));
      expect(bodyOf(eleventhWrong).status).toBe(401);
      expect(slept).toEqual([loginDelayMs(11), loginDelayMs(11)]);
      expect(loginDelayMs(11)).toBeGreaterThanOrEqual(1000);
      expect(loginDelayMs(21)).toBeLessThanOrEqual(3000);
      expect(alerts.some((line) => line.includes('开始延迟而不锁定'))).toBe(true);
    } finally {
      loginThrottle.sleep = origSleep;
      alertSpy.mockRestore();
    }

    await expect(auth.login(`missing-${nonce}`, 'password-a', '10.2.0.3', tenantA.code)).rejects.toThrow('用户名或密码错误');
    await expect(auth.login('shared', 'password-wrong', '10.2.0.4', tenantA.code)).rejects.toThrow('用户名或密码错误');

    const disabledRows = await rawClient.auditLog.findMany({
      where: { tenantId: tenantA.id, action: 'LOGIN_FAIL', username: `disabled-${nonce}`, ip: '10.2.0.9' },
      orderBy: { createdAt: 'asc' },
    });
    expect(disabledRows).toHaveLength(2);
    expect(disabledRows.every((row) => row.userId === userDisabled.id)).toBe(true);
    const reasons = disabledRows.map((row) => (row.after as { reason?: string } | null)?.reason ?? null);
    expect(reasons.sort()).toEqual(['DISABLED', null].sort());

    const missingRows = await rawClient.auditLog.findMany({
      where: { tenantId: tenantA.id, action: 'LOGIN_FAIL', username: `missing-${nonce}` },
    });
    expect(missingRows).toHaveLength(1);
    expect(missingRows[0].userId).toBeNull();

    const sharedFails = await rawClient.auditLog.findMany({
      where: { tenantId: tenantA.id, action: 'LOGIN_FAIL', username: 'shared' },
    });
    expect(sharedFails.length).toBeGreaterThan(0);
    expect(sharedFails.every((row) => row.userId === userA.id)).toBe(true);

    const warns: string[] = [];
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warns.push(String(message));
    });
    try {
      await expect(auth.login(`ghost-${nonce}`, 'password-a', '10.2.0.8', `missing-tenant-${nonce}`)).rejects.toThrow('用户名或密码错误');
    } finally {
      warnSpy.mockRestore();
    }
    expect(warns.some((line) => line.includes('无法写入审计'))).toBe(true);
    expect(await rawClient.auditLog.count({ where: { username: `ghost-${nonce}` } })).toBe(0);

    const hashCost10 = bcrypt.hashSync('password-cost10', 10);
    await rawClient.user.create({
      data: { tenantId: tenantA.id, username: `cost10-${nonce}`, name: '代价', role: 'CLERK', dataScope: 'ALL', passwordHash: hashCost10, status: 'ACTIVE' },
    });
    const startedWrong = Date.now();
    await expect(auth.login(`cost10-${nonce}`, 'password-wrong', '10.2.3.1', tenantA.code)).rejects.toThrow('用户名或密码错误');
    const wrongMs = Date.now() - startedWrong;
    const startedMissing = Date.now();
    await expect(auth.login(`nobody-${nonce}`, 'password-wrong', '10.2.3.2', `missing-tenant-${nonce}`)).rejects.toThrow('用户名或密码错误');
    const missingMs = Date.now() - startedMissing;
    expect(Math.abs(wrongMs - missingMs)).toBeLessThan(400);
    expect(DUMMY_PASSWORD_HASH.split('$')[2]).toBe('10');

    await expect(tenantContext.run({ tenantId: tenantA.id }, () => prisma.user.create({
      data: { tenantId: tenantA.id, username: 'System', name: '保留', role: 'CLERK', dataScope: 'ALL', passwordHash: bcrypt.hashSync('password-x', 4), status: 'ACTIVE' },
    }))).rejects.toThrow('用户名 system 为系统保留');
    const users = new UsersController(prisma, auth, new AuditService());
    await expect(users.create(owner(userA.id, tenantA.id), {
      username: 'SyStEm', password: 'password-x', name: '保留', role: 'CLERK',
    })).rejects.toThrow('用户名 system 为系统保留');
    await expect(tenantContext.run({ tenantId: tenantA.id }, () => prisma.user.update({
      where: { id: userA.id },
      data: { username: 'system' },
    }))).rejects.toThrow('用户名 system 为系统保留');
  });
});
