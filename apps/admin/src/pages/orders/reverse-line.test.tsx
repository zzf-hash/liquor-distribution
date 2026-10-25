import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrderLineDTO } from '../../services/api'
import { ReverseLineModal, canReverseLine, netLineQty } from './reverse-line'

function line(partial: Partial<OrderLineDTO> & Pick<OrderLineDTO, 'id' | 'qty'>): OrderLineDTO {
  return {
    productId: 'p1',
    productName: '飞天',
    unit: 'BASE',
    conversionRate: 6,
    unitPrice: 100,
    amount: 100,
    priceType: 'TERMINAL',
    isGift: false,
    createdAt: '2026-10-25T00:00:00.000Z',
    ...partial,
  }
}

describe('canReverseLine', () => {
  const original = line({ id: 'l1', qty: 4 })
  const reversal = line({ id: 'l2', qty: -1, reversalOfId: 'l1' })

  it('allows clerk to reverse a confirmed original line for the remaining quantity', () => {
    expect(netLineQty([original, reversal], original)).toBe(3)
    expect(canReverseLine('CONFIRMED', 'clerk', [original, reversal], original)).toBe(true)
    expect(canReverseLine('CONFIRMED', 'clerk', [original, reversal], reversal)).toBe(false)
  })

  it('blocks warehouse and orders that already left the warehouse', () => {
    expect(canReverseLine('CONFIRMED', 'warehouse', [original], original)).toBe(false)
    expect(canReverseLine('DELIVERING', 'owner', [original], original)).toBe(false)
  })
})

describe('ReverseLineModal', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('requires a reason before calling the reverse API', async () => {
    const onSubmit = vi.fn()
    render(
      <ReverseLineModal
        open
        productName="飞天"
        maxQty={3}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '确认冲销' }))
    expect(await screen.findByText('请填写冲销原因')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits quantity and reason', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <ReverseLineModal
        open
        productName="飞天"
        maxQty={3}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('冲销原因（必填）'), { target: { value: '客户改单' } })
    fireEvent.click(screen.getByRole('button', { name: '确认冲销' }))
    expect(onSubmit).toHaveBeenCalledWith(3, '客户改单')
  })
})
