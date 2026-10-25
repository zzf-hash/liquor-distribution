import { describe, expect, it } from 'vitest';
import { rememberIdemKey } from './idempotency';
import type { IdemSlot } from './idempotency';

describe('page idempotency key', () => {
  it('reuses the key for the same submission and rotates after success or a new payload', () => {
    const holder: { current: IdemSlot | null } = { current: null };
    const first = { customerId: 'c1', amount: 10, method: '转账' };
    const key = rememberIdemKey(holder, first);
    expect(rememberIdemKey(holder, first)).toBe(key);

    const changed = { customerId: 'c1', amount: 12, method: '转账' };
    const next = rememberIdemKey(holder, changed);
    expect(next).not.toBe(key);

    holder.current = null;
    expect(rememberIdemKey(holder, changed)).not.toBe(next);
  });
});