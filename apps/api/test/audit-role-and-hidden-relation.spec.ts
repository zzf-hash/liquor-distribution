/**
 * LQ1-052 业务账号追加审计链; LQ1-054 必填关联被 RLS 滤掉时不 500。
 * liquor_app: LOGIN、非超级用户、非表主、无 BYPASSRLS, AuditLog 只有 SELECT/INSERT。
 * 口令只在本进程里生成, 不作为部署凭据。
 */
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService, rawClient } from '../src/prisma/prisma.service';
import { rlsRoleContext, tenantContext } from '../src/prisma/tenant-context';
import { AuditService } from '../src/audit/audit.service';
import { PromotionsController } from '../src/modules/promotions/promotions.controller';
import { CapFeesService } from '../src/modules/cap-fees/cap-fees.service';
import { DailyTasksService } from '../src/modules/daily-tasks/daily-tasks.service';
import { StockAlertService, SYSTEM_USER } from '../src/modules/stock-alert/stock-alert.service';
import type { AuthUser } from '../src/common/current-user.decorator';

const nonce = `lq1f${Date.now().toString(36)}`;
const appPassword = `pw${nonce}`;
const prisma = new PrismaService();
const auditStub = { log: async () => undefined } as unknown as AuditService;

function owner(id: string, tenantId: string): AuthUser {
  return { id, tenantId, username: 'owner', name: '老板', role: 'OWNER', dataScope: 'ALL', aud: 'staff' };
}

function appUrl(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = 'liquor_app';
  url.password = appPassword;
  url.searchParams.set('connection_limit', '1');
  return url.toString();
}

describe('业务账号审计链 / 跨租户必填关联', () => {
  const promotions = new PromotionsController(prisma, auditStub);
  const capFees = new CapFeesService(prisma, auditStub, {} as never);
  let appClient: PrismaClient;
  let peer: PrismaClient;
  let tenantA: { id: string };
  let tenantB: { id: string };
  let userA: { id: string };
  let userB: { id: string };
  let productA: { id: string };
  let productB: { id: string };
  let customerA: { id: string };
  let customerB: { id: string };
  let goodPromo: { id: string };
  let badPromo: { id: string };
  let goodPolicy: { id: string };
  let badPolicy: { id: string };
  let goodRecycle: { id: string };
  let badRecycle: { id: string };
  let goodOrder: { id: string };
  let badCustomerOrder: { id: string };
  let badLineOrder: { id: string };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未设置');
    await rawClient.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liquor_app') THEN
          CREATE ROLE liquor_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS;
        ELSE
          ALTER ROLE liquor_app WITH LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
    `);
    await rawClient.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO liquor_app`);
    await rawClient.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO liquor_app`);
    await rawClient.$executeRawUnsafe(`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM liquor_app`);

    tenantA = await rawClient.tenant.create({ data: { code: `${nonce}-A`, name: '审计A' } });
    tenantB = await rawClient.tenant.create({ data: { code: `${nonce}-B`, name: '审计B' } });
    userA = await rawClient.user.create({
      data: { tenantId: tenantA.id, username: `a-${nonce}`, name: '甲', role: 'OWNER', dataScope: 'ALL' },
    });
    userB = await rawClient.user.create({
      data: { tenantId: tenantB.id, username: `b-${nonce}`, name: '乙', role: 'OWNER', dataScope: 'ALL' },
    });
    productA = await rawClient.product.create({
      data: { tenantId: tenantA.id, skuCode: `S-${nonce}-A`, name: '酒A', category: 'BAIJIU', baseUnit: '箱', packSize: 6 },
    });
    productB = await rawClient.product.create({
      data: { tenantId: tenantB.id, skuCode: `S-${nonce}-B`, name: '酒B', category: 'BAIJIU', baseUnit: '箱', packSize: 6 },
    });
    customerA = await rawClient.customer.create({
      data: { tenantId: tenantA.id, code: `C-${nonce}-A`, name: '店A', type: 'YANJIUDIAN', phone: '13800000011', address: '甲路' },
    });
    customerB = await rawClient.customer.create({
      data: { tenantId: tenantB.id, code: `C-${nonce}-B`, name: '店B', type: 'YANJIUDIAN', phone: '13800000012', address: '乙路' },
    });
    goodPromo = await rawClient.promotion.create({
      data: { tenantId: tenantB.id, productId: productB.id, buyQty: 2, giftQty: 1, createdById: userB.id, note: 'good' },
    });
    badPromo = await rawClient.promotion.create({
      data: { tenantId: tenantB.id, productId: productA.id, buyQty: 2, giftQty: 1, createdById: userB.id, note: 'cross' },
    });
    goodPolicy = await rawClient.capFeePolicy.create({
      data: { tenantId: tenantB.id, productId: productB.id, perBottleFee: new Prisma.Decimal('1.0000'), createdById: userB.id },
    });
    badPolicy = await rawClient.capFeePolicy.create({
      data: { tenantId: tenantB.id, productId: productA.id, perBottleFee: new Prisma.Decimal('1.0000'), createdById: userB.id },
    });
    goodRecycle = await rawClient.capRecycleOrder.create({
      data: {
        tenantId: tenantB.id, recycleNo: `GAI-${nonce}-OK`, customerId: customerB.id, createdById: userB.id,
        lines: [], totalAmount: new Prisma.Decimal('1.00'),
      },
    });
    badRecycle = await rawClient.capRecycleOrder.create({
      data: {
        tenantId: tenantB.id, recycleNo: `GAI-${nonce}-BAD`, customerId: customerA.id, createdById: userB.id,
        lines: [], totalAmount: new Prisma.Decimal('1.00'),
      },
    });
    const orderBase = {
      tenantId: tenantB.id, source: 'CLERK' as const, signMode: 'E_SIGN' as const, status: 'PENDING_CONFIRM' as const,
      addressSnapshot: '乙路', createdById: userB.id, customerName: '店',
    };
    goodOrder = await rawClient.salesOrder.create({
      data: { ...orderBase, orderNo: `SO-${nonce}-OK`, customerId: customerB.id, customerName: '店B' },
    });
    badCustomerOrder = await rawClient.salesOrder.create({
      data: { ...orderBase, orderNo: `SO-${nonce}-CUST`, customerId: customerA.id, customerName: '店A' },
    });
    badLineOrder = await rawClient.salesOrder.create({
      data: { ...orderBase, orderNo: `SO-${nonce}-LINE`, customerId: customerB.id, customerName: '店B' },
    });
    const line = {
      tenantId: tenantB.id, unit: 'BASE' as const, conversionRate: 6, qty: new Prisma.Decimal('1'),
      unitPrice: new Prisma.Decimal('10'), amount: new Prisma.Decimal('10'), priceType: 'MANUAL' as const,
      priceVersion: 't', productName: '酒', createdById: userB.id,
    };
    await rawClient.orderLine.create({ data: { ...line, orderId: goodOrder.id, productId: productB.id, productName: '酒B' } });
    await rawClient.orderLine.create({ data: { ...line, orderId: badLineOrder.id, productId: productA.id, productName: '酒A' } });

    appClient = new PrismaClient({ datasources: { db: { url: appUrl() } } });
    peer = new PrismaClient({ datasources: { db: { url: appUrl() } } });
  });

  afterAll(async () => {
    await appClient?.$disconnect().catch(() => undefined);
    await peer?.$disconnect().catch(() => undefined);
    if (tenantA && tenantB) {
      const ids = [tenantA.id, tenantB.id];
      await rawClient.auditLog.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.dailyStockReport.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.orderLine.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.salesOrder.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.capRecycleOrder.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.capFeePolicy.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.promotion.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.customer.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.product.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.user.deleteMany({ where: { tenantId: { in: ids } } }).catch(() => undefined);
      await rawClient.tenant.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
    await rawClient.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM liquor_app`).catch(() => undefined);
    await rawClient.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM liquor_app`).catch(() => undefined);
    await rawClient.$executeRawUnsafe(`DROP ROLE IF EXISTS liquor_app`).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await rawClient.$disconnect().catch(() => undefined);
  });

  it('liquor_app 不是超级用户也不是表主, AuditLog 不能 UPDATE, 但审计能写入且链连续', async () => {
    const priv = await rawClient.$queryRaw<Array<{ upd: boolean; ins: boolean; sel: boolean; super: boolean; bypass: boolean; owner: boolean }>>`
      SELECT
        has_table_privilege('liquor_app', '"AuditLog"', 'UPDATE') AS upd,
        has_table_privilege('liquor_app', '"AuditLog"', 'INSERT') AS ins,
        has_table_privilege('liquor_app', '"AuditLog"', 'SELECT') AS sel,
        r.rolsuper AS super,
        r.rolbypassrls AS bypass,
        pg_get_userbyid(c.relowner) = 'liquor_app' AS owner
      FROM pg_roles r, pg_class c
      WHERE r.rolname = 'liquor_app' AND c.relname = 'AuditLog'
    `;
    expect(priv[0]).toMatchObject({ upd: false, ins: true, sel: true, super: false, bypass: false, owner: false });

    await expect(appClient.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantA.id}, true)`;
      await tx.$queryRaw`SELECT "rowHash" FROM "AuditLog" WHERE "tenantId" = ${tenantA.id} LIMIT 1 FOR UPDATE`;
    })).rejects.toThrow(/permission denied|42501/);

    const audit = new AuditService().bindClient(appClient);
    await audit.log({
      user: { id: userA.id, tenantId: tenantA.id, username: 'a', role: 'OWNER' },
      action: 'LOGIN', entityType: 'User', entityId: userA.id,
    });
    await expect(audit.verifyChain(tenantA.id)).resolves.toEqual({ ok: true });
    const written = await rawClient.auditLog.findMany({ where: { tenantId: tenantA.id, action: 'LOGIN' } });
    expect(written).toHaveLength(1);
    expect(written[0].userId).toBe(userA.id);
    expect(written[0].prevRowHash).toBe('GENESIS');
  });

  it('两个业务连接并发追加不分叉', async () => {
    const left = new AuditService().bindClient(appClient);
    const right = new AuditService().bindClient(peer);
    const user = { id: userA.id, tenantId: tenantA.id, username: 'a', role: 'OWNER' };
    await Promise.all([
      left.log({ user, action: 'ORDER_CREATE', entityType: 'Order', entityId: `${nonce}-1`, after: { n: 1 } }),
      right.log({ user, action: 'ORDER_CREATE', entityType: 'Order', entityId: `${nonce}-2`, after: { n: 2 } }),
    ]);
    await expect(left.verifyChain(tenantA.id)).resolves.toEqual({ ok: true });
    const rows = await rawClient.auditLog.findMany({
      where: { tenantId: tenantA.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0].prevRowHash).toBe('GENESIS');
    const prevs = rows.map((row) => row.prevRowHash);
    expect(new Set(prevs).size).toBe(prevs.length);
    for (let i = 1; i < rows.length; i += 1) expect(rows[i].prevRowHash).toBe(rows[i - 1].rowHash);
  });

  it('写入失败记 error 并触发告警, 不把异常抛回业务', async () => {
    const errors: string[] = [];
    const alerts: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    const notify = { send: async (title: string, lines: string[]) => { alerts.push([title, ...lines].join('\n')); return true; } };
    const audit = new AuditService(notify as never).bindClient(appClient);
    const before = await rawClient.auditLog.count({ where: { tenantId: tenantA.id, action: 'TOKEN_REVOKE' } });
    try {
      await rawClient.$executeRawUnsafe(`REVOKE INSERT ON TABLE "AuditLog" FROM liquor_app`);
      await expect(audit.log({
        user: { id: userA.id, tenantId: tenantA.id, username: 'a', role: 'OWNER' },
        action: 'TOKEN_REVOKE', entityType: 'User', entityId: userA.id,
      })).resolves.toBeUndefined();
    } finally {
      await rawClient.$executeRawUnsafe(`GRANT INSERT ON TABLE "AuditLog" TO liquor_app`);
      spy.mockRestore();
    }
    const after = await rawClient.auditLog.count({ where: { tenantId: tenantA.id, action: 'TOKEN_REVOKE' } });
    expect(after).toBe(before);
    expect(errors.some((line) => line.includes('audit append failed'))).toBe(true);
    expect(alerts.some((line) => line.includes('审计写入失败'))).toBe(true);
  });

  it('liquor_app 跑定时任务时系统审计写入 userId 为空, 没有 23503, 链仍连续', async () => {
    const errors: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    const notify = { send: async () => false };
    const audit = new AuditService(notify as never).bindClient(appClient);
    const daily = new DailyTasksService(prisma, audit, notify as never, {} as never, {} as never);
    const stock = new StockAlertService(prisma, audit, notify as never, {} as never, {} as never);
    const actor = SYSTEM_USER(tenantA.id);
    try {
      const reminders = await rlsRoleContext.run('liquor_app', () => tenantContext.run({ tenantId: tenantA.id }, () => daily.runDueReminders(actor)));
      expect(reminders).toMatchObject({ dueSoonCount: 0, notified: false });
      const scan = await rlsRoleContext.run('liquor_app', () => tenantContext.run({ tenantId: tenantA.id }, () => stock.runScan(actor, { createRestocks: true })));
      expect(scan.rows).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((line) => line.includes('23503') || line.includes('audit append failed'))).toEqual([]);

    const rows = await rawClient.auditLog.findMany({
      where: { tenantId: tenantA.id, username: 'system', action: { in: ['AR_REMINDER_RUN', 'STOCK_REPORT_RUN'] } },
      orderBy: { action: 'asc' },
    });
    expect(rows.map((row) => row.action)).toEqual(['AR_REMINDER_RUN', 'STOCK_REPORT_RUN']);
    expect(rows.every((row) => row.userId === null && row.username === 'system')).toBe(true);
    await expect(audit.verifyChain(tenantA.id)).resolves.toEqual({ ok: true });
  });

  it('跨租户必填关联不把列表打成 500: 跳过该行, 详情按不存在', async () => {
    const warns: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warns.push(String(message));
    });
    try {
      const user = owner(userB.id, tenantB.id);
      const listed = await rlsRoleContext.run('liquor_app', () => tenantContext.run({ tenantId: tenantB.id }, async () => {
        const promos = await promotions.list(user) as Array<{ id: string; productName: string }>;
        const policies = await capFees.listPolicies(user) as Array<{ id: string; productName: string }>;
        const recycles = await capFees.listRecycles(user, {}) as { items: Array<{ id: string }> };
        const orders = await prisma.salesOrder.findMany({
          where: { tenantId: tenantB.id, orderNo: { startsWith: `SO-${nonce}` } },
          include: {
            customer: { select: { name: true } },
            lines: { include: { product: { select: { name: true } } } },
          },
        });
        const hidden = await prisma.capRecycleOrder.findUnique({
          where: { id: badRecycle.id, tenantId: tenantB.id },
          include: { customer: true },
        });
        const visible = await prisma.capRecycleOrder.findUnique({
          where: { id: goodRecycle.id, tenantId: tenantB.id },
          include: { customer: true },
        });
        return { promos, policies, recycles, orders, hidden, visible };
      }));

      expect(listed.promos.map((row) => row.id)).toEqual([goodPromo.id]);
      expect(listed.promos[0].productName).toBe('酒B');
      expect(listed.policies.map((row) => row.id)).toEqual([goodPolicy.id]);
      expect(listed.policies[0].productName).toBe('酒B');
      expect(listed.recycles.items.map((row) => row.id)).toEqual([goodRecycle.id]);
      expect(listed.orders.map((row) => row.id)).toEqual([goodOrder.id]);
      expect(listed.orders[0].customer.name).toBe('店B');
      expect(listed.orders[0].lines[0].product.name).toBe('酒B');
      expect(listed.hidden).toBeNull();
      expect(listed.visible?.customer.id).toBe(customerB.id);
    } finally {
      spy.mockRestore();
    }

    const text = warns.join('\n');
    expect(text).toContain(badPromo.id);
    expect(text).toContain(badPolicy.id);
    expect(text).toContain(badRecycle.id);
    expect(text).toContain(badCustomerOrder.id);
    expect(text).toContain(badLineOrder.id);
    expect(text).toContain('详情');
  });
});
