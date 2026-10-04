import { ConflictException } from '@nestjs/common';

// P0-03: 出库单状态机(安全评审§3.2 P0-C 四类之一)
// 拣货中→复核出库(终态, 生成库存流水)
// P1-16(2026-10 审查): 状态机原含 VOIDED 态但 Prisma OutboundStatus 枚举只有 PICKING/CONFIRMED,
// 一旦写 VOIDED 落库即非法枚举。作废语义=直接删拣货单(未复核无流水, 无需状态), 状态机对齐 schema。
// 硬约束: 已复核(CONFIRMED)的出库单禁任何变更——库存流水 append-only(B4), 回冲只走新单据
export type OutboundState = 'PICKING' | 'CONFIRMED';

export const OUTBOUND_TRANSITIONS: Readonly<Record<OutboundState, readonly OutboundState[]>> = {
  PICKING: ['CONFIRMED'],
  CONFIRMED: [],
};

export const OUTBOUND_STATE_LABELS: Record<OutboundState, string> = {
  PICKING: '拣货中',
  CONFIRMED: '已复核出库',
};

export function assertOutboundTransition(from: OutboundState, to: OutboundState): void {
  const allowed = OUTBOUND_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new ConflictException(`出库单状态 ${from} → ${to} 不在白名单, 拒绝转换(P0-03/P0-C)`); // 409
  }
}
