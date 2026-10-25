/** 下单等写接口幂等键（服务端唯一索引兜底，重试不双写） */
export function genIdemKey(): string {
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 同一次提交复用同一个 Idempotency-Key，失败重试不换键。
 * 请求体变化，或成功后 releaseIdemKey，下一次提交才换新键。
 * 合法的重复订货必须换键，不能按商品内容去重。
 */
const heldIdemKeys = new Map<string, { fingerprint: string; key: string }>()

export function stableIdemKey(scope: string, payload: unknown): string {
  const fingerprint = JSON.stringify(payload)
  const held = heldIdemKeys.get(scope)
  if (held && held.fingerprint === fingerprint) return held.key
  const key = genIdemKey()
  heldIdemKeys.set(scope, { fingerprint, key })
  return key
}

export function releaseIdemKey(scope: string): void {
  heldIdemKeys.delete(scope)
}

/** UUID 幂等键：优先 crypto.randomUUID（H5/新基础库），weapp 旧内核回退拼装 */
export function uuid(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return genIdemKey()
}
