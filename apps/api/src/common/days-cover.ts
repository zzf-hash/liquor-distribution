/**
 * 可售天数 = 可用库存 / 窗口内日均出库。
 * 没有出库时返回 null（前端显示「-」），可用量≤0 时为 0。
 */
export function daysCoverOf(available: number, soldInWindow: number, windowDays: number): number | null {
  if (!Number.isFinite(available)) return null;
  if (available <= 0) return 0;
  if (!(windowDays > 0) || !(soldInWindow > 0) || !Number.isFinite(soldInWindow)) return null;
  const days = available / (soldInWindow / windowDays);
  return Math.round(days * 10) / 10;
}

/** 看板低库存用的出库窗口（自然日，与种子 7 日动销对齐）。 */
export const LOW_STOCK_COVER_WINDOW_DAYS = 7;
