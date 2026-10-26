// 客户端真接口通道（P0-T50/T51）：统一 Taro.request 封装 + 会话 + 购物车持久化。
// 信封约定与 admin 一致（{code:0,data}）；token 存 Taro storage 'ld_token'；
// BASE 从环境变量读（构建时 TARO_APP_API_BASE 注入），默认本机开发后端。
import Taro from '@tarojs/taro'
import { inventoryListQuery, type InventoryProductList } from './inventory-list'
import { SESSION_KEYS, clearConfirmedRole, sessionFromLogin, setConfirmedRole, type MemorySession } from './session-cache'
import { reportError, trackEvent } from './telemetry'

const BASE: string = process.env.TARO_APP_API_BASE || 'http://127.0.0.1:3000/api'
export { BASE }

const TOKEN_KEY = SESSION_KEYS.token
const USER_KEY = SESSION_KEYS.name
const ROLE_KEY = SESSION_KEYS.role
const UID_KEY = SESSION_KEYS.id
const CART_KEY = 'ld_cart'

// P1 全员端：登录入口统一到员工登录页（五角色共用，按 role 分发首页）
export const LOGIN_PAGE = '/pages/staff/login/index'

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

/** 登录角色（大写枚举：OWNER/CLERK/REP/WAREHOUSE/CUSTOMER），员工端按钮显隐用 */
export function getRole(): string {
  return String(Taro.getStorageSync(ROLE_KEY) ?? '')
}

export function getUserId(): string {
  return String(Taro.getStorageSync(UID_KEY) ?? '')
}

export function readSession(): MemorySession {
  return {
    token: getToken(),
    role: getRole(),
    name: getUserName(),
    id: getUserId(),
  }
}

export function writeSession(session: MemorySession): void {
  Taro.setStorageSync(TOKEN_KEY, session.token)
  Taro.setStorageSync(USER_KEY, session.name)
  Taro.setStorageSync(ROLE_KEY, session.role)
  Taro.setStorageSync(UID_KEY, session.id)
  setConfirmedRole(session.role)
}

export function saveSession(login: LoginResult): void {
  writeSession(sessionFromLogin(login))
}

export function clearSession(): void {
  Taro.removeStorageSync(TOKEN_KEY)
  Taro.removeStorageSync(USER_KEY)
  Taro.removeStorageSync(ROLE_KEY)
  Taro.removeStorageSync(UID_KEY)
  clearConfirmedRole()
}

/** 角色首页路由表（统一登录后按 role 自动跳转）。定义在 config/role-home.ts。 */
export { ROLE_HOME_PAGE } from '../config/role-home'

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
  } catch (e) {
    reportError('request_network_fail', { path, method: opts.method ?? 'GET' }, 'error')
    throw new ApiError('网络连接失败，请检查网络后重试', -1, -1, null)
  }

  // B1：401 分两类，文案必须区分，否则排查被误导
  if (statusCode === 401) {
    if (path === '/auth/login') {
      // 登录即 401 = 账号/密码错（或该库无此账号）——不是"过期"。
      // 常见诱因：devtools 打的不是线上后端（本地后端 JWT 密钥/库与线上不一致）
      throw new ApiError('账号或密码错误', 401, 401, null)
    }
    // 带 token 的受保护接口 401 = token 过期/被吊销/与当前后端密钥不符 → 清会话回登录
    clearSession()
    Taro.reLaunch({ url: LOGIN_PAGE })
    throw new ApiError('登录已过期，请重新登录', 401, 401, null)
  }
  if (statusCode < 200 || statusCode >= 300 || !envelope || envelope.code !== 0) {
    // 4xx/5xx 全量上报(除登录 401 属正常尝试)——远程可观测, 不用再等用户贴日志
    if (!(statusCode === 401 && path === '/auth/login')) {
      reportError(`request_${statusCode}_${path}`, {
        method: opts.method ?? 'GET',
        apiCode: envelope?.code ?? statusCode,
        message: envelope?.message,
      }, statusCode >= 500 ? 'error' : 'warn')
    }
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

/** GET /auth/me 的现有字段。角色以这次响应为准。 */
export interface ServerIdentity {
  id: string
  username: string
  name: string
  role: string
  dataScope: string
}

export const authApi = {
  login: (username: string, password: string, tenantCode?: string) =>
    request<LoginResult>('/auth/login', {
      method: 'POST',
      body: { username, password, ...(tenantCode?.trim() ? { tenantCode: tenantCode.trim() } : {}) },
    }),
  /** 启动时校验缓存 token。AuthGuard 回库看账号状态和 token_version，失效是 401。 */
  me: () => request<ServerIdentity>('/auth/me'),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
}

/** 退出或切换前清掉本地 token 和角色。能连上后端时同时吊销令牌。 */
export async function signOut(): Promise<void> {
  if (getToken()) {
    try {
      await authApi.logout()
    } catch {
      // 网络失败或 401 都继续清本地。401 时 request 已经清过并回到登录页。
    }
  }
  clearSession()
  Taro.reLaunch({ url: LOGIN_PAGE })
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

// 订单状态（枚举对齐后端 OrderStatus；标签=statemachine/order-state.ts 口径）
export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING_CONFIRM: '待确认',
  CONFIRMED: '已确认',
  OUTBOUND: '已出库',
  DELIVERING: '配送中',
  SIGNED: '已签收',
  SETTLED: '已销账',
  CANCELLED: '已取消',
  REJECTED: '已拒收',
}

// 状态配色档（admin 语义：蓝进行/绿成功/红风险/灰终态）
export const ORDER_STATUS_TONES: Record<string, string> = {
  PENDING_CONFIRM: 'warn',
  CONFIRMED: 'info',
  OUTBOUND: 'info',
  DELIVERING: 'info',
  SIGNED: 'ok',
  SETTLED: 'ok',
  CANCELLED: 'muted',
  REJECTED: 'danger',
}

export const ORDER_SOURCE_LABELS: Record<string, string> = {
  CLERK: '内勤录入',
  REP: '业务员代下',
  CUSTOMER: '客户自助',
}

export interface ShopProductDTO {
  productId: string
  name: string
  specText?: string | null
  baseUnit?: string | null
  minUnit?: string | null
  packSize?: number | null
  price: Decimalish
  /** 接口返回的可订单位。专属价可能是瓶，否则为箱。页面不另造瓶价。 */
  unit: ShopUnit
  priceType: string
}

export const shopApi = {
  /** q 只匹配品名。接口固定最多 100 条，没有 page 参数。 */
  products: (q?: string) => {
    const query = q?.trim()
    return request<{ items: ShopProductDTO[] }>(`/shop/products${query ? `?q=${encodeURIComponent(query)}` : ''}`)
  },
}

export interface PromotionRuleDTO {
  productId: string
  giftProductId: string | null
  giftProductName: string
  buyQty: number
  giftQty: number
  unit: ShopUnit
  active?: boolean
}

export const promotionsApi = {
  active: () => request<PromotionRuleDTO[]>('/promotions?active=1'),
}

// ───────────────────────── 订单（客户 token 自动过滤自己） ─────────────────────────

export interface PageResult<T> {
  items: T[]
  total: number
  openTotal?: number
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
  /** P1-5：customerId 禁传（服务端强制 token 身份），source 固定 CUSTOMER。幂等键由页面传入。 */
  create: (lines: Array<{ productId: string; unit: ShopUnit; qty: number }>, idemKey: string) => {
    const body = { source: 'CUSTOMER', lines }
    return request<CreateOrderResultDTO>('/orders', {
      method: 'POST',
      body,
      idemKey,
    }).then((r) => {
      trackEvent('customer_order_created', { orderNo: r.orderNo, lines: lines.length })
      return r
    })
  },
  // ── 员工端（P1 全员端）──
  /** 订单池（clerk/boss/warehouse）：按状态 tab 过滤，q 搜索单号/客户名 */
  staffList: (params: { status?: string; q?: string; page?: number; pageSize?: number }) => {
    const qs: string[] = []
    if (params.status) qs.push(`status=${params.status}`)
    if (params.q) qs.push(`q=${encodeURIComponent(params.q)}`)
    if (params.page) qs.push(`page=${params.page}`)
    if (params.pageSize) qs.push(`pageSize=${params.pageSize}`)
    return request<PageResult<StaffOrderRowDTO>>(`/orders${qs.length ? `?${qs.join('&')}` : ''}`)
  },
  /** 订单详情（行明细 + precheck + 客户信息 + 出库/签收/应收挂载） */
  detail: (id: string) => request<OrderDetailDTO>(`/orders/${id}`),
  /** 确认（待确认→已确认；信用复核不过 422 抛 ApiError，body.data 带复核数据） */
  confirm: (id: string) => request<Record<string, unknown>>(`/orders/${id}/confirm`, { method: 'POST', body: {} }),
  /** 生成拣货单（CONFIRMED→出库单 PICKING，FIFO 批次建议；仓配端拣货工作台接管） */
  outbound: (id: string) => request<Record<string, unknown>>(`/orders/${id}/outbound`, { method: 'POST', body: {} }),
  cancel: (id: string, reason: string) =>
    request<Record<string, unknown>>(`/orders/${id}/cancel`, { method: 'POST', body: { reason } }),
  /** 特批放行（老板本人；type=ORDER_SPECIAL） */
  approveSpecial: (id: string, reason: string, type: 'CREDIT_RELEASE' | 'PRICE_SPECIAL' | 'ORDER_SPECIAL' = 'ORDER_SPECIAL') =>
    request<Record<string, unknown>>(`/orders/${id}/approve-special`, { method: 'POST', body: { type, reason } }),
  /** 发运（OUTBOUND→DELIVERING，仓配） */
  deliver: (id: string) => request<Record<string, unknown>>(`/orders/${id}/deliver`, { method: 'POST', body: {} }),
  /** 配送前红字冲销（内勤/老板） */
  reverseLine: (id: string, lineId: string, qty: number, reason: string) =>
    request<Record<string, unknown>>(`/orders/${id}/lines/${lineId}/reverse`, { method: 'POST', body: { qty, reason } }),
  /** 签收（逐行实收 + 签收类型 + 回包装；服务端算差额回冲与应收） */
  sign: (id: string, body: SignBody, idemKey: string) =>
    request<SignResultDTO>(`/orders/${id}/sign`, {
      method: 'POST',
      body: body as unknown as Record<string, unknown>,
      idemKey,
    }),
  /** 整单拒收（配送中，需原因） */
  reject: (id: string, reason: string) =>
    request<Record<string, unknown>>(`/orders/${id}/reject`, { method: 'POST', body: { reason } }),
  /** 业务员代下单（source=REP；价格由服务端取价引擎解析）。幂等键由页面传入。 */
  repCreate: (
    input: { customerId: string; lines: Array<{ productId: string; unit: ShopUnit; qty: number }> },
    idemKey: string,
  ) =>
    request<CreateOrderResultDTO>('/orders', {
      method: 'POST',
      body: { customerId: input.customerId, source: 'REP', lines: input.lines },
      idemKey,
    }),
}

// ───────────────────────── 待结单据（文案红线：只说"待结金额"） ─────────────────────────

// 账龄档位键(M9-3): b1/b2/b3 上限租户级可配(默认 30/50/90), 文案由 agingApi 下发
export type ArBucket = 'not_due' | 'b1' | 'b2' | 'b3' | 'b4' | 'disputed'

export interface AgingConfigDTO {
  b1: number
  b2: number
  b3: number
}

export interface AgingConfigResultDTO {
  config: AgingConfigDTO
  labels: Record<ArBucket, string>
}

export const agingApi = {
  get: () => request<AgingConfigResultDTO>('/receivables/aging-config'),
}

/** 档位文案兜底(与后端默认 30/50/90 一致); 拉到配置后请用 agingApi 的 labels */
export function defaultArBucketLabels(): Record<ArBucket, string> {
  return {
    not_due: '未到期',
    b1: '逾期1-30天',
    b2: '逾期31-50天',
    b3: '逾期51-90天',
    b4: '逾期90天以上',
    disputed: '争议',
  }
}

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
  settledAt?: string
}

export const receivablesApi = {
  /** 客户 token 只返回自己的未归档单据；"已结"（open<=0）由后端支持后自动出现在 items 里 */
  mine: () => request<PageResult<CustomerReceivableDTO>>('/receivables?pageSize=200'),
  /** 内勤应收台账。openTotal 是筛选后的全量未结合计，不是当前页合计。 */
  list: (params?: { bucket?: string; page?: number; pageSize?: number }) => {
    const qs = [`page=${params?.page ?? 1}`, `pageSize=${params?.pageSize ?? 50}`]
    if (params?.bucket) qs.push(`bucket=${encodeURIComponent(params.bucket)}`)
    return request<PageResult<CustomerReceivableDTO>>(`/receivables?${qs.join('&')}`)
  },
}

// ───────────────────────── 月结对账单（M9-5 客户侧：列表/确认/异议） ─────────────────────────

export type StatementStatus = 'GENERATED' | 'SENT' | 'CONFIRMED' | 'DISPUTED' | 'RESOLVED'

export const STATEMENT_STATUS_LABELS: Record<string, string> = {
  GENERATED: '已生成',
  SENT: '待我确认',
  CONFIRMED: '已确认',
  DISPUTED: '有异议',
  RESOLVED: '异议已处理',
}

export interface StatementLineDTO {
  docNo: string
  type: string
  total: number
  settledInPeriod: number
  open: number
  generatedAt: string
  dueDate: string
  dispute?: boolean
  generatedBeforePeriod?: boolean
}

export interface StatementDTO {
  id: string
  statementNo: string
  period: string
  totalCharged: number
  totalSettled: number
  openBalance: number
  status: StatementStatus
  lines?: StatementLineDTO[] | null
  sentAt?: string | null
  confirmedAt?: string | null
  customer?: { code?: string | null; name: string } | null
  createdAt: string
}

export type DisputeType = 'MISSING_ORDER' | 'PRICE' | 'GIFT' | 'RETURN'

export const DISPUTE_TYPE_LABELS: Record<string, string> = {
  MISSING_ORDER: '漏单',
  PRICE: '价格',
  GIFT: '赠品',
  RETURN: '退货',
}

export const statementsApi = {
  /** 客户 token 只返回自己的对账单 */
  list: (status?: string) =>
    request<StatementDTO[]>(`/statements${status ? `?status=${status}` : ''}`),
  detail: (id: string) => request<StatementDTO>(`/statements/${id}`),
  /** 客户确认（SENT → CONFIRMED） */
  confirm: (id: string) => request<StatementDTO>(`/statements/${id}/confirm`, { method: 'POST', body: {} }),
  /** 客户异议：差异项（四类）进内勤工作池 */
  dispute: (id: string, items: Array<{ type: DisputeType; content: string }>, idemKey: string) =>
    request<Record<string, unknown>>(`/statements/${id}/dispute`, {
      method: 'POST',
      body: { items },
      idemKey,
    }),
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

// ───────────────────────── 业务员拜访（P1-T13，rep token：八步骤+定位+水印照片） ─────────────────────────

/** 业务员名下客户（GET /customers，rep token 自动过滤） */
export interface VisitCustomerDTO {
  id: string
  name: string
  code?: string | null
  abcLevel?: string | null
}

/** 八步骤勾选（schema Visit.steps Json，键见页面 VISIT_STEPS） */
export type VisitSteps = Record<string, boolean>

export interface VisitDTO {
  id: string
  repId: string
  customerId: string
  customer?: { name: string } | null
  visitedAt: string
  location?: string | null
  photoUrl?: string | null
  steps?: VisitSteps | null
  notes?: string | null
  createdAt: string
}

export const visitsApi = {
  customers: () => request<PageResult<VisitCustomerDTO>>('/customers?page=1&pageSize=200'),
  /** 打卡提交。没有上传接口，调用方不要传 photoUrl。幂等键由页面传入。 */
  create: (
    input: { customerId: string; location?: string; photoUrl?: string; steps: VisitSteps; notes?: string },
    idemKey: string,
  ) =>
    request<VisitDTO>('/visits', {
      method: 'POST',
      body: input as unknown as Record<string, unknown>,
      idemKey,
    }),
  /** 我的拜访时间线（rep token 只返回自己） */
  mine: () => request<PageResult<VisitDTO>>('/visits?mine=1'),
  /** 月度统计（本月 X 次） */
  stats: (month: string) =>
    request<{ month: string; count: number }>(`/visits/stats?month=${encodeURIComponent(month)}`),
}

// ───────────────────────── 业务员语音报单（P1-T12，rep token：语音/文字 → 待确认草稿） ─────────────────────────

export type DraftSource = 'VOICE' | 'TEXT'

/** 草稿行（items Json：productId 空=未匹配，确认转单在内勤后台完成） */
export interface RepDraftItemDTO {
  productName: string
  productId?: string | null
  qty: number
  unit: string
  unitPrice?: number | null
  priceHint?: number | null
  aliasMatched?: boolean
}

export interface RepDraftDTO {
  id: string
  draftNo: string
  source: DraftSource
  rawText?: string | null
  customerHint?: string | null
  items: RepDraftItemDTO[]
  confidence: number
  ambiguities?: string[] | null
  engine?: string | null
  /** 后端附带：confidence < 0.7 低置信度红条强提示 */
  lowConfidence?: boolean
  createdAt: string
}

export const draftsApi = {
  /** 报单入口：语音(试点期口述内容手敲成文字)/文字 → 后端 qwen 解析成草稿；确认转单在内勤后台「转单草稿」工作台 */
  create: (input: { source: DraftSource; text: string }, idemKey: string) =>
    request<RepDraftDTO>('/drafts', {
      method: 'POST',
      body: { source: input.source, text: input.text },
      idemKey,
    }),
  /** C组 M12-1: 真语音——录音 base64 直传(≤60s)，后端腾讯云 ASR 转写→qwen 解析；rawText 手敲文本可兜底优先 */
  createVoice: (
    input: { audioBase64: string; audioFormat: 'mp3' | 'wav' | 'm4a' | 'aac'; rawText?: string },
    idemKey: string,
  ) =>
    request<RepDraftDTO>('/drafts', {
      method: 'POST',
      body: {
        source: 'VOICE' as const,
        audioBase64: input.audioBase64,
        audioFormat: input.audioFormat,
        ...(input.rawText ? { text: input.rawText } : {}),
      },
      idemKey,
    }),
}

// ───────────────────────── 员工端·订单行/详情（P1 全员端，契约对齐 apps/api OrdersService） ─────────────────────────

/** 订单池列表行（GET /orders 员工视角：完整 salesOrder 字段 + lineCount） */
export interface StaffOrderRowDTO {
  id: string
  orderNo: string
  status: string
  totalAmount: Decimalish
  customerId: string
  customerName: string
  source: string
  lineCount?: number
  createdAt: string
  deliveryDate?: string | null
  addressSnapshot?: string | null
  specialApproved?: boolean
}

export interface OrderLineDTO {
  id: string
  productId: string
  productName: string
  specText?: string | null
  unit: string
  qty: Decimalish
  unitPrice: Decimalish
  amount: Decimalish
  priceType?: string
  isGift?: boolean
  /** 红字冲销行：指向被冲销的原行（负数量） */
  reversalOfId?: string | null
}

/** 审单预检（Order.precheck JSON 的展示视图，字段宽进严出） */
export interface PrecheckView {
  customer?: { ok?: boolean; reason?: string } & Record<string, unknown>
  credit?: {
    ok?: boolean
    limit?: number
    openAr?: number
    inTransit?: number
    available?: number
    need?: number
  } & Record<string, unknown>
  inventory?: Array<{ productName?: string; ok?: boolean; onHand?: number; occupied?: number; need?: number }>
  minOrder?: { ok?: boolean; amount?: number; min?: number }
}

export interface OrderDetailDTO {
  id: string
  orderNo: string
  status: string
  statusLabel?: string | null
  source: string
  totalAmount: Decimalish
  addressSnapshot?: string | null
  deliveryDate?: string | null
  createdAt: string
  cancelReason?: string | null
  specialApproved?: boolean
  precheck?: Record<string, unknown> | null
  customer: { id: string; code?: string | null; name: string; phone?: string | null; termsDays?: number | null; settlement?: string | null }
  lines: OrderLineDTO[]
  outbounds?: Array<{ outboundNo: string; status: string; lines?: Array<{ qty: Decimalish; batch?: { batchNo?: string } | null }> }>
  signature?: Record<string, unknown> | null
  receivables?: Array<Record<string, unknown>>
}

export interface SignBody {
  type: 'E_SIGN' | 'PHOTO' | 'PAPER'
  signerName?: string
  /** E_SIGN: canvas 手写签名导出的 dataURL(base64); PHOTO: 拍照凭证 dataURL */
  signatureData?: string
  photoUrl?: string
  deviceInfo?: string
  /** 回包装回填（品类+数量，落押金台账） */
  returnPackages?: Array<{ category: string; qty: number }>
  /** 逐行实收（默认=净量；缺省行服务端按净量计） */
  lines?: Array<{ orderLineId: string; actualQty: number }>
}

export interface SignResultDTO {
  orderNo: string
  status: 'SIGNED' | 'REJECTED'
  acceptedAmount: number
  receivableGenerated?: boolean
}

// ───────────────────────── 老板端·四问看板（GET /dashboard/four-questions） ─────────────────────────

export interface FourQuestionsDTO {
  salesToday: { amount: number; orderCount: number }
  collectedToday: { amount: number; paymentCount: number }
  debt: {
    total: number
    buckets: Record<ArBucket, number>
    topDebtors: Array<{ customerId: string; name: string; open: number }>
  }
  lowStock: Array<{ productId: string; skuCode?: string; name: string; onHand: number; occupied: number; available: number }>
  repRanking: Array<{ userId: string; name: string; salesAmount: number; orderCount: number; paymentAmount: number }>
  generatedAt: string
}

export const dashboardApi = {
  fourQuestions: () => request<FourQuestionsDTO>('/dashboard/four-questions'),
}

export const inventoryApi = {
  products: (q: string, page: number, pageSize = 20) =>
    request<InventoryProductList>(inventoryListQuery(q, page, pageSize)),
}

// ───────────────────────── 老板端·审批中心（GET /approvals · POST /approvals/:id/decide） ─────────────────────────

export const APPROVAL_LINE_LABELS: Record<string, string> = {
  CREDIT_RELEASE: '信用放行',
  PRICE_SPECIAL: '价格特批',
  PRICE_CHANGE: '调价审批',
  PURCHASE: '采购审批',
  EXPENSE: '费用审批',
  RETURN: '退货审批',
  STOCKTAKE: '盘点调账',
}

export const APPROVAL_STATUS_LABELS: Record<string, string> = {
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  EXPIRED_24H: '已过期',
}

export interface ApprovalItemDTO {
  id: string
  line: string
  entityType: string
  entityId: string
  title: string
  amount: number | null
  reason: string
  payload?: Record<string, unknown> | null
  applicant: { id: string; name: string; role: string } | null
  status: string
  createdAt: string
  approverHint?: string
}

export const approvalsApi = {
  list: (status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED_24H') =>
    request<PageResult<ApprovalItemDTO>>(`/approvals${status ? `?status=${status}&pageSize=50` : '?pageSize=50'}`),
  /** 审批决定（意见必填；金额路由由服务端硬校验） */
  decide: (id: string, action: 'approve' | 'reject', opinion: string) =>
    request<Record<string, unknown>>(`/approvals/${id}/decide`, { method: 'POST', body: { action, opinion } }),
}

// ───────────────────────── 仓配端·出库工作台（GET /orders/outbounds · POST confirm） ─────────────────────────

/** FIFO 建议批次行（qty=最小单位拣货量） */
export interface OutboundLineDTO {
  id?: string
  qty: Decimalish
  batch?: { batchNo?: string } | null
  orderLine?: { productName: string; unit?: string; conversionRate?: number; qty?: Decimalish } | null
}

export interface OutboundRowDTO {
  id: string
  outboundNo: string
  status: string
  createdAt: string
  order: { orderNo: string; customerName: string; addressSnapshot?: string | null; status?: string; deliveryDate?: string | null }
  lines: OutboundLineDTO[]
}

export const outboundsApi = {
  /** status=PICKING 待拣货复核 / CONFIRMED 已出库；不传=全量（详情按 outboundNo 前端查找） */
  list: (status?: string) =>
    request<PageResult<OutboundRowDTO>>(`/orders/outbounds${status ? `?status=${status}&pageSize=100` : '?pageSize=100'}`),
  /** 复核确认出库。幂等键由页面按出库单持有。 */
  confirm: (outboundNo: string, idemKey: string) =>
    request<Record<string, unknown>>(`/orders/outbounds/${encodeURIComponent(outboundNo)}/confirm`, {
      method: 'POST',
      body: {},
      idemKey,
    }),
}

// ───────────────────────── 收款（POST /payments 幂等 · GET /payments?status=） ─────────────────────────

export const PAYMENT_METHODS: string[] = ['现金', '转账', '微信', '支付宝']

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  REPORTED: '待确认',
  CONFIRMED: '已销账',
  CANCELLED: '已冲正',
}

export interface PaymentRowDTO {
  id: string
  paymentNo: string
  amount: Decimalish
  method?: string | null
  voucher?: string | null
  note?: string | null
  status: string
  createdAt: string
  confirmedAt?: string | null
  customer: { name: string }
}

export const paymentsApi = {
  /** 收款登记/上报（rep→REPORTED 待确认；clerk/owner→即确认 FIFO 销账） */
  report: (
    input: { customerId: string; amount: number; method?: string; voucher?: string; note?: string },
    idemKey: string,
  ) =>
    request<Record<string, unknown>>('/payments', {
      method: 'POST',
      body: input as unknown as Record<string, unknown>,
      idemKey,
    }),
  /** 注意：该接口 data 直接返回数组（非 {items} 分页） */
  list: (status?: string) =>
    request<PaymentRowDTO[]>(`/payments${status ? `?status=${status}` : ''}`),
  confirm: (id: string) =>
    request<Record<string, unknown>>(`/payments/${id}/confirm`, { method: 'POST', body: {} }),
}

// ───────────────────────── 客户（GET /customers，rep token 自动过滤名下） ─────────────────────────

export const SETTLEMENT_LABELS: Record<string, string> = { CASH: '现结', MONTHLY: '月结' }

export interface CustomerRowDTO {
  id: string
  code?: string | null
  name: string
  phone?: string | null
  address?: string | null
  settlement?: string | null
  termsDays?: number | null
  abcLevel?: string | null
  status?: string | null
  salesperson?: { id: string; name: string } | null
}

export const customersApi = {
  list: (params?: { q?: string; page?: number; pageSize?: number }) => {
    const qs: string[] = []
    if (params?.q) qs.push(`q=${encodeURIComponent(params.q)}`)
    qs.push(`page=${params?.page ?? 1}`)
    qs.push(`pageSize=${params?.pageSize ?? 200}`)
    return request<PageResult<CustomerRowDTO>>(`/customers?${qs.join('&')}`)
  },
}

// ───────────────────────── 商品搜索与取价（rep 代下单：/products?q= + /prices/resolve） ─────────────────────────

export interface ProductRowDTO {
  id: string
  skuCode?: string | null
  name: string
  specText?: string | null
  baseUnit?: string | null
  minUnit?: string | null
  packSize?: number | null
  status?: string | null
}

export interface ResolvedPriceDTO {
  price: Decimalish
  priceType: string
  priceRowId?: string
  validFrom?: string | null
}

export const productsApi = {
  search: (q?: string) =>
    request<PageResult<ProductRowDTO>>(`/products${q ? `?q=${encodeURIComponent(q)}&pageSize=50` : '?pageSize=50'}`),
}

export const pricesApi = {
  /** 取价引擎（客户专属价>终端>二批>一批>零售）；无生效价时 data 可能为 null */
  resolve: (customerId: string, productId: string, unit?: string) =>
    request<ResolvedPriceDTO | null>(
      `/prices/resolve?customerId=${encodeURIComponent(customerId)}&productId=${encodeURIComponent(productId)}${unit ? `&unit=${unit}` : ''}`,
    ),
}

// ───────────────────────── 业务员绩效（GET /performance?month=，rep 项：回款/新客/拜访/提成） ─────────────────────────

export interface PerfItemDTO {
  repId: string
  name: string
  paymentAmount: number
  newCustomers: number
  visitCount: number
  visitTarget?: number
  returnDeduction: number
  commission: number
}

export interface PerfDTO {
  month: string
  items: PerfItemDTO[]
  generatedAt: string
}

export const performanceApi = {
  monthly: (month: string) => request<PerfDTO>(`/performance?month=${encodeURIComponent(month)}`),
}

// ───────────────────────── B组 开瓶费: 政策查询 + 瓶盖回收登记(业务员/仓配) ─────────────────────────

export interface CapPolicyDTO {
  id: string
  productId: string
  skuCode: string
  productName: string
  unitLabel: string
  packSize: number
  perBottleFee: number
  requireCap: boolean
  noCapRate: number
}

export interface CapRecycleDTO {
  id: string
  recycleNo: string
  status: 'PENDING_CONFIRM' | 'CONFIRMED' | 'CANCELLED'
  customer: { code?: string | null; name: string }
  lines: Array<{ productId: string; productName: string; qty: number; perBottleFee: number; amount: number }>
  totalAmount: number
  note?: string | null
  createdAt: string
}

export const CAP_RECYCLE_STATUS_LABELS: Record<string, string> = {
  PENDING_CONFIRM: '待确认',
  CONFIRMED: '已兑付',
  CANCELLED: '已取消',
}

export const capFeesApi = {
  /** 生效政策(回瓶盖模式才需要登记回收; 不回盖由系统月度自动计提) */
  policies: () => request<CapPolicyDTO[]>('/cap-fees/policies'),
  /** 登记回收单(业务员仅限自己名下客户) */
  createRecycle: (
    input: { customerId: string; lines: Array<{ productId: string; qty: number }>; note?: string },
    idemKey: string,
  ) =>
    request<CapRecycleDTO>('/cap-fees/recycles', {
      method: 'POST',
      body: input as unknown as Record<string, unknown>,
      idemKey,
    }),
  /** 我的回收单(业务员只见自己登记的) */
  myRecycles: (status?: string) =>
    request<{ items: CapRecycleDTO[]; total: number }>(`/cap-fees/recycles${status ? `?status=${status}&pageSize=50` : '?pageSize=50'}`),
}
