/**
 * P0-03 单测: IdempotencyService 幂等基座(资金/库存写接口统一)
 * 核心语义:
 *   - 新 key → check() 返回 null(执行), complete() 落记录
 *   - 同 key 同指纹 → check() 返回 {replay:true, summary}(回放首次响应, 不双写)
 *   - 同 key 不同指纹 → 409(防跨端点/参数串用)
 *   - 0923 前旧格式(非 sha256)记录 → 视同同请求回放(兼容)
 *   - complete() 唯一索引撞车(P2002) → 幂等成功, 不抛
 */
import { ConflictException } from '@nestjs/common';
import { IdempotencyService, IdempotencyResult } from '../src/audit/idempotency.service';

type Rec = {
  tenantId: string;
  key: string;
  endpoint: string;
  requestHash: string;
  responseSummary: unknown;
  createdBy: string;
};
const mkRec = (over: Partial<Rec> = {}): Rec => ({
  tenantId: 't1',
  key: 'k1',
  endpoint: '/orders',
  requestHash: 'a'.repeat(64),
  responseSummary: { ok: true, id: 'ord_1' },
  createdBy: 'u1',
  ...over,
});

function makeSrv(records: Rec[]) {
  const prisma = {
    idempotencyRecord: {
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { tenantId_key: { tenantId: string; key: string } } }) =>
        records.find((r) => r.tenantId === where.tenantId_key.tenantId && r.key === where.tenantId_key.key) ?? null,
      ),
      create: jest.fn().mockImplementation(async ({ data }: { data: Rec }) => {
        const existing = records.find((r) => r.tenantId === data.tenantId && r.key === data.key);
        if (existing) {
          const e: Error & { code?: string } = new Error('unique constraint');
          e.code = 'P2002';
          throw e;
        }
        records.push(data);
        return data;
      }),
    },
  } as never;
  return new IdempotencyService(prisma);
}
const USER = { id: 'u1', tenantId: 't1' };
const P = { amount: 100, sku: 'A' };

describe('IdempotencyService.requestHash', () => {
  it('同 endpoint+同参数(键序无关) → 同指纹', () => {
    const a = IdempotencyService.requestHash('/x', { amount: 100, sku: 'A' });
    const b = IdempotencyService.requestHash('/x', { sku: 'A', amount: 100 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
  it('不同参数 → 不同指纹', () => {
    expect(IdempotencyService.requestHash('/x', { amount: 100 })).not.toBe(
      IdempotencyService.requestHash('/x', { amount: 200 }),
    );
  });
  it('不同 endpoint 同参数 → 不同指纹(防跨端点串用)', () => {
    expect(IdempotencyService.requestHash('/orders', P)).not.toBe(
      IdempotencyService.requestHash('/payments', P),
    );
  });
});

describe('IdempotencyService.check', () => {
  it('无 key → 返回 null(交由路由层强制)', async () => {
    const srv = makeSrv([]);
    expect(await srv.check(USER, '/orders', '', P)).toBeNull();
  });
  it('新 key → null(执行, 不回放)', async () => {
    const srv = makeSrv([]);
    expect(await srv.check(USER, '/orders', 'k_new', P)).toBeNull();
  });
  it('同 key 同指纹 → replay:true + 回放 summary', async () => {
    const h = IdempotencyService.requestHash('/orders', P);
    const srv = makeSrv([mkRec({ key: 'k1', requestHash: h, responseSummary: { ok: true, id: 'ord_1' } })]);
    const r = await srv.check(USER, '/orders', 'k1', P);
    expect(r).toBeInstanceOf(IdempotencyResult);
    expect(r!.replay).toBe(true);
    expect(r!.summary).toEqual({ ok: true, id: 'ord_1' });
  });
  it('同 key 不同指纹(sha256) → 409 防串用', async () => {
    const other = IdempotencyService.requestHash('/orders', { amount: 999 });
    const srv = makeSrv([mkRec({ key: 'k1', requestHash: other })]);
    await expect(srv.check(USER, '/orders', 'k1', P)).rejects.toThrow(ConflictException);
  });
  it('0923 前旧格式(非 sha256)同 key → 视同回放, 不 409', async () => {
    const srv = makeSrv([mkRec({ key: 'k1', requestHash: 'legacy-md5-xxxx' })]);
    const r = await srv.check(USER, '/orders', 'k1', P);
    expect(r!.replay).toBe(true);
  });
  it('租户隔离: 他人同 key 不影响本租户(返回 null, 视为新)', async () => {
    const h = IdempotencyService.requestHash('/orders', P);
    const srv = makeSrv([mkRec({ tenantId: 'other', key: 'k1', requestHash: h })]);
    // 本租户 t1 无记录
    expect(await srv.check(USER, '/orders', 'k1', P)).toBeNull();
  });
});

describe('IdempotencyService.complete', () => {
  it('新 key 落记录(requestHash=sha256, endpoint, summary)', async () => {
    const records: Rec[] = [];
    const srv = makeSrv(records);
    await srv.complete(USER, '/orders', 'k1', P, { ok: true, id: 'ord_1' });
    expect(records).toHaveLength(1);
    expect(records[0].key).toBe('k1');
    expect(records[0].endpoint).toBe('/orders');
    expect(records[0].requestHash).toBe(IdempotencyService.requestHash('/orders', P));
    expect(records[0].responseSummary).toEqual({ ok: true, id: 'ord_1' });
  });
  it('无 key → 不落(直接返回)', async () => {
    const records: Rec[] = [];
    const srv = makeSrv(records);
    await srv.complete(USER, '/orders', '', P, { ok: true });
    expect(records).toHaveLength(0);
  });
  it('并发竞态 P2002 → 幂等成功, 不抛', async () => {
    // 已有同 key 记录 → create 抛 P2002 → complete 吞掉
    const records: Rec[] = [mkRec({ key: 'k1' })];
    const srv = makeSrv(records);
    await expect(
      srv.complete(USER, '/orders', 'k1', P, { ok: true }),
    ).resolves.toBeUndefined();
  });
  it('传入 tx 时优先用 tx 落库', async () => {
    const create = jest.fn().mockResolvedValue({});
    const tx = { idempotencyRecord: { create } } as never;
    const srv = makeSrv([]);
    await srv.complete(USER, '/orders', 'k1', P, { ok: true }, tx);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
