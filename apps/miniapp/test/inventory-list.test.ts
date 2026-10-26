import { describe, expect, it } from 'vitest'
import { guardRedirect } from '../src/services/route-guard'
import { ROLE_HOME_PAGE } from '../src/config/role-home'
import {
  inventoryCardLines,
  inventoryListQuery,
  inventoryPageCount,
  type InventoryProductRow,
} from '../src/services/inventory-list'

const row: InventoryProductRow = {
  productId: 'p1',
  skuCode: 'SKU0001',
  name: '示例酱香型白酒',
  specText: '500ml×6',
  baseUnit: '箱',
  minUnit: '瓶',
  packSize: 6,
  onHand: 9,
  locations: [
    { location: 'A-01', onHand: 6 },
    { location: 'A-02', onHand: 3 },
  ],
  occupied: 6,
  available: 3,
  threshold: 12,
  alert: true,
}

describe('inventory list', () => {
  it('renders the name, spec, each location, the total and the alert', () => {
    expect(inventoryCardLines(row)).toEqual([
      '示例酱香型白酒',
      '500ml×6',
      'A-01 6 瓶',
      'A-02 3 瓶',
      '合计 9 瓶',
      '预警',
    ])
    expect(inventoryCardLines({
      ...row,
      specText: null,
      locations: [{ location: null, onHand: 9 }],
      alert: false,
    })).toEqual([
      '示例酱香型白酒',
      '未填规格',
      '未填库位 9 瓶',
      '合计 9 瓶',
    ])
  })

  it('sends the keyword and resets the visible page through the query', () => {
    expect(inventoryListQuery('  酱香  ', 1)).toBe('/reports/inventory/products?q=%E9%85%B1%E9%A6%99&page=1&pageSize=20')
    expect(inventoryListQuery('', 1)).toBe('/reports/inventory/products?page=1&pageSize=20')
  })

  it('pages after the first screen', () => {
    expect(inventoryPageCount(41, 20)).toBe(3)
    expect(inventoryPageCount(0, 20)).toBe(1)
    expect(inventoryListQuery('酱香', 2)).toContain('page=2')
  })

  it('keeps the inventory page on the staff side of the guard', () => {
    expect(guardRedirect('CUSTOMER', '/pages/boss/inventory/index')).toBe(ROLE_HOME_PAGE.CUSTOMER)
    expect(guardRedirect('OWNER', '/pages/boss/inventory/index')).toBeNull()
    expect(guardRedirect('CLERK', '/pages/boss/inventory/index')).toBeNull()
    expect(guardRedirect('WAREHOUSE', '/pages/boss/inventory/index')).toBeNull()
    expect(guardRedirect('', '/pages/boss/inventory/index')).toBe('/pages/staff/login/index')
  })
})