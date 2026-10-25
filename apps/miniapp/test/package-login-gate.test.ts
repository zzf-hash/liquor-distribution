import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_PACKAGE_STAFF_TOAST,
  STAFF_PACKAGE_CUSTOMER_TOAST,
  loggedOutLoginPage,
  loginBlock,
  storedCustomerOnStaffPackage,
} from '../src/services/package-login-gate'

describe('staff package rejects customer accounts', () => {
  it('blocks a CUSTOMER login without keeping the session', () => {
    expect(loginBlock('staff', 'CUSTOMER', 'staff')).toEqual({
      toast: STAFF_PACKAGE_CUSTOMER_TOAST,
      clearSession: true,
    })
    expect(STAFF_PACKAGE_CUSTOMER_TOAST).toBe('请使用客户端')
    expect(loginBlock('staff', ' customer ', 'staff')?.clearSession).toBe(true)
    expect(loginBlock('staff', 'CUSTOMER', 'customer')?.clearSession).toBe(true)
  })

  it('clears a stored customer token when the staff package starts', () => {
    expect(storedCustomerOnStaffPackage('staff', 'CUSTOMER')).toBe(true)
    expect(storedCustomerOnStaffPackage('staff', ' customer ')).toBe(true)
    expect(loggedOutLoginPage('staff')).toBe('/pages/staff/login/index')
  })

  it('still admits staff roles on the staff package', () => {
    expect(loginBlock('staff', 'REP', 'staff')).toBeNull()
    expect(loginBlock('staff', 'CLERK', 'staff')).toBeNull()
    expect(loginBlock('staff', 'WAREHOUSE', 'staff')).toBeNull()
    expect(loginBlock('staff', 'OWNER', 'staff')).toBeNull()
    expect(storedCustomerOnStaffPackage('staff', 'REP')).toBe(false)
    expect(storedCustomerOnStaffPackage('staff', '')).toBe(false)
    expect(storedCustomerOnStaffPackage('staff', null)).toBe(false)
  })
})

describe('customer package login is unchanged', () => {
  it('lets a customer through the staff login door and the customer login door', () => {
    expect(loginBlock('customer', 'CUSTOMER', 'staff')).toBeNull()
    expect(loginBlock('customer', 'CUSTOMER', 'customer')).toBeNull()
    expect(storedCustomerOnStaffPackage('customer', 'CUSTOMER')).toBe(false)
    expect(loggedOutLoginPage('customer')).toBe('/pages/customer/login/index')
  })

  it('keeps rejecting staff accounts on the customer login door without clearing a session', () => {
    expect(loginBlock('customer', 'REP', 'customer')).toEqual({
      toast: CUSTOMER_PACKAGE_STAFF_TOAST,
      clearSession: false,
    })
    expect(CUSTOMER_PACKAGE_STAFF_TOAST).toBe('该账号不是客户账号，请联系商家开通')
    expect(loginBlock('customer', 'WAREHOUSE', 'customer')?.clearSession).toBe(false)
    expect(loginBlock('customer', '', 'customer')?.toast).toBe(CUSTOMER_PACKAGE_STAFF_TOAST)
    expect(loginBlock('customer', 'REP', 'staff')).toBeNull()
  })
})
