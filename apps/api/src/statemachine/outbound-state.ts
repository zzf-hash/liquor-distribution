import { ConflictException } from '@nestjs/common';

// P0-03: 出库单状态机(安全评审§3.2 P0-C 四类之一)
// 拣货中→复核出库(终态, 生成库存流水) / 作废(拣货阶段未复核, 红字留痕)
// 硬约束: 已复核(CONFIRMED)的出库单禁任何变更——库存流水 append-only(B4), 回冲只走新单据
export type OutboundState = 'PICKING' | 'CONFIRMED' | 'VOIDED';

export const OUTBOUND_TRANSITIONS: Readonly<Record<OutboundState, readonly OutboundState[]>> = {
  PICKING: ['CONFIRMED', 'VOIDED'],
  CONFIRMED: [],
  VOIDED: [],
};

export const OUTBOUND_STATE_LABELS: Record<OutboundState, string> = {
  PICKING: '拣货中',
  CONFIRMED: '已复核出库',
  VOIDED: '已作废(未复核红字)',
};

export function assertOutboundTransition(from: OutboundState, to: OutboundState): void {
  const allowed = OUTBOUND_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new ConflictException(`出库单状态 ${from} → ${to} 不在白名单, 拒绝转换(P0-03/P0-C)`); // 409
  }
}
