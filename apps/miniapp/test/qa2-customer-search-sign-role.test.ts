import { describe, expect, it } from 'vitest'
import { ROLE_HOME_PAGE } from '../src/services/api'
import { staffHomeOffCustomerPage } from '../src/services/customer-page-guard'
import { productSearchOnConfirm, productSearchOnInput } from '../src/services/product-search'
import { bumpReceivedQty, receivedQtyForSubmit } from '../src/services/sign-qty'

describe('product search', () => {
  it('confirms with the event value instead of a stale keyword', () => {
    expect(productSearchOnConfirm('茅台')).toBe('茅台')
    expect(productSearchOnConfirm('')).toBe('')
  })

  it('reloads immediately when the input is cleared and waits otherwise', () => {
    expect(productSearchOnInput('')).toEqual({ keyword: '', loadNow: '' })
    expect(productSearchOnInput('茅')).toEqual({ keyword: '茅', loadNow: null })
    expect(productSearchOnInput('  ')).toEqual({ keyword: '  ', loadNow: null })
  })
})

describe('sign received qty', () => {
  it('keeps a typed decimal and submits three decimal places inside 0..net', () => {
    expect(receivedQtyForSubmit('1.5', 10)).toBe(1.5)
    expect(receivedQtyForSubmit('1.2346', 10)).toBe(1.235)
    expect(receivedQtyForSubmit('0', 5)).toBe(0)
    expect(receivedQtyForSubmit('1.5', 1.5)).toBe(1.5)
    expect(receivedQtyForSubmit('', 5)).toBe(0)
  })

  it('rejects quantities outside 0..net', () => {
    expect(receivedQtyForSubmit('-0.1', 5)).toBeNull()
    expect(receivedQtyForSubmit('5.1', 5)).toBeNull()
    expect(receivedQtyForSubmit('1.5004', 1.5)).toBeNull()
    expect(receivedQtyForSubmit('abc', 5)).toBeNull()
  })

  it('steps by 1 and clamps to 0..net at three decimals', () => {
    expect(bumpReceivedQty('1.5', 10, 1)).toBe('2.5')
    expect(bumpReceivedQty('0.4', 10, -1)).toBe('0')
    expect(bumpReceivedQty('9.5', 10, 1)).toBe('10')
    expect(bumpReceivedQty('10', 10, 1)).toBe('10')
    expect(bumpReceivedQty('0.001', 10, 1)).toBe('1.001')
    expect(bumpReceivedQty('abc', 3, 1)).toBe('3')
  })
})

describe('staff off customer pages', () => {
  it('sends each staff role home from a customer page', () => {
    expect(staffHomeOffCustomerPage('WAREHOUSE', 'pages/customer/products/index')).toBe(ROLE_HOME_PAGE.WAREHOUSE)
    expect(staffHomeOffCustomerPage('rep', '/pages/customer/cart/index?from=hash')).toBe(ROLE_HOME_PAGE.REP)
    expect(staffHomeOffCustomerPage('CLERK', 'pages/customer/orders/index')).toBe(ROLE_HOME_PAGE.CLERK)
    expect(staffHomeOffCustomerPage('OWNER', 'pages/customer/receivables/index')).toBe(ROLE_HOME_PAGE.OWNER)
    expect(ROLE_HOME_PAGE.WAREHOUSE).toBe('/pages/warehouse/outbounds/index')
    expect(ROLE_HOME_PAGE.REP).toBe('/pages/salesman/home/index')
    expect(ROLE_HOME_PAGE.CLERK).toBe('/pages/clerk/orders/index')
    expect(ROLE_HOME_PAGE.OWNER).toBe('/pages/boss/dashboard/index')
  })

  it('leaves customers, logged-out users, and the customer login page alone', () => {
    expect(staffHomeOffCustomerPage('CUSTOMER', 'pages/customer/products/index')).toBeNull()
    expect(staffHomeOffCustomerPage('', 'pages/customer/products/index')).toBeNull()
    expect(staffHomeOffCustomerPage(null, 'pages/customer/products/index')).toBeNull()
    expect(staffHomeOffCustomerPage('WAREHOUSE', 'pages/customer/login/index')).toBeNull()
    expect(staffHomeOffCustomerPage('WAREHOUSE', 'pages/warehouse/sign/index')).toBeNull()
    expect(staffHomeOffCustomerPage('ADMIN', 'pages/customer/products/index')).toBeNull()
  })
})
