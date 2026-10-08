import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrdersService } from '../src/modules/orders/orders.service';
import { ReceivablesService } from '../src/modules/receivables/receivables.service';
import { ReturnsService } from '../src/modules/returns/returns.service';

const audit = { log: jest.fn() } as never;
const idem = { check: jest.fn(), complete: jest.fn() } as never;
const notify = { send: jest.fn() } as never;

describe('business regression guards', () => {
  it('includes payment reversals when projecting customer credit exposure', async () => {
    const prisma = {
      receivable: {
        findMany: jest.fn().mockResolvedValue([{
          total: new Prisma.Decimal(100),
          ledger: [
            { direction: 'SETTLE', amount: new Prisma.Decimal(100), paymentId: 'payment-1' },
            { direction: 'REVERSAL', amount: new Prisma.Decimal(100), paymentId: 'payment-1' },
          ],
        }]),
      },
      salesOrder: { aggregate: jest.fn().mockResolvedValue({ _sum: { totalAmount: new Prisma.Decimal(0) } }) },
    };
    const service = new OrdersService(prisma as never, audit, idem);

    await expect(service.creditProjection('customer-1')).resolves.toMatchObject({ openAr: 100 });
  });

  it('rejects receivables access for an unbound customer login', async () => {
    const prisma = { receivable: { findMany: jest.fn() } };
    const service = new ReceivablesService(prisma as never, audit, idem, notify);

    await expect(service.list({ id: 'user-1', tenantId: 'tenant-1', role: 'CUSTOMER', aud: 'customer' } as never, {}))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.receivable.findMany).not.toHaveBeenCalled();
  });

  it('caps returnable quantity to persisted accepted signature quantity', () => {
    const service = new ReturnsService({} as never, audit, {} as never);
    const acceptedQty = (service as never as { acceptedQty: (order: unknown, lineId: string, netQty: number) => number }).acceptedQty;

    expect(acceptedQty.call(service, { signature: { actualLines: [{ orderLineId: 'line-1', actualQty: 3 }] } }, 'line-1', 8)).toBe(3);
    expect(acceptedQty.call(service, { signature: { actualLines: [{ orderLineId: 'line-1', actualQty: 30 }] } }, 'line-1', 8)).toBe(8);
  });
});
