import { describe, expect, it } from 'vitest'
import { APP_ROLE, readAppRole } from '../src/config/app-role'
import { homeEntriesForRole } from '../src/config/home-entries'
import { markAsrUnavailable, readAsrUnavailable, shouldFallbackVoiceToText } from '../src/config/asr-fallback'
import {
  CUSTOMER_TABS,
  WAREHOUSE_TABS,
  nativeTabBarFor,
  tabBarAction,
  tabsForAppRole,
  tabsForRuntimeRole,
} from '../src/config/role-tabs'

describe('tabBar by role', () => {
  it('defaults the compiled package to the customer tabs', () => {
    expect(APP_ROLE).toBe('customer')
    expect(readAppRole(undefined)).toBe('customer')
    expect(readAppRole('')).toBe('customer')
    expect(readAppRole('nope')).toBe('customer')
    expect(readAppRole('staff')).toBe('staff')
    expect(tabsForAppRole('customer').map((tab) => tab.text)).toEqual(['首页', '订货', '我的订单', '待结金额'])
    expect(nativeTabBarFor('customer')).toEqual(CUSTOMER_TABS)
    expect(tabsForAppRole('warehouse')).toEqual(WAREHOUSE_TABS)
  })

  it('omits the native tab bar from the staff package', () => {
    expect(tabsForAppRole('staff')).toEqual([])
    expect(nativeTabBarFor('staff')).toBeNull()
    expect(tabBarAction('staff', 'REP', 'pages/salesman/home/index')).toBe('hide-native')
    expect(tabBarAction('staff', 'WAREHOUSE', 'pages/warehouse/outbounds/index')).toBe('hide-native')
    expect(tabBarAction('staff', 'CLERK', 'pages/clerk/orders/index')).toBe('hide-native')
    expect(tabBarAction('staff', 'OWNER', 'pages/boss/dashboard/index')).toBe('hide-native')
    expect(nativeTabBarFor('customer')?.map((tab) => tab.pagePath)).toEqual([
      'pages/index/index',
      'pages/customer/products/index',
      'pages/customer/orders/index',
      'pages/customer/receivables/index',
    ])
  })

  it('sends warehouse staff off customer pages and hides the customer tab bar', () => {
    expect(tabBarAction('customer', 'WAREHOUSE', 'pages/customer/products/index')).toBe('redirect-staff-home')
    expect(tabBarAction('customer', 'WAREHOUSE', 'pages/warehouse/outbounds/index')).toBe('hide-native')
    expect(tabBarAction('warehouse', 'WAREHOUSE', 'pages/warehouse/outbounds/index')).toBe('show-native')
  })

  it('sends a customer account off staff pages', () => {
    expect(tabBarAction('customer', 'CUSTOMER', 'pages/clerk/orders/index')).toBe('redirect-customer-home')
    expect(tabBarAction('customer', 'CUSTOMER', 'pages/customer/products/index')).toBe('show-native')
    expect(tabsForRuntimeRole('REP')?.[0].pagePath).toBe('pages/salesman/home/index')
    expect(CUSTOMER_TABS.some((tab) => tab.pagePath.includes('warehouse'))).toBe(false)
  })
})

describe('customer home entries', () => {
  it('hides voice and photo for customers because those APIs are not available', () => {
    expect(homeEntriesForRole('CUSTOMER')).toEqual(['text'])
    expect(homeEntriesForRole('')).toEqual(['text'])
  })

  it('keeps voice for roles that can create drafts', () => {
    expect(homeEntriesForRole('REP')).toEqual(['voice', 'text'])
    expect(homeEntriesForRole('CLERK')).toContain('voice')
    expect(homeEntriesForRole('OWNER')).toContain('voice')
    expect(homeEntriesForRole('WAREHOUSE')).toEqual(['text'])
  })
})

describe('ASR fallback', () => {
  it('switches to text when the backend says ASR is not configured', () => {
    expect(shouldFallbackVoiceToText('语音转写失败: ASR 未配置(TENCENT_SECRET_ID/SECRET_KEY), 请手敲文字提交')).toBe(true)
    expect(shouldFallbackVoiceToText('网络连接失败')).toBe(false)
  })

  it('remembers the fallback so the next visit starts in text mode', () => {
    const store = new Map<string, string>()
    expect(readAsrUnavailable((key) => store.get(key) ?? '')).toBe(false)
    markAsrUnavailable((key, value) => { store.set(key, value) })
    expect(readAsrUnavailable((key) => store.get(key) ?? '')).toBe(true)
  })
})
