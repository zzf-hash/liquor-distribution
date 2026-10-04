/**
 * P0-03 单测: 三类状态机(订单 / 出库单 / 收款单)转换白名单
 * 安全评审§3.2 P0-C: 白名单集中定义, 业务路由禁裸 UPDATE status;
 * 硬约束——未签收不可销账、已复核出库/收款单 append-only——由白名单结构保证,
 * 本测试穷举每一对 (from,to) 断言与白名单一致, 任何绕行路径都会被 409 拦住。
 */
import { ConflictException } from '@nestjs/common';
import {
  ORDER_TRANSITIONS,
  ORDER_STATUS_LABELS,
  assertOrderTransition,
  type OrderStatus,
} from '../src/statemachine/order-state';
import {
  OUTBOUND_TRANSITIONS,
  OUTBOUND_STATE_LABELS,
  assertOutboundTransition,
  type OutboundState,
} from '../src/statemachine/outbound-state';
import {
  PAYMENT_TRANSITIONS,
  PAYMENT_STATE_LABELS,
  assertPaymentTransition,
  type PaymentState,
} from '../src/statemachine/payment-state';

/** 从转换表构造全集: 键 = 所有 from, 值 = 该 from 允许的目标 */
function matrix<K extends string>(
  transitions: Readonly<Record<K, readonly K[]>>,
  all: readonly K[],
): Array<[K, K, boolean]> {
  const rows: Array<[K, K, boolean]> = [];
  for (const from of all) {
    for (const to of all) {
      const allowed = transitions[from]!.includes(to);
      rows.push([from, to, allowed]);
    }
  }
  return rows;
}

function expectRejects(
  fn: () => void,
  msg: string,
): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    if (e instanceof ConflictException) {
      threw = true;
      expect(e.message).toContain(msg);
    } else {
      throw e;
    }
  }
  expect(threw).toBe(true);
}

describe('订单状态机 (OrderStatus)', () => {
  const ALL = [
    'PENDING_CONFIRM',
    'CONFIRMED',
    'OUTBOUND',
    'DELIVERING',
    'SIGNED',
    'SETTLED',
    'CANCELLED',
    'REJECTED',
  ] as const satisfies readonly OrderStatus[];

  it('转换白名单与需求主链完全一致', () => {
    const rows = matrix(ORDER_TRANSITIONS, ALL);
    // 主链
    expect(rows.filter(([f, t]) => f === 'PENDING_CONFIRM' && t === 'CONFIRMED').length).toBe(1);
    expect(ORDER_TRANSITIONS.PENDING_CONFIRM).toContain('CONFIRMED');
    expect(ORDER_TRANSITIONS.PENDING_CONFIRM).toContain('CANCELLED');
    expect(ORDER_TRANSITIONS.CONFIRMED).toContain('OUTBOUND');
    expect(ORDER_TRANSITIONS.CONFIRMED).toContain('CANCELLED');
    expect(ORDER_TRANSITIONS.OUTBOUND).toEqual(['DELIVERING']);
    expect(ORDER_TRANSITIONS.DELIVERING).toContain('SIGNED');
    expect(ORDER_TRANSITIONS.DELIVERING).toContain('REJECTED');
    expect(ORDER_TRANSITIONS.SIGNED).toEqual(['SETTLED']);
  });

  it('终态(SIGNED→SETTLED / CANCELLED / REJECTED)无出边', () => {
    expect(ORDER_TRANSITIONS.SETTLED).toEqual([]);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
    expect(ORDER_TRANSITIONS.REJECTED).toEqual([]);
  });

  it('硬约束: 未签收(PENDING/CONFIRMED/OUTBOUND/DELIVERING)一律不可直达 SETTLED', () => {
    // 只有 SIGNED 能到 SETTLED
    for (const from of ['PENDING_CONFIRM', 'CONFIRMED', 'OUTBOUND', 'DELIVERING'] as OrderStatus[]) {
      expect(ORDER_TRANSITIONS[from]).not.toContain('SETTLED');
    }
    expect(ORDER_TRANSITIONS.SIGNED).toContain('SETTLED');
  });

  it('取消只能发生在配送前; 出库/配送/签收后不可取消', () => {
    expect(ORDER_TRANSITIONS.PENDING_CONFIRM).toContain('CANCELLED');
    expect(ORDER_TRANSITIONS.CONFIRMED).toContain('CANCELLED');
    expect(ORDER_TRANSITIONS.OUTBOUND).not.toContain('CANCELLED');
    expect(ORDER_TRANSITIONS.DELIVERING).not.toContain('CANCELLED');
    expect(ORDER_TRANSITIONS.SIGNED).not.toContain('CANCELLED');
  });

  it('合法转换通过 assertOrderTransition 不抛错', () => {
    expect(() => assertOrderTransition('PENDING_CONFIRM', 'CONFIRMED')).not.toThrow();
    expect(() => assertOrderTransition('CONFIRMED', 'OUTBOUND')).not.toThrow();
    expect(() => assertOrderTransition('OUTBOUND', 'DELIVERING')).not.toThrow();
    expect(() => assertOrderTransition('DELIVERING', 'SIGNED')).not.toThrow();
    expect(() => assertOrderTransition('SIGNED', 'SETTLED')).not.toThrow();
    expect(() => assertOrderTransition('PENDING_CONFIRM', 'CANCELLED')).not.toThrow();
  });

  it('非法转换(含自环)被 409 拦截', () => {
    // 跳步: 待确认直接签收
    expectRejects(() => assertOrderTransition('PENDING_CONFIRM', 'SIGNED'), '不在白名单');
    // 跳步: 待确认直接销账(硬约束)
    expectRejects(() => assertOrderTransition('PENDING_CONFIRM', 'SETTLED'), '不在白名单');
    // 终态再动
    expectRejects(() => assertOrderTransition('SETTLED', 'SIGNED'), '不在白名单');
    expectRejects(() => assertOrderTransition('CANCELLED', 'PENDING_CONFIRM'), '不在白名单');
    expectRejects(() => assertOrderTransition('REJECTED', 'DELIVERING'), '不在白名单');
    // 自环
    expectRejects(() => assertOrderTransition('CONFIRMED', 'CONFIRMED'), '不在白名单');
  });

  it('标签覆盖全部状态且非空', () => {
    for (const s of ALL) {
      expect(Object.keys(ORDER_STATUS_LABELS)).toContain(s);
      expect(ORDER_STATUS_LABELS[s].length).toBeGreaterThan(0);
    }
  });
});

describe('出库单状态机 (OutboundState)', () => {
  // P1-16: VOIDED 移除(Prisma 枚举无此值), 作废=删除拣货单, 状态机对齐 schema
  const ALL = ['PICKING', 'CONFIRMED'] as const satisfies readonly OutboundState[];

  it('主链: 拣货→复核(终态); 无作废状态位', () => {
    expect(OUTBOUND_TRANSITIONS.PICKING).toContain('CONFIRMED');
    expect(OUTBOUND_TRANSITIONS.PICKING).not.toContain('VOIDED');
    expect(OUTBOUND_TRANSITIONS.CONFIRMED).toEqual([]);
  });

  it('硬约束: 已复核(CONFIRMED)后禁任何变更(库存流水 append-only)', () => {
    expect(OUTBOUND_TRANSITIONS.CONFIRMED).toEqual([]);
    expect(() => assertOutboundTransition('CONFIRMED', 'PICKING')).toThrow(ConflictException);
    expect(() => assertOutboundTransition('CONFIRMED', 'CONFIRMED')).toThrow(ConflictException);
  });

  it('非法状态值被白名单拦截(含 VOIDED 残留写入路径)', () => {
    expect(() => assertOutboundTransition('PICKING', 'VOIDED' as never)).toThrow(ConflictException);
    expect(() => assertOutboundTransition('VOIDED' as never, 'PICKING' as never)).toThrow(ConflictException);
  });

  it('合法路径不抛错', () => {
    expect(() => assertOutboundTransition('PICKING', 'CONFIRMED')).not.toThrow();
  });

  it('标签覆盖全部状态', () => {
    for (const s of ALL) {
      expect(OUTBOUND_STATE_LABELS[s]).toBeTruthy();
    }
  });
});

describe('收款单状态机 (PaymentState)', () => {
  const ALL = ['REPORTED', 'CONFIRMED', 'CANCELLED'] as const satisfies readonly PaymentState[];

  it('主链: 上报→确认(核销) / 上报→冲正', () => {
    expect(PAYMENT_TRANSITIONS.REPORTED).toContain('CONFIRMED');
    expect(PAYMENT_TRANSITIONS.REPORTED).toContain('CANCELLED');
  });

  it('硬约束: 确认后走红字冲正(CONFIRMED→CANCELLED), 不可逆回 REPORTED', () => {
    expect(PAYMENT_TRANSITIONS.CONFIRMED).toEqual(['CANCELLED']);
    expect(PAYMENT_TRANSITIONS.CONFIRMED).not.toContain('REPORTED');
    expect(() => assertPaymentTransition('CONFIRMED', 'REPORTED')).toThrow(ConflictException);
  });

  it('冲正(CANCELLED)终态不可逆', () => {
    expect(PAYMENT_TRANSITIONS.CANCELLED).toEqual([]);
    expect(() => assertPaymentTransition('CANCELLED', 'CONFIRMED')).toThrow(ConflictException);
    expect(() => assertPaymentTransition('CANCELLED', 'REPORTED')).toThrow(ConflictException);
  });

  it('合法路径不抛错', () => {
    expect(() => assertPaymentTransition('REPORTED', 'CONFIRMED')).not.toThrow();
    expect(() => assertPaymentTransition('REPORTED', 'CANCELLED')).not.toThrow();
    expect(() => assertPaymentTransition('CONFIRMED', 'CANCELLED')).not.toThrow();
  });

  it('标签覆盖全部状态', () => {
    for (const s of ALL) {
      expect(PAYMENT_STATE_LABELS[s]).toBeTruthy();
    }
  });
});
