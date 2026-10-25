import { BadRequestException, ConflictException, ValidationPipe } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { validate, type ValidationError } from 'class-validator';
import { OrdersService } from '../src/modules/orders/orders.service';
import { SignDto } from '../src/modules/orders/orders.controller';
import { ReturnsService } from '../src/modules/returns/returns.service';
import { ReportsController } from '../src/modules/reports/reports.controller';
import { fallbackLineCost } from '../src/modules/reports/cost-fallback';
import { buildCorsOptions, DEV_CORS_ORIGINS } from '../src/common/cors';

const warehouse = { id: 'u1', tenantId: 't1', role: 'WAREHOUSE', username: 'wh', name: '仓', aud: 'staff' } as never;
const audit = { log: jest.fn() };

function deliveringOrder() {
  return {
    id: 'o1',
    orderNo: 'SO1',
    status: 'DELIVERING',
    customerId: 'c1',
    lines: [{
      id: 'l1', productId: 'p1', productName: '酒', reversalOfId: null,
      qty: new Prisma.Decimal(1), unit: 'BASE' as const, conversionRate: 6,
      unitPrice: new Prisma.Decimal('100.00'), amount: new Prisma.Decimal('100.00'),
    }],
    customer: { termsDays: 0 },
    outbounds: [],
  };
}

function signHarness(order: unknown = deliveringOrder()) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const signature = jest.fn().mockResolvedValue({});
  const receivable = jest.fn().mockResolvedValue({});
  const ledger = jest.fn().mockResolvedValue({});
  const prisma = {
    salesOrder: { findUnique: jest.fn().mockResolvedValue(order) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      salesOrder: { updateMany },
      signatureRecord: { create: signature },
      receivable: { create: receivable },
      inventoryLedger: { create: ledger },
      packageRecord: { create: jest.fn() },
      systemConfig: { findFirst: jest.fn() },
    })),
  };
  const svc = new OrdersService(prisma as never, audit as never, {} as never);
  return { svc, prisma, updateMany, signature, receivable, ledger };
}

async function expectBadRequest(run: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await run();
    throw new Error(`expected 400 ${message}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
    expect((error as BadRequestException).message).toBe(message);
  }
}

function constraintMessages(errors: ValidationError[]): string[] {
  const out: string[] = [];
  for (const error of errors) {
    if (error.constraints) out.push(...Object.values(error.constraints));
    if (error.children?.length) out.push(...constraintMessages(error.children));
  }
  return out;
}

describe('PR35-1 sign proof', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });

  it('rejects an electronic sign without a signature before any write', async () => {
    const { svc, prisma, updateMany, signature, receivable } = signHarness();
    await expectBadRequest(() => svc.sign(warehouse, 'o1', { type: 'E_SIGN' }), '电子签收必须提交签名');
    await expectBadRequest(() => svc.sign(warehouse, 'o1', { type: 'E_SIGN', signatureData: '   ' }), '电子签收必须提交签名');
    expect(prisma.salesOrder.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(signature).not.toHaveBeenCalled();
    expect(receivable).not.toHaveBeenCalled();
  });

  it('rejects paper and photo signs without a photo before any write', async () => {
    const paper = signHarness();
    await expectBadRequest(() => paper.svc.sign(warehouse, 'o1', { type: 'PAPER' }), '纸质单签收必须提交照片');
    expect(paper.prisma.$transaction).not.toHaveBeenCalled();
    expect(paper.signature).not.toHaveBeenCalled();
    expect(paper.updateMany).not.toHaveBeenCalled();
    expect(paper.receivable).not.toHaveBeenCalled();

    const photo = signHarness();
    await expectBadRequest(() => photo.svc.sign(warehouse, 'o1', { type: 'PHOTO', photoUrl: '  ' }), '拍照签收必须提交照片');
    expect(photo.prisma.salesOrder.findUnique).not.toHaveBeenCalled();
    expect(photo.receivable).not.toHaveBeenCalled();
  });

  it('signs and generates a receivable only after the proof is present', async () => {
    const electronic = signHarness();
    const signed = await electronic.svc.sign(warehouse, 'o1', { type: 'E_SIGN', signatureData: 'data:image/png;base64,abc' }) as { status: string; receivableGenerated: boolean };
    expect(signed).toMatchObject({ status: 'SIGNED', receivableGenerated: true });
    expect(electronic.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'o1', status: 'DELIVERING' },
      data: expect.objectContaining({ status: 'SIGNED' }),
    }));
    expect(electronic.signature).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'E_SIGN', signatureData: 'data:image/png;base64,abc' }),
    }));
    expect(electronic.receivable).toHaveBeenCalledTimes(1);

    const paper = signHarness();
    await paper.svc.sign(warehouse, 'o1', { type: 'PAPER', photoUrl: 'https://cdn.example/paper.jpg' });
    expect(paper.signature).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'PAPER', photoUrl: 'https://cdn.example/paper.jpg' }),
    }));
    expect(paper.receivable).toHaveBeenCalledTimes(1);
  });

  it('rejects the same missing proof on SignDto with HTTP 400', async () => {
    const dto = Object.assign(new SignDto(), { type: 'E_SIGN', signatureData: '' });
    expect(constraintMessages(await validate(dto))).toContain('电子签收必须提交签名');

    await expect(pipe.transform({ type: 'PAPER' }, { type: 'body', metatype: SignDto })).rejects.toBeInstanceOf(BadRequestException);
    try {
      await pipe.transform({ type: 'PHOTO', photoUrl: '   ' }, { type: 'body', metatype: SignDto });
      throw new Error('blank photo should be 400');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getStatus()).toBe(400);
      const body = (error as BadRequestException).getResponse() as { message: string[] };
      expect(body.message).toContain('拍照签收必须提交照片');
    }

    const accepted = await pipe.transform(
      { type: 'E_SIGN', signatureData: 'signed' },
      { type: 'body', metatype: SignDto },
    );
    expect(accepted).toMatchObject({ type: 'E_SIGN', signatureData: 'signed' });
  });
});

describe('PR35-2 CORS allowlist', () => {
  it('never uses a wildcard and defaults to local dev origins only outside production', () => {
    expect(buildCorsOptions({}).origin).toEqual([...DEV_CORS_ORIGINS]);
    expect(buildCorsOptions({ NODE_ENV: 'production' }).origin).toBe(false);
    expect(buildCorsOptions({ CORS_ORIGINS: '' }).origin).toBe(false);
    expect(buildCorsOptions({ CORS_ORIGINS: '*' }).origin).toBe(false);
    expect(buildCorsOptions({ CORS_ORIGINS: ' * , https://h5.example.com ' }).origin).toEqual(['https://h5.example.com']);
    expect(buildCorsOptions({ NODE_ENV: 'development', CORS_ORIGINS: 'https://h5.example.com' }).origin).toEqual(['https://h5.example.com']);

    for (const env of [{}, { NODE_ENV: 'production' }, { CORS_ORIGINS: '*' }, { CORS_ORIGINS: 'https://h5.example.com,*' }]) {
      const options = buildCorsOptions(env);
      expect(options.origin).not.toBe('*');
      expect(options.origin).not.toBe(true);
      if (Array.isArray(options.origin)) expect(options.origin).not.toContain('*');
      expect(options.methods).toEqual(expect.arrayContaining(['GET', 'POST', 'OPTIONS']));
      expect(options.allowedHeaders).toEqual(expect.arrayContaining(['Content-Type', 'Authorization', 'Idempotency-Key']));
    }

    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain('enableCors(buildCorsOptions())');
    expect(main).not.toMatch(/origin:\s*['"]\*['"]/);
  });

  async function preflight(origin: string, env: NodeJS.ProcessEnv): Promise<{ status: number; allowOrigin: string | null; allowHeaders: string | null; allowMethods: string | null }> {
    const adapter = new ExpressAdapter();
    adapter.enableCors(buildCorsOptions(env));
    const server = http.createServer(adapter.getInstance());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization,idempotency-key',
        },
      });
      const headers = {
        status: res.status,
        allowOrigin: res.headers.get('access-control-allow-origin'),
        allowHeaders: res.headers.get('access-control-allow-headers'),
        allowMethods: res.headers.get('access-control-allow-methods'),
      };
      await res.arrayBuffer();
      return headers;
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }

  it('allows the H5 dev origin preflight and refuses every other origin', async () => {
    const allowed = await preflight('http://127.0.0.1:10086', {});
    expect(allowed.status).toBe(204);
    expect(allowed.allowOrigin).toBe('http://127.0.0.1:10086');
    expect(allowed.allowOrigin).not.toBe('*');
    expect(allowed.allowHeaders?.toLowerCase()).toContain('authorization');
    expect(allowed.allowHeaders?.toLowerCase()).toContain('idempotency-key');
    expect(allowed.allowHeaders?.toLowerCase()).toContain('content-type');
    expect(allowed.allowMethods).toContain('POST');
    expect(allowed.allowMethods).toContain('GET');

    const stranger = await preflight('https://evil.example', {});
    expect(stranger.allowOrigin).toBeNull();

    const production = await preflight('http://127.0.0.1:10086', { NODE_ENV: 'production' });
    expect(production.allowOrigin).toBeNull();

    const listed = await preflight('https://h5.example.com', { CORS_ORIGINS: 'https://h5.example.com', NODE_ENV: 'production' });
    expect(listed.allowOrigin).toBe('https://h5.example.com');
    const notListed = await preflight('http://127.0.0.1:10086', { CORS_ORIGINS: 'https://h5.example.com', NODE_ENV: 'production' });
    expect(notListed.allowOrigin).toBeNull();
  });
});

describe('PR35-3 return receive copy', () => {
  function harness(status: string) {
    const prisma = {
      returnOrder: { findUnique: jest.fn().mockResolvedValue({ id: 'rt', status, returnNo: 'RT1', tenantId: 't1' }) },
      receivable: { findMany: jest.fn() },
      $transaction: jest.fn(),
    };
    const svc = new ReturnsService(prisma as never, audit as never, {} as never);
    return { svc, prisma };
  }

  it('says 已收货 when the return was already received and writes nothing', async () => {
    const { svc, prisma } = harness('RECEIVED');
    try {
      await svc.receive(warehouse, 'rt');
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getStatus()).toBe(409);
      expect((error as ConflictException).message).toBe('已收货');
    }
    expect(prisma.receivable.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps the approval message when the return is not approved yet', async () => {
    const { svc, prisma } = harness('PENDING_REVIEW');
    await expect(svc.receive(warehouse, 'rt')).rejects.toThrow('退货审批通过后才可收货回冲');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('says 已收货 when a concurrent receive already claimed the return', async () => {
    const inventory = jest.fn();
    const credit = jest.fn();
    const approved = {
      id: 'rt', status: 'APPROVED', returnNo: 'RT1', tenantId: 't1', reason: '破损',
      lines: [{ orderLineId: 'a', productId: 'p', qty: new Prisma.Decimal(1) }],
      order: {
        orderNo: 'SO1',
        lines: [{ id: 'a', unit: 'MIN', conversionRate: 1, unitPrice: new Prisma.Decimal('10.00') }],
        outbounds: [{ status: 'CONFIRMED', lines: [{ orderLineId: 'a', batchId: 'b1', qty: new Prisma.Decimal(1) }] }],
      },
    };
    const prisma = {
      returnOrder: { findUnique: jest.fn().mockResolvedValue(approved) },
      receivable: { findMany: jest.fn().mockResolvedValue([{ id: 'ar1' }]) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        returnOrder: {
          updateMany: async () => ({ count: 0 }),
          findUnique: async () => ({ status: 'RECEIVED' }),
        },
        inventoryLedger: { create: inventory },
        receivableLedger: { create: credit },
      }),
    };
    const svc = new ReturnsService(prisma as never, audit as never, {} as never);
    await expect(svc.receive(warehouse, 'rt')).rejects.toThrow('已收货');
    expect(inventory).not.toHaveBeenCalled();
    expect(credit).not.toHaveBeenCalled();
  });
});

describe('LQ-FE-004 gross-margin cost fallback', () => {
  it('converts BASE and MIN cost with pack size and does not divide a bottle price twice', () => {
    expect(fallbackLineCost({ qty: 2, unit: 'BASE', conversionRate: 6, ratio: 1, basePrice: 100, minPrice: null })).toBe(200);
    expect(fallbackLineCost({ qty: 2, unit: 'BASE', conversionRate: 6, ratio: 1, basePrice: null, minPrice: 10 })).toBe(120);
    expect(fallbackLineCost({ qty: 6, unit: 'MIN', conversionRate: 6, ratio: 1, basePrice: null, minPrice: 10 })).toBe(60);
    expect(fallbackLineCost({ qty: 6, unit: 'MIN', conversionRate: 6, ratio: 1, basePrice: 60, minPrice: null })).toBe(60);
    expect(fallbackLineCost({ qty: 1, unit: 'BASE', conversionRate: 6, ratio: 1, basePrice: 100, minPrice: 10 })).toBe(100);
    expect(fallbackLineCost({ qty: 1, unit: 'BASE', conversionRate: 6, ratio: 1, basePrice: null, minPrice: null })).toBeNull();
    expect(fallbackLineCost({ qty: 1, unit: 'BASE', conversionRate: 6, ratio: 0, basePrice: null, minPrice: null })).toBe(0);
  });

  function signedLine(line: { qty: number; unit: 'BASE' | 'MIN'; conversionRate: number; amount: string; actualQty?: number }) {
    return {
      customerId: 'c1', customerName: '店', salespersonId: null,
      lines: [{
        id: 'l1', productId: 'p1', productName: '酒', reversalOfId: null,
        qty: new Prisma.Decimal(line.qty), unit: line.unit, conversionRate: line.conversionRate,
        amount: new Prisma.Decimal(line.amount),
        product: { category: 'BAIJIU', skuCode: 'S' },
      }],
      signature: line.actualQty === undefined ? null : { actualLines: [{ orderLineId: 'l1', actualQty: line.actualQty }] },
      outbounds: [] as Array<{ lines: Array<{ orderLineId: string; qty: Prisma.Decimal; batch: { unitCost: Prisma.Decimal } }> }>,
    };
  }

  async function report(orders: unknown[], prices: unknown[]) {
    const prisma = {
      salesOrder: { findMany: jest.fn().mockResolvedValue(orders) },
      price: { findMany: jest.fn().mockResolvedValue(prices) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const ctrl = new ReportsController(prisma as never);
    const body = await ctrl.grossProfit({ tenantId: 't1' } as never, '2026-10', 'category') as {
      rows: Array<{ cost: number; margin: number | null; costKnown?: boolean }>;
      totals: { revenue: number; cost: number; margin: number | null };
    };
    return { body, prisma };
  }

  it('uses a BASE cost for a case line instead of reporting 100% margin', async () => {
    const { body, prisma } = await report(
      [signedLine({ qty: 2, unit: 'BASE', conversionRate: 6, amount: '350.00' })],
      [
        { productId: 'p1', unit: 'BASE', price: new Prisma.Decimal('100.00'), validFrom: new Date('2026-06-01') },
        { productId: 'p1', unit: 'BASE', price: new Prisma.Decimal('80.00'), validFrom: new Date('2026-01-01') },
      ],
    );
    expect(prisma.price.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ levelType: 'COST', unit: { in: ['BASE', 'MIN'] } }),
      orderBy: { validFrom: 'desc' },
    }));
    expect(body.totals.revenue).toBe(350);
    expect(body.totals.cost).toBe(200);
    expect(body.totals.margin).toBe(42.9);
    expect(body.rows[0].costKnown).toBeUndefined();
  });

  it('converts a bottle line from a case cost and a case line from a bottle cost', async () => {
    const bottle = await report(
      [signedLine({ qty: 6, unit: 'MIN', conversionRate: 6, amount: '60.00' })],
      [{ productId: 'p1', unit: 'BASE', price: new Prisma.Decimal('60.00'), validFrom: new Date('2026-01-01') }],
    );
    expect(bottle.body.totals.cost).toBe(60);
    expect(bottle.body.totals.margin).toBe(0);

    const cases = await report(
      [signedLine({ qty: 2, unit: 'BASE', conversionRate: 6, amount: '200.00' })],
      [{ productId: 'p1', unit: 'MIN', price: new Prisma.Decimal('10.00'), validFrom: new Date('2026-01-01') }],
    );
    expect(cases.body.totals.cost).toBe(120);
    expect(cases.body.totals.margin).toBe(40);
  });

  it('leaves margin empty when neither cost unit exists', async () => {
    const { body } = await report(
      [signedLine({ qty: 1, unit: 'BASE', conversionRate: 6, amount: '175.00' })],
      [],
    );
    expect(body.totals.revenue).toBe(175);
    expect(body.totals.cost).toBe(0);
    expect(body.totals.margin).toBeNull();
    expect(body.rows[0].margin).toBeNull();
  });

  it('keeps outbound batch cost and does not treat a zero-receipt line as missing cost', async () => {
    const order = signedLine({ qty: 1, unit: 'BASE', conversionRate: 6, amount: '100.00', actualQty: 0 });
    order.lines.push({
      id: 'l2', productId: 'p2', productName: '啤', reversalOfId: null,
      qty: new Prisma.Decimal(1), unit: 'BASE', conversionRate: 12,
      amount: new Prisma.Decimal('100.00'),
      product: { category: 'PIJIU', skuCode: 'P' },
    });
    const priced = {
      customerId: 'c1', customerName: '店', salespersonId: null,
      lines: [order.lines[1]],
      signature: null,
      outbounds: [{ lines: [{ orderLineId: 'l2', qty: new Prisma.Decimal(2), batch: { unitCost: new Prisma.Decimal('15.00') } }] }],
    };
    const withReject = { ...order, lines: order.lines };
    const { body } = await report(
      [withReject, priced],
      [{ productId: 'p2', unit: 'BASE', price: new Prisma.Decimal('40.00'), validFrom: new Date('2026-01-01') }],
    );
    expect(body.totals.revenue).toBe(100);
    expect(body.totals.cost).toBe(30);
    expect(body.totals.margin).toBe(70);
  });
});
