import { HttpException } from '@nestjs/common';
import { PRICE_UNIT_INPUTS } from '@liquor/shared';
import { ApprovalsService } from '../src/modules/approvals/approvals.service';
import { DraftsService } from '../src/modules/drafts/drafts.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { SpecialOrdersService } from '../src/modules/special-orders/special-orders.service';
import type { AuthUser } from '../src/common/current-user.decorator';

const owner: AuthUser = {
  id: 'owner', tenantId: 't1', username: 'owner', name: '老板', role: 'OWNER', dataScope: 'ALL', aud: 'staff',
};
const rep: AuthUser = {
  id: 'rep1', tenantId: 't1', username: 'rep1', name: '业务', role: 'REP', dataScope: 'ALL', aud: 'staff',
};

/** 与 seed-p1 样例宴席特单同一形状：商品行单位可换，自由品名行保持「箱」且不进正式订单。 */
function seedInput(unit: string) {
  return {
    title: '样例宴席特单(种子)',
    customerId: 'c1',
    customerName: '张三烟酒店',
    isBanquet: true,
    eventDate: '2026-10-20',
    venue: '喜来登宴会厅',
    contactName: '张三',
    contactPhone: '13800000001',
    address: '示例街道1号',
    lines: [
      { productId: 'p-maotai', productName: '飞天茅台53度500ml', unit, qty: 2, price: 2900 },
      { productName: '宴席赠饮可乐(自由品名)', unit: '箱', qty: 1, price: 0 },
    ],
  };
}

function harness() {
  const state: { so: Record<string, unknown> | null; approval: Record<string, unknown> | null } = { so: null, approval: null };
  const orders = { create: jest.fn(async () => ({ id: 'ord1', orderNo: 'SO-1' })) };
  const audit = { log: jest.fn() };
  const notify = { sendApprovalCard: jest.fn(async () => true), send: jest.fn() };
  const priceFind = jest.fn(async () => null);
  const prisma = {
    specialOrder: {
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: { data: { specialNo: string; title: string; customerId?: string; customerName: string; isBanquet: boolean; address: string; deliveryDate?: Date; status: string; createdById: string; lines: { create: Array<Record<string, unknown>> } } }) => {
        state.so = {
          id: 'so-seed',
          specialNo: data.specialNo,
          title: data.title,
          customerId: data.customerId,
          customerName: data.customerName,
          isBanquet: data.isBanquet,
          address: data.address,
          deliveryDate: data.deliveryDate ?? null,
          status: data.status,
          createdById: data.createdById,
          convertedOrderId: null,
          lines: data.lines.create.map((l, i) => ({
            id: `line-${i}`,
            productId: l.productId,
            productName: l.productName,
            unit: l.unit,
            qty: l.qty,
            price: l.price,
          })),
        };
        return state.so;
      }),
      findUnique: jest.fn(async () => state.so),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.so!, data);
        return state.so;
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.so!, data);
        return { count: 1 };
      }),
    },
    approvalRecord: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.approval = { id: 'ap-seed', ...data, status: 'PENDING' };
        return state.approval;
      }),
      findUnique: jest.fn(async () => state.approval),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => (state.approval?.status === 'APPROVED' ? state.approval : null)),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (state.approval?.status !== 'PENDING') return { count: 0 };
        Object.assign(state.approval, data);
        return { count: 1 };
      }),
    },
    systemConfig: { findFirst: jest.fn(async () => ({ value: { v: 2000 } })) },
    price: { findFirst: priceFind },
    customerPrice: { findFirst: jest.fn(async () => null) },
    orderDraft: {
      findUnique: jest.fn(),
      update: jest.fn(async () => ({})),
    },
    product: { findUnique: jest.fn(async () => ({ name: '飞天茅台53度500ml' })), findMany: jest.fn() },
    salesOrder: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (
        where.id === 'ord1' || where.id === state.so?.convertedOrderId
          ? { id: where.id, orderNo: 'SO-1' }
          : null
      )),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const approvals = new ApprovalsService(prisma as never, audit as never, notify as never);
  const specials = new SpecialOrdersService(prisma as never, audit as never, approvals, orders as never);
  const drafts = new DraftsService(prisma as never, audit as never, orders as never, {} as never, {} as never);
  return { state, orders, prisma, approvals, specials, drafts, priceFind };
}

async function expectUnit422(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    throw new Error('应该返回 422');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    expect(http.getStatus()).toBe(422);
    const message = http.message;
    expect(message).toContain('打');
    expect(message).not.toContain('服务内部错误');
    for (const allowed of PRICE_UNIT_INPUTS) expect(message).toContain(allowed);
  }
}

describe('special order unit mapping', () => {
  it.each([
    ['箱', 'BASE'],
    ['件', 'BASE'],
    ['BASE', 'BASE'],
    ['MIN', 'MIN'],
    ['瓶', 'MIN'],
  ] as const)('approves and converts a seed-shaped special order whose unit is %s', async (raw, expected) => {
    const { state, orders, prisma, specials, approvals, priceFind } = harness();
    await specials.create(rep, seedInput(raw));
    expect(state.so?.status).toBe('DRAFT');
    expect((state.so?.lines as Array<{ unit: string }>)[0].unit).toBe(raw);

    await specials.submit(rep, 'so-seed', '婚宴用酒议价(低于二批价)');
    expect(state.so?.status).toBe('PENDING_PRICE');
    expect(state.approval?.status).toBe('PENDING');

    const decided = await approvals.decide(owner, 'ap-seed', { action: 'approve', opinion: 'qa2' });
    expect(decided).toMatchObject({ approved: true, entityType: 'SPECIAL_ORDER' });
    expect(state.so?.status).toBe('APPROVED');
    for (const call of priceFind.mock.calls) expect(call[0].where.unit).toBe(expected);

    const converted = await specials.convert(owner, 'so-seed') as { orderId: string };
    expect(converted.orderId).toBe('ord1');
    expect(state.so?.status).toBe('CONVERTED');
    const lines = orders.create.mock.calls[0][0].lines as Array<{ productId: string; unit: string; qty: number; priceOverride: number }>;
    expect(lines).toEqual([
      expect.objectContaining({ productId: 'p-maotai', unit: expected, qty: 2, priceOverride: 2900 }),
    ]);
    expect(orders.create.mock.calls[0][2]).toBe('special-convert:so-seed');
    expect(orders.create.mock.calls[0][4]).toBe(prisma);
  });

  it('rejects an unmapped unit with 422 on create, decide, and convert', async () => {
    const created = harness();
    await expectUnit422(() => created.specials.create(rep, seedInput('打')));
    expect(created.prisma.specialOrder.create).not.toHaveBeenCalled();

    const pending = harness();
    pending.state.so = {
      id: 'so-seed', status: 'PENDING_PRICE', customerId: 'c1', address: '示例街道1号', isBanquet: true,
      specialNo: 'SP-SEED-1', deliveryDate: null,
      lines: [
        { productId: 'p-maotai', productName: '飞天茅台53度500ml', unit: '打', qty: 2, price: 2900 },
        { productName: '宴席赠饮可乐(自由品名)', unit: '箱', qty: 1, price: 0 },
      ],
    };
    pending.state.approval = {
      id: 'ap-seed', status: 'PENDING', line: 'PRICE_SPECIAL', entityType: 'SPECIAL_ORDER', entityId: 'so-seed',
      applicantId: 'rep1', amount: 5800, tenantId: 't1',
    };
    await expectUnit422(() => pending.approvals.decide(owner, 'ap-seed', { action: 'approve', opinion: 'qa2' }));
    expect(pending.priceFind).not.toHaveBeenCalled();
    expect(pending.state.approval?.status).toBe('PENDING');

    const approved = harness();
    approved.state.so = {
      id: 'so-seed', status: 'APPROVED', customerId: 'c1', address: '示例街道1号', isBanquet: true,
      specialNo: 'SP-SEED-1', deliveryDate: null, convertedOrderId: null,
      lines: [{ productId: 'p-maotai', productName: '飞天茅台53度500ml', unit: '打', qty: 2, price: 2900 }],
    };
    await expectUnit422(() => approved.specials.convert(owner, 'so-seed'));
    expect(approved.orders.create).not.toHaveBeenCalled();
    expect(approved.state.so?.status).toBe('APPROVED');
  });

  it('replays the linked order when convert is repeated, and only one order when two converts race', async () => {
    const h = harness();
    h.state.so = {
      id: 'so-seed', status: 'APPROVED', customerId: 'c1', address: '示例街道1号', isBanquet: true,
      specialNo: 'SP-SEED-1', deliveryDate: null, convertedOrderId: null,
      lines: [{ productId: 'p-maotai', productName: '飞天茅台53度500ml', unit: '箱', qty: 2, price: 2900 }],
    };
    h.prisma.specialOrder.updateMany = jest.fn(async ({ where, data }: { where: { status: string }; data: Record<string, unknown> }) => {
      const so = h.state.so!;
      if (so.status !== where.status || so.convertedOrderId) return { count: 0 };
      Object.assign(so, data);
      return { count: 1 };
    });
    let chain = Promise.resolve();
    h.prisma.$transaction = jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const run = chain.then(() => fn(h.prisma));
      chain = run.then(() => undefined, () => undefined);
      return run;
    });

    const [first, second] = await Promise.all([
      h.specials.convert(owner, 'so-seed'),
      h.specials.convert(owner, 'so-seed'),
    ]) as Array<{ orderId: string; orderNo: string; replay?: boolean }>;

    expect(h.orders.create).toHaveBeenCalledTimes(1);
    expect(h.orders.create.mock.calls[0][2]).toBe('special-convert:so-seed');
    expect(first.orderId).toBe(second.orderId);
    expect(first.orderNo).toBe('SO-1');
    expect([first.replay, second.replay].filter(Boolean)).toEqual([true]);
    expect(h.state.so?.status).toBe('CONVERTED');
    expect(h.state.so?.convertedOrderId).toBe('ord1');

    h.orders.create.mockClear();
    const again = await h.specials.convert(owner, 'so-seed') as { orderId: string; replay?: boolean };
    expect(again).toMatchObject({ orderId: 'ord1', orderNo: 'SO-1', replay: true });
    expect(h.orders.create).not.toHaveBeenCalled();
  });

  it('maps a voice-draft 箱 into BASE and rejects 打 before creating an order', async () => {
    const { prisma, drafts, orders } = harness();
    prisma.orderDraft.findUnique.mockResolvedValue({
      id: 'd1', status: 'PENDING_REVIEW', customerId: 'c1', createdById: 'rep1', draftNo: 'DF1', source: 'VOICE',
      items: [{ productId: 'p-maotai', productName: '飞天茅台53度500ml', qty: 2, unit: '箱', unitPrice: 2900 }],
    });
    await drafts.confirm(rep, 'd1', {});
    expect(orders.create.mock.calls[0][0].lines[0].unit).toBe('BASE');

    orders.create.mockClear();
    prisma.orderDraft.findUnique.mockResolvedValue({
      id: 'd2', status: 'PENDING_REVIEW', customerId: 'c1', createdById: 'rep1', draftNo: 'DF2', source: 'TEXT',
      items: [{ productId: 'p-maotai', productName: '飞天茅台53度500ml', qty: 1, unit: '打' }],
    });
    await expectUnit422(() => drafts.confirm(rep, 'd2', {}));
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('rejects an unmapped unit inside order create before any product lookup', async () => {
    const idem = { check: jest.fn() };
    const prisma = { product: { findMany: jest.fn() } };
    const svc = new OrdersService(prisma as never, { log: jest.fn() } as never, idem as never);
    await expectUnit422(() => svc.create(
      { customerId: 'c1', source: 'CLERK', lines: [{ productId: 'p-maotai', qty: 1, unit: '打' as 'BASE' }] },
      owner,
    ));
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(idem.check).not.toHaveBeenCalled();
  });
});
