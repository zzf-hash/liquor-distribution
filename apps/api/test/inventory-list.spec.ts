import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, RolesGuard } from '../src/common/roles.guard';
import {
  ReportsController,
  ledgerOnHand,
  locationsFromBatches,
  lowStockThreshold,
  occupiedByProduct,
} from '../src/modules/reports/reports.controller';

jest.mock('@prisma/client', () => {
  const stub = {
    $extends: jest.fn().mockReturnValue({
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    }),
  };
  return { PrismaClient: jest.fn().mockImplementation(() => stub), Prisma: {} };
});

const handler = ReportsController.prototype.inventoryProducts;

function guardFor(role: string, aud: 'staff' | 'customer') {
  const guard = new RolesGuard(new Reflector());
  return guard.canActivate({
    switchToHttp: () => ({
      getRequest: () => ({ user: { role, aud }, path: '/api/reports/inventory/products' }),
    }),
    getHandler: () => handler,
    getClass: () => ReportsController,
  } as never);
}

describe('inventory product list permissions', () => {
  it('declares OWNER, CLERK and WAREHOUSE, and leaves the customer out', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
    expect(roles).toEqual(['OWNER', 'CLERK', 'WAREHOUSE']);
    expect(roles).not.toContain('CUSTOMER');
  });

  it('lets the owner, clerk and warehouse through, and rejects the customer and the rep', () => {
    expect(guardFor('OWNER', 'staff')).toBe(true);
    expect(guardFor('CLERK', 'staff')).toBe(true);
    expect(guardFor('WAREHOUSE', 'staff')).toBe(true);
    expect(() => guardFor('CUSTOMER', 'customer')).toThrow(ForbiddenException);
    expect(() => guardFor('REP', 'staff')).toThrow(ForbiddenException);
  });
});

describe('inventory product list caliber', () => {
  it('sums batch ledger the same way as the inventory report, grouped by location', () => {
    expect(ledgerOnHand([
      { direction: 'IN', qty: 10 },
      { direction: 'OUT', qty: 4 },
    ])).toBe(6);
    const locations = locationsFromBatches([
      { location: 'A-02', ledger: [{ direction: 'IN', qty: 3 }] },
      { location: 'A-01', ledger: [{ direction: 'IN', qty: 10 }, { direction: 'OUT', qty: 4 }] },
      { location: 'A-01', ledger: [{ direction: 'IN', qty: 1 }] },
      { location: null, ledger: [{ direction: 'IN', qty: 2 }] },
    ]);
    expect(locations).toEqual([
      { location: 'A-01', onHand: 7 },
      { location: 'A-02', onHand: 3 },
      { location: null, onHand: 2 },
    ]);
    expect(locations.reduce((sum, row) => sum + row.onHand, 0)).toBe(12);
  });

  it('uses the dashboard threshold and the same occupied quantity', () => {
    expect(lowStockThreshold(undefined)).toBe(12);
    expect(lowStockThreshold({ v: 5 })).toBe(5);
    expect(lowStockThreshold('nope')).toBe(12);
    const occupied = occupiedByProduct([
      { productId: 'p1', qty: 1, unit: 'BASE', conversionRate: 6 },
      { productId: 'p1', qty: 2, unit: 'MIN', conversionRate: 6 },
    ]);
    expect(occupied.get('p1')).toBe(8);
  });

  it('scopes every read to the caller tenant and pages the search', async () => {
    const calls: Array<{ model: string; where: unknown; skip?: number; take?: number }> = [];
    const prisma = {
      product: {
        count: jest.fn(async ({ where }: { where: unknown }) => {
          calls.push({ model: 'product.count', where });
          return 2;
        }),
        findMany: jest.fn(async ({ where, skip, take }: { where: unknown; skip: number; take: number }) => {
          calls.push({ model: 'product.findMany', where, skip, take });
          expect(where).toMatchObject({ tenantId: 'tenant-a' });
          return [{
            id: 'p1', skuCode: 'SKU0001', name: '示例酱香', specText: '500ml×6',
            baseUnit: '箱', minUnit: '瓶', packSize: 6,
          }];
        }),
      },
      systemConfig: {
        findFirst: jest.fn(async ({ where }: { where: unknown }) => {
          calls.push({ model: 'systemConfig', where });
          return { value: { v: 12 } };
        }),
      },
      batchStock: {
        findMany: jest.fn(async ({ where }: { where: unknown }) => {
          calls.push({ model: 'batchStock', where });
          return [
            { productId: 'p1', location: 'A-01', ledger: [{ direction: 'IN', qty: 10 }, { direction: 'OUT', qty: 4 }] },
            { productId: 'p1', location: 'A-02', ledger: [{ direction: 'IN', qty: 3 }] },
          ];
        }),
      },
      orderLine: {
        findMany: jest.fn(async ({ where }: { where: unknown }) => {
          calls.push({ model: 'orderLine', where });
          return [{ productId: 'p1', qty: 1, unit: 'BASE', conversionRate: 6 }];
        }),
      },
    };
    const ctrl = new ReportsController(prisma as never);
    const page = await ctrl.inventoryProducts(
      { tenantId: 'tenant-a', role: 'OWNER' } as never,
      '酱香',
      '2',
      '1',
    );
    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(1);
    expect(page.total).toBe(2);
    expect(page.items).toEqual([expect.objectContaining({
      productId: 'p1',
      name: '示例酱香',
      specText: '500ml×6',
      onHand: 9,
      locations: [
        { location: 'A-01', onHand: 6 },
        { location: 'A-02', onHand: 3 },
      ],
      occupied: 6,
      available: 3,
      threshold: 12,
      alert: true,
    })]);
    expect(JSON.stringify(page)).not.toContain('unitCost');
    expect(calls.find((c) => c.model === 'product.findMany')).toMatchObject({
      skip: 1,
      take: 1,
      where: {
        tenantId: 'tenant-a',
        OR: [
          { name: { contains: '酱香', mode: 'insensitive' } },
          { skuCode: { contains: '酱香', mode: 'insensitive' } },
          { specText: { contains: '酱香', mode: 'insensitive' } },
        ],
      },
    });
    for (const call of calls) {
      expect(JSON.stringify(call.where)).toContain('tenant-a');
      expect(JSON.stringify(call.where)).not.toContain('tenant-b');
    }
  });
});
