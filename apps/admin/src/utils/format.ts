// 展示格式化：金额 ¥ 千分位两位小数；Decimal 经 JSON 序列化可能是 string|number
export type Decimalish = string | number;

export function toNum(x: Decimalish | null | undefined): number {
  if (x === null || x === undefined) return 0;
  return typeof x === 'number' ? x : Number(x);
}

/** ¥1,234.56；负数（红字冲销行）由调用方决定配色 */
export function fmtMoney(x: Decimalish | null | undefined): string {
  const n = toNum(x);
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtDateTime(x: string | Date | null | undefined): string {
  if (!x) return '-';
  const d = typeof x === 'string' ? new Date(x) : x;
  if (Number.isNaN(d.getTime())) return String(x);
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function fmtDate(x: string | Date | null | undefined): string {
  if (!x) return '-';
  const d = typeof x === 'string' ? new Date(x) : x;
  if (Number.isNaN(d.getTime())) return String(x);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
