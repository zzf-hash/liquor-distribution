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

/** 近 n 个月份（YYYY-MM，当月开始、新→旧）；月份下拉数据源（不引 dayjs 直依赖） */
export function recentMonths(n = 18): string[] {
  const out: string[] = [];
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth(); // 0-based
  for (let i = 0; i < n; i += 1) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  return out;
}

/** 当月（YYYY-MM）；绩效/返利核算的默认期间 */
export function currentMonth(): string {
  return recentMonths(1)[0];
}
