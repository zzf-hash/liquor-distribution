/** 下单等写接口幂等键。由页面在一次提交开始时生成，不要在 api 请求里现造。 */
export function genIdemKey(): string {
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export interface IdemSlot {
  fingerprint: string
  key: string
}

/**
 * 把键放进页面 ref。内容不变时复用；内容变了才换新键。
 * 提交成功后调用方把 holder.current 置空，下一次相同内容也会换新键。
 */
export function rememberIdemKey(holder: { current: IdemSlot | null }, payload: unknown): string {
  const fingerprint = JSON.stringify(payload ?? null)
  if (holder.current && holder.current.fingerprint === fingerprint) return holder.current.key
  const key = genIdemKey()
  holder.current = { fingerprint, key }
  return key
}

/** UUID 幂等键：优先 crypto.randomUUID（H5/新基础库），weapp 旧内核回退拼装 */
export function uuid(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return genIdemKey()
}
