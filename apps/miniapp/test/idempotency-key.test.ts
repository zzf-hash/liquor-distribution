import { describe, expect, it } from 'vitest'
import { releaseIdemKey, stableIdemKey } from '../src/services/idempotency'

describe('stable idempotency key', () => {
  it('reuses the key for the same submission and rotates after success or a new payload', () => {
    const scope = 'orders.create.customer.test'
    const first = { source: 'CUSTOMER', lines: [{ productId: 'p1', unit: 'BASE', qty: 2 }] }
    const key = stableIdemKey(scope, first)
    expect(stableIdemKey(scope, first)).toBe(key)

    const changed = { source: 'CUSTOMER', lines: [{ productId: 'p1', unit: 'BASE', qty: 3 }] }
    const next = stableIdemKey(scope, changed)
    expect(next).not.toBe(key)

    releaseIdemKey(scope)
    expect(stableIdemKey(scope, changed)).not.toBe(next)
    releaseIdemKey(scope)
  })
})