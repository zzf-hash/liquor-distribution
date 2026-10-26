/** GET /reports/inventory/products 的现有字段。合计是各库位在库相加。 */
export interface InventoryLocationQty {
  location: string | null
  onHand: number
}

export interface InventoryProductRow {
  productId: string
  skuCode: string
  name: string
  specText: string | null
  baseUnit: string
  minUnit: string
  packSize: number
  onHand: number
  locations: InventoryLocationQty[]
  occupied: number
  available: number
  threshold: number
  alert: boolean
}

export interface InventoryProductList {
  items: InventoryProductRow[]
  total: number
  page: number
  pageSize: number
  threshold: number
  generatedAt: string
}

export function inventoryListQuery(q: string, page: number, pageSize = 20): string {
  const params = [`page=${page}`, `pageSize=${pageSize}`]
  const keyword = q.trim()
  if (keyword) params.unshift(`q=${encodeURIComponent(keyword)}`)
  return `/reports/inventory/products?${params.join('&')}`
}

export function inventoryPageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

/** 空库位不编仓库名。 */
export function locationLabel(location: string | null | undefined): string {
  const text = (location ?? '').trim()
  return text || '未填库位'
}

export function inventorySpecLabel(row: Pick<InventoryProductRow, 'specText'>): string {
  const text = (row.specText ?? '').trim()
  return text || '未填规格'
}

/** 列表卡片上要出现的字：名称、规格、各库位、合计、预警。 */
export function inventoryCardLines(row: InventoryProductRow): string[] {
  const places = row.locations.length === 0
    ? ['没有批次']
    : row.locations.map((place) => `${locationLabel(place.location)} ${place.onHand} ${row.minUnit}`)
  return [
    row.name,
    inventorySpecLabel(row),
    ...places,
    `合计 ${row.onHand} ${row.minUnit}`,
    row.alert ? '预警' : '',
  ].filter((line) => line !== '')
}
