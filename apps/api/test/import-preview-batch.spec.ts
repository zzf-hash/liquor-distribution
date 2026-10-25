import { ImportsService } from '../src/modules/imports/imports.service';
import type { AuthUser } from '../src/common/current-user.decorator';

const owner: AuthUser = {
  id: 'owner', tenantId: 't1', username: 'owner', name: '老板', role: 'OWNER', dataScope: 'ALL', aud: 'staff',
};

/** 同一秒内两张价格预览。列够走到批次落库。 */
function priceCsv(): Buffer {
  return Buffer.from('商品编码*,价格类型*,计价单位*,价格*\nSKU0008,零售指导价,箱,21\n', 'utf8');
}

describe('import preview batch number', () => {
  it('adds a random suffix so two previews in the same second do not share a batchNo', async () => {
    const seen = new Set<string>();
    const prisma = {
      product: { findFirst: jest.fn(async () => ({ id: 'p1' })) },
      customer: { findFirst: jest.fn(async () => null) },
      customerPrice: { findFirst: jest.fn(async () => null) },
      price: { findFirst: jest.fn(async () => null) },
      importBatch: {
        create: jest.fn(async ({ data }: { data: { batchNo: string } }) => {
          if (seen.has(data.batchNo)) {
            const error = new Error('Unique constraint failed on the fields: (tenantId, batchNo)') as Error & { code: string };
            error.code = 'P2002';
            throw error;
          }
          seen.add(data.batchNo);
          return { id: `batch-${seen.size}`, ...data };
        }),
      },
      importRowError: { createMany: jest.fn(async () => ({ count: 0 })) },
    };
    const audit = { log: jest.fn(async () => undefined) };
    const svc = new ImportsService(prisma as never, audit as never);

    const [a, b] = await Promise.all([
      svc.preview(owner, 'PRICE', 'a.csv', priceCsv()),
      svc.preview(owner, 'PRICE', 'b.csv', priceCsv()),
    ]) as Array<{ batchNo: string }>;

    expect(a.batchNo).not.toBe(b.batchNo);
    expect(a.batchNo).toMatch(/^IMP\d{14}-PRI-[0-9a-f]{8}$/);
    expect(b.batchNo).toMatch(/^IMP\d{14}-PRI-[0-9a-f]{8}$/);
    expect(prisma.importBatch.create).toHaveBeenCalledTimes(2);
  });
});
