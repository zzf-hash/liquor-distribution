// 登录失败计数(单进程内存)。按用户名逐步变慢, 按 IP 只告警。
// 多实例部署应换成 Redis; 这里与原先的单实例窗口一致。

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** 超过这个次数后, 该用户名的每次失败延迟 1s 起、逐步到 3s。不返回 429, 不锁死账号。 */
export const LOGIN_FAIL_THRESHOLD = 10;
/** 同一 IP 在窗口内失败超过这个次数: 打日志并发告警, 不延迟、不拒绝。 */
export const IP_ALERT_THRESHOLD = 50;

export function loginDelayMs(failCount: number): number {
  if (failCount <= LOGIN_FAIL_THRESHOLD) return 0;
  const over = failCount - LOGIN_FAIL_THRESHOLD;
  return Math.min(3000, 1000 + (over - 1) * 200);
}

export interface LoginPenalty {
  delayMs: number;
  userCount: number;
  ipCount: number;
  alertUser: boolean;
  alertIp: boolean;
}

type Bucket = { count: number; firstAt: number; alerted: boolean };

export class LoginThrottle {
  private readonly byUser = new Map<string, Bucket>();
  private readonly byIp = new Map<string, Bucket>();
  /** 测试可替换, 避免真的睡 1–3 秒。生产用 setTimeout。 */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  reset(): void {
    this.byUser.clear();
    this.byIp.clear();
  }

  userCount(key: string): number {
    return this.byUser.get(key)?.count ?? 0;
  }

  noteFailure(userKey: string, ip?: string): LoginPenalty {
    this.prune();
    const now = Date.now();
    const user = this.bump(this.byUser, userKey, now);
    const ipBucket = ip ? this.bump(this.byIp, ip, now) : undefined;
    const alertUser = user.count > LOGIN_FAIL_THRESHOLD && !user.alerted;
    if (alertUser) user.alerted = true;
    const alertIp = Boolean(ipBucket && ipBucket.count > IP_ALERT_THRESHOLD && !ipBucket.alerted);
    if (alertIp && ipBucket) ipBucket.alerted = true;
    return {
      delayMs: loginDelayMs(user.count),
      userCount: user.count,
      ipCount: ipBucket?.count ?? 0,
      alertUser,
      alertIp,
    };
  }

  clearUser(userKey: string): void {
    this.byUser.delete(userKey);
  }

  private bump(map: Map<string, Bucket>, key: string, now: number): Bucket {
    const cur = map.get(key);
    if (!cur || now - cur.firstAt >= LOGIN_WINDOW_MS) {
      const fresh: Bucket = { count: 1, firstAt: now, alerted: false };
      map.set(key, fresh);
      return fresh;
    }
    cur.count += 1;
    return cur;
  }

  private prune(): void {
    if (this.byUser.size + this.byIp.size < 5000) return;
    const now = Date.now();
    for (const [key, bucket] of this.byUser) {
      if (now - bucket.firstAt >= LOGIN_WINDOW_MS) this.byUser.delete(key);
    }
    for (const [key, bucket] of this.byIp) {
      if (now - bucket.firstAt >= LOGIN_WINDOW_MS) this.byIp.delete(key);
    }
  }
}

export const loginThrottle = new LoginThrottle();

export function loginUserKey(tenantCode: string | undefined, username: string): string {
  return `${tenantCode ?? '-'}|${username}`;
}
