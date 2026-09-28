import { ConflictException } from '@nestjs/common';

// P0-03: 收款单状态机(安全评审§3.2 P0-C 四类之一)
// 上报(业务员F9①)→录入确认(内勤F9②, 同事务写应收流水 SETTLE+销账) / 冲正(红字, 禁改原单)
// 硬约束: CONFIRMED 后禁任何字段变更(B4 append-only); 差错走 CONFIRMED→CANCELLED 红字冲正(新 REVERSAL 流水, 原单冻结, 全审计)
export type PaymentState = 'REPORTED' | 'CONFIRMED' | 'CANCELLED';

export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  REPORTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CANCELLED'], // 红字冲正(§3.2 P0-C: 禁直改, 走 CANCELLED 冻结原单+红字流水); 不可逆回 REPORTED
  CANCELLED: [],
};

export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  REPORTED: '已上报(待内勤确认)',
  CONFIRMED: '已确认(核销流水已写)',
  CANCELLED: '已冲正(红字, 原单冻结)',
};

export function assertPaymentTransition(from: PaymentState, to: PaymentState): void {
  const allowed = PAYMENT_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new ConflictException(`收款单状态 ${from} → ${to} 不在白名单, 拒绝转换(P0-03/P0-C)`); // 409
  }
}
