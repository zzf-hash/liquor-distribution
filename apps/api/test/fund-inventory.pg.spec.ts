/**
 * LQ1-050 / LQ1-003 / LQ1-008 / LQ1-020 / S1 against a real PostgreSQL.
 *
 * Set FUND_PG_URL to a Postgres URL whose database name ends with `_test`.
 * The user and password come only from that variable. Example:
 *   postgresql://USER:PASSWORD@127.0.0.1:5432/liquor_fund_test
 * The suite applies migrations (including Expense_cap_source_uidx) and then
 * wipes that database. It does not run when FUND_PG_URL is unset or the
 * database name does not end with `_test`.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { HttpException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { OrdersService } from '../src/modules/orders/orders.service';
import { CapFeesService } from '../src/modules/cap-fees/cap-fees.service';
import { ExpensesService } from '../src/modules/expenses/expenses.service';

/** Null when the suite may migrate and wipe. Otherwise a reason it must not run. */
export function pgSuiteRefusal(raw: string | undefined): string | null {
  if (!raw) return 'FUND_PG_URL is not set';
  let name = '';
  try {
    name = decodeURIComponent(new URL(raw).pathname.replace(/^\//, ''));
  } catch {
    return 'FUND_PG_URL is not a valid URL';
  }
  if (!name.endsWith('_test')) return `database "${name}" does not end with _test`;
  return null;
}

const pgUrl = process.env.FUND_PG_URL;
const refusal = pgSuiteRefusal(pgUrl);

describe('FUND_PG_URL gate', () => {
  it('refuses to run unless the database name ends with _test', () => {
    expect(pgSuiteRefusal(undefined)).toMatch(/not set/);
    expect(pgSuiteRefusal('postgresql://127.0.0.1:5432/liquor')).toMatch(/_test/);
    expect(pgSuiteRefusal('postgresql://127.0.0.1:5432/liquor_fund_test')).toBeNull();
    expect(pgSuiteRefusal('not a url')).toMatch(/not a valid URL/);
  });
});

const audit = { log: async () => ({}) };
const approvals = { announcePending: async () => undefined };
const idem = { check: async () => null, complete: async () => undefined };

const pgIt = refusal ? it.skip : it;

describe('fund/inventory rules on PostgreSQL', () => {
  let prisma: PrismaClient;
  let tenantId = '';
  let userId = '';
  let customerId = '';
  let productId = '';

  beforeAll(async () => {
    if (refusal || !pgUrl) return;
    if (pgSuiteRefusal(pgUrl)) throw new Error(pgSuiteRefusal(pgUrl) ?? 'refused');
    execSync('pnpm exec prisma migrate deploy', {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: pgUrl },
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ datasources: { db: { url: pgUrl } } });
    await prisma.$connect();
    await wipe(prisma);
    const tenant = await prisma.tenant.create({ data: { name: 'PG测试', code: `pg-${Date.now()}` } });
    tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { tenantId, username: 'clerk', name: '内勤', role: 'CLERK', dataScope: 'ALL' },
    });
    userId = user.id;
    const customer = await prisma.customer.create({
      data: {
        tenantId, code: 'C-PG', name: '测试店', type: 'CHAOSHI', phone: '13800000000', address: '测试路',
        settlement: 'MONTHLY', creditLimit: new Prisma.Decimal('20000.00'), onboarding: 'ACTIVE', status: 'ACTIVE',
      },
    });
    customerId = customer.id;
    const product = await prisma.product.create({
      data: { tenantId, skuCode: 'PG-BEER', name: '啤酒', category: 'PIJIU', baseUnit: '箱', packSize: 12 },
    });
    productId = product.id;
  }, 120000);

  afterAll(async () => {
    if (!prisma || pgSuiteRefusal(pgUrl)) return;
    await wipe(prisma);
    await prisma.$disconnect();
  });

  function actor(role: 'CLERK' | 'OWNER' = 'CLERK') {
    return { id: userId, tenantId, role, username: 'clerk', name: '内勤', aud: 'staff' } as never;
  }

  pgIt('has the partial unique index and can take pg_advisory_xact_lock without deserializing void', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'Expense_cap_source_uidx'`;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('CAP_ACCRUAL');
    expect(indexes[0].indexdef).toContain('CAP_RECYCLE');
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'cap-accrual:probe'}))`);
    })).resolves.toBeUndefined();
  });

  pgIt('LQ1-003 lets only one of two parallel confirms through the credit limit', async () => {
    await prisma.receivable.create({
      data: {
        tenantId, customerId, sourceType: 'INITIAL', sourceDocNo: 'PG-AR-1',
        total: new Prisma.Decimal('8000.00'), dueDate: new Date('2026-11-30T00:00:00Z'),
        generatedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    const mk = async (orderNo: string) => prisma.salesOrder.create({
      data: {
        tenantId, orderNo, customerId, customerName: '测试店', source: 'CLERK', signMode: 'PAPER',
        status: 'PENDING_CONFIRM', totalAmount: new Prisma.Decimal('6480.00'), addressSnapshot: '测试路',
        createdById: userId,
      },
    });
    const o1 = await mk('PG-SO-1');
    const o2 = await mk('PG-SO-2');
    const svc = new OrdersService(prisma as never, audit as never, idem as never);
    const results = await Promise.allSettled([svc.confirm(actor(), o1.id), svc.confirm(actor(), o2.id)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HttpException);
    expect(((rejected[0] as PromiseRejectedResult).reason as HttpException).getStatus()).toBe(422);
    const confirmed = await prisma.salesOrder.count({ where: { id: { in: [o1.id, o2.id] }, status: 'CONFIRMED' } });
    expect(confirmed).toBe(1);
  });

  pgIt('LQ1-008 confirms one recycle document when two cashiers race', async () => {
    const recycle = await prisma.capRecycleOrder.create({
      data: {
        tenantId, recycleNo: 'PG-GAI-1', customerId, status: 'PENDING_CONFIRM',
        lines: [{ productId, productName: '啤酒', qty: 10, perBottleFee: 1, amount: 10 }],
        totalAmount: new Prisma.Decimal('10.00'), createdById: userId,
      },
    });
    const expenses = new ExpensesService(prisma as never, audit as never, approvals as never);
    const svc = new CapFeesService(prisma as never, audit as never, expenses);
    const results = await Promise.allSettled([
      svc.confirmRecycle(actor(), recycle.id, { payMode: 'AR_OFFSET' }),
      svc.confirmRecycle(actor(), recycle.id, { payMode: 'AR_OFFSET' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const saved = await prisma.capRecycleOrder.findUnique({ where: { id: recycle.id } });
    expect(saved?.status).toBe('CONFIRMED');
    const fees = await prisma.expense.findMany({ where: { tenantId, source: 'CAP_RECYCLE:PG-GAI-1' } });
    expect(fees).toHaveLength(1);
  });

  pgIt('LQ1-020 / LQ1-050 accrues one corkage fee when many calls race, and a repeat is a skip', async () => {
    await prisma.capFeePolicy.create({
      data: {
        tenantId, productId, perBottleFee: new Prisma.Decimal('1'), requireCap: false,
        noCapRate: new Prisma.Decimal('1'), createdById: userId,
      },
    });
    await prisma.salesOrder.create({
      data: {
        tenantId, orderNo: 'PG-SO-SIGNED', customerId, customerName: '测试店', source: 'CLERK', signMode: 'PAPER',
        status: 'SIGNED', totalAmount: new Prisma.Decimal('100.00'), addressSnapshot: '测试路',
        createdById: userId, signedAt: new Date('2026-09-15T12:00:00Z'),
        lines: {
          create: [{
            tenantId, productId, productName: '啤酒', unit: 'MIN', conversionRate: 12,
            qty: new Prisma.Decimal(10), unitPrice: new Prisma.Decimal('10.00'), amount: new Prisma.Decimal('100.00'),
            priceType: 'TERMINAL', priceVersion: 'pg', createdById: userId,
          }],
        },
      },
    });
    const expenses = new ExpensesService(prisma as never, audit as never, approvals as never);
    const svc = new CapFeesService(prisma as never, audit as never, expenses);
    const owner = actor('OWNER');
    const raced = await Promise.all(Array.from({ length: 8 }, () => svc.accrue(owner, '2026-09')));
    const created = raced.reduce((s, r) => s + r.expenses, 0);
    const skipped = raced.reduce((s, r) => s + r.skipped, 0);
    expect(created).toBe(1);
    expect(skipped).toBe(7);
    expect(raced.reduce((s, r) => s + r.totalAmount, 0)).toBe(10);
    const again = await svc.accrue(owner, '2026-09');
    expect(again.expenses).toBe(0);
    expect(again.skipped).toBe(1);
    const rows = await prisma.expense.findMany({ where: { tenantId, source: `CAP_ACCRUAL:2026-09:${customerId}` } });
    expect(rows).toHaveLength(1);
    await expect(prisma.expense.create({
      data: {
        tenantId, expenseNo: 'PG-DUP-CAP', category: 'CAP_FEE', title: 'dup', amount: new Prisma.Decimal('1.00'),
        customerId, payMode: 'AR_OFFSET', status: 'APPROVED', source: `CAP_ACCRUAL:2026-09:${customerId}`, createdById: userId,
      },
    })).rejects.toMatchObject({ code: 'P2002' });
  });

  pgIt('S1 tenant B cannot confirm, cancel, or accrue from tenant A', async () => {
    const tenantB = await prisma.tenant.create({ data: { name: '租户B', code: `pg-b-${Date.now()}` } });
    const userB = await prisma.user.create({
      data: { tenantId: tenantB.id, username: 'clerk-b', name: '他店内勤', role: 'CLERK', dataScope: 'ALL' },
    });
    const product = await prisma.product.create({
      data: { tenantId, skuCode: 'PG-BEER-X', name: '啤酒乙', category: 'PIJIU', baseUnit: '箱', packSize: 12 },
    });
    await prisma.capFeePolicy.create({
      data: {
        tenantId, productId: product.id, perBottleFee: new Prisma.Decimal('2'), requireCap: false,
        noCapRate: new Prisma.Decimal('1'), createdById: userId,
      },
    });
    await prisma.salesOrder.create({
      data: {
        tenantId, orderNo: 'PG-SO-A-SEP', customerId, customerName: '测试店', source: 'CLERK', signMode: 'PAPER',
        status: 'SIGNED', totalAmount: new Prisma.Decimal('20.00'), addressSnapshot: '测试路',
        createdById: userId, signedAt: new Date('2026-09-10T12:00:00Z'),
        lines: {
          create: [{
            tenantId, productId: product.id, productName: '啤酒乙', unit: 'MIN', conversionRate: 12,
            qty: new Prisma.Decimal(4), unitPrice: new Prisma.Decimal('5.00'), amount: new Prisma.Decimal('20.00'),
            priceType: 'TERMINAL', priceVersion: 'pg', createdById: userId,
          }],
        },
      },
    });
    const recycle = await prisma.capRecycleOrder.create({
      data: {
        tenantId, recycleNo: 'PG-GAI-A', customerId, status: 'PENDING_CONFIRM',
        lines: [{ productId: product.id, productName: '啤酒乙', qty: 2, perBottleFee: 2, amount: 4 }],
        totalAmount: new Prisma.Decimal('4.00'), createdById: userId,
      },
    });
    const expenses = new ExpensesService(prisma as never, audit as never, approvals as never);
    const svc = new CapFeesService(prisma as never, audit as never, expenses);
    const intruder = { id: userB.id, tenantId: tenantB.id, role: 'CLERK', username: 'clerk-b', name: '他店内勤', aud: 'staff' } as never;
    await expect(svc.confirmRecycle(intruder, recycle.id, { payMode: 'AR_OFFSET' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.cancelRecycle(intruder, recycle.id, '跨租户')).rejects.toBeInstanceOf(NotFoundException);
    const still = await prisma.capRecycleOrder.findUnique({ where: { id: recycle.id } });
    expect(still?.status).toBe('PENDING_CONFIRM');
    expect(await prisma.expense.count({ where: { source: 'CAP_RECYCLE:PG-GAI-A' } })).toBe(0);
    const accrued = await svc.accrue(intruder, '2026-09');
    expect(accrued.expenses).toBe(0);
    expect(accrued.customers).toBe(0);
    expect(await prisma.expense.count({ where: { tenantId: tenantB.id, category: 'CAP_FEE' } })).toBe(0);
    const policies = await svc.listPolicies(intruder) as unknown[];
    expect(policies).toHaveLength(0);
    expect(await prisma.capFeePolicy.count({ where: { tenantId, productId: product.id } })).toBe(1);
  });
});

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.receivableLedger.deleteMany();
  await prisma.receivable.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.approvalRecord.deleteMany();
  await prisma.capRecycleOrder.deleteMany();
  await prisma.capFeePolicy.deleteMany();
  await prisma.orderLine.deleteMany();
  await prisma.salesOrder.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
}
