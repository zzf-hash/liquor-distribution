import { execFileSync } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { TENANT_MODELS } from '../src/prisma/tenant-models';

const ownerUrl = process.env.MIGRATE_DATABASE_URL ?? '';
const appPassword = process.env.E2E_APP_PASSWORD ?? '';
const logs: string[] = [];
const hits: Array<{ method: string; path: string; status: number; snippet: string }> = [];

function capture(level: string, args: unknown[]): void {
  const text = args.map((part) => {
    if (typeof part === 'string') return part;
    if (part instanceof Error) return part.stack ?? part.message;
    try { return JSON.stringify(part); } catch { return String(part); }
  }).join(' ');
  logs.push(`${level} ${text}`);
}

const logger = {
  log: (...args: unknown[]) => capture('LOG', args),
  error: (...args: unknown[]) => capture('ERROR', args),
  warn: (...args: unknown[]) => capture('WARN', args),
  debug: (...args: unknown[]) => capture('DEBUG', args),
  verbose: (...args: unknown[]) => capture('VERBOSE', args),
};

describe('liquor_app HTTP e2e', () => {
  const nonce = Date.now().toString(36);
  const username = `owner-${nonce}`;
  const password = `pw-${nonce}-e2e`;
  const tenantCode = `E2E-${nonce}`;
  let owner: PrismaClient;
  let app: NestExpressApplication;
  let base = '';
  let token = '';
  let tenantId = '';
  let productId = '';
  let customerId = '';

  beforeAll(async () => {
    if (!/^[0-9a-f]+$/.test(appPassword)) throw new Error('E2E_APP_PASSWORD 缺失');
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'execute', '--schema', 'prisma/schema.prisma', '--file', 'prisma/grant-liquor-app.sql'], {
      env: { ...process.env, DATABASE_URL: ownerUrl },
      stdio: 'pipe',
    });
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    await owner.$executeRawUnsafe(`ALTER ROLE liquor_app WITH LOGIN PASSWORD '${appPassword}'`);

    const tenant = await owner.tenant.create({ data: { code: tenantCode, name: 'e2e' } });
    tenantId = tenant.id;
    const user = await owner.user.create({
      data: {
        tenantId,
        username,
        name: 'e2e老板',
        role: 'OWNER',
        dataScope: 'ALL',
        status: 'ACTIVE',
        passwordHash: bcrypt.hashSync(password, 4),
      },
    });
    const product = await owner.product.create({
      data: { tenantId, skuCode: `SKU-${nonce}`, name: 'e2e酒', category: 'BAIJIU', baseUnit: '箱', packSize: 6, status: 'ON_SALE' },
    });
    productId = product.id;
    await owner.price.create({
      data: {
        tenantId,
        productId,
        unit: 'BASE',
        levelType: 'TERMINAL',
        price: new Prisma.Decimal('12.00'),
        validFrom: new Date('2020-01-01T00:00:00.000Z'),
        createdBy: user.id,
      },
    });
    const customer = await owner.customer.create({
      data: {
        tenantId,
        code: `C-${nonce}`,
        name: 'e2e店',
        type: 'YANJIUDIAN',
        phone: '13800000000',
        address: 'e2e 路 1 号',
        onboarding: 'ACTIVE',
        status: 'ACTIVE',
        settlement: 'MONTHLY',
        creditLimit: new Prisma.Decimal('100000.00'),
        minOrderAmount: new Prisma.Decimal('0'),
      },
    });
    customerId = customer.id;
    const batch = await owner.batchStock.create({
      data: { tenantId, productId, batchNo: `B-${nonce}`, unitCost: new Prisma.Decimal('1.0000'), isInitial: true },
    });
    await owner.inventoryLedger.create({
      data: {
        tenantId,
        productId,
        batchId: batch.id,
        direction: 'IN',
        qty: new Prisma.Decimal('100'),
        refType: 'INITIAL_IMPORT',
        createdBy: user.id,
      },
    });

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger, bodyParser: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (owner && tenantId) {
      await owner.$executeRawUnsafe(`SET session_replication_role = replica`).catch(() => undefined);
      for (const model of TENANT_MODELS) {
        await owner.$executeRawUnsafe(`DELETE FROM "${model}" WHERE "tenantId" = '${tenantId}'`).catch(() => undefined);
      }
      await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = '${tenantId}'`).catch(() => undefined);
      await owner.$executeRawUnsafe(`SET session_replication_role = origin`).catch(() => undefined);
      await owner.$disconnect().catch(() => undefined);
    }
  });

  async function call(method: string, path: string, opts?: { body?: unknown; token?: string | null; headers?: Record<string, string> }): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
    const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
    if (opts?.token) headers.authorization = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts?.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${base}${path}`, { method, headers, body });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* 导出二进制 */ }
    hits.push({ method, path, status: res.status, snippet: text.slice(0, 240) });
    return { status: res.status, text, json };
  }

  function assertHealthy(label: string, status: number, text: string): void {
    const bad = status === 404 || status >= 500 || text.includes('42501');
    if (bad) {
      const tail = logs.slice(-30).join('\n');
      throw new Error(`${label} -> ${status} ${text.slice(0, 400)}\n${tail}`);
    }
  }

  it('启动自检确认 liquor_app, 登录后覆盖读接口、定时任务和下单', async () => {
    const boot = logs.join('\n');
    expect(boot).toContain('不是超级用户');
    expect(boot).not.toContain('不符合 RLS 基线');

    const health = await call('GET', '/api/health', { token: null });
    expect(health.status).toBe(200);

    const login = await call('POST', '/api/auth/login', { body: { username, password, tenantCode } });
    expect(login.status).toBe(200);
    expect(login.json?.code).toBe(0);
    const data = login.json?.data as { token?: string } | undefined;
    token = data?.token ?? '';
    expect(token.length).toBeGreaterThan(20);

    const month = new Date().toISOString().slice(0, 7);
    const gets = [
      '/api/health/notify-status',
      '/api/auth/me',
      '/api/users',
      '/api/products',
      `/api/products/${productId}`,
      `/api/products/${productId}/prices`,
      '/api/customers',
      `/api/customers/${customerId}`,
      `/api/customers/${customerId}/prices`,
      `/api/prices/resolve?customerId=${customerId}&productId=${productId}&unit=BASE`,
      '/api/orders',
      '/api/orders/outbounds',
      '/api/receivables',
      '/api/receivables/summary',
      '/api/receivables/aging-config',
      '/api/receivables/reminders',
      '/api/payments',
      '/api/approvals',
      '/api/expenses',
      '/api/expenses/summary',
      '/api/promotions',
      '/api/cap-fees/policies',
      '/api/cap-fees/recycles',
      '/api/purchases',
      '/api/returns',
      '/api/packages',
      '/api/packages/summary',
      '/api/stocktakes',
      '/api/rebates/schemes',
      '/api/rebates/settlements',
      '/api/statements',
      '/api/visits',
      '/api/visits/stats',
      '/api/drafts',
      '/api/drafts/engine-status',
      '/api/aliases',
      '/api/imports',
      '/api/special-orders',
      '/api/price-changes',
      '/api/price-changes/batch',
      '/api/stock-alert/config',
      '/api/stock-alert/expiry',
      '/api/stock-alert/expiry/config',
      '/api/stock-alert/report',
      '/api/stock-alert/restocks',
      '/api/dashboard/four-questions',
      `/api/reports/monthly?month=${month}`,
      '/api/reports/inventory',
      `/api/reports/gross-profit?month=${month}`,
      `/api/performance?month=${month}`,
      '/api/audit',
      '/api/telemetry/summary',
      '/api/orders/export',
      '/api/receivables/export',
      '/api/payments/export',
      '/api/statements/export',
    ];
    for (const path of gets) {
      const res = await call('GET', path, { token });
      assertHealthy(`GET ${path}`, res.status, res.text);
    }

    const shop = await call('GET', '/api/shop/products', { token });
    expect(shop.status).toBe(403);

    const reserved = await call('POST', '/api/users', {
      token,
      body: { username: 'SyStEm', password: 'not-the-real-one', name: '保留', role: 'CLERK' },
    });
    expect(reserved.status).toBe(400);
    expect(reserved.text).toContain('系统保留');

    const order = await call('POST', '/api/orders', {
      token,
      headers: { 'idempotency-key': `e2e-${nonce}` },
      body: {
        customerId,
        source: 'CLERK',
        lines: [{ productId, qty: 1, unit: 'BASE', priceOverride: 10 }],
      },
    });
    assertHealthy('POST /api/orders', order.status, order.text);
    expect(order.status).toBeLessThan(300);
    expect(order.json?.code).toBe(0);

    const posts: Array<{ path: string; body?: unknown }> = [
      { path: '/api/daily-tasks/reminders/run' },
      { path: '/api/daily-tasks/archive/run' },
      { path: '/api/daily-tasks/statements/run?period=2020-01' },
      { path: '/api/daily-tasks/cap-accrue/run?period=2020-01' },
      { path: '/api/stock-alert/run' },
      { path: '/api/payroll/generate', body: { month } },
      { path: '/api/telemetry/events', body: { events: [{ source: 'admin', kind: 'custom', name: 'e2e' }] } },
    ];
    for (const item of posts) {
      const res = await call('POST', item.path, { token: item.path.startsWith('/api/telemetry') ? null : token, body: item.body ?? {} });
      assertHealthy(`POST ${item.path}`, res.status, res.text);
      expect(res.status).toBeLessThan(300);
    }

    const payroll = await call('GET', `/api/payroll?month=${month}`, { token });
    assertHealthy('GET /api/payroll', payroll.status, payroll.text);
    expect(payroll.status).toBeLessThan(300);

    const forwarded = await call('POST', '/api/auth/login', {
      body: { username, password: 'wrong-password', tenantCode },
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(forwarded.status).toBe(401);
    const fail = await owner.auditLog.findFirst({
      where: { tenantId, action: 'LOGIN_FAIL', username },
      orderBy: { createdAt: 'desc' },
    });
    expect(fail?.ip).toBe('203.0.113.9');

    const joined = logs.join('\n');
    const forbidden = (joined.match(/42501/g) ?? []).length;
    const outsideTx = (joined.match(/事务外查询/g) ?? []).length;
    const notFound = hits.filter((hit) => hit.status === 404);
    // 只打方法、路径、状态, 不含口令或令牌。
    console.log(`E2E_HITS ${JSON.stringify(hits.map((hit) => [hit.method, hit.path, hit.status]))}`);
    expect({ forbidden, outsideTx, notFound }).toEqual({ forbidden: 0, outsideTx: 0, notFound: [] });
  });
});
