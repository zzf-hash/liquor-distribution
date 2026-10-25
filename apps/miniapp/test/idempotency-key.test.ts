import { describe, expect, it } from 'vitest'
import { rememberIdemKey } from '../src/services/idempotency'
import type { IdemSlot } from '../src/services/idempotency'

describe('page idempotency key', () => {
  it('reuses the key for the same submission and rotates after success or a new payload', () => {
    const holder: { current: IdemSlot | null } = { current: null }
    const first = { source: 'CUSTOMER', lines: [{ productId: 'p1', unit: 'BASE', qty: 2 }] }
    const key = rememberIdemKey(holder, first)
    expect(rememberIdemKey(holder, first)).toBe(key)

    const changed = { source: 'CUSTOMER', lines: [{ productId: 'p1', unit: 'BASE', qty: 3 }] }
    const next = rememberIdemKey(holder, changed)
    expect(next).not.toBe(key)

    holder.current = null
    expect(rememberIdemKey(holder, changed)).not.toBe(next)
  })
})
