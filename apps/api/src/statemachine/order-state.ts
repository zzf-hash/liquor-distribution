import { ConflictException } from '@nestjs/common';

// P0-C 统一状态机(安全评审§3.2): 转换白名单集中定义, 业务路由禁止裸 UPDATE status
// 待确认→已确认→出库→配送→签收→销账 / 取消 / 拒收
// 硬约束: 未签收不可销账(白名单保证, 无绕行路径)
export type OrderStatus =
  | 'PENDING_CONFIRM' // 待确认
  | 'CONFIRMED' // 已确认(待出库; 信用在途占用口径, D07)
  | 'OUTBOUND' // 已出库
  | 'DELIVERING' // 配送中
  | 'SIGNED' // 已签收(应收已生成)
  | 'SETTLED' // 已销账(终态)
  | 'CANCELLED' // 取消(配送前, 终态)
  | 'REJECTED'; // 拒收(库存回冲, 终态)

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING_CONFIRM: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['OUTBOUND', 'CANCELLED'],
  OUTBOUND: ['DELIVERING'],
  DELIVERING: ['SIGNED', 'REJECTED'],
  SIGNED: ['SETTLED'],
  SETTLED: [],
  CANCELLED: [],
  REJECTED: [],
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING_CONFIRM: '待确认',
  CONFIRMED: '已确认',
  OUTBOUND: '已出库',
  DELIVERING: '配送中',
  SIGNED: '已签收',
  SETTLED: '已销账',
  CANCELLED: '已取消',
  REJECTED: '已拒收',
};

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  const allowed = ORDER_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new ConflictException(`订单状态 ${from} → ${to} 不在白名单, 拒绝转换(P0-C)`); // 409
  }
}

// 非法转换留审计由调用方负责(catch 之前调 audit)
