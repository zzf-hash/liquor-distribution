/**
 * LQ1-059: 同一商品 + 单位 + 价级 + 生效日第二次生效不能撞 Price 唯一键 500。
 * 事务内按唯一键 upsert, 审计记下被覆盖的旧价和新价。客户专属价同一生效日同样处理。
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PriceChangesService } from '../src/modules/price-changes/price-changes.service';

const owner = { id: 'u1', tenantId: 't1', role: 'OWNER', username: 'owner', name: '老板', aud: 'staff' } as const;
const effective = new Date('2026-10-25T00:00:00.000Z');

type PriceRow = {
  id: string;
  tenantId: string;
  productId: string;
  unit: string;
  levelType: string;
  validFrom: Date;
  price: Prisma.Decimal;
  approvalRef: string;
  note: string;
  createdBy: string;
};

type CustomerPriceRow = PriceRow & { customerId: string };

type RequestRow = {
  id: string;
  tenantId: string;
  productId: string;
  unit: string;
  levelType: string;
  oldPrice: Prisma.Decimal;
  newPrice: Prisma.Decimal;
  effectiveDate: Date;
  reason: string;
  customerSync: boolean;
  status: string;
};

function sameTime(a: Date, b: Date): boolean {
  return new Date(a).getTime() === new Date(b).getTime();
}

function priceKeyOf(row: { tenantId: string; productId: string; unit: string; levelType: string; validFrom: Date }): string {
  return [row.tenantId, row.productId, row.unit, row.levelType, new Date(row.validFrom).toISOString()].join('|');
}

function customerKeyOf(row: { tenantId: string; customerId: string; productId: string; unit: string; validFrom: Date }): string {
  return [row.tenantId, row.customerId, row.productId, row.unit, new Date(row.validFrom).toISOString()].join('|');
}

describe('LQ1-059 second effectuate upserts the same-day price', () => {
  function harness(seed?: { prices?: PriceRow[]; customerPrices?: CustomerPriceRow[] }) {
    const prices: PriceRow[] = [...(seed?.prices ?? [])];
    const customerPrices: CustomerPriceRow[] = [...(seed?.customerPrices ?? [])];
    const requests = new Map<string, RequestRow>();
    let priceSeq = prices.length;
    let customerSeq = customerPrices.length;
    const audits: Array<{ action: string; entityId?: string; before?: unknown; after?: unknown }> = [];

    function findPrice(key: { tenantId: string; productId: string; unit: string; levelType: string; validFrom: Date }): PriceRow | undefined {
      const id = priceKeyOf(key);
      return prices.find((row) => priceKeyOf(row) === id);
    }

    function findCustomer(key: { tenantId: string; customerId: string; productId: string; unit: string; validFrom: Date }): CustomerPriceRow | undefined {
      const id = customerKeyOf(key);
      return customerPrices.find((row) => customerKeyOf(row) === id);
    }

    const tx = {
      price: {
        findUnique: jest.fn(async ({ where }: { where: { tenantId_productId_unit_levelType_validFrom: PriceRow } }) => {
          return findPrice(where.tenantId_productId_unit_levelType_validFrom) ?? null;
        }),
        create: jest.fn(async () => {
          throw Object.assign(new Error('Unique constraint failed on Price'), { code: 'P2002' });
        }),
        upsert: jest.fn(async ({ where, create, update }: {
          where: { tenantId_productId_unit_levelType_validFrom: PriceRow };
          create: Omit<PriceRow, 'id'>;
          update: Partial<PriceRow>;
        }) => {
          const key = where.tenantId_productId_unit_levelType_validFrom;
          const existing = findPrice(key);
          if (existing) {
            Object.assign(existing, update);
            return { ...existing };
          }
          priceSeq += 1;
          const created: PriceRow = { id: `price-${priceSeq}`, ...create, ...key };
          prices.push(created);
          return { ...created };
        }),
      },
      customerPrice: {
        findMany: jest.fn(async ({ where }: { where: { tenantId: string; productId: string; unit: string } }) => {
          return customerPrices
            .filter((row) => row.tenantId === where.tenantId && row.productId === where.productId && row.unit === where.unit)
            .sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
        }),
        findUnique: jest.fn(async ({ where }: { where: { tenantId_customerId_productId_unit_validFrom: CustomerPriceRow } }) => {
          return findCustomer(where.tenantId_customerId_productId_unit_validFrom) ?? null;
        }),
        create: jest.fn(async () => {
          throw Object.assign(new Error('Unique constraint failed on CustomerPrice'), { code: 'P2002' });
        }),
        upsert: jest.fn(async ({ where, create, update }: {
          where: { tenantId_customerId_productId_unit_validFrom: CustomerPriceRow };
          create: Omit<CustomerPriceRow, 'id'>;
          update: Partial<CustomerPriceRow>;
        }) => {
          const key = where.tenantId_customerId_productId_unit_validFrom;
          const existing = findCustomer(key);
          if (existing) {
            Object.assign(existing, update);
            return { ...existing };
          }
          customerSeq += 1;
          const created: CustomerPriceRow = { id: `cp-${customerSeq}`, ...create, ...key };
          customerPrices.push(created);
          return { ...created };
        }),
      },
      priceChangeRequest: {
        update: jest.fn(async ({ where, data }: { where: { id: string; tenantId: string }; data: { status: string } }) => {
          const row = requests.get(where.id);
          if (!row || row.tenantId !== where.tenantId) throw Object.assign(new Error('not found'), { code: 'P2025' });
          Object.assign(row, data);
          return row;
        }),
      },
    };

    const prisma = {
      ...tx,
      priceChangeRequest: {
        ...tx.priceChangeRequest,
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => requests.get(where.id) ?? null),
      },
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    };

    const audit = {
      log: jest.fn(async (entry: { action: string; entityId?: string; before?: unknown; after?: unknown }) => {
        audits.push(entry);
      }),
    };

    function addRequest(row: RequestRow): void {
      requests.set(row.id, row);
    }

    return { prisma, audit, prices, customerPrices, audits, addRequest, svc: new PriceChangesService(prisma as never, audit as never, {} as never) };
  }

  it('updates the existing row, keeps one row, and audits the row old price and the new price', async () => {
    const h = harness({
      prices: [{
        id: 'price-other',
        tenantId: 't2',
        productId: 'p1',
        unit: 'BASE',
        levelType: 'TERMINAL',
        validFrom: effective,
        price: new Prisma.Decimal('1.00'),
        approvalRef: 'other',
        note: 'other',
        createdBy: 'u2',
      }],
      customerPrices: [
        {
          id: 'cp-t1',
          tenantId: 't1',
          customerId: 'c1',
          productId: 'p1',
          unit: 'BASE',
          levelType: 'TERMINAL',
          validFrom: new Date('2026-01-01T00:00:00.000Z'),
          price: new Prisma.Decimal('10.00'),
          approvalRef: 'seed',
          note: 'seed',
          createdBy: 'u1',
        },
        {
          id: 'cp-t2',
          tenantId: 't2',
          customerId: 'c1',
          productId: 'p1',
          unit: 'BASE',
          levelType: 'TERMINAL',
          validFrom: new Date('2026-06-01T00:00:00.000Z'),
          price: new Prisma.Decimal('50.00'),
          approvalRef: 'other',
          note: 'other',
          createdBy: 'u2',
        },
      ],
    });
    h.addRequest({
      id: 'pc-1',
      tenantId: 't1',
      productId: 'p1',
      unit: 'BASE',
      levelType: 'TERMINAL',
      oldPrice: new Prisma.Decimal('10.10'),
      newPrice: new Prisma.Decimal('11.20'),
      effectiveDate: effective,
      reason: '第一次',
      customerSync: true,
      status: 'APPROVED',
    });
    h.addRequest({
      id: 'pc-2',
      tenantId: 't1',
      productId: 'p1',
      unit: 'BASE',
      levelType: 'TERMINAL',
      oldPrice: new Prisma.Decimal('10.10'),
      newPrice: new Prisma.Decimal('11.25'),
      effectiveDate: effective,
      reason: '同一天再生效',
      customerSync: true,
      status: 'APPROVED',
    });

    const first = await h.svc.effectuate(owner, 'pc-1') as { status: string; priceRowId: string };
    const second = await h.svc.effectuate(owner, 'pc-2') as { status: string; priceRowId: string };

    expect(first.status).toBe('EFFECTIVE');
    expect(second.status).toBe('EFFECTIVE');
    expect(second.priceRowId).toBe(first.priceRowId);
    expect(h.prisma.price.create).not.toHaveBeenCalled();
    expect(h.prisma.customerPrice.create).not.toHaveBeenCalled();

    const ours = h.prices.filter((row) => row.tenantId === 't1' && priceKeyOf(row) === priceKeyOf({
      tenantId: 't1', productId: 'p1', unit: 'BASE', levelType: 'TERMINAL', validFrom: effective,
    }));
    expect(ours).toHaveLength(1);
    expect(ours[0].id).toBe(first.priceRowId);
    expect(ours[0].price.toFixed(2)).toBe('11.25');
    expect(h.prices.find((row) => row.tenantId === 't2')?.price.toFixed(2)).toBe('1.00');

    const shifted = h.customerPrices.filter((row) => row.tenantId === 't1' && sameTime(row.validFrom, effective));
    expect(shifted).toHaveLength(1);
    // 10.00 + (11.20-10.10) = 11.10, then + (11.25-10.10) = 12.25.
    expect(shifted[0].price.toFixed(2)).toBe('12.25');
    expect(h.customerPrices.find((row) => row.id === 'cp-t2')?.price.toFixed(2)).toBe('50.00');

    const effect = h.audits.filter((entry) => entry.action === 'PRICE_CHANGE_EFFECT' && entry.entityId === 'pc-2');
    expect(effect).toHaveLength(1);
    expect(effect[0].before).toEqual({ oldPrice: '11.20' });
    expect(effect[0].after).toEqual(expect.objectContaining({ oldPrice: '11.20', newPrice: '11.25', priceRowId: first.priceRowId }));
    const sync = h.audits.filter((entry) => entry.action === 'PRICE_CUSTOMER_SYNC' && entry.entityId === 'pc-2');
    expect(sync).toHaveLength(1);
    expect(sync[0].before).toEqual({ prices: [{ customerId: 'c1', oldPrice: '11.10' }] });
    expect(sync[0].after).toEqual(expect.objectContaining({ prices: [{ customerId: 'c1', newPrice: '12.25' }] }));

    await expect(h.svc.effectuate(owner, 'pc-2')).rejects.toBeInstanceOf(ConflictException);
    expect(ours[0].price.toFixed(2)).toBe('11.25');
  });
});
