import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { StockAlertController, StockAlertDailyTask, SystemConfigReader } from '../src/modules/stock-alert/stock-alert.controller';
import { StockAlertService } from '../src/modules/stock-alert/stock-alert.service';
import type { AuthUser } from '../src/common/current-user.decorator';

const owner: AuthUser = {
  id: 'owner', tenantId: 't1', username: 'owner', name: '老板', role: 'OWNER', dataScope: 'ALL', aud: 'staff',
};

interface ReportRow {
  id: string;
  tenantId: string;
  reportDate: Date;
  productId: string;
  onHand: unknown;
  restockId: string | null;
  restockStatus: string | null;
  level: string;
}

function dayKey(value: unknown): string {
  return dayjs(value as Date).format('YYYY-MM-DD');
}

function matches(row: ReportRow, where: Record<string, unknown>): boolean {
  if (where.tenantId && row.tenantId !== where.tenantId) return false;
  if (where.reportDate && dayKey(row.reportDate) !== dayKey(where.reportDate)) return false;
  if (where.productId && row.productId !== where.productId) return false;
  if (where.restockId === null && row.restockId != null) return false;
  const not = where.NOT as { restockId?: null } | undefined;
  if (not && not.restockId === null && row.restockId == null) return false;
  return true;
}

/** 内存里的当日快照。createMany 在 (tenantId, reportDate, productId) 已存在时抛 P2002。 */
function world() {
  const reports: ReportRow[] = [
    {
      id: 'row-linked', tenantId: 't1', reportDate: new Date(), productId: 'p-linked',
      onHand: 1, restockId: 'rq-1', restockStatus: 'SUBMITTED', level: 'LOW',
    },
    {
      id: 'row-free', tenantId: 't1', reportDate: new Date(), productId: 'p-free',
      onHand: 1, restockId: null, restockStatus: null, level: 'OK',
    },
  ];
  let seq = 0;
  const dailyStockReport = {
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => reports.filter((r) => matches(r, where))),
    deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = reports.length;
      for (let i = reports.length - 1; i >= 0; i--) if (matches(reports[i], where)) reports.splice(i, 1);
      return { count: before - reports.length };
    }),
    createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const row of data) {
        const clash = reports.some((r) => r.tenantId === row.tenantId && r.productId === row.productId && dayKey(r.reportDate) === dayKey(row.reportDate));
        if (clash) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`tenantId`,`reportDate`,`productId`)', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
      }
      for (const row of data) {
        reports.push({
          id: `row-new-${++seq}`,
          tenantId: String(row.tenantId),
          reportDate: row.reportDate as Date,
          productId: String(row.productId),
          onHand: row.onHand,
          restockId: (row.restockId as string | null) ?? null,
          restockStatus: (row.restockStatus as string | null) ?? null,
          level: String(row.level),
        });
      }
      return { count: data.length };
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of reports) {
        if (!matches(row, where)) continue;
        if ('restockId' in data) row.restockId = data.restockId as string | null;
        if ('restockStatus' in data) row.restockStatus = data.restockStatus as string | null;
        if ('onHand' in data) row.onHand = data.onHand;
        if ('level' in data) row.level = String(data.level);
        count += 1;
      }
      return { count };
    }),
  };
  const prisma = {
    dailyStockReport,
    systemConfig: { findFirst: jest.fn(async () => null) },
    product: {
      findMany: jest.fn(async () => [
        { id: 'p-linked', tenantId: 't1', status: 'ON_SALE', name: '已挂报货', skuCode: 'SKU-L', packSize: 6 },
        { id: 'p-free', tenantId: 't1', status: 'ON_SALE', name: '未挂报货', skuCode: 'SKU-F', packSize: 6 },
      ]),
    },
    inventoryLedger: {
      findMany: jest.fn(async () => []),
      groupBy: jest.fn(async ({ by }: { by: string[] }) => {
        if (by.includes('batchId')) return [];
        return [
          { productId: 'p-linked', direction: 'IN', _sum: { qty: 12 } },
          { productId: 'p-free', direction: 'IN', _sum: { qty: 4 } },
        ];
      }),
    },
    purchaseLine: { groupBy: jest.fn(async () => []) },
    batchStock: { findMany: jest.fn(async () => []) },
    restockRequest: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn(),
    },
    tenant: { findMany: jest.fn(async () => [{ id: 't1' }]) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const notify = { send: jest.fn(async () => true) };
  const svc = new StockAlertService(prisma as never, audit as never, notify as never, {} as never, {} as never);
  const cfgReader = new SystemConfigReader(prisma as never);
  const controller = new StockAlertController(svc, cfgReader);
  const daily = new StockAlertDailyTask(svc, cfgReader, { prune: jest.fn(async () => 0) } as never);
  return { reports, prisma, audit, controller, daily };
}

function linked(reports: ReportRow[]): ReportRow {
  const row = reports.find((r) => r.productId === 'p-linked');
  if (!row) throw new Error('挂着报货单的快照行被删了');
  return row;
}

describe('stock alert rerun when a row already has a restock', () => {
  it('POST /stock-alert/run refreshes numbers and keeps restockId', async () => {
    const { reports, prisma, audit, controller } = world();
    const first = await controller.run(owner) as { rows: number };
    const second = await controller.run(owner) as { rows: number };

    expect(first.rows).toBe(2);
    expect(second.rows).toBe(2);
    const row = linked(reports);
    expect(row.id).toBe('row-linked');
    expect(row.restockId).toBe('rq-1');
    expect(row.restockStatus).toBe('SUBMITTED');
    expect(Number(row.onHand)).toBe(12);
    const free = reports.filter((r) => r.productId === 'p-free');
    expect(free).toHaveLength(1);
    expect(free[0].restockId).toBeNull();
    expect(Number(free[0].onHand)).toBe(4);
    expect(prisma.restockRequest.create).not.toHaveBeenCalled();
    expect(audit.log.mock.calls.map((c) => c[0].action)).toEqual(['STOCK_REPORT_RUN', 'STOCK_REPORT_RUN']);
  });

  it('daily runAllTenants refreshes numbers and keeps restockId', async () => {
    const { reports, prisma, audit, daily } = world();
    const first = await daily.runAllTenants();
    const second = await daily.runAllTenants();

    expect(first).toEqual([expect.objectContaining({ tenantId: 't1', rows: 2 })]);
    expect(first[0]).not.toHaveProperty('error');
    expect(second[0]).not.toHaveProperty('error');
    const row = linked(reports);
    expect(row.id).toBe('row-linked');
    expect(row.restockId).toBe('rq-1');
    expect(row.restockStatus).toBe('SUBMITTED');
    expect(Number(row.onHand)).toBe(12);
    expect(reports.filter((r) => r.productId === 'p-free')).toHaveLength(1);
    expect(prisma.restockRequest.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledTimes(2);
    expect(audit.log.mock.calls[0][0].user).toMatchObject({ id: 'system', username: 'system', tenantId: 't1' });
  });
});
