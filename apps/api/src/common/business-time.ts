import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

/** 业务日历。单号日期、账期起止、看板「今日」都按此时区，不跟服务器本地时区走。 */
export const BUSINESS_TZ = 'Asia/Shanghai';

function asBiz(input?: dayjs.ConfigType): dayjs.Dayjs {
  return input === undefined ? dayjs().tz(BUSINESS_TZ) : dayjs(input).tz(BUSINESS_TZ);
}

/** 当前时刻，墙钟为 Asia/Shanghai。 */
export function bizNow(): dayjs.Dayjs {
  return dayjs().tz(BUSINESS_TZ);
}

/** 业务日 YYYYMMDD（单号用）。 */
export function bizDayStamp(input?: dayjs.ConfigType): string {
  return asBiz(input).format('YYYYMMDD');
}

/** 业务日 YYYY-MM-DD。 */
export function bizDateKey(input?: dayjs.ConfigType): string {
  return asBiz(input).format('YYYY-MM-DD');
}

/** 业务月 YYYY-MM。 */
export function bizMonthKey(input?: dayjs.ConfigType): string {
  return asBiz(input).format('YYYY-MM');
}

/** 上一业务月。日切默认核算「上月」用这个，而不是服务器本地月。 */
export function bizPrevMonthKey(input?: dayjs.ConfigType): string {
  return asBiz(input).subtract(1, 'month').format('YYYY-MM');
}

/**
 * YYYY-MM 业务月的起止瞬间（含首尾）。
 * 2026-10 在上海是 [2026-09-30T16:00:00.000Z, 2026-10-31T15:59:59.999Z]。
 */
export function bizMonthRange(period: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error(`业务月格式须为 YYYY-MM，收到 ${period}`);
  }
  const start = dayjs.tz(`${period}-01 00:00:00.000`, 'YYYY-MM-DD HH:mm:ss.SSS', BUSINESS_TZ);
  return { start: start.toDate(), end: start.endOf('month').toDate() };
}

export function bizStartOfDay(input?: dayjs.ConfigType): Date {
  return asBiz(input).startOf('day').toDate();
}

export function bizEndOfDay(input?: dayjs.ConfigType): Date {
  return asBiz(input).endOf('day').toDate();
}

export function bizStartOfMonth(input?: dayjs.ConfigType): Date {
  return asBiz(input).startOf('month').toDate();
}

/**
 * 上海日历日差：to 的日期 − from 的日期。to 缺省为现在。
 * 正数表示 from 早于 to（到期日已过则为正的逾期天数）。
 */
export function bizDayDiff(from: dayjs.ConfigType, to?: dayjs.ConfigType): number {
  const a = dayjs(from).tz(BUSINESS_TZ).startOf('day');
  const b = asBiz(to).startOf('day');
  return b.diff(a, 'day');
}

/**
 * 把业务日写成 UTC 零点，给 Prisma `@db.Date` 用。
 * 驱动按 UTC 的年月日落 DATE；若改用上海零点，UTC 日期会落到前一天。
 */
export function bizDateUtc(input?: dayjs.ConfigType): Date {
  return dateKeyUtc(bizDateKey(input));
}

export function dateKeyUtc(yyyyMmDd: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) {
    throw new Error(`日期格式须为 YYYY-MM-DD，收到 ${yyyyMmDd}`);
  }
  return new Date(`${yyyyMmDd}T00:00:00.000Z`);
}

/** 读回 `@db.Date`（UTC 零点）对应的业务日。 */
export function formatDbDate(input: dayjs.ConfigType): string {
  return dayjs(input).utc().format('YYYY-MM-DD');
}
