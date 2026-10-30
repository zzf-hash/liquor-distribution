import { describe, expect, it } from 'vitest'
import { homeEntriesForRole } from '../src/config/home-entries'
import { markAsrUnavailable, readAsrUnavailable, shouldFallbackVoiceToText } from '../src/config/asr-fallback'
import {
  CUSTOMER_TABS,
  WAREHOUSE_TABS,
  nativeTabBarFor,
  tabBarAction,
  tabsForRuntimeRole,
} from '../src/config/role-tabs'

describe('tabBar by role', () => {
  it('keeps one runtime tab list per role and does not emit a native tab bar', () => {
    expect(nativeTabBarFor('customer')).toBeNull()
    expect(nativeTabBarFor('staff')).toBeNull()
    expect(nativeTabBarFor('warehouse')).toBeNull()
    expect(tabsForRuntimeRole('CUSTOMER')).toEqual(CUSTOMER_TABS)
    expect(tabsForRuntimeRole('WAREHOUSE')).toEqual(WAREHOUSE_TABS)
    expect(tabsForRuntimeRole('CUSTOMER')?.map((tab) => tab.text)).toEqual(['首页', '订货', '我的订单', '待结金额'])
    expect(tabsForRuntimeRole('CLERK')?.map((tab) => tab.text)).toEqual(['首页', '订单', '收款', '客户欠款'])
    expect(tabsForRuntimeRole('OWNER')?.map((tab) => tab.text)).toEqual(['首页', '看板', '待审批', '订单'])
    expect(tabsForRuntimeRole('CUSTOMER')?.map((tab) => tab.pagePath)).toEqual([
      'pages/index/index',
      'pages/customer/products/index',
      'pages/customer/orders/index',
      'pages/customer/receivables/index',
    ])
  })

  it('still hides the customer tab set when the signed-in role is staff', () => {
    expect(tabBarAction('customer', 'REP', 'pages/salesman/home/index')).toBe('hide-native')
    expect(tabBarAction('staff', 'WAREHOUSE', 'pages/warehouse/outbounds/index')).toBe('hide-native')
    expect(tabBarAction('staff', 'CLERK', 'pages/clerk/orders/index')).toBe('hide-native')
    expect(tabBarAction('staff', 'OWNER', 'pages/boss/dashboard/index')).toBe('hide-native')
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
