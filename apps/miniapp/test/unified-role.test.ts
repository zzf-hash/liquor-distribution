import { describe, expect, it } from 'vitest'
import { ROLE_HOME_PAGE } from '../src/config/role-home'
import {
  SESSION_KEYS,
  clearMemorySession,
  emptySession,
  sessionAfterMe,
  sessionFromLogin,
} from '../src/services/session-cache'
import { guardRedirect, homeForRole, LOGIN_PATH } from '../src/services/route-guard'

describe('role routing follows the backend role', () => {
  it('sends each known role to its own home', () => {
    expect(homeForRole('CUSTOMER')).toBe(ROLE_HOME_PAGE.CUSTOMER)
    expect(homeForRole('REP')).toBe(ROLE_HOME_PAGE.REP)
    expect(homeForRole(' clerk ')).toBe(ROLE_HOME_PAGE.CLERK)
    expect(homeForRole('WAREHOUSE')).toBe(ROLE_HOME_PAGE.WAREHOUSE)
    expect(homeForRole('owner')).toBe(ROLE_HOME_PAGE.OWNER)
    expect(ROLE_HOME_PAGE.CUSTOMER).toBe('/pages/customer/products/index')
    expect(ROLE_HOME_PAGE.REP).toBe('/pages/salesman/home/index')
  })

  it('does not invent a home for an unknown role', () => {
    expect(homeForRole('')).toBeNull()
    expect(homeForRole(null)).toBeNull()
    expect(homeForRole('ADMIN')).toBeNull()
  })

  it('stores the role from the login payload', () => {
    expect(sessionFromLogin({
      token: 'tok',
      user: { id: 'u1', name: '张三', role: 'CUSTOMER' },
    })).toEqual({ token: 'tok', role: 'CUSTOMER', name: '张三', id: 'u1' })
  })
})

describe('cross-role routes bounce to the signed-in home', () => {
  it('sends a customer off every staff page, including a direct H5 url', () => {
    expect(guardRedirect('CUSTOMER', '/pages/salesman/home/index')).toBe(ROLE_HOME_PAGE.CUSTOMER)
    expect(guardRedirect('CUSTOMER', 'pages/clerk/orders/index')).toBe(ROLE_HOME_PAGE.CUSTOMER)
    expect(guardRedirect('CUSTOMER', '#/pages/warehouse/outbounds/index')).toBe(ROLE_HOME_PAGE.CUSTOMER)
    expect(guardRedirect('CUSTOMER', '/pages/boss/dashboard/index?from=url')).toBe(ROLE_HOME_PAGE.CUSTOMER)
    expect(guardRedirect('CUSTOMER', 'pages/customer/products/index')).toBeNull()
    expect(guardRedirect('CUSTOMER', 'pages/index/index')).toBeNull()
  })

  it('sends staff off customer pages back to that role home', () => {
    expect(guardRedirect('REP', '/pages/customer/products/index')).toBe(ROLE_HOME_PAGE.REP)
    expect(guardRedirect('CLERK', '#/pages/index/index')).toBe(ROLE_HOME_PAGE.CLERK)
    expect(guardRedirect('WAREHOUSE', 'pages/customer/cart/index')).toBe(ROLE_HOME_PAGE.WAREHOUSE)
    expect(guardRedirect('OWNER', 'pages/customer/orders/index?x=1')).toBe(ROLE_HOME_PAGE.OWNER)
    expect(guardRedirect('REP', 'pages/salesman/visit/index')).toBeNull()
    expect(guardRedirect('CLERK', 'pages/clerk/order-detail/index')).toBeNull()
  })

  it('lets a guest stay on the landing and login pages only', () => {
    expect(guardRedirect('', 'pages/index/index')).toBeNull()
    expect(guardRedirect(null, LOGIN_PATH)).toBeNull()
    expect(guardRedirect('', 'pages/customer/login/index')).toBeNull()
    expect(guardRedirect('', '/pages/customer/products/index')).toBe(LOGIN_PATH)
    expect(guardRedirect('', '#/pages/salesman/home/index')).toBe(LOGIN_PATH)
  })
})

describe('logout and startup token check', () => {
  it('clears the token and the role cache', () => {
    expect(clearMemorySession()).toEqual(emptySession())
    expect(SESSION_KEYS.token).toBe('ld_token')
    expect(SESSION_KEYS.role).toBe('ld_role')
    expect(Object.values(SESSION_KEYS)).toEqual(['ld_token', 'ld_user', 'ld_role', 'ld_uid'])
  })

  it('sends an invalid cached token back to login and drops the role', () => {
    const next = sessionAfterMe(
      { token: 'expired', role: 'REP', name: '李业务员', id: 'u2' },
      { ok: false, unauthorized: true },
    )
    expect(next.redirectToLogin).toBe(true)
    expect(next.session).toEqual(emptySession())
  })

  it('overwrites the cached role with the role from /auth/me', () => {
    const next = sessionAfterMe(
      { token: 'tok', role: 'CUSTOMER', name: '旧缓存', id: 'u1' },
      { ok: true, user: { id: 'u2', name: '李业务员', role: 'REP' } },
    )
    expect(next.redirectToLogin).toBe(false)
    expect(next.session).toEqual({ token: 'tok', role: 'REP', name: '李业务员', id: 'u2' })
  })

  it('does not validate when there is no token, and keeps the cache if the check cannot connect', () => {
    const cached = { token: 'tok', role: 'CUSTOMER', name: '张三', id: 'u1' }
    expect(sessionAfterMe(emptySession(), { ok: false, unauthorized: true }).redirectToLogin).toBe(false)
    expect(sessionAfterMe(cached, { ok: false, unauthorized: false })).toEqual({
      session: cached,
      redirectToLogin: false,
    })
    expect(sessionAfterMe(cached, { ok: true, user: { role: '  ' } }).redirectToLogin).toBe(true)
  })
})
