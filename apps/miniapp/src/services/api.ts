// 客户端真接口通道（P0-T50/T51）：统一 Taro.request 封装 + 会话 + 购物车持久化。
// 信封约定与 admin 一致（{code:0,data}）；token 存 Taro storage 'ld_token'；
// BASE 从环境变量读（构建时 TARO_APP_API_BASE 注入），默认本机开发后端。
import Taro from '@tarojs/taro'

const BASE: string = process.env.TARO_APP_API_BASE || 'http://127.0.0.1:3000/api'

const TOKEN_KEY = 'ld_token'
const USER_KEY = 'ld_user'
const CART_KEY = 'ld_cart'

export const LOGIN_PAGE = '/pages/customer/login/index'

// ───────────────────────── 展示格式化（Decimal 序列化可能是 string|number） ─────────────────────────

export type Decimalish = string | number

export function toNum(x: Decimalish | null | undefined): number {
  if (x === null || x === undefined) return 0
  return typeof x === 'number' ? x : Number(x)
}

/** ¥1,234.56 */
export function fmtMoney(x: Decimalish | null | undefined): string {
  const n = toNum(x)
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtDate(x: string | null | undefined): string {
  if (!x) return '-'
  const d = new Date(x)
  return Number.isNaN(d.getTime()) ? String(x) : d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function fmtDateTime(x: string | null | undefined): string {
  if (!x) return '-'
  const d = new Date(x)
  return Number.isNaN(d.getTime())
    ? String(x)
    : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function labelOf(map: Record<string, string>, key?: string | null, fallback = '-'): string {
  return (key && map[key]) || fallback
}

// ───────────────────────── 信封与错误 ─────────────────────────

export interface ApiEnvelope<T> {
  code: number
  data?: T
  message?: string
}

/** 携带原始响应体，便于审单预检 422 等场景读取业务数据 */
export class ApiError extends Error {
  readonly status: number
  readonly code: number
  readonly body: ApiEnvelope<unknown> | null

  constructor(message: string, status: number, code: number, body: ApiEnvelope<unknown> | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

/** 下单等写接口幂等键（服务端唯一索引兜底，重试不双写） */
export function genIdemKey(): string {
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// ───────────────────────── 会话（ld_token） ─────────────────────────

export interface LoginResult {
  token: string
  user: { id: string; username: string; name: string; role: string; dataScope: string }
}

export function getToken(): string {
  return String(Taro.getStorageSync(TOKEN_KEY) ?? '')
}

export function isLoggedIn(): boolean {
  return getToken() !== ''
}

export function getUserName(): string {
  return String(Taro.getStorageSync(USER_KEY) ?? '')
}

export function saveSession(login: LoginResult): void {
  Taro.setStorageSync(TOKEN_KEY, login.token)
  Taro.setStorageSync(USER_KEY, login.user?.name ?? '')
}

export function clearSession(): void {
  Taro.removeStorageSync(TOKEN_KEY)
  Taro.removeStorageSync(USER_KEY)
}

// ───────────────────────── 请求通道 ─────────────────────────

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: Record<string, unknown>
  idemKey?: string
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const header: Record<string, string> = {}
  if (opts.body !== undefined) header['Content-Type'] = 'application/json'
  const token = getToken()
  if (token) header['Authorization'] = `Bearer ${token}`
  if (opts.idemKey) header['Idempotency-Key'] = opts.idemKey

  let statusCode = -1
  let envelope: ApiEnvelope<T> | null = null
  try {
    const res = await Taro.request({
      url: `${BASE}${path}`,
      method: opts.method ?? 'GET',
      header,
      data: opts.body,
      timeout: 15000,
    })
    statusCode = res.statusCode
    envelope = (res.data ?? null) as ApiEnvelope<T> | null
  } catch {
    throw new ApiError('网络连接失败，请检查网络后重试', -1, -1, null)
  }

  // B1：token 过期/被吊销 → 清会话回登录页（登录接口本身除外，避免死循环）
  if (statusCode === 401) {
    clearSession()
    if (path !== '/auth/login') Taro.reLaunch({ url: LOGIN_PAGE })
    throw new ApiError('登录已过期，请重新登录', 401, 401, null)
  }
  if (statusCode < 200 || statusCode >= 300 || !envelope || envelope.code !== 0) {
    throw new ApiError(
      envelope?.message || `请求失败（HTTP ${statusCode}）`,
      statusCode,
      envelope?.code ?? statusCode,
      envelope ?? null,
    )
  }
  return envelope.data as T
}

// ───────────────────────── 登录（P0 账密演示，正式微信登录后续版本） ─────────────────────────

export const authApi = {
  login: (username: string, password: string) =>
    request<LoginResult>('/auth/login', { method: 'POST', body: { username, password } }),
}

// ───────────────────────── 商品（GET /shop/products，专属价已解析） ─────────────────────────

export type ShopUnit = 'BASE' | 'MIN'

export const UNIT_LABELS: Record<string, string> = { BASE: '箱', MIN: '瓶' }

export const PRICE_TYPE_LABELS: Record<string, string> = {
  CUSTOMER_EXCLUSIVE: '专属价',
  TIER1: '一批价',
  TIER2: '二批价',
  TERMINAL: '供货价',
  RETAIL: '零售价',
  SPECIAL: '特批价',
  MANUAL: '手工价',
}

export interface ShopProductDTO {
  productId: string
  name: string
  specText?: string | null
  price: Decimalish
  unit: ShopUnit
  priceType: string
}

export const shopApi = {
  products: () => request<{ items: ShopProductDTO[] }>('/shop/products'),
}

// ───────────────────────── 订单（客户 token 自动过滤自己） ─────────────────────────

export interface PageResult<T> {
  items: T[]
  total: number
}

export interface CustomerOrderDTO {
  id: string
  orderNo: string
  status: string
  statusLabel?: string | null
  totalAmount: Decimalish
  lineCount?: number
  createdAt: string
}

export interface CreateOrderResultDTO {
  id: string
  orderNo: string
  status: string
  totalAmount: number
  precheck?: Record<string, unknown>
}

export const ordersApi = {
  mine: (params?: { page?: number; pageSize?: number }) => {
    const qs: string[] = []
    if (params?.page) qs.push(`page=${params.page}`)
    if (params?.pageSize) qs.push(`pageSize=${params.pageSize}`)
    return request<PageResult<CustomerOrderDTO>>(`/orders${qs.length ? `?${qs.join('&')}` : ''}`)
  },
  /** P1-5：customerId 禁传（服务端强制 token 身份），source 固定 CUSTOMER */
  create: (lines: Array<{ productId: string; unit: ShopUnit; qty: number }>) =>
    request<CreateOrderResultDTO>('/orders', {
      method: 'POST',
      body: { source: 'CUSTOMER', lines },
      idemKey: genIdemKey(),
    }),
}

// ───────────────────────── 待结单据（文案红线：只说"待结金额"） ─────────────────────────

export type ArBucket = 'not_due' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90p' | 'disputed'

export interface CustomerReceivableDTO {
  id: string
  sourceType: string
  sourceDocNo: string
  customerName: string
  total: number
  settled: number
  open: number
  dueDate: string
  daysOverdue: number
  disputeFlag: boolean
  bucket: ArBucket
}

export const receivablesApi = {
  /** 客户 token 只返回自己的未归档单据；"已结"（open<=0）由后端支持后自动出现在 items 里 */
  mine: () => request<PageResult<CustomerReceivableDTO>>('/receivables'),
}

// ───────────────────────── 购物车（本地 state + storage 持久化，key=productId+unit） ─────────────────────────

export interface CartItem {
  productId: string
  name: string
  specText?: string | null
  unit: ShopUnit
  price: Decimalish
  priceType: string
  qty: number
}

export function cartKeyOf(productId: string, unit: string): string {
  return `${productId}|${unit}`
}

export function loadCart(): CartItem[] {
  try {
    const raw = Taro.getStorageSync(CART_KEY)
    if (!raw) return []
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(list) ? (list as CartItem[]) : []
  } catch {
    return []
  }
}

export function saveCart(items: CartItem[]): void {
  Taro.setStorageSync(CART_KEY, items)
}

/** 件数合计（购物车角标/结算确认文案用） */
export function cartQty(items: CartItem[]): number {
  return items.reduce((s, it) => s + it.qty, 0)
}
