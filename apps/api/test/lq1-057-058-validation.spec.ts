import 'reflect-metadata';
import { BadRequestException, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { configureApp } from '../src/configure-app';
import type { AuthUser } from '../src/common/current-user.decorator';
import { ImportsController, PreviewDto } from '../src/modules/imports/imports.controller';
import { ImportsService } from '../src/modules/imports/imports.service';
import {
  BatchItemDto,
  CreateBatchDto,
  CreatePriceChangeDto,
  PriceChangesController,
} from '../src/modules/price-changes/price-changes.controller';
import { PriceChangesService } from '../src/modules/price-changes/price-changes.service';

const owner = {
  id: 'owner', tenantId: 't1', username: 'owner', name: '老板', role: 'OWNER', dataScope: 'ALL', aud: 'staff',
} as AuthUser;

/** 与 configureApp 同一套管道，这样单测拦的就是全局 ValidationPipe 会拦的请求。 */
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: false,
  exceptionFactory: (errors) => new BadRequestException(errors),
});

const csv = Buffer.from('sku\n1\n', 'utf8');
const file = { buffer: csv, originalname: 'prices.csv', size: csv.length };

function priceBody(unit: unknown): Record<string, unknown> {
  return {
    productId: 'p1',
    unit,
    levelType: 'TERMINAL',
    newPrice: 12.5,
    effectiveDate: '2026-10-25',
    reason: '厂家提价',
  };
}

async function expectPipe400(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    throw new Error('expected ValidationPipe to reject with 400');
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
  }
}

describe('LQ1-057 import preview kind', () => {
  const preview = jest.fn(async () => ({ batchNo: 'IMP1', kind: 'PRICE' }));
  const controller = new ImportsController({ preview } as unknown as ImportsService);

  beforeEach(() => preview.mockClear());

  it('accepts kind from the multipart form field and still enum-checks it', async () => {
    const body = await pipe.transform({ kind: 'PRICE' }, { type: 'body', metatype: PreviewDto });
    expect(body).toMatchObject({ kind: 'PRICE' });
    await controller.preview(owner, file, undefined, '', body);
    expect(preview).toHaveBeenCalledWith(owner, 'PRICE', 'prices.csv', csv);
  });

  it('accepts kind from the query when the body omits it', async () => {
    const body = await pipe.transform({}, { type: 'body', metatype: PreviewDto });
    expect(body.kind).toBeUndefined();
    await controller.preview(owner, file, 'CUSTOMER', '', body);
    expect(preview).toHaveBeenCalledWith(owner, 'CUSTOMER', 'prices.csv', csv);
  });

  it('returns 400 when neither body nor query provides a valid kind', async () => {
    const body = await pipe.transform({}, { type: 'body', metatype: PreviewDto });
    await expect(controller.preview(owner, file, undefined, '', body)).rejects.toMatchObject({
      status: 400,
      message: 'kind 须为 PRODUCT/CUSTOMER/PRICE/INVENTORY/RECEIVABLE',
    });
    await expect(controller.preview(owner, file, 'NOPE', '', body)).rejects.toMatchObject({ status: 400 });
    expect(preview).not.toHaveBeenCalled();
  });

  it('returns 400 from the pipe when the multipart kind is not an import kind', async () => {
    await expectPipe400(() => pipe.transform({ kind: 'NOPE' }, { type: 'body', metatype: PreviewDto }));
    expect(preview).not.toHaveBeenCalled();
  });
});

describe('LQ1-058 price-change unit', () => {
  it('normalizes 箱 and 瓶 on create before the enum check', async () => {
    const base = await pipe.transform(priceBody('箱'), { type: 'body', metatype: CreatePriceChangeDto });
    const min = await pipe.transform(priceBody('瓶'), { type: 'body', metatype: CreatePriceChangeDto });
    const passthrough = await pipe.transform(priceBody('BASE'), { type: 'body', metatype: CreatePriceChangeDto });
    expect(base.unit).toBe('BASE');
    expect(min.unit).toBe('MIN');
    expect(passthrough.unit).toBe('BASE');
  });

  it('normalizes 箱 and 瓶 on each batch item and leaves a missing unit empty', async () => {
    const dto = await pipe.transform({
      items: [
        { productId: 'p1', unit: '箱', levelType: 'TERMINAL', newPrice: 10 },
        { productId: 'p2', unit: '瓶', levelType: 'RETAIL', newPrice: 3 },
        { productId: 'p3', levelType: 'TIER1', newPrice: 8 },
      ],
      effectiveDate: '2026-10-25',
      reason: '批量',
    }, { type: 'body', metatype: CreateBatchDto });
    expect(dto.items.map((item: BatchItemDto) => item.unit)).toEqual(['BASE', 'MIN', undefined]);
  });

  it('returns 400 for an invalid unit on create and on a batch item', async () => {
    await expectPipe400(() => pipe.transform(priceBody('打'), { type: 'body', metatype: CreatePriceChangeDto }));
    await expectPipe400(() => pipe.transform({
      items: [{ productId: 'p1', unit: '打', levelType: 'TERMINAL', newPrice: 10 }],
      effectiveDate: '2026-10-25',
      reason: '批量',
    }, { type: 'body', metatype: CreateBatchDto }));
  });
});

describe('LQ1-057 multipart preview through the global pipe', () => {
  const preview = jest.fn(async (_user: AuthUser, kind: string) => ({ batchNo: 'IMP1', kind }));

  @Module({
    controllers: [ImportsController],
    providers: [{ provide: ImportsService, useValue: { preview } }],
  })
  class PreviewHttpModule {}

  let app: NestExpressApplication;
  let baseUrl = '';

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(PreviewHttpModule, { logger: false, bodyParser: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => preview.mockClear());

  function form(kind?: string): FormData {
    const fd = new FormData();
    if (kind !== undefined) fd.append('kind', kind);
    fd.append('file', new Blob([csv]), 'prices.csv');
    return fd;
  }

  it('accepts kind as a multipart form field', async () => {
    const res = await fetch(`${baseUrl}/api/imports/preview`, { method: 'POST', body: form('PRODUCT') });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ kind: 'PRODUCT' });
    expect(preview).toHaveBeenCalledWith(undefined, 'PRODUCT', 'prices.csv', expect.any(Buffer));
  });

  it('accepts kind from the query when the form omits it', async () => {
    const res = await fetch(`${baseUrl}/api/imports/preview?kind=INVENTORY`, { method: 'POST', body: form() });
    expect(res.status).toBe(201);
    expect(preview).toHaveBeenCalledWith(undefined, 'INVENTORY', 'prices.csv', expect.any(Buffer));
  });

  it('returns 400 when the form and the query both omit kind', async () => {
    const res = await fetch(`${baseUrl}/api/imports/preview`, { method: 'POST', body: form() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 400,
      message: 'kind 须为 PRODUCT/CUSTOMER/PRICE/INVENTORY/RECEIVABLE',
    });
    expect(preview).not.toHaveBeenCalled();
  });
});

describe('LQ1-058 price-change HTTP unit', () => {
  const create = jest.fn(async (_user: AuthUser, dto: { unit: string }) => ({ id: 'pc1', unit: dto.unit }));
  const createBatch = jest.fn(async (_user: AuthUser, dto: { items: Array<{ unit?: string }> }) => ({
    batchNo: 'PC-B1',
    count: dto.items.length,
    items: dto.items.map((item) => ({ unit: item.unit ?? null })),
  }));

  @Module({
    controllers: [PriceChangesController],
    providers: [{ provide: PriceChangesService, useValue: { create, createBatch } }],
  })
  class PriceHttpModule {}

  let app: NestExpressApplication;
  let baseUrl = '';

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(PriceHttpModule, { logger: false, bodyParser: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    create.mockClear();
    createBatch.mockClear();
  });

  it('accepts 箱 and 瓶 on create and stores the normalized enum', async () => {
    const box = await fetch(`${baseUrl}/api/price-changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(priceBody('箱')),
    });
    expect(box.status).toBe(201);
    expect(await box.json()).toMatchObject({ unit: 'BASE' });
    expect(create).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ unit: 'BASE' }));

    const bottle = await fetch(`${baseUrl}/api/price-changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(priceBody(' 瓶 ')),
    });
    expect(bottle.status).toBe(201);
    expect(create).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ unit: 'MIN' }));
  });

  it('returns 400 for an invalid unit and does not call the service', async () => {
    const res = await fetch(`${baseUrl}/api/price-changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(priceBody('打')),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('BASE');
    expect(body.message).toContain('MIN');
    expect(create).not.toHaveBeenCalled();
  });

  it('normalizes batch item units and rejects an invalid one', async () => {
    const ok = await fetch(`${baseUrl}/api/price-changes/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { productId: 'p1', unit: '箱', levelType: 'TERMINAL', newPrice: 10 },
          { productId: 'p2', unit: '瓶', levelType: 'RETAIL', newPrice: 3 },
        ],
        effectiveDate: '2026-10-25',
        reason: '批量',
      }),
    });
    expect(ok.status).toBe(201);
    expect(createBatch).toHaveBeenCalledWith(undefined, expect.objectContaining({
      items: [
        expect.objectContaining({ unit: 'BASE' }),
        expect.objectContaining({ unit: 'MIN' }),
      ],
    }));

    createBatch.mockClear();
    const bad = await fetch(`${baseUrl}/api/price-changes/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ productId: 'p1', unit: '打', levelType: 'TERMINAL', newPrice: 10 }],
        effectiveDate: '2026-10-25',
        reason: '批量',
      }),
    });
    expect(bad.status).toBe(400);
    expect(createBatch).not.toHaveBeenCalled();
  });
});
