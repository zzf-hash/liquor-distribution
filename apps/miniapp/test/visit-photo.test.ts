import { describe, expect, it } from 'vitest'
import { visitCreateBody } from '../src/services/visit-photo'

describe('visit photo', () => {
  it('omits photoUrl even when a local photo was taken', () => {
    const body = visitCreateBody({
      customerId: 'c1',
      location: '1,2',
      steps: { displayCheck: true },
      notes: '备注',
    })
    expect(body).toEqual({
      customerId: 'c1',
      location: '1,2',
      steps: { displayCheck: true },
      notes: '备注',
    })
    expect(body).not.toHaveProperty('photoUrl')
    expect(JSON.stringify(body)).not.toContain('pending:')
  })
})