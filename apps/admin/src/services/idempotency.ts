export interface IdemSlot {
  fingerprint: string;
  key: string;
}

/** 资金/库存写接口幂等键。页面在提交开始时调用，api 方法只接收已经生成的键。 */
export function genIdemKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 内容不变时复用 holder 里的键。成功后把 holder.current 置空，下一次再换新键。 */
export function rememberIdemKey(holder: { current: IdemSlot | null }, payload: unknown): string {
  const fingerprint = JSON.stringify(payload ?? null);
  if (holder.current && holder.current.fingerprint === fingerprint) return holder.current.key;
  const key = genIdemKey();
  holder.current = { fingerprint, key };
  return key;
}
