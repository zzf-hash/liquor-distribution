/** 步进 ±1。结果夹在 0 到净量，并按 3 位小数对齐。当前值非法时从净量起算。 */
export function bumpReceivedQty(current: string, net: number, delta: number): string {
  const cur = Number(current)
  const base = Number.isFinite(cur) ? cur : net
  const next = Math.min(net, Math.max(0, Math.round((base + delta) * 1000) / 1000))
  return String(next)
}

/**
 * 提交实收。允许小数；须为有限数且在 0 到净量之间。
 * 按原签收逻辑保留 3 位小数。非法返回 null，由页面提示，不提交。
 */
/**
 * 行尾文案。实收小于净量是拒收；等于净量是足额。
 * 实收大于净量时不显示「足额」（提交仍会被拦住）。
 */
export function receivedQtyTail(raw: string, net: number): string {
  const actual = Number(raw || 0)
  if (Number.isFinite(actual) && actual > net) return ''
  const rejected = net - actual
  return rejected > 0 ? `拒收 ${rejected}` : '足额'
}

export function receivedQtyForSubmit(raw: string, net: number): number | null {
  const actual = Number(raw)
  if (!Number.isFinite(actual) || actual < 0 || actual > net) return null
  return Number(actual.toFixed(3))
}
