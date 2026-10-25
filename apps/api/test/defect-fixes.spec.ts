import { BadRequestException, ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { IsArray, IsEnum, IsString, ValidateNested, validate } from 'class-validator';
import { Type } from 'class-transformer';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import { bizDayDiff, bizDayStamp, bizMonthRange } from '../src/common/business-time';
import { daysCoverOf } from '../src/common/days-cover';
import { formatValidationErrors, joinExceptionMessage } from '../src/common/validation-message';
import { OrdersService } from '../src/modules/orders/orders.service';
import { planReturnReceive } from '../src/modules/returns/return-receive-plan';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { planDemoOutbound } = require('../prisma/demo-stock-plan');

class LineDto {
  @IsString() productId!: string;
}

class OrderBody {
  @IsEnum(['CLERK', 'REP', 'CUSTOMER']) source!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => LineDto) lines!: LineDto[];
}

function hostOf(): { status: jest.Mock; json: jest.Mock; host: { switchToHttp: () => { getResponse: () => { status: jest.Mock } } } } {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return {
    status,
    json,
    host: { switchToHttp: () => ({ getResponse: () => ({ status }) }) },
  };
}

describe('LQ1-013 business calendar', () => {
  it('puts 2026-09-30 16:30Z on the Shanghai business day of 2026-10-01', () => {
    const instant = new Date('2026-09-30T16:30:00.000Z');
    expect(bizDayStamp(instant)).toBe('20261001');
    const october = bizMonthRange('2026-10');
    const september = bizMonthRange('2026-09');
    expect(october.start.toISOString()).toBe('2026-09-30T16:00:00.000Z');
    expect(october.end.toISOString()).toBe('2026-10-31T15:59:59.999Z');
    expect(instant >= october.start && instant <= october.end).toBe(true);
    expect(instant >= september.start && instant <= september.end).toBe(false);
  });

  it('counts overdue days on the Shanghai calendar', () => {
    expect(bizDayDiff('2026-10-01T00:00:00+08:00', '2026-10-03T01:00:00+08:00')).toBe(2);
  });
});

describe('LQ1-042 validation messages', () => {
  it('keeps enum values when several messages are joined', () => {
    const message = joinExceptionMessage(
      ['source must be one of the following values: CLERK, REP, CUSTOMER', 'lines must be an array'],
      'fallback',
    );
    expect(message).toBe('source must be one of the following values: CLERK, REP, CUSTOMER；lines must be an array');
    expect(message).toContain('CLERK');
    expect(message).toContain('REP');
    expect(message).toContain('CUSTOMER');
  });

  it('lists allowed enum values from a real class-validator failure', async () => {
    const body = new OrderBody();
    body.source = 'NOPE';
    const errors = await validate(body);
    const message = formatValidationErrors(errors).join('；');
    expect(message).toContain('CLERK');
    expect(message).toContain('REP');
    expect(message).toContain('CUSTOMER');
    expect(message).toContain('lines');
    expect(message).not.toMatch(/values:\s*；/);
    expect(message).not.toMatch(/values:\s*,/);
  });
});

describe('LQ1-015 precheck payload', () => {
  const filter = new HttpExceptionFilter();

  it('keeps data on 422 and does not attach a stack', () => {
    const precheck = { inventory: [{ ok: false, productName: '青岛啤酒' }] };
    const { status, json, host } = hostOf();
    filter.catch(new HttpException({ message: '审单预检未通过', data: precheck }, HttpStatus.UNPROCESSABLE_ENTITY), host as never);
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({ code: 422, message: '审单预检未通过', data: precheck });
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('stack');
  });

  it('does not echo data on other status codes', () => {
    const { json, host } = hostOf();
    filter.catch(new HttpException({ message: 'bad', data: { secret: true } }, HttpStatus.BAD_REQUEST), host as never);
    expect(json).toHaveBeenCalledWith({ code: 400, message: 'bad' });
  });
});

describe('LQ1-010 order idempotency', () => {
  it('refuses to create an order when Idempotency-Key is missing', async () => {
    const idem = { check: jest.fn(), complete: jest.fn() };
    const service = new OrdersService({} as never, { log: jest.fn() } as never, idem as never);
    await expect(service.create(
      { customerId: 'c1', source: 'CLERK', lines: [{ productId: 'p1', qty: 1, unit: 'BASE' }] },
      { id: 'u1', tenantId: 't1', role: 'CLERK' } as never,
      '  ',
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(idem.check).not.toHaveBeenCalled();
  });
});

describe('LQ1-039 days cover', () => {
  it('divides available stock by the daily outbound rate', () => {
    expect(daysCoverOf(4080, 4440, 7)).toBe(6.4);
    expect(daysCoverOf(0, 100, 7)).toBe(0);
    expect(daysCoverOf(-360, 4440, 7)).toBe(0);
    expect(daysCoverOf(100, 0, 7)).toBeNull();
  });
});

describe('LQ1-012 demo stock plan', () => {
  it('tops up Qingdao so 4440 outbound leaves 4080 and no batch negative', () => {
    const plan = planDemoOutbound(
      [{ id: 'a', net: 2880 }, { id: 'b', net: 960 }, { id: 'c', net: 240 }],
      [620, 620, 620, 640, 640, 640, 660],
    );
    expect(plan.topUp).toBe(4440);
    const nets = new Map<string, number>([['a', 2880 + plan.topUp], ['b', 960], ['c', 240]]);
    for (const day of plan.perDay as Array<Array<{ batchId: string; qty: number }>>) {
      for (const row of day) nets.set(row.batchId, (nets.get(row.batchId) ?? 0) - row.qty);
    }
    for (const net of nets.values()) expect(net).toBeGreaterThanOrEqual(0);
    expect([...nets.values()].reduce((sum, net) => sum + net, 0)).toBe(4080);
  });

  it('does not top up a product that already covers the outbound', () => {
    const plan = planDemoOutbound([{ id: 'w', net: 4800 }], [420, 420, 420, 440, 440, 440, 420]);
    expect(plan.topUp).toBe(0);
    const left = 4800 - plan.perDay.flat().reduce((sum: number, row: { qty: number }) => sum + row.qty, 0);
    expect(left).toBe(1800);
  });
});

describe('LQ1-016 return receive preview', () => {
  it('allocates confirmed outbound batches and prices the credit from the order line', () => {
    const plan = planReturnReceive({
      lines: [{ orderLineId: 'l1', productId: 'p1', qty: 2 }],
      orderLines: [{ id: 'l1', productName: '青岛啤酒', unit: 'BASE', conversionRate: 12, unitPrice: 60 }],
      outboundLines: [
        { orderLineId: 'l1', batchId: 'b1', batchNo: 'PIJIU-1', qty: 10 },
        { orderLineId: 'l1', batchId: 'b2', batchNo: 'PIJIU-2', qty: 20 },
      ],
    });
    expect(plan.arCredit).toBe(120);
    expect(plan.batches).toEqual([
      { batchId: 'b1', batchNo: 'PIJIU-1', productId: 'p1', productName: '青岛啤酒', qty: 10 },
      { batchId: 'b2', batchNo: 'PIJIU-2', productId: 'p1', productName: '青岛啤酒', qty: 14 },
    ]);
  });

  it('rejects a return larger than confirmed outbound', () => {
    expect(() => planReturnReceive({
      lines: [{ orderLineId: 'l1', productId: 'p1', qty: 1 }],
      orderLines: [{ id: 'l1', productName: '酒', unit: 'MIN', conversionRate: 1, unitPrice: 10 }],
      outboundLines: [],
    })).toThrow(ConflictException);
  });
});
