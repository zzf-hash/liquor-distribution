jest.mock('@prisma/client', () => {
  const stub = {
    $extends: jest.fn().mockReturnValue({
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    }),
  };
  return { PrismaClient: jest.fn().mockImplementation(() => stub), Prisma: {} };
});

import { PromotionsController } from '../src/modules/promotions/promotions.controller';

function row(id: string, closed: boolean, note: string) {
  const now = new Date('2026-10-26T00:00:00.000Z');
  return {
    id,
    kind: 'BUY_N_GET_M',
    productId: 'p1',
    giftProductId: null,
    buyQty: 2,
    giftQty: 1,
    unit: 'BASE',
    validFrom: new Date(now.getTime() - 86_400_000),
    validTo: null,
    closedAt: closed ? now : null,
    note,
    product: { skuCode: 'SKU', name: '示例酒', baseUnit: '箱', minUnit: '瓶' },
    giftProduct: null,
  };
}

function prismaFor(rows: ReturnType<typeof row>[]) {
  return {
    promotion: {
      findMany: jest.fn(async ({ where }: { where: { closedAt?: null; tenantId?: string } }) => {
        return rows.filter((item) => where.closedAt === null ? item.closedAt === null : true);
      }),
    },
  };
}

describe('customer promotion list', () => {
  const open = row('open', false, '内部备注');
  const closed = row('closed', true, '关闭原因');

  it('returns only active rules and omits note for a customer', async () => {
    const prisma = prismaFor([open, closed]);
    const ctrl = new PromotionsController(prisma as never, { log: jest.fn() } as never);
    const list = await ctrl.list({ tenantId: 't1', role: 'CUSTOMER', aud: 'customer' } as never) as Array<Record<string, unknown>>;
    expect(list.map((item) => item.id)).toEqual(['open']);
    expect(list[0].active).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(list[0], 'note')).toBe(false);
    expect(JSON.stringify(list)).not.toContain('内部备注');
    expect(prisma.promotion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 't1', closedAt: null }),
    }));
  });

  it('keeps closed rules and note for staff', async () => {
    const prisma = prismaFor([open, closed]);
    const ctrl = new PromotionsController(prisma as never, { log: jest.fn() } as never);
    const list = await ctrl.list({ tenantId: 't1', role: 'OWNER', aud: 'staff' } as never) as Array<Record<string, unknown>>;
    expect(list.map((item) => item.id)).toEqual(['open', 'closed']);
    expect(list.find((item) => item.id === 'closed')?.note).toBe('关闭原因');
  });
});
