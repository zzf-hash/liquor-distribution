import { BadRequestException, ConflictException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { arOpenCents } from '../src/modules/receivables/aging';
import { RebatesService } from '../src/modules/rebates/rebates.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { ReturnsService } from '../src/modules/returns/returns.service';
import { CapFeesService } from '../src/modules/cap-fees/cap-fees.service';
import { ExpensesService } from '../src/modules/expenses/expenses.service';
import { PriceChangesService } from '../src/modules/price-changes/price-changes.service';
import { ReportsController } from '../src/modules/reports/reports.controller';
import { OrdersController } from '../src/modules/orders/orders.controller';
import { fallbackCostCents, assembleGrossProfit, cashRebateBusinessMonth, GROSS_PROFIT_CALIBER, marginPercent, offsetBusinessMonth } from '../src/modules/reports/gross-profit';
import { giftStackConflict, GIFT_STACK_CONFLICT } from '../src/modules/orders/gift-policy';
import { returnLinesCents } from '../src/modules/returns/return-amount';
import { centsToDecimal, mulQtyFeeRateToCents, toCents } from '../src/common/money';
import { TENANT_MODELS } from '../src/prisma/prisma.service';
import { AuditAction } from '../src/audit/audit.service';

const audit = { log: jest.fn() };
const idem = { check: jest.fn().mockResolvedValue(null), complete: jest.fn() };
const clerk = { id: 'u1', tenantId: 't1', role: 'CLERK', username: 'clerk', name: '内勤', aud: 'staff' } as never;
const owner = { id: 'u2', tenantId: 't1', role: 'OWNER', username: 'owner', name: '老板', aud: 'staff' } as never;

function sqlText(q: { strings?: string[] } | string): string {
  if (typeof q === 'string') return q;
  return (q.strings ?? []).join('?');
}

function mutex() {
  let tail = Promise.resolve();
  return function lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

describe('LQ1-002 invoice rebate open balance includes FEE_OFFSET', () => {
  it('treats a receivable filled by FEE_OFFSET as having nothing left to offset', () => {
    const { openCents } = arOpenCents(new Prisma.Decimal('30000.00'), [
      { direction: 'FEE_OFFSET', amount: new Prisma.Decimal('30000.00'), paymentId: null },
    ]);
    expect(openCents).toBe(0);
  });

  it('does not write a rebate offset when fee offsets already consumed the receivable', async () => {
    const ledgerCreate = jest.fn();
    const sql: string[] = [];
    const prisma = {
      rebateSettlement: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 's1' }) },
      rebateScheme: { findFirst: jest.fn().mockResolvedValue({ id: 'sch', type: 'C', rate: new Prisma.Decimal('0.03'), tiers: null, validFrom: new Date('2026-01-01'), closedAt: null }) },
      payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal('10000.00') } }) },
      packageRecord: { aggregate: jest.fn().mockResolvedValue({ _sum: { depositPaid: new Prisma.Decimal(0) } }) },
      customer: { findUnique: jest.fn().mockResolvedValue({ name: '店' }) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        rebateSettlement: { create: async (args: { data: { rebateAmount: Prisma.Decimal } }) => ({ id: 's1', rebateAmount: args.data.rebateAmount }) },
        $queryRaw: async (q: { strings?: string[] }) => { sql.push(sqlText(q)); return []; },
        receivable: { findMany: async () => [{ id: 'ar1', total: new Prisma.Decimal('30000.00'), ledger: [{ direction: 'FEE_OFFSET', amount: new Prisma.Decimal('30000.00'), paymentId: null }] }] },
        receivableLedger: { create: ledgerCreate },
      }),
    };
    const svc = new RebatesService(prisma as never, audit as never);
    const result = await svc.settle(clerk, { customerId: 'c1', period: '2026-10', settleType: 'INVOICE' }) as { unapplied: number };
    expect(result.unapplied).toBe(300);
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(sql.some((s) => s.includes('FOR UPDATE') && s.includes('Receivable'))).toBe(true);
  });

  it('offsets only the open cents that remain after FEE_OFFSET', async () => {
    const ledgerCreate = jest.fn().mockResolvedValue({});
    const prisma = {
      rebateSettlement: { findUnique: jest.fn().mockResolvedValue(null) },
      rebateScheme: { findFirst: jest.fn().mockResolvedValue({ id: 'sch', type: 'C', rate: new Prisma.Decimal('0.03'), tiers: null, validFrom: new Date('2026-01-01'), closedAt: null }) },
      payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal('10000.00') } }) },
      packageRecord: { aggregate: jest.fn().mockResolvedValue({ _sum: { depositPaid: null } }) },
      customer: { findUnique: jest.fn().mockResolvedValue({ name: '店' }) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        rebateSettlement: { create: async () => ({ id: 's1' }) },
        $queryRaw: async () => [],
        receivable: { findMany: async () => [{ id: 'ar1', total: new Prisma.Decimal('30000.00'), ledger: [{ direction: 'FEE_OFFSET', amount: new Prisma.Decimal('29700.00'), paymentId: null }] }] },
        receivableLedger: { create: ledgerCreate },
      }),
    };
    const svc = new RebatesService(prisma as never, audit as never);
    const result = await svc.settle(clerk, { customerId: 'c1', period: '2026-10', settleType: 'INVOICE' }) as { unapplied: number };
    expect(result.unapplied).toBe(0);
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
    expect(toCents(ledgerCreate.mock.calls[0][0].data.amount)).toBe(30000);
  });
});

describe('LQ1-003 confirm credit check is serialized on the customer row', () => {
  function harness(limit = '20000.00', open = '8000.00') {
    const orders = new Map<string, { status: string; total: string; special: boolean }>([
      ['o1', { status: 'PENDING_CONFIRM', total: '6480.00', special: false }],
      ['o2', { status: 'PENDING_CONFIRM', total: '6480.00', special: false }],
    ]);
    const sql: string[] = [];
    const lock = mutex();
    const tx = {
      $queryRaw: async (q: { strings?: string[] }) => { sql.push(sqlText(q)); return []; },
      salesOrder: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const o = orders.get(where.id);
          if (!o) return null;
          return { id: where.id, status: o.status, customerId: 'c1', tenantId: 't1', specialApproved: o.special, totalAmount: new Prisma.Decimal(o.total), lines: [] };
        },
        findMany: async () => [...orders.entries()].filter(([, o]) => ['CONFIRMED', 'OUTBOUND', 'DELIVERING'].includes(o.status)).map(([, o]) => ({ totalAmount: new Prisma.Decimal(o.total), lines: [] })),
        updateMany: async ({ where, data }: { where: { id: string; status: string }; data: { status: string } }) => {
          const o = orders.get(where.id);
          if (!o || o.status !== where.status) return { count: 0 };
          o.status = data.status;
          return { count: 1 };
        },
      },
      customer: { findUnique: async () => ({ id: 'c1', creditLimit: new Prisma.Decimal(limit) }) },
      receivable: { findMany: async () => [{ total: new Prisma.Decimal(open), ledger: [] }] },
    };
    const prisma = {
      salesOrder: { findUnique: tx.salesOrder.findUnique },
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => lock(() => fn(tx)),
    };
    return { prisma, sql, orders };
  }

  it('lets only one of two parallel confirms through when together they would exceed the limit', async () => {
    const { prisma, sql, orders } = harness();
    const svc = new OrdersService(prisma as never, audit as never, idem as never);
    const results = await Promise.allSettled([svc.confirm(clerk, 'o1'), svc.confirm(clerk, 'o2')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HttpException);
    expect(((rejected[0] as PromiseRejectedResult).reason as HttpException).getStatus()).toBe(422);
    expect([...orders.values()].filter((o) => o.status === 'CONFIRMED')).toHaveLength(1);
    expect(sql.some((s) => s.includes('FOR UPDATE') && s.includes('Customer'))).toBe(true);
  });

  it('still takes the customer lock when the order is already special-approved', async () => {
    const { prisma, sql, orders } = harness('100.00', '0');
    orders.get('o1')!.special = true;
    orders.get('o2')!.special = true;
    const svc = new OrdersService(prisma as never, audit as never, idem as never);
    await Promise.all([svc.confirm(clerk, 'o1'), svc.confirm(clerk, 'o2')]);
    expect([...orders.values()].every((o) => o.status === 'CONFIRMED')).toBe(true);
    expect(sql.filter((s) => s.includes('FOR UPDATE'))).toHaveLength(2);
  });
});

describe('LQ1-004 manual gifts and buy-N-get-M are mutually exclusive', () => {
  it('rejects a manual gift that overlaps the promo gift for the same product', () => {
    expect(giftStackConflict(['p1'], [{ productId: 'p1', giftProductId: 'p1' }])).toBe(GIFT_STACK_CONFLICT);
    expect(giftStackConflict(['gift-sku'], [{ productId: 'p1', giftProductId: 'gift-sku' }])).toBe(GIFT_STACK_CONFLICT);
    expect(giftStackConflict(['other'], [{ productId: 'p1', giftProductId: 'p1' }])).toBeNull();
  });

  function orderPrisma(promo: boolean, giftThreshold?: number, priced = true) {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      customer: { findUnique: jest.fn().mockResolvedValue({ id: 'c1', name: '店', status: 'ACTIVE', onboarding: 'ACTIVE', salespersonId: null, settlement: 'MONTHLY', creditLimit: new Prisma.Decimal(10000), minOrderAmount: new Prisma.Decimal(0), signMode: 'PHOTO', address: 'addr', salesperson: null }) },
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'p1', name: '酒', status: 'ON_SALE', specText: '500', packSize: 6 }]) },
      customerPrice: { findFirst: jest.fn().mockResolvedValue(null) },
      price: { findFirst: jest.fn().mockResolvedValue(priced ? { id: 'pr', price: new Prisma.Decimal('175.00'), validFrom: new Date('2026-01-01') } : null) },
      promotion: { findMany: jest.fn().mockResolvedValue(promo ? [{ productId: 'p1', giftProductId: null, buyQty: 2, giftQty: 1, unit: 'BASE' }] : []) },
      receivable: { findMany: jest.fn().mockResolvedValue([]) },
      salesOrder: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), create: jest.fn(async () => ({ id: 'o1', orderNo: 'SO1', status: 'PENDING_CONFIRM' })) },
      inventoryLedger: { groupBy: jest.fn().mockResolvedValue([{ productId: 'p1', direction: 'IN', _sum: { qty: new Prisma.Decimal(1000) } }]) },
      orderLine: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => { created.push(...data); return { count: data.length }; }) },
      idempotencyRecord: { create: jest.fn(async () => ({ id: 'idem1' })) },
      systemConfig: { findFirst: jest.fn().mockResolvedValue(giftThreshold === undefined ? null : { value: giftThreshold }) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    };
    return { prisma, created };
  }

  it('refuses to stack a manual gift on top of a hit buy-N-get-M rule', async () => {
    const { prisma } = orderPrisma(true);
    const svc = new OrdersService(prisma as never, audit as never, idem as never);
    const idemKey = 'idem-lq1-004-stack';
    await expect(svc.create({
      customerId: 'c1', source: 'CLERK',
      lines: [
        { productId: 'p1', qty: 2, unit: 'BASE' },
        { productId: 'p1', qty: 10, unit: 'BASE', isGift: true },
      ],
    }, clerk, idemKey)).rejects.toBeInstanceOf(ConflictException);
    expect(idem.check).toHaveBeenCalledWith(clerk, 'orders.create', idemKey, expect.anything());
    expect(prisma.salesOrder.create).not.toHaveBeenCalled();
  });

  it('bills a manual gift at zero, deducts inventory, and does not occupy credit', async () => {
    (audit.log as jest.Mock).mockClear();
    const manual = orderPrisma(false);
    const svc = new OrdersService(manual.prisma as never, audit as never, idem as never);
    const created = await svc.create({ customerId: 'c1', source: 'CLERK', lines: [{ productId: 'p1', qty: 1, unit: 'BASE', isGift: true }] }, clerk, 'idem-lq1-004-manual');
    expect(created.totalAmount).toBe(0);
    expect(created.precheck.credit.need).toBe(0);
    expect(created.precheck.credit).not.toHaveProperty('manualGiftCredit');
    expect(manual.created[0]).toMatchObject({ isGift: true, priceVersion: 'gift' });
    expect(toCents(manual.created[0].unitPrice as Prisma.Decimal)).toBe(0);
    expect(created.precheck.inventory[0].need).toBe(6);
    expect(manual.prisma.idempotencyRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ key: 'idem-lq1-004-manual', endpoint: 'orders.create' }),
    }));
    expect((audit.log as jest.Mock).mock.calls.some((c) => c[0]?.action === AuditAction.ORDER_GIFT_MANUAL)).toBe(false);

    const promo = orderPrisma(true);
    const promoSvc = new OrdersService(promo.prisma as never, audit as never, idem as never);
    const promoOrder = await promoSvc.create({ customerId: 'c1', source: 'CLERK', lines: [{ productId: 'p1', qty: 2, unit: 'BASE' }] }, clerk, 'idem-lq1-004-promo');
    expect(promoOrder.totalAmount).toBe(350);
    expect(promoOrder.precheck.credit.need).toBe(350);
    const gift = promo.created.find((l) => l.isGift);
    expect(gift).toMatchObject({ priceVersion: 'gift', promoNote: '买2送1' });
    expect(promoOrder.precheck.inventory[0].need).toBe(18);
  });

  it('audits a manual gift whose reference price exceeds the threshold without blocking the order', async () => {
    (audit.log as jest.Mock).mockClear();
    const manual = orderPrisma(false, 100);
    const svc = new OrdersService(manual.prisma as never, audit as never, idem as never);
    const created = await svc.create(
      { customerId: 'c1', source: 'CLERK', lines: [{ productId: 'p1', qty: 1, unit: 'BASE', isGift: true }] },
      clerk,
      'idem-lq1-004-gift-audit',
    );
    expect(created.totalAmount).toBe(0);
    expect(created.precheck.credit.need).toBe(0);
    expect(manual.prisma.salesOrder.create).toHaveBeenCalled();
    const logged = (audit.log as jest.Mock).mock.calls.map((c) => c[0]).find((e) => e?.action === AuditAction.ORDER_GIFT_MANUAL);
    expect(logged).toMatchObject({
      action: AuditAction.ORDER_GIFT_MANUAL,
      entityId: 'o1',
      after: { referenceYuan: 175, thresholdYuan: 100 },
    });
  });

  it('still returns the saved order when the gift audit write throws', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failing = {
      log: jest.fn(async (entry: { action?: string }) => {
        if (entry?.action === AuditAction.ORDER_GIFT_MANUAL) throw new Error('audit down');
      }),
    };
    const manual = orderPrisma(false, 100);
    const svc = new OrdersService(manual.prisma as never, failing as never, idem as never);
    try {
      const created = await svc.create(
        { customerId: 'c1', source: 'CLERK', lines: [{ productId: 'p1', qty: 1, unit: 'BASE', isGift: true }] },
        clerk,
        'idem-lq1-004-gift-audit-down',
      );
      expect(created).toMatchObject({ id: 'o1', totalAmount: 0 });
      expect(created.orderNo).toMatch(/^SO\d{8}-\d{4}$/);
      expect(manual.prisma.salesOrder.create).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ORDER_GIFT_MANUAL failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('audits a manual gift line that has no reference price and marks it 无参考价', async () => {
    (audit.log as jest.Mock).mockClear();
    const manual = orderPrisma(false, undefined, false);
    const svc = new OrdersService(manual.prisma as never, audit as never, idem as never);
    const created = await svc.create(
      { customerId: 'c1', source: 'CLERK', lines: [{ productId: 'p1', qty: 1, unit: 'BASE', isGift: true }] },
      clerk,
      'idem-lq1-004-gift-unpriced',
    );
    expect(created.totalAmount).toBe(0);
    expect(manual.prisma.salesOrder.create).toHaveBeenCalled();
    const logged = (audit.log as jest.Mock).mock.calls.map((c) => c[0]).find((e) => e?.action === AuditAction.ORDER_GIFT_MANUAL);
    expect(logged).toMatchObject({
      action: AuditAction.ORDER_GIFT_MANUAL,
      entityId: 'o1',
      after: {
        referenceYuan: 0,
        lines: [{ productId: 'p1', qty: 1, unit: 'BASE', note: '无参考价' }],
      },
    });
  });

  it('sends Idempotency-Key from the header into order create', async () => {
    const { prisma } = orderPrisma(false);
    const svc = new OrdersService(prisma as never, audit as never, idem as never);
    const ctrl = new OrdersController(svc);
    const idemKey = 'idem-lq1-004-header';
    await ctrl.create(
      { customerId: 'c1', source: 'CLERK', lines: [{ productId: 'p1', qty: 1, unit: 'BASE', isGift: true }] },
      clerk,
      idemKey,
      '127.0.0.1',
    );
    expect(prisma.idempotencyRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ key: idemKey, endpoint: 'orders.create' }),
    }));
  });

  it('does not count an in-transit manual gift toward the next credit check', async () => {
    const prisma = {
      receivable: { findMany: jest.fn().mockResolvedValue([]) },
      salesOrder: { findMany: jest.fn().mockResolvedValue([{
        totalAmount: new Prisma.Decimal(0),
        lines: [{ isGift: true, qty: new Prisma.Decimal(2), priceVersion: 'gift' }],
      }]) },
    };
    const svc = new OrdersService(prisma as never, audit as never, idem as never);
    await expect(svc.creditProjection('c1')).resolves.toMatchObject({ openAr: 0, inTransit: 0 });
  });
});

describe('LQ1-005 return approval amount stays in sync and is what receipt credits', () => {
  it('sums appended lines with the original unit price in cents', () => {
    const cents = returnLinesCents(
      [{ orderLineId: 'a', qty: 1 }, { orderLineId: 'b', qty: 2 }],
      [{ id: 'a', unitPrice: new Prisma.Decimal('3050.00') }, { id: 'b', unitPrice: new Prisma.Decimal('34.00') }],
    );
    expect(cents).toBe(311800);
  });

  it('rewrites the pending approval amount when lines are appended', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const sql: string[] = [];
    const tx = {
      $queryRaw: async (q: { strings?: string[] }) => { sql.push(sqlText(q)); return []; },
      returnOrder: { findUnique: async () => ({ id: 'rt', status: 'PENDING_REVIEW', returnNo: 'RT1', sourceOrderId: 'so', lines: [{ orderLineId: 'a', qty: new Prisma.Decimal(1) }] }) },
      salesOrder: { findUnique: async () => ({
        id: 'so', orderNo: 'SO1', signature: null,
        lines: [
          { id: 'a', productName: '甲', qty: new Prisma.Decimal(2), unitPrice: new Prisma.Decimal('100.00'), reversalOfId: null },
          { id: 'b', productName: '乙', qty: new Prisma.Decimal(1), unitPrice: new Prisma.Decimal('18.00'), reversalOfId: null },
        ],
        returns: [{ status: 'PENDING_REVIEW', lines: [{ orderLineId: 'a', qty: new Prisma.Decimal(1) }] }],
      }) },
      returnLine: { createMany: async () => ({ count: 1 }) },
      approvalRecord: { updateMany },
    };
    const prisma = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) };
    const svc = new ReturnsService(prisma as never, audit as never, {} as never);
    const result = await svc.appendLines(clerk, 'rt', [{ orderLineId: 'b', qty: 1 }]) as { amount: number };
    expect(result.amount).toBe(118);
    expect(toCents(updateMany.mock.calls[0][0].data.amount)).toBe(11800);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ entityType: 'RETURN', status: 'PENDING' });
    expect(sql.some((s) => s.includes('FOR UPDATE') && s.includes('ReturnOrder'))).toBe(true);
  });

  it('credits receivables with the approved amount rather than the extended line sum', async () => {
    const ledger = jest.fn().mockResolvedValue({});
    const prisma = {
      returnOrder: { findUnique: async () => ({
        id: 'rt', status: 'APPROVED', returnNo: 'RT1', tenantId: 't1', reason: '破损',
        lines: [{ orderLineId: 'a', productId: 'p', qty: new Prisma.Decimal(2) }],
        order: {
          orderNo: 'SO1',
          lines: [{ id: 'a', unit: 'BASE', conversionRate: 1, unitPrice: new Prisma.Decimal('100.00') }],
          outbounds: [{ status: 'CONFIRMED', lines: [{ orderLineId: 'a', batchId: 'b1', qty: new Prisma.Decimal(2) }] }],
        },
      }) },
      receivable: { findMany: async () => [{ id: 'ar1' }] },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        returnOrder: { updateMany: async () => ({ count: 1 }) },
        approvalRecord: { findFirst: async () => ({ amount: new Prisma.Decimal('150.00'), status: 'APPROVED' }) },
        inventoryLedger: { create: async () => ({}) },
        receivableLedger: { create: ledger },
      }),
    };
    const svc = new ReturnsService(prisma as never, audit as never, {} as never);
    const result = await svc.receive(clerk, 'rt') as { arCredit: number };
    expect(result.arCredit).toBe(150);
    expect(toCents(ledger.mock.calls[0][0].data.amount)).toBe(15000);
    expect(ledger.mock.calls[0][0].data.direction).toBe('RETURN_CREDIT');
  });
});

describe('LQ1-006 / LQ1-021 gross margin cost units and erosion', () => {
  it('converts BASE and MIN cost without dividing a bottle price twice', () => {
    expect(fallbackCostCents({ qty: 2, unit: 'BASE', conversionRate: 6, ratio: 1, quote: { baseCents: 10000, minCents: null } })).toBe(20000);
    expect(fallbackCostCents({ qty: 2, unit: 'BASE', conversionRate: 6, ratio: 1, quote: { baseCents: null, minCents: 1000 } })).toBe(12000);
    expect(fallbackCostCents({ qty: 6, unit: 'MIN', conversionRate: 6, ratio: 1, quote: { baseCents: null, minCents: 1000 } })).toBe(6000);
    expect(fallbackCostCents({ qty: 6, unit: 'MIN', conversionRate: 6, ratio: 1, quote: { baseCents: 60000, minCents: null } })).toBe(60000);
    expect(fallbackCostCents({ qty: 1, unit: 'BASE', conversionRate: 6, ratio: 1, quote: { baseCents: null, minCents: null } })).toBeNull();
  });

  it('leaves margin empty when cost is unknown instead of reporting 100%', () => {
    expect(marginPercent(35000, 35000, false)).toBeNull();
    expect(marginPercent(10000, 35000, true)).toBe(28.6);
  });

  it('keeps gross profit as revenue minus cost and puts offsets in net contribution', () => {
    const customer = assembleGrossProfit({
      dimension: 'customer',
      rows: [
        { key: 'c1', name: '甲', revenueCents: 35000, costCents: 20000, costKnown: true },
        { key: 'c2', name: '乙', revenueCents: 10000, costCents: 4000, costKnown: true },
      ],
      erosions: [
        { customerId: 'c1', rebateCents: 3000, feeCents: 2000 },
        { customerId: 'c3', rebateCents: 0, feeCents: 500 },
      ],
      customerNames: new Map([['c3', '丙']]),
    });
    const c1 = customer.rows.find((r) => r.key === 'c1')!;
    expect(c1.profitCents).toBe(35000 - 20000);
    expect(c1.netContributionCents).toBe(35000 - 20000 - 3000 - 2000);
    expect(customer.rows.find((r) => r.key === 'c3')!.profitCents).toBe(0);
    expect(customer.rows.find((r) => r.key === 'c3')!.netContributionCents).toBe(-500);
    expect(customer.totals.profitCents).toBe((35000 + 10000) - (20000 + 4000));
    expect(customer.totals.netContributionCents).toBe((35000 + 10000) - (20000 + 4000) - 3000 - 2500);

    const product = assembleGrossProfit({
      dimension: 'product',
      rows: [
        { key: 'a', name: 'A', revenueCents: 100, costCents: 0, costKnown: true },
        { key: 'b', name: 'B', revenueCents: 300, costCents: 0, costKnown: true },
      ],
      erosions: [{ customerId: 'c1', rebateCents: 4, feeCents: 0 }],
    });
    expect(product.rows.map((r) => r.rebateCents).sort()).toEqual([1, 3]);
    expect(product.totals.profitCents).toBe(400);
    expect(product.totals.netContributionCents).toBe(400 - 4);
    expect(GROSS_PROFIT_CALIBER).toContain('毛利 = 签收实收收入 − 销售成本');
    expect(GROSS_PROFIT_CALIBER).toContain('净贡献');
    expect(GROSS_PROFIT_CALIBER).toContain('FEE_OFFSET');
    expect(GROSS_PROFIT_CALIBER).toContain('REBATE_OFFSET');
    expect(GROSS_PROFIT_CALIBER).toContain('不看流水 createdAt');
  });

  it('leaves profit, margin, and net contribution null when cost is unknown, including totals if any row is unknown', () => {
    const unknown = assembleGrossProfit({
      dimension: 'product',
      rows: [{ key: 'p', name: '酒', revenueCents: 17500, costCents: 0, costKnown: false }],
      erosions: [{ customerId: 'c1', rebateCents: 500, feeCents: 200 }],
    });
    expect(unknown.rows[0].costCents).toBe(0);
    expect(unknown.rows[0].profitCents).toBeNull();
    expect(unknown.rows[0].margin).toBeNull();
    expect(unknown.rows[0].netContributionCents).toBeNull();
    expect(unknown.rows[0].rebateCents).toBe(500);
    expect(unknown.totals.profitCents).toBeNull();
    expect(unknown.totals.netContributionCents).toBeNull();
    expect(unknown.totals.costKnown).toBe(false);

    const mixed = assembleGrossProfit({
      dimension: 'category',
      rows: [
        { key: 'known', name: '白酒', revenueCents: 35000, costCents: 20000, costKnown: true },
        { key: 'missing', name: '啤酒', revenueCents: 10000, costCents: 0, costKnown: false },
      ],
      erosions: [],
    });
    const priced = mixed.rows.find((r) => r.key === 'known')!;
    const missing = mixed.rows.find((r) => r.key === 'missing')!;
    expect(priced.profitCents).toBe(15000);
    expect(priced.netContributionCents).toBe(15000);
    expect(priced.margin).toBe(42.9);
    expect(missing.profitCents).toBeNull();
    expect(missing.margin).toBeNull();
    expect(missing.netContributionCents).toBeNull();
    expect(mixed.totals.profitCents).toBeNull();
    expect(mixed.totals.netContributionCents).toBeNull();
    expect(mixed.totals.revenueCents).toBe(45000);
    expect(mixed.totals.costCents).toBe(20000);
  });

  it('attributes offsets by the source document month, not the ledger createdAt', () => {
    expect(offsetBusinessMonth({
      sourceType: 'INITIAL',
      generatedAt: new Date('2026-06-15T12:00:00Z'),
    })).toBe('2026-06');
    expect(offsetBusinessMonth({
      sourceType: 'ORDER',
      signedAt: new Date('2026-10-02T12:00:00Z'),
      generatedAt: new Date('2026-11-01T12:00:00Z'),
    })).toBe('2026-10');
    expect(cashRebateBusinessMonth('REBATE_SETTLE:2026-09:c1', new Date('2026-10-05T12:00:00Z'))).toBe('2026-09');
    expect(cashRebateBusinessMonth(null, new Date('2026-10-05T12:00:00Z'))).toBe('2026-10');
  });

  it('uses a BASE cost price for a case line and keeps offsets out of gross profit', async () => {
    const ledgerWhere: unknown[] = [];
    const receivableWhere: unknown[] = [];
    const octoberReceivable = {
      id: 'ar-oct', customerId: 'c1', sourceType: 'ORDER', sourceDocNo: 'SO-OCT', generatedAt: new Date('2026-10-03T12:00:00Z'),
    };
    const juneInitial = {
      id: 'ar-june', customerId: 'c2', sourceType: 'INITIAL', sourceDocNo: '初0003', generatedAt: new Date('2026-06-15T12:00:00Z'),
    };
    const prisma = {
      salesOrder: { findMany: jest.fn().mockResolvedValue([{
        orderNo: 'SO-OCT', signedAt: new Date('2026-10-02T12:00:00Z'),
        customerId: 'c1', customerName: '店', salespersonId: null,
        lines: [{ id: 'l1', productId: 'p1', productName: '酒', reversalOfId: null, qty: new Prisma.Decimal(2), unit: 'BASE', conversionRate: 6, amount: new Prisma.Decimal('350.00'), product: { category: 'BAIJIU', skuCode: 'S' } }],
        signature: null,
        outbounds: [],
      }]) },
      price: { findMany: jest.fn().mockResolvedValue([{ productId: 'p1', unit: 'BASE', price: new Prisma.Decimal('100.00'), validFrom: new Date('2026-01-01') }]) },
      receivable: { findMany: jest.fn(async ({ where }: { where: { sourceType?: string; NOT?: { sourceType?: string } } }) => {
        receivableWhere.push(where);
        if (where.sourceType === 'ORDER') return [octoberReceivable];
        return [juneInitial];
      }) },
      receivableLedger: { findMany: jest.fn(async ({ where }: { where: { receivableId?: { in: string[] }; createdAt?: unknown } }) => {
        ledgerWhere.push(where);
        expect(where.createdAt).toBeUndefined();
        const ids = where.receivableId?.in ?? [];
        const rows = [];
        if (ids.includes('ar-oct')) rows.push({ direction: 'FEE_OFFSET', amount: new Prisma.Decimal('30.00'), receivableId: 'ar-oct' });
        if (ids.includes('ar-june')) rows.push({ direction: 'FEE_OFFSET', amount: new Prisma.Decimal('500.00'), receivableId: 'ar-june' });
        return rows;
      }) },
      expense: { findMany: jest.fn().mockResolvedValue([
        { amount: new Prisma.Decimal('20.00'), customerId: 'c1', source: 'REBATE_SETTLE:2026-10:c1', occurredAt: new Date('2026-11-02T12:00:00Z') },
        { amount: new Prisma.Decimal('99.00'), customerId: 'c1', source: 'REBATE_SETTLE:2026-06:c1', occurredAt: new Date('2026-10-20T12:00:00Z') },
      ]) },
      $transaction: async (arg: Promise<unknown>[]) => Promise.all(arg),
    };
    const ctrl = new ReportsController(prisma as never);
    const report = await ctrl.grossProfit({ tenantId: 't1' } as never, '2026-10', 'product') as {
      rows: Array<{ cost: number; profit: number; netContribution: number; margin: number | null }>;
      totals: { revenue: number; cost: number; rebateErosion: number; feeErosion: number; profit: number; netContribution: number; margin: number | null };
      caliber: string;
    };
    expect(report.totals.revenue).toBe(350);
    expect(report.totals.cost).toBe(200);
    expect(report.totals.rebateErosion).toBe(20);
    expect(report.totals.feeErosion).toBe(30);
    expect(report.totals.profit).toBe(150);
    expect(report.totals.netContribution).toBe(100);
    expect(report.totals.margin).toBe(42.9);
    expect(report.rows[0].margin).not.toBe(100);
    expect(report.rows[0].profit).toBe(150);
    expect(report.rows[0].netContribution).toBe(100);
    expect(report.caliber).toBe(GROSS_PROFIT_CALIBER);
    expect(receivableWhere.some((w) => JSON.stringify(w).includes('generatedAt'))).toBe(true);
    expect(JSON.stringify(ledgerWhere)).not.toContain('createdAt');
  });

  it('does not report a 100% margin when no cost price exists', async () => {
    const prisma = {
      salesOrder: { findMany: jest.fn().mockResolvedValue([{
        customerId: 'c1', customerName: '店', salespersonId: null,
        lines: [{ id: 'l1', productId: 'p1', productName: '酒', reversalOfId: null, qty: new Prisma.Decimal(1), unit: 'BASE', conversionRate: 6, amount: new Prisma.Decimal('175.00'), product: { category: 'BAIJIU' } }],
        signature: null, outbounds: [],
      }]) },
      price: { findMany: jest.fn().mockResolvedValue([]) },
      receivable: { findMany: jest.fn().mockResolvedValue([]) },
      receivableLedger: { findMany: jest.fn().mockResolvedValue([]) },
      expense: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: async (arg: Promise<unknown>[]) => Promise.all(arg),
    };
    const ctrl = new ReportsController(prisma as never);
    const report = await ctrl.grossProfit({ tenantId: 't1' } as never, '2026-10', 'category') as {
      rows: Array<{ profit: number | null; margin: number | null; netContribution: number | null; cost: number }>;
      totals: { cost: number; margin: number | null; profit: number | null; netContribution: number | null };
    };
    expect(report.totals.cost).toBe(0);
    expect(report.totals.profit).toBeNull();
    expect(report.totals.margin).toBeNull();
    expect(report.totals.netContribution).toBeNull();
    expect(report.rows[0].cost).toBe(0);
    expect(report.rows[0].profit).toBeNull();
    expect(report.rows[0].margin).toBeNull();
    expect(report.rows[0].netContribution).toBeNull();
  });
});

describe('LQ1-008 bottle-cap confirmation claims status before the fee document', () => {
  it('creates one expense when two confirms race, and only after the status claim', async () => {
    let status = 'PENDING_CONFIRM';
    const events: string[] = [];
    const tx = {
      capRecycleOrder: {
        updateMany: async ({ where }: { where: { status?: string; tenantId?: string }; data?: { expenseId?: string } }) => {
          if (where.status) {
            events.push('claim');
            expect(where.tenantId).toBe('t1');
            if (status !== 'PENDING_CONFIRM') return { count: 0 };
            status = 'CONFIRMED';
            return { count: 1 };
          }
          events.push('link');
          return { count: 1 };
        },
        findFirst: async ({ where }: { where: { tenantId?: string } }) => {
          if (where.tenantId && where.tenantId !== 't1') return null;
          return {
            id: 'r1', status, recycleNo: 'GAI1', customerId: 'c1', totalAmount: new Prisma.Decimal('100.00'),
            note: null, lines: [{ productName: '啤酒', qty: 10 }], customer: { name: '店' },
          };
        },
        update: async () => { events.push('link'); return {}; },
      },
    };
    const expenses = {
      create: jest.fn(async () => { throw new Error('fee document must be created inside the claim transaction'); }),
      createLinkedInTx: jest.fn(async () => {
        await new Promise((r) => setTimeout(r, 20));
        events.push('expense');
        return { id: 'e1', expenseNo: 'FY1', approvalId: 'a1' };
      }),
      announceLinked: jest.fn(async () => { events.push('announce'); }),
    };
    const prisma = {
      capRecycleOrder: { updateMany: async () => { throw new Error('status claim must run inside the transaction'); } },
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const svc = new CapFeesService(prisma as never, audit as never, expenses as never);
    const results = await Promise.allSettled([
      svc.confirmRecycle(clerk, 'r1', { payMode: 'AR_OFFSET' }),
      svc.confirmRecycle(clerk, 'r1', { payMode: 'AR_OFFSET' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(expenses.createLinkedInTx).toHaveBeenCalledTimes(1);
    expect(events.indexOf('claim')).toBeLessThan(events.indexOf('expense'));
    expect(events.filter((e) => e === 'expense')).toHaveLength(1);
    expect(status).toBe('CONFIRMED');
  });

  it('does not confirm or read another tenant recycle, and accrual ignores that tenant policy', async () => {
    const updateMany = jest.fn(async () => ({ count: 0 }));
    const findFirst = jest.fn(async () => null);
    const policyFind = jest.fn(async ({ where }: { where: { tenantId?: string } }) => {
      expect(where.tenantId).toBe('t2');
      return [];
    });
    const prisma = {
      capRecycleOrder: { updateMany, findFirst },
      capFeePolicy: { findMany: policyFind },
      salesOrder: { findMany: jest.fn(async () => { throw new Error('orders must not be read when this tenant has no policy'); }) },
      $transaction: async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    };
    const expenses = { createLinkedInTx: jest.fn(), announceLinked: jest.fn() };
    const svc = new CapFeesService(prisma as never, audit as never, expenses as never);
    const other = { ...clerk, tenantId: 't2' };
    await expect(svc.confirmRecycle(other, 'recycle-a', { payMode: 'AR_OFFSET' })).rejects.toBeInstanceOf(NotFoundException);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'recycle-a', tenantId: 't2', status: 'PENDING_CONFIRM' },
    }));
    expect(expenses.createLinkedInTx).not.toHaveBeenCalled();
    await expect(svc.cancelRecycle(other, 'recycle-a', 'no')).rejects.toBeInstanceOf(NotFoundException);
    const accrued = await svc.accrue(other, '2026-09');
    expect(accrued).toMatchObject({ expenses: 0, customers: 0 });
    expect(policyFind).toHaveBeenCalled();
  });
});

describe('LQ1-020 monthly corkage accrual is idempotent under concurrency', () => {
  it('locks the period and treats a duplicate source as already accrued', async () => {
    const sources = new Set<string>();
    const sql: string[] = [];
    const tx = {
      $executeRaw: async (q: { strings?: string[] }) => { sql.push(sqlText(q)); return 0; },
      expense: {
        findFirst: async ({ where }: { where: { source: string } }) => (sources.has(where.source) ? { id: 'dup' } : null),
        count: async () => sources.size,
        create: async ({ data }: { data: { source: string } }) => {
          await new Promise((r) => setTimeout(r, 20));
          if (sources.has(data.source)) {
            const err = new Error('Unique constraint failed on the fields: (`tenantId`,`source`)') as Error & { code?: string; meta?: { target?: string[] } };
            err.code = 'P2002';
            err.meta = { target: ['tenantId', 'source'] };
            throw err;
          }
          sources.add(data.source);
          return { id: `e-${sources.size}`, expenseNo: 'FY1' };
        },
      },
    };
    const prisma = {
      capFeePolicy: { findMany: async () => [{ productId: 'p', perBottleFee: new Prisma.Decimal('1'), noCapRate: new Prisma.Decimal('1'), requireCap: false, product: { name: '啤酒' } }] },
      salesOrder: { findMany: async () => [{ customerId: 'c1', lines: [{ productId: 'p', unit: 'MIN', qty: new Prisma.Decimal(10), conversionRate: 1 }] }] },
      expense: {
        findFirst: async () => { throw new Error('duplicate check must use the transaction'); },
        create: async () => { throw new Error('insert must use the transaction'); },
      },
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const expenses = new ExpensesService(prisma as never, audit as never, {} as never);
    const svc = new CapFeesService(prisma as never, audit as never, expenses);
    const [a, b] = await Promise.all([
      svc.accrue(owner, '2026-09'),
      svc.accrue(owner, '2026-09'),
    ]);
    expect(sources.size).toBe(1);
    expect(a.expenses + b.expenses).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
    expect(a.totalAmount + b.totalAmount).toBe(10);
    expect(sql.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
  });
});

describe('S1 tenant models and S5 cap accrual rounding', () => {
  it('scopes expense, cap recycle, cap policy, and promotion queries to the tenant', () => {
    for (const model of ['Expense', 'CapRecycleOrder', 'CapFeePolicy', 'Promotion']) {
      expect(TENANT_MODELS.has(model)).toBe(true);
    }
  });

  it('rounds qty × fee × rate in cents, not via a binary float toFixed', () => {
    expect(mulQtyFeeRateToCents(1, '1.005', 1)).toBe(101);
    expect(Math.round(Number((1.005).toFixed(2)) * 100)).toBe(100);
    expect(mulQtyFeeRateToCents(10, 1, 1)).toBe(1000);
  });
});

describe('savePolicy maps cap_fee_policy_same_tenant to 409', () => {
  function policyPrisma(upsert: jest.Mock) {
    return {
      product: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', tenantId: 't1' }) },
      capFeePolicy: { findFirst: jest.fn().mockResolvedValue(null), upsert },
    };
  }

  it('returns HTTP 409 for either trigger message and leaves other errors alone', async () => {
    for (const message of [
      'CapFeePolicy tenantId t2 does not match product tenant t1',
      'CapFeePolicy product p1 does not exist',
    ]) {
      const upsert = jest.fn().mockRejectedValue(new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: 'test' }));
      const svc = new CapFeesService(policyPrisma(upsert) as never, audit as never, {} as never);
      const err = await svc.savePolicy(owner, { productId: 'p1', perBottleFee: 1 }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getStatus()).toBe(409);
    }
    const upsert = jest.fn().mockRejectedValue(new Error('connection reset'));
    const svc = new CapFeesService(policyPrisma(upsert) as never, audit as never, {} as never);
    await expect(svc.savePolicy(owner, { productId: 'p1', perBottleFee: 1 })).rejects.toThrow('connection reset');
  });
});

describe('LQ1-011 price adjustment rejects a zero new price', () => {
  const svc = new PriceChangesService({} as never, audit as never, {} as never);
  const base = { productId: 'p', unit: 'BASE' as const, levelType: 'TERMINAL', effectiveDate: '2026-10-25', reason: '调价' };

  it('rejects 0, negative, and sub-cent prices before writing a draft', async () => {
    await expect(svc.create(owner, { ...base, newPrice: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(owner, { ...base, newPrice: -1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(owner, { ...base, newPrice: 0.001 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores a one-cent price as a decimal, not a float artifact', () => {
    expect(centsToDecimal(1).toFixed(2)).toBe('0.01');
  });
});

describe('price change effectuate normalizes the unit and keeps cent prices', () => {
  it('maps 箱 to BASE and rounds the shifted customer price in cents', async () => {
    const priceWrites: Array<{ unit: string }> = [];
    const customerWrites: Array<{ unit: string; price: Prisma.Decimal }> = [];
    const exclusive = new Prisma.Decimal('1.005');
    const oldPrice = new Prisma.Decimal('0.10');
    const newPrice = new Prisma.Decimal('0.20');
    const prisma = {
      priceChangeRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pc-1',
          status: 'APPROVED',
          productId: 'p1',
          unit: '箱',
          levelType: 'TERMINAL',
          oldPrice,
          newPrice,
          customerSync: true,
          effectiveDate: new Date('2026-10-25T00:00:00.000Z'),
          reason: '调价',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      price: {
        create: jest.fn(async ({ data }: { data: { unit: string } }) => {
          priceWrites.push(data);
          return { id: 'price-1' };
        }),
      },
      customerPrice: {
        findMany: jest.fn().mockResolvedValue([
          { customerId: 'c1', price: exclusive, productId: 'p1' },
        ]),
        create: jest.fn(async ({ data }: { data: { unit: string; price: Prisma.Decimal } }) => {
          customerWrites.push(data);
          return data;
        }),
      },
    };
    const svc = new PriceChangesService(prisma as never, audit as never, {} as never);
    await svc.effectuate(owner, 'pc-1');

    expect(prisma.customerPrice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ unit: 'BASE' }),
    }));
    expect(priceWrites[0]?.unit).toBe('BASE');
    expect(customerWrites).toHaveLength(1);
    expect(customerWrites[0]?.unit).toBe('BASE');
    // 1.005 + 0.10 is 1.105. Half-up cents is 1.11. Number#toFixed lands on 1.10.
    expect(customerWrites[0]?.price.toFixed(2)).toBe('1.11');
    expect((Number(exclusive) + (Number(newPrice) - Number(oldPrice))).toFixed(2)).toBe('1.10');
  });
});
