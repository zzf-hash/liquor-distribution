// 真接口通道：统一 fetch 封装（{code:0,data} 信封 / 401 跳登录 / 幂等键）+ 各资源类型化方法。
// 接口契约对齐 apps/api：products/customers/prices(L3 自研) + orders/receivables/payments/imports/users。
import { apiBase } from './api-base';
import { clearAuth, getAuth } from './auth';
import { reportError } from './telemetry';
import type { Decimalish } from '../utils/format';

const BASE_URL: string = apiBase();
export { BASE_URL };

export interface ApiEnvelope<T> {
  code: number;
  data?: T;
  message?: string;
}

/** 携带原始响应体，便于 422 预检拦截等场景读取业务数据 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: number;
  readonly body: ApiEnvelope<unknown> | null;

  constructor(message: string, status: number, code: number, body: ApiEnvelope<unknown> | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** FormData 自动跳过 JSON 头 */
  formData?: FormData;
  idemKey?: string;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const auth = getAuth();
  const headers = new Headers();
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  if (auth?.token) headers.set('Authorization', `Bearer ${auth.token}`);
  if (opts.idemKey) headers.set('Idempotency-Key', opts.idemKey);

  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.formData ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: opts.signal,
  }).catch((e: unknown) => {
    reportError('request_network_fail', { path, method: opts.method ?? 'GET', reason: String(e).slice(0, 300) });
    throw new ApiError('网络连接失败，请检查网络后重试', -1, -1, null);
  }) as Response;

  // B1：token 过期/被吊销（禁用即时生效）→ 清会话回登录页
  if (res.status === 401) {
    clearAuth();
    window.location.href = '/login';
    throw new ApiError('登录已过期，请重新登录', 401, 401, null);
  }

  let envelope: ApiEnvelope<unknown> | null = null;
  try {
    envelope = (await res.json()) as ApiEnvelope<unknown>;
  } catch {
    envelope = null;
  }
  if (!res.ok || !envelope || envelope.code !== 0) {
    // 4xx/5xx 全量上报（远程可观测）
    reportError(`request_${res.status}_${path}`, {
      method: opts.method ?? 'GET',
      apiCode: envelope?.code ?? res.status,
      message: envelope?.message,
    }, res.status >= 500 ? 'error' : 'warn');
    throw new ApiError(
      envelope?.message || `请求失败（HTTP ${res.status}）`,
      res.status,
      envelope?.code ?? res.status,
      envelope,
    );
  }
  return envelope.data as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** M1-5 单据导出（xlsx 二进制流，绕过 JSON 信封）：鉴权同 request，blob 落地浏览器下载 */
export async function downloadApiFile(path: string, fallbackName: string): Promise<void> {
  const auth = getAuth();
  const headers: Record<string, string> = {};
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  if (res.status === 401) {
    clearAuth();
    window.location.href = '/login';
    throw new ApiError('登录已过期，请重新登录', 401, 401, null);
  }
  if (!res.ok) {
    let msg = `导出失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as ApiEnvelope<unknown>;
      if (body?.message) msg = body.message;
    } catch { /* 二进制错误页忽略 */ }
    throw new ApiError(msg, res.status, res.status, null);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const starMatch = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plainMatch = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = starMatch ? decodeURIComponent(starMatch[1]) : plainMatch ? plainMatch[1] : fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ───────────────────────── 通用分页 ─────────────────────────

export interface PageResult<T> {
  items: T[];
  total: number;
}

// ───────────────────────── 商品（P0-T10） ─────────────────────────

export type PriceUnitDTO = 'BASE' | 'MIN';
export type ProductCategoryDTO = 'BAIJIU' | 'PIJIU' | 'HONGJIU' | 'YANGJIU' | 'YINLIAO' | 'QITA';
export type ProductStatusDTO = 'ON_SALE' | 'OFF_SALE';

export interface PriceSummaryDTO {
  unit: PriceUnitDTO;
  levelType: string;
  price: Decimalish;
  validFrom: string;
}

export interface ProductDTO {
  id: string;
  skuCode: string;
  name: string;
  category: ProductCategoryDTO;
  brand?: string | null;
  baseUnit: string;
  minUnit: string;
  packSize: number;
  barcode?: string | null;
  abv?: number | null;
  origin?: string | null;
  supplier?: string | null;
  specText?: string | null;
  highValue: boolean;
  status: ProductStatusDTO;
  pinyinFirst?: string | null;
  createdAt: string;
  priceSummary?: PriceSummaryDTO[];
}

export interface ProductInput {
  skuCode?: string; // 编辑时不传（编码禁改）
  name?: string;
  category?: ProductCategoryDTO;
  brand?: string;
  baseUnit?: string;
  minUnit?: string;
  packSize?: number;
  barcode?: string;
  abv?: number;
  origin?: string;
  supplier?: string;
  specText?: string;
  highValue?: boolean;
  pinyinFirst?: string;
}

export const productsApi = {
  list: (params: { q?: string; category?: string; status?: string; page?: number; pageSize?: number }) =>
    request<PageResult<ProductDTO>>(`/products${qs(params)}`),
  detail: (id: string) => request<ProductDTO>(`/products/${id}`),
  create: (input: ProductInput) => request<ProductDTO>('/products', { method: 'POST', body: input }),
  update: (id: string, input: ProductInput) =>
    request<ProductDTO>(`/products/${id}`, { method: 'PATCH', body: input }),
  disable: (id: string) => request<ProductDTO>(`/products/${id}/disable`, { method: 'POST', body: {} }),
};

// ───────────────────────── 客户（P0-T12） ─────────────────────────

export type OnboardingStatusDTO =
  | 'REP_DRAFT'
  | 'CLERK_CONFIRMED'
  | 'PENDING_OWNER'
  | 'ACTIVE'
  | 'REJECTED';
export type OnboardingActionDTO = 'clerk_confirm' | 'submit_owner' | 'owner_approve' | 'reject';

export interface CustomerDTO {
  id: string;
  code: string;
  name: string;
  type: string;
  contact?: string | null;
  phone: string;
  licenseNo?: string | null;
  region?: string | null;
  address: string;
  abcLevel?: string | null;
  settlement: 'CASH' | 'MONTHLY';
  termsDays: number;
  creditLimit: Decimalish;
  minOrderAmount: Decimalish;
  receivingWindow?: string | null;
  signMode: 'E_SIGN' | 'PAPER';
  printerModel?: string | null;
  salesperson?: { id: string; name: string } | null;
  salespersonId?: string | null;
  onboarding: OnboardingStatusDTO;
  status: 'ACTIVE' | 'DISABLED';
  priceCount?: number;
  createdAt: string;
}

export interface CustomerInput {
  code?: string; // 编辑时不传（编码禁改）
  name?: string;
  type?: string;
  contact?: string;
  phone?: string;
  licenseNo?: string;
  region?: string;
  address?: string;
  abcLevel?: string;
  settlement?: 'CASH' | 'MONTHLY';
  termsDays?: number;
  creditLimit?: number;
  minOrderAmount?: number;
  receivingWindow?: string;
  signMode?: 'E_SIGN' | 'PAPER';
  salespersonId?: string;
  note?: string;
}

export const customersApi = {
  list: (params: {
    q?: string;
    type?: string;
    settlement?: string;
    onboarding?: string;
    page?: number;
    pageSize?: number;
  }) => request<PageResult<CustomerDTO>>(`/customers${qs(params)}`),
  detail: (id: string) => request<CustomerDTO>(`/customers/${id}`),
  create: (input: CustomerInput) => request<CustomerDTO>('/customers', { method: 'POST', body: input }),
  update: (id: string, input: CustomerInput) =>
    request<CustomerDTO>(`/customers/${id}`, { method: 'PATCH', body: input }),
  onboarding: (id: string, action: OnboardingActionDTO, reason?: string) =>
    request<CustomerDTO>(`/customers/${id}/onboarding`, { method: 'POST', body: { action, reason } }),
  disable: (id: string) => request<CustomerDTO>(`/customers/${id}/disable`, { method: 'POST', body: {} }),
};

// ───────────────────────── 价格（P0-T11） ─────────────────────────

export interface PriceVersionDTO {
  id: string;
  productId: string;
  unit: PriceUnitDTO;
  levelType: string;
  price: Decimalish;
  validFrom: string;
  validTo?: string | null;
  approvalRef?: string | null;
  note?: string | null;
  createdAt: string;
}

export interface CustomerPriceVersionDTO extends PriceVersionDTO {
  customerId: string;
  product?: { skuCode: string; name: string } | null;
}

export interface ResolvedPriceDTO {
  price: Decimalish;
  priceType: string;
  priceRowId: string;
  validFrom: string;
}

export interface PriceVersionInput {
  unit: PriceUnitDTO;
  levelType: string;
  price: number;
  validFrom: string;
  validTo?: string;
  approvalRef?: string;
  note?: string;
}

/** 客户专属价无 levelType（一客一价不分级） */
export interface CustomerPriceInput {
  productId: string;
  unit: PriceUnitDTO;
  price: number;
  validFrom: string;
  validTo?: string;
  approvalRef?: string;
  note?: string;
}

export const pricesApi = {
  listForProduct: (productId: string) => request<PriceVersionDTO[]>(`/products/${productId}/prices`),
  createForProduct: (productId: string, input: PriceVersionInput) =>
    request<PriceVersionDTO>(`/products/${productId}/prices`, { method: 'POST', body: input }),
  listForCustomer: (customerId: string) =>
    request<CustomerPriceVersionDTO[]>(`/customers/${customerId}/prices`),
  createForCustomer: (customerId: string, input: CustomerPriceInput) =>
    request<CustomerPriceVersionDTO>(`/customers/${customerId}/prices`, { method: 'POST', body: input }),
  /** 取价引擎：客户专属价 > 终端 > 二批 > 一批 > 零售 */
  resolve: (params: { customerId: string; productId: string; unit?: PriceUnitDTO }) =>
    request<ResolvedPriceDTO>(`/prices/resolve${qs(params)}`),
};

// ───────────────────────── 订单（P0-T20~T25） ─────────────────────────

export type OrderStatusDTO =
  | 'PENDING_CONFIRM'
  | 'CONFIRMED'
  | 'OUTBOUND'
  | 'DELIVERING'
  | 'SIGNED'
  | 'SETTLED'
  | 'CANCELLED'
  | 'REJECTED';

export interface OrderLineDTO {
  id: string;
  productId: string;
  productName: string;
  specText?: string | null;
  unit: PriceUnitDTO;
  conversionRate: number;
  qty: Decimalish;
  unitPrice: Decimalish;
  amount: Decimalish;
  priceType: string;
  isGift: boolean;
  /** 红字冲销行：reversalOfId 指向被冲销原行（负数量展示） */
  reversalOfId?: string | null;
  createdAt: string;
}

export interface OrderDTO {
  id: string;
  orderNo: string;
  customerId: string;
  customerName: string;
  source: 'CLERK' | 'REP' | 'CUSTOMER';
  signMode: 'E_SIGN' | 'PAPER';
  status: OrderStatusDTO;
  totalAmount: Decimalish;
  deliveryDate?: string | null;
  precheck?: Record<string, unknown> | null;
  specialApproved: boolean;
  cancelReason?: string | null;
  lineCount?: number;
  createdAt: string;
  /** 详情接口附带 */
  lines?: OrderLineDTO[];
  statusLabel?: string;
}

export interface CreateOrderInput {
  customerId: string;
  source: 'CLERK' | 'REP';
  lines: Array<{ productId: string; unit: PriceUnitDTO; qty: number }>;
  addressOverride?: string;
  deliveryDate?: string;
  note?: string;
}

export interface CreateOrderResultDTO {
  id: string;
  orderNo: string;
  status: string;
  totalAmount: number;
  precheck: Record<string, unknown>;
}

export type ApproveSpecialType = 'CREDIT_RELEASE' | 'PRICE_SPECIAL' | 'ORDER_SPECIAL';

export const ordersApi = {
  list: (params: { status?: string; customerId?: string; q?: string; page?: number; pageSize?: number }) =>
    request<PageResult<OrderDTO>>(`/orders${qs(params)}`),
  detail: (id: string) => request<OrderDTO>(`/orders/${id}`),
  create: (input: CreateOrderInput) =>
    request<CreateOrderResultDTO>('/orders', { method: 'POST', body: input }),
  confirm: (id: string) => request<OrderDTO>(`/orders/${id}/confirm`, { method: 'POST', body: {} }),
  approveSpecial: (id: string, type: ApproveSpecialType, reason: string) =>
    request<OrderDTO>(`/orders/${id}/approve-special`, { method: 'POST', body: { type, reason } }),
  cancel: (id: string, reason: string) =>
    request<OrderDTO>(`/orders/${id}/cancel`, { method: 'POST', body: { reason } }),
  reject: (id: string, reason: string) =>
    request<OrderDTO>(`/orders/${id}/reject`, { method: 'POST', body: { reason } }),
  /** 配送前红字冲销一行（POST /orders/:id/lines/:lineId/reverse） */
  reverseLine: (id: string, lineId: string, qty: number, reason: string) =>
    request<OrderDTO>(`/orders/${id}/lines/${lineId}/reverse`, { method: 'POST', body: { qty, reason } }),
  /** 已确认订单生成拣货单。仓配、老板、内勤。 */
  outbound: (id: string) => request<Record<string, unknown>>(`/orders/${id}/outbound`, { method: 'POST', body: {} }),
  /** 已出库订单发运。仓配、老板。 */
  deliver: (id: string) => request<Record<string, unknown>>(`/orders/${id}/deliver`, { method: 'POST', body: {} }),
};

// ───────────────────────── 应收 / 收款（P0-T30~T31） ─────────────────────────

// 账龄档位键（M9-3）：b1/b2/b3 上限租户级可配（默认 30/50/90，Q1 已确认），文案由 agingApi 下发
export type ArBucketDTO = 'not_due' | 'b1' | 'b2' | 'b3' | 'b4' | 'disputed';

export interface AgingConfigDTO {
  b1: number;
  b2: number;
  b3: number;
}

export interface AgingConfigResultDTO {
  config: AgingConfigDTO;
  labels: Record<ArBucketDTO, string>;
}

export const agingApi = {
  /** 档位配置 + 档位文案（三端共用口径） */
  get: () => request<AgingConfigResultDTO>('/receivables/aging-config'),
  save: (config: AgingConfigDTO) =>
    request<AgingConfigDTO>('/receivables/aging-config', { method: 'POST', body: config }),
};

export interface ReceivableDTO {
  id: string;
  sourceType: 'ORDER' | 'INITIAL';
  sourceDocNo: string;
  customerName: string;
  total: number;
  settled: number;
  open: number;
  dueDate: string;
  daysOverdue: number;
  disputeFlag: boolean;
  bucket: ArBucketDTO;
}

export interface PaymentDTO {
  id: string;
  paymentNo: string;
  customerId: string;
  amount: Decimalish;
  method?: string | null;
  voucher?: string | null;
  status: 'REPORTED' | 'CONFIRMED' | 'CANCELLED';
  createdAt: string;
  confirmedAt?: string | null;
  customer?: { name: string } | null;
}

export interface PaymentInput {
  customerId: string;
  amount: number;
  method?: string;
  voucher?: string;
  note?: string;
}

export const receivablesApi = {
  list: (params: { bucket?: ArBucketDTO; customerId?: string; page?: number; pageSize?: number }) =>
    request<PageResult<ReceivableDTO>>(`/receivables${qs(params)}`),
  /** 待确认收款列表（F9②：业务员上报→内勤确认销账） */
  listPayments: (params?: { status?: string; customerId?: string }) =>
    request<PaymentDTO[]>(`/payments${qs(params ?? {})}`),
  createPayment: (input: PaymentInput, idemKey: string) =>
    request<PaymentDTO>('/payments', { method: 'POST', body: input, idemKey }),
  confirmPayment: (id: string) => request<PaymentDTO>(`/payments/${id}/confirm`, { method: 'POST', body: {} }),
  /** 抹零：金额与原因必填，幂等键必带 */
  waive: (id: string, amount: number, reason: string, idemKey: string) =>
    request<Record<string, unknown>>(`/receivables/${id}/waive`, {
      method: 'POST',
      body: { amount, reason },
      idemKey,
    }),
  /** 坏账：老板执行，原因必填，金额由服务端按未结余额核销 */
  writeOff: (id: string, reason: string, idemKey: string) =>
    request<Record<string, unknown>>(`/receivables/${id}/write-off`, {
      method: 'POST',
      body: { reason },
      idemKey,
    }),
  reminders: () => request<Array<{ sourceDocNo: string; dueDate: string; open: number; daysLeft: number }>>('/receivables/reminders'),
  reversePayment: (id: string, reason: string) =>
    request<Record<string, unknown>>(`/payments/${id}/reverse`, { method: 'POST', body: { reason } }),
};

// ───────────────────────── 数据导入（P0-T13 / P0-07） ─────────────────────────

export type ImportKindDTO = 'PRODUCT' | 'CUSTOMER' | 'PRICE' | 'INVENTORY' | 'RECEIVABLE';

export interface ImportRowIssueDTO {
  rowNo: number;
  rowKey?: string | null;
  level: 'REJECT_BATCH' | 'REJECT_ROW' | 'WARN';
  reasonCode: string;
  message: string;
  raw?: unknown;
}

export interface ImportPreviewDTO {
  batchNo: string;
  kind: ImportKindDTO;
  total: number;
  passed: number;
  rejected: number;
  warned: number;
  status: string;
  rejectBatch: ImportRowIssueDTO[];
  rejectRow: ImportRowIssueDTO[];
  warn: ImportRowIssueDTO[];
}

export interface ImportCommitResultDTO {
  ok?: boolean;
  batchNo: string;
  [key: string]: unknown;
}

export const importsApi = {
  /** multipart 字段名 file + kind（后端 FileInterceptor('file')） */
  preview: (kind: ImportKindDTO, file: File) => {
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('file', file);
    return request<ImportPreviewDTO>('/imports/preview', { method: 'POST', formData: fd });
  },
  commit: (batchNo: string) =>
    request<ImportCommitResultDTO>(`/imports/${encodeURIComponent(batchNo)}/commit`, {
      method: 'POST',
      body: {},
    }),
  rollback: (batchNo: string) =>
    request<ImportCommitResultDTO>(`/imports/${encodeURIComponent(batchNo)}/rollback`, {
      method: 'POST',
      body: {},
    }),
};

export const dailyTasksApi = {
  reminders: () => request<Record<string, unknown>>('/daily-tasks/reminders/run', { method: 'POST', body: {} }),
  statements: (period?: string) =>
    request<Record<string, unknown>>(`/daily-tasks/statements/run${period ? `?period=${encodeURIComponent(period)}` : ''}`, { method: 'POST', body: {} }),
  archive: () => request<Record<string, unknown>>('/daily-tasks/archive/run', { method: 'POST', body: {} }),
  capAccrue: (period?: string) =>
    request<Record<string, unknown>>(`/daily-tasks/cap-accrue/run${period ? `?period=${encodeURIComponent(period)}` : ''}`, { method: 'POST', body: {} }),
};

// ───────────────────────── 员工（业务员下拉用） ─────────────────────────

export interface UserDTO {
  id: string;
  username: string;
  name: string;
  role: 'OWNER' | 'REP' | 'CLERK' | 'WAREHOUSE';
  status: 'ACTIVE' | 'DISABLED';
  phone?: string | null;
}

export const usersApi = {
  list: () => request<UserDTO[]>('/users'),
  create: (input: { username: string; password: string; name: string; role: UserDTO['role']; phone?: string }) =>
    request<Pick<UserDTO, 'id' | 'username' | 'name' | 'role'>>('/users', { method: 'POST', body: input }),
  disable: (id: string) => request<{ ok: boolean }>(`/users/${id}/disable`, { method: 'POST', body: {} }),
  /** 归属业务员下拉；接口不可用时静默降级为空（REP 自建后端自动挂自己） */
  listReps: async (): Promise<UserDTO[]> => {
    try {
      const all = await request<UserDTO[]>('/users');
      return all.filter((u) => u.role === 'REP' && u.status === 'ACTIVE');
    } catch {
      return [];
    }
  },
};

// ───────────────────────── 审批中心（P1-T01，五条线统一 D01） ─────────────────────────

export type ApprovalLineDTO =
  | 'CREDIT_RELEASE'
  | 'PRICE_SPECIAL'
  | 'PRICE_CHANGE'
  | 'PURCHASE'
  | 'EXPENSE'
  | 'RETURN';
export type ApprovalStatusDTO = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED_24H';

export interface ApprovalRecordDTO {
  id: string;
  line: ApprovalLineDTO;
  entityType: string;
  entityId: string;
  title: string;
  amount?: Decimalish | null;
  reason: string;
  /** 线内扩展（调价差异清单/特单字段快照等），详情展开渲染 */
  payload?: Record<string, unknown> | null;
  applicant: { id: string; name: string };
  status: ApprovalStatusDTO;
  createdAt: string;
  /** 已决附带 */
  approver?: { id: string; name: string } | null;
  opinion?: string | null;
  decidedAt?: string | null;
}

export const approvalsApi = {
  /** status 逗号多值（已决 tab：APPROVED,REJECTED,EXPIRED_24H） */
  list: (params: { status?: string; page?: number; pageSize?: number }) =>
    request<PageResult<ApprovalRecordDTO>>(`/approvals${qs(params)}`),
  /** 审批人金额路由（≤2000 内勤 / >2000 或低于成本老板）由后端强制，前端只提示 */
  decide: (id: string, action: 'approve' | 'reject', opinion: string) =>
    request<ApprovalRecordDTO>(`/approvals/${id}/decide`, { method: 'POST', body: { action, opinion } }),
  /** C组: 批量决定（批量调价等一单一审批场景）；逐单走后端全套校验，单条失败不拖垮 */
  bulkDecide: (ids: string[], action: 'approve' | 'reject', opinion: string) =>
    request<{ applied: number; failed: Array<{ id: string; error: string }> }>('/approvals/bulk-decide', { method: 'POST', body: { ids, action, opinion } }),
};

// ───────────────────────── 特单（P1-T02，F8 全员下单+婚宴宴席） ─────────────────────────

export type SpecialOrderStatusDTO = 'DRAFT' | 'PENDING_PRICE' | 'APPROVED' | 'CONVERTED' | 'REJECTED';

export interface SpecialOrderLineDTO {
  id: string;
  productId?: string | null;
  productName: string;
  specText?: string | null;
  unit: string;
  qty: Decimalish;
  price: Decimalish;
  note?: string | null;
}

export interface SpecialOrderDTO {
  id: string;
  specialNo: string;
  title: string;
  customerId?: string | null;
  customerName: string;
  isBanquet: boolean;
  eventDate?: string | null;
  venue?: string | null;
  contactName: string;
  contactPhone: string;
  address: string;
  deliveryDate?: string | null;
  payeeName?: string | null;
  payDueDate?: string | null;
  note?: string | null;
  status: SpecialOrderStatusDTO;
  convertedOrderId?: string | null;
  createdAt: string;
  /** 详情接口附带 */
  lines?: SpecialOrderLineDTO[];
  /** 转单后正式订单号（CONVERTED 附带） */
  orderNo?: string | null;
  lineCount?: number;
}

export interface SpecialOrderInput {
  title: string;
  customerId?: string;
  customerName: string;
  isBanquet?: boolean;
  eventDate?: string;
  venue?: string;
  contactName: string;
  contactPhone: string;
  address: string;
  deliveryDate?: string;
  payeeName?: string;
  payDueDate?: string;
  note?: string;
  lines: Array<{ productId?: string; productName: string; unit: string; qty: number; price: number }>;
}

/** 转单结果：orderNo 优先展示，旧后端只有 convertedOrderId 时降级 */
export interface SpecialOrderConvertResultDTO {
  id: string;
  specialNo: string;
  status: SpecialOrderStatusDTO;
  convertedOrderId?: string | null;
  orderNo?: string | null;
  [key: string]: unknown;
}

export const specialOrdersApi = {
  list: (params: { status?: string; q?: string; page?: number; pageSize?: number }) =>
    request<PageResult<SpecialOrderDTO>>(`/special-orders${qs(params)}`),
  detail: (id: string) => request<SpecialOrderDTO>(`/special-orders/${id}`),
  /** 创建为 DRAFT；定价审批通过（APPROVED）前不可出货（红线） */
  create: (input: SpecialOrderInput) =>
    request<SpecialOrderDTO>('/special-orders', { method: 'POST', body: input }),
  /** DRAFT → PENDING_PRICE，并在审批中心生成待办（PRICE_SPECIAL 线） */
  submit: (id: string) =>
    request<SpecialOrderDTO>(`/special-orders/${id}/submit`, { method: 'POST', body: {} }),
  /** APPROVED → CONVERTED，生成正式订单 */
  convert: (id: string, idemKey: string) =>
    request<SpecialOrderConvertResultDTO>(`/special-orders/${id}/convert`, {
      method: 'POST',
      body: {},
      idemKey,
    }),
};

// ───────────────────────── 退货（P1-T03，F10 + R4 只多不少） ─────────────────────────

export type ReturnStatusDTO = 'PENDING_REVIEW' | 'APPROVED' | 'RECEIVED' | 'CANCELLED';

export interface ReturnLineDTO {
  id: string;
  orderLineId: string;
  productId: string;
  productName?: string | null;
  qty: Decimalish;
  note?: string | null;
}

export interface ReturnOrderDTO {
  id: string;
  returnNo: string;
  sourceOrderId: string;
  /** 列表附带：原订单号 */
  orderNo?: string | null;
  customerId: string;
  customerName?: string | null;
  reason: string;
  status: ReturnStatusDTO;
  receivedAt?: string | null;
  createdAt: string;
  lineCount?: number;
  qtySum?: Decimalish;
  /** 详情接口附带 */
  lines?: ReturnLineDTO[];
}

export interface ReturnInput {
  sourceOrderId: string;
  reason: string;
  lines: Array<{ orderLineId: string; qty: number }>;
}

/** 收货预览：批次回冲 + 应收冲减。依赖后端 PR #1 的 GET /returns/:id/preview-receive。 */
export interface ReturnReceivePreviewDTO {
  batches: Array<{ batchNo?: string | null; productId?: string; productName?: string | null; qty: Decimalish }>;
  arCredit: Decimalish;
}

export const returnsApi = {
  list: (params: { status?: string; page?: number; pageSize?: number }) =>
    request<PageResult<ReturnOrderDTO>>(`/returns${qs(params)}`),
  detail: (id: string) => request<ReturnOrderDTO>(`/returns/${id}`),
  create: (input: ReturnInput, idemKey: string) =>
    request<ReturnOrderDTO>('/returns', { method: 'POST', body: input, idemKey }),
  /** 收货预览。404 表示接口尚未部署；409 表示当前退货单不能收货。 */
  previewReceive: (id: string) => request<ReturnReceivePreviewDTO>(`/returns/${id}/preview-receive`),
  /** 仓库收货确认：批次回冲 + 应收重算（幂等键防重放双写） */
  receive: (id: string, idemKey: string) =>
    request<ReturnOrderDTO>(`/returns/${id}/receive`, { method: 'POST', body: {}, idemKey }),
  /** 待审批退货追加行（数量只增） */
  appendLines: (id: string, lines: Array<{ orderLineId: string; qty: number; note?: string }>) =>
    request<{ appended: number }>(`/returns/${id}/lines`, { method: 'POST', body: { lines } }),
};

// ───────────────────────── 调价（P1-T05，F7 + D08 版本化） ─────────────────────────

export type PriceChangeStatusDTO =
  | 'DRAFT'
  | 'PENDING'
  | 'APPROVED'
  | 'EFFECTIVE'
  | 'REJECTED'
  | 'CANCELLED';

/** 存货增贬值测算（R7/D15：仅登记不自动调账） */
export interface StockImpactDTO {
  onHandQty: Decimalish;
  oldPrice: Decimalish;
  newPrice: Decimalish;
  deltaAmount: Decimalish;
}

export interface PriceChangeDTO {
  id: string;
  productId: string;
  /** 列表接口附带 */
  product?: { skuCode: string; name: string } | null;
  unit: PriceUnitDTO;
  levelType: string;
  oldPrice: Decimalish;
  newPrice: Decimalish;
  effectiveDate: string;
  reason: string;
  stockImpact?: StockImpactDTO | null;
  customerSync: boolean;
  customerSyncResult?: { customers: number; delta?: number } | null;
  status: PriceChangeStatusDTO;
  approvalId?: string | null;
  effectuatedAt?: string | null;
  createdAt: string;
}

export interface PriceChangeInput {
  productId: string;
  unit: PriceUnitDTO;
  levelType: string;
  newPrice: number;
  effectiveDate: string;
  reason: string;
  customerSync?: boolean;
}

export const priceChangesApi = {
  list: (params: { status?: string; page?: number; pageSize?: number }) =>
    request<PageResult<PriceChangeDTO>>(`/price-changes${qs(params)}`),
  /** 创建草稿；响应附带存货增贬值测算 stockImpact（后端按在库量×价差计算） */
  create: (input: PriceChangeInput) =>
    request<PriceChangeDTO>('/price-changes', { method: 'POST', body: input }),
  /** DRAFT → PENDING，生成 PRICE_CHANGE 审批待办（审批中心） */
  submit: (id: string) =>
    request<{ id: string; status: PriceChangeStatusDTO; approvalId: string }>(`/price-changes/${id}/submit`, {
      method: 'POST',
      body: {},
    }),
  /** APPROVED → EFFECTIVE：插入新价格版本行（D08 只新增版本不覆盖历史）；customerSync=true 时同步平移客户专属价 */
  effectuate: (id: string) =>
    request<{ id: string; status: PriceChangeStatusDTO; priceRowId: string; customerSyncResult?: { customers: number; delta: number } | null }>(`/price-changes/${id}/effectuate`, {
      method: 'POST',
      body: {},
    }),
  /** C组 M2-7 一键批量调价：逐单创建+提审（共用批次号） */
  createBatch: (input: { items: Array<{ productId: string; unit?: PriceUnitDTO; levelType: string; newPrice: number }>; effectiveDate: string; reason: string; customerSync?: boolean }) =>
    request<{ batchNo: string; count: number; items: Array<{ id: string; productId: string; oldPrice: number; newPrice: number; approvalId: string }> }>('/price-changes/batch', { method: 'POST', body: input }),
  /** C组: 批次列表（一键调价工作台） */
  listBatches: () =>
    request<Array<{ batchNo: string; createdAt: string; total: number; draft: number; pending: number; approved: number; effective: number; rejected: number; items: Array<{ id: string; approvalId: string | null; product: string; skuCode: string; levelType: string; oldPrice: number; newPrice: number; status: string; customerSync: boolean; customerSyncResult?: { customers: number } | null }> }>>('/price-changes/batch'),
  /** C组: 批量生效（该批次全部已批单一次落价） */
  effectuateBatch: (batchNo: string) =>
    request<{ batchNo: string; applied: number; failed: Array<{ id: string; error: string }> }>(`/price-changes/batch/${encodeURIComponent(batchNo)}/effectuate`, { method: 'POST', body: {} }),
};

// ───────────────────────── 回包装（P1-T04，F11 + 押金台账） ─────────────────────────

export type PackageRecordTypeDTO = 'WITH_ORDER' | 'STANDALONE' | 'OUT';

export interface PackageRecordDTO {
  id: string;
  customerId: string;
  /** 列表接口附带 */
  customer?: { code: string; name: string } | null;
  category: string;
  qty: number;
  type: PackageRecordTypeDTO;
  orderId?: string | null;
  /** OUT（押金退付）为负数 */
  depositPaid: Decimalish;
  note?: string | null;
  createdAt: string;
}

export interface PackageSummaryDTO {
  items: Array<{ category: string; qty: number; deposit: number }>;
  totalDeposit: number;
}

/** 幂等重放时仅返回 { replay: true, summary }，业务字段缺省 */
export interface PackageCreateResultDTO {
  id?: string;
  category?: string;
  qty?: number;
  type?: PackageRecordTypeDTO;
  depositPaid?: Decimalish;
  replay?: boolean;
}

export const packagesApi = {
  /** 各品类押金余额汇总（qty=在押数量，deposit=押金余额） */
  summary: () => request<PackageSummaryDTO>('/packages/summary'),
  list: (params: { customerId?: string; category?: string; type?: string; page?: number; pageSize?: number }) =>
    request<PageResult<PackageRecordDTO>>(`/packages${qs(params)}`),
  /** F11 无单回收（STANDALONE）/ 押金退付（OUT，后端校验余额）；押金=品类 cfg 单价×数量 */
  create: (input: { customerId: string; category: string; qty: number; type: 'STANDALONE' | 'OUT'; note?: string }, idemKey: string) =>
    request<PackageCreateResultDTO>('/packages', { method: 'POST', body: input, idemKey }),
};

// ───────────────────────── 采购（P1-T06，F3 先付 / F4 后付双流程） ─────────────────────────

export type PurchaseTypeDTO = 'PREPAID' | 'POSTPAID';
export type PurchaseStatusDTO =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PAID'
  | 'RECEIVED'
  | 'CANCELLED';

export interface PurchaseLineDTO {
  id: string;
  productId: string;
  /** 列表/详情接口附带 */
  product?: { name: string; skuCode: string } | null;
  batchNo: string;
  qty: Decimalish; // 最小单位
  unitCost: Decimalish;
  produceDate?: string | null;
  expiryDate?: string | null;
}

export interface PurchaseOrderDTO {
  id: string;
  purNo: string;
  supplier: string;
  type: PurchaseTypeDTO;
  status: PurchaseStatusDTO;
  totalAmount: Decimalish;
  payeeNote?: string | null;
  paidAt?: string | null;
  receivedAt?: string | null;
  note?: string | null;
  createdAt: string;
  /** 列表/详情接口均附带 */
  lines?: PurchaseLineDTO[];
}

export interface PurchaseInput {
  supplier: string;
  type: PurchaseTypeDTO;
  payeeNote?: string;
  note?: string;
  lines: Array<{
    productId: string;
    batchNo: string;
    qty: number;
    unitCost: number;
    produceDate?: string;
    expiryDate?: string;
  }>;
}

export const purchasesApi = {
  list: (params: { status?: string; page?: number; pageSize?: number }) =>
    request<PageResult<PurchaseOrderDTO>>(`/purchases${qs(params)}`),
  detail: (id: string) => request<PurchaseOrderDTO>(`/purchases/${id}`),
  create: (input: PurchaseInput) => request<PurchaseOrderDTO>('/purchases', { method: 'POST', body: input }),
  /** DRAFT → PENDING_APPROVAL，生成 PURCHASE 审批待办 */
  submit: (id: string) =>
    request<{ id: string; status: PurchaseStatusDTO; approvalId: string }>(`/purchases/${id}/submit`, {
      method: 'POST',
      body: {},
    }),
  /** 登记付款：F3=APPROVED 后 / F4=RECEIVED 后（资金动作，幂等键必传） */
  pay: (id: string, idemKey: string, note?: string) =>
    request<{ purNo: string; status: PurchaseStatusDTO; amount: number }>(`/purchases/${id}/pay`, {
      method: 'POST',
      body: { note },
      idemKey,
    }),
  /** 收货入库：F3=PAID 后 / F4=APPROVED 后；批次建/补 + IN 流水 + COST 价版本 */
  receive: (id: string) =>
    request<{
      purNo: string;
      status: PurchaseStatusDTO;
      batches: Array<{ productId: string; batchNo: string; qty: number }>;
      costPriceVersions: number;
    }>(`/purchases/${id}/receive`, { method: 'POST', body: {} }),
};

// ───────────────────────── 盘点（P1-T07，Q11 仓管盘→内勤核对→超阈值报老板→调账） ─────────────────────────

export type StocktakeTypeDTO = 'SPOT' | 'FULL';
export type StocktakeStatusDTO =
  | 'DRAFT'
  | 'COUNTED'
  | 'RECONCILED'
  | 'PENDING_APPROVAL'
  | 'ADJUSTED'
  | 'CANCELLED';

export interface StocktakeLineDTO {
  id: string;
  productId: string;
  batchId: string;
  /** 详情接口附带（商品名挂在批次上） */
  batch?: { batchNo: string; product?: { skuCode: string; name: string } | null } | null;
  systemQty: Decimalish; // 建单时账面快照
  countedQty: Decimalish; // 实盘（建单预填=账面，录实盘覆盖）
  unitCost: Decimalish;
}

export interface StocktakeDTO {
  id: string;
  takeNo: string;
  type: StocktakeTypeDTO;
  status: StocktakeStatusDTO;
  countedById: string;
  /** 列表接口附带（仓管·盘） */
  countedBy?: { id: string; name: string } | null;
  reconciledById?: string | null;
  /** 列表接口附带（内勤·核，双签另一环） */
  reconciledBy?: { id: string; name: string } | null;
  thresholdOver: boolean;
  diffAmount?: Decimalish | null; // 成本口径差异金额
  note?: string | null;
  countedAt?: string | null;
  reconciledAt?: string | null;
  adjustedAt?: string | null;
  createdAt: string;
  /** 详情接口附带（建单即生成账面快照行） */
  lines?: StocktakeLineDTO[];
  lineCount?: number;
}

export const stocktakesApi = {
  list: (params: { status?: string; page?: number; pageSize?: number }) =>
    request<PageResult<StocktakeDTO>>(`/stocktakes${qs(params)}`),
  detail: (id: string) => request<StocktakeDTO>(`/stocktakes/${id}`),
  /** 建单（仓管/老板）：类型+范围（全部商品或品类），响应附带行=账面快照 */
  create: (input: { type: StocktakeTypeDTO; category?: ProductCategoryDTO }) =>
    request<StocktakeDTO>('/stocktakes', { method: 'POST', body: input }),
  /** 仓管录实盘（DRAFT/COUNTED 可重复录）→ COUNTED */
  count: (id: string, lines: Array<{ id: string; countedQty: number }>) =>
    request<{ id: string; status: StocktakeStatusDTO }>(`/stocktakes/${id}/count`, {
      method: 'POST',
      body: { lines },
    }),
  /** 内勤核对差异 → RECONCILED；差异超阈值 → PENDING_APPROVAL（thresholdOver=true，STOCKTAKE 审批线） */
  reconcile: (id: string) =>
    request<{ id: string; status: StocktakeStatusDTO; thresholdOver: boolean; diffAmount?: Decimalish | null }>(
      `/stocktakes/${id}/reconcile`,
      { method: 'POST', body: {} },
    ),
  /** 调账落账（内勤/老板，仅 RECONCILED）：差异行写 ADJUST 流水（盘盈 IN/盘亏 OUT），幂等拒绝 */
  adjust: (id: string) =>
    request<{ id: string; status: StocktakeStatusDTO; adjustedLines: number }>(`/stocktakes/${id}/adjust`, {
      method: 'POST',
      body: {},
    }),
};

// ───────────────────────── 优惠返利（P1-T08，D02 b/c 互斥·月末核算货补/票折） ─────────────────────────

export type RebateTypeDTO = 'B' | 'C';
export type RebateSettleTypeDTO = 'GOODS' | 'INVOICE' | 'CASH';

/** 坎级阶梯（C组 M3-2）：月累计基数取最高命中档 */
export interface RebateTierDTO {
  minAmount: number;
  rate: number;
}

export interface RebateSchemeDTO {
  id: string;
  customerId: string;
  /** 列表接口附带 */
  customer?: { code: string; name: string } | null;
  type: RebateTypeDTO;
  rate: Decimalish; // 单一费率(无坎级时)
  tiers?: Array<{ minAmount: Decimalish; rate: Decimalish }> | null;
  note?: string | null;
  validFrom: string;
  validTo?: string | null;
  closedAt?: string | null;
  createdById: string;
  createdAt: string;
}

export interface RebateSettlementDTO {
  id: string;
  customerId: string;
  /** 列表接口附带 */
  customer?: { code: string; name: string } | null;
  schemeId: string;
  period: string; // YYYY-MM
  baseAmount: Decimalish; // 计提基数（当月回款−瓶箱押金口径）
  rebateAmount: Decimalish;
  settleType: RebateSettleTypeDTO;
  status: string; // DRAFT→CONFIRMED
  confirmedAt?: string | null;
  note?: string | null;
  createdAt: string;
}

/** 核算测算：基数=当月回款−瓶箱押金支出，返利额=基数×费率 */
export interface RebateSettlementPreviewDTO {
  customerId: string;
  period: string;
  schemeType?: RebateTypeDTO;
  rate?: Decimalish;
  payments?: Decimalish;
  bottlesDeposit?: Decimalish;
  baseAmount: Decimalish;
  rebateAmount: Decimalish;
  [key: string]: unknown;
}

export const rebatesApi = {
  listSchemes: (params: { customerId?: string }) =>
    request<RebateSchemeDTO[]>(`/rebates/schemes${qs(params)}`),
  /** 同客户已有生效中方案 → 409（D02 b/c 互斥），前端捕获展示；生效起始=创建当天（无 validFrom 入参） */
  createScheme: (input: { customerId: string; type: RebateTypeDTO; rate: number; tiers?: RebateTierDTO[]; validTo?: string; note?: string }) =>
    request<RebateSchemeDTO>('/rebates/schemes', { method: 'POST', body: input }),
  closeScheme: (id: string) =>
    request<{ id: string; closed: boolean }>(`/rebates/schemes/${id}/close`, { method: 'POST', body: {} }),
  previewSettlement: (input: { customerId: string; period: string }) =>
    request<RebateSettlementPreviewDTO>('/rebates/settlements/preview', { method: 'POST', body: input }),
  /** GOODS=货补（走随单赠下单）/ INVOICE=票折（REBATE_OFFSET 冲应收）/ CASH=现金（REBATE 费用单）；资金动作加幂等键防重放 */
  createSettlement: (input: { customerId: string; period: string; settleType: RebateSettleTypeDTO; note?: string }, idemKey: string) =>
    request<RebateSettlementDTO>('/rebates/settlements', { method: 'POST', body: input, idemKey }),
  listSettlements: (params: { period?: string }) =>
    request<RebateSettlementDTO[]>(`/rebates/settlements${qs(params)}`),
};

// ───────────────────────── 随单赠·买N送M（C组 M3-1） ─────────────────────────

export interface PromotionDTO {
  id: string;
  kind: 'BUY_N_GET_M';
  productId: string;
  productName: string;
  skuCode: string;
  giftProductId: string | null;
  giftProductName: string;
  buyQty: number;
  giftQty: number;
  unit: 'BASE' | 'MIN';
  unitLabel: string;
  validFrom: string;
  validTo?: string | null;
  closedAt?: string | null;
  note?: string | null;
  active: boolean;
}

export const promotionsApi = {
  list: (active?: boolean) => request<PromotionDTO[]>(`/promotions${active ? '?active=1' : ''}`),
  create: (input: { productId: string; giftProductId?: string; buyQty: number; giftQty: number; unit?: 'BASE' | 'MIN'; validTo?: string; note?: string }) =>
    request<PromotionDTO>('/promotions', { method: 'POST', body: input }),
  close: (id: string, reason: string) =>
    request<{ id: string; closed: boolean }>(`/promotions/${id}/close`, { method: 'POST', body: { reason } }),
};

// ───────────────────────── 对账中心（P1-T10，月结对账·差异四类） ─────────────────────────

export type StatementStatusDTO = 'GENERATED' | 'SENT' | 'CONFIRMED' | 'DISPUTED' | 'RESOLVED';
export type DisputeTypeDTO = 'MISSING_ORDER' | 'PRICE' | 'GIFT' | 'RETURN';
export type DisputeStatusDTO = 'OPEN' | 'RESOLVED';

/** 对账单明细行（lines Json 摘要：期间应收单据号/类型/金额/日期/未结） */
export interface StatementLineDTO {
  docNo: string;
  type?: string | null;
  total?: Decimalish;
  settledInPeriod?: Decimalish;
  open?: Decimalish;
  generatedAt?: string | null;
  dueDate?: string | null;
  dispute?: boolean | null;
}

export interface DisputeItemDTO {
  id: string;
  statementId: string;
  type: DisputeTypeDTO;
  content: string;
  resolution?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  status: DisputeStatusDTO;
  createdAt: string;
}

export interface StatementDTO {
  id: string;
  statementNo: string;
  customerId: string;
  period: string; // YYYY-MM
  totalCharged: Decimalish; // 当期发生（期间应收 CHARGE）
  totalSettled: Decimalish; // 当期核销（期间 SETTLE+REBATE_OFFSET）
  openBalance: Decimalish; // 期末未结（客户当前 open 合计）
  lines?: StatementLineDTO[];
  status: StatementStatusDTO;
  sentAt?: string | null;
  confirmedAt?: string | null;
  note?: string | null;
  createdAt: string;
  /** 列表/详情接口附带 */
  customer?: { code: string; name: string } | null;
  /** 详情接口附带（差异工作池） */
  disputes?: DisputeItemDTO[];
}

export const statementsApi = {
  list: (params: { status?: string; customerId?: string; period?: string }) =>
    request<StatementDTO[]>(`/statements${qs(params)}`),
  detail: (id: string) => request<StatementDTO>(`/statements/${id}`),
  /** 按客户+月份生成（tenant+customer+period 唯一，重复 409）；响应含 lines 摘要 */
  generate: (input: { customerId: string; period: string }) =>
    request<StatementDTO>('/statements/generate', { method: 'POST', body: input }),
  /** GENERATED → SENT（推送后客户 miniapp 可见，可确认或提异议） */
  send: (id: string) => request<StatementDTO>(`/statements/${id}/send`, { method: 'POST', body: {} }),
  /** 差异处理（结论必填）；该单全部差异处理完自动 RESOLVED。修 P1: 原路径缺 /statements 前缀 → 404 */
  resolveDispute: (disputeId: string, resolution: string) =>
    request<{ id: string; status: DisputeStatusDTO }>(`/statements/disputes/${disputeId}/resolve`, {
      method: 'POST',
      body: { resolution },
    }),
};

// ───────────────────────── 一键报表（P1-T11，月报表/库存表） ─────────────────────────

export interface MonthlyCategoryRowDTO {
  category: string;
  amount: Decimalish;
}

export interface MonthlyRepRowDTO {
  repId: string;
  name: string;
  salesAmount: Decimalish;
  paymentAmount?: Decimalish | null;
  orderCount?: number | null;
}

export interface MonthlyTopProductDTO {
  productId: string;
  skuCode: string;
  name: string;
  qty: Decimalish;
  amount: Decimalish;
}

/** GET /reports/monthly 响应：经营汇总 + 品类/业务员/商品三张表 */
export interface MonthlyReportDTO {
  month: string;
  salesByCategory: MonthlyCategoryRowDTO[];
  repRanking: MonthlyRepRowDTO[];
  topProducts: MonthlyTopProductDTO[]; // Top10
  summary: {
    charged: Decimalish; // 应收发生（当月签收）
    collected: Decimalish; // 收款（当月确认）
    returned: Decimalish; // 退货金额（当月收货）
    purchased: Decimalish; // 采购金额（当月收货）
    open?: Decimalish | null; // 期末未结（附注）
  };
  generatedAt?: string;
}

export interface InventoryReportItemDTO {
  productId: string;
  skuCode: string;
  name: string;
  batchNo: string;
  onHand: Decimalish;
  unitCost: Decimalish;
  amount: Decimalish; // 在库 × 单位成本
}

/** GET /reports/inventory 响应：批次级在库成本明细 */
export interface InventoryReportDTO {
  items: InventoryReportItemDTO[];
  totalAmount?: Decimalish | null;
  generatedAt?: string;
}

/** C组 M10-2 毛利分析行 */
export interface GrossProfitRowDTO {
  key: string;
  name: string;
  revenue: number;
  cost: number;
  profit: number;
  margin: number | null;
}

export interface GrossProfitDTO {
  month: string;
  dimension: 'category' | 'customer' | 'rep' | 'product';
  rows: GrossProfitRowDTO[];
  totals: { revenue: number; cost: number; profit: number; margin: number | null; orderCount: number };
  caliber: string;
}

export const reportsApi = {
  monthly: (month: string) => request<MonthlyReportDTO>(`/reports/monthly${qs({ month })}`),
  inventory: () => request<InventoryReportDTO>('/reports/inventory'),
  grossProfit: (month: string, dimension: string) =>
    request<GrossProfitDTO>(`/reports/gross-profit${qs({ month, dimension })}`),
};

// ───────────────────────── 绩效工资（P1-T09，D5 回款70/拜访20/新客10·可复算） ─────────────────────────

/** 绩效指标行（GET /performance）；工资表 items 同构，baseSalary/total 为工资表口径 */
export interface PerformanceItemDTO {
  repId: string;
  name: string;
  paymentAmount: Decimalish; // 当月回款（确认收款×客户归属 D5）
  newCustomers: number;
  visitCount: number; // T13 拜访接入前预留 0
  returnDeduction: Decimalish; // 退货冲减（当期冲减不回算）
  commission: Decimalish; // 提成测算
  baseSalary?: Decimalish | null; // 底薪（cfg）
  total?: Decimalish | null; // 合计=底薪+提成
}

export interface PayrollDTO {
  id: string;
  month: string; // YYYY-MM
  items: PerformanceItemDTO[];
  totalAmount: Decimalish;
  status: string; // DRAFT→CONFIRMED
  confirmedAt?: string | null;
  generatedBy: string;
  createdAt: string;
}

/** GET /performance 响应：{month, items, generatedAt} */
export interface PerformanceResultDTO {
  month: string;
  items: PerformanceItemDTO[];
  generatedAt: string;
}

export const payrollApi = {
  /** 当月绩效口径：回款=确认收款×客户归属；拜访数待 T13 接入 */
  performance: (month: string) => request<PerformanceResultDTO>(`/performance${qs({ month })}`),
  /** 按当月绩效一键生成/复算工资表（tenant+month 唯一，覆盖重算；已确认月份后端拒绝） */
  generate: (month: string) => request<PayrollDTO>('/payroll/generate', { method: 'POST', body: { month } }),
  /** 指定月份工资表；未生成（404）归一为 null 走空态 */
  get: async (month: string): Promise<PayrollDTO | null> => {
    try {
      return await request<PayrollDTO>(`/payroll${qs({ month })}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  /** 确认发放（owner） */
  confirm: (id: string) => request<PayrollDTO>(`/payroll/${id}/confirm`, { method: 'POST', body: {} }),
};

// ───────────────────────── 转单草稿（P1-T12，语音/拍照/文字 → 可编辑草稿 → 确认转单） ─────────────────────────

export type DraftSourceDTO = 'VOICE' | 'PHOTO' | 'TEXT';
export type DraftStatusDTO = 'PENDING_REVIEW' | 'CONFIRMED' | 'DISCARDED';

/** 草稿行（items Json：productName 原文，productId 空=未匹配需人工选） */
export interface DraftItemDTO {
  productName: string;
  productId?: string | null;
  qty: number;
  unit: string; // 原文口径（箱/瓶）
  unitPrice?: number | null;
  priceHint?: number | null;
  aliasMatched?: boolean;
}

export interface OrderDraftDTO {
  id: string;
  draftNo: string;
  source: DraftSourceDTO;
  rawText?: string | null;
  photoUrl?: string | null;
  customerId?: string | null;
  customerHint?: string | null;
  items: DraftItemDTO[];
  confidence: number;
  ambiguities?: string[] | null;
  engine?: string | null;
  status: DraftStatusDTO;
  convertedOrderId?: string | null;
  createdAt: string;
  /** 后端附带：confidence < 0.7 低置信度强提示（红线：必须逐项人工核对） */
  lowConfidence: boolean;
}

export interface DraftEngineStatusDTO {
  engine: string;
  available: boolean;
  baseUrl: string;
}

/** 确认转单结果：只建 PENDING_CONFIRM 订单（D16 红线：不可能直接出库） */
export interface DraftConfirmResultDTO {
  draftNo: string;
  orderId: string;
  orderNo: string;
  orderStatus: string;
}

export const draftsApi = {
  engineStatus: () => request<DraftEngineStatusDTO>('/drafts/engine-status'),
  list: (params: { status?: DraftStatusDTO; page?: number; pageSize?: number }) =>
    request<PageResult<OrderDraftDTO>>(`/drafts${qs(params)}`),
  create: (input: { source: DraftSourceDTO; text?: string; photoUrl?: string }) =>
    request<OrderDraftDTO>('/drafts', { method: 'POST', body: input }),
  /** 可编辑红线：人工修正客户/items（仅 PENDING_REVIEW） */
  update: (id: string, input: { customerId?: string; items?: DraftItemDTO[] }) =>
    request<OrderDraftDTO>(`/drafts/${id}`, { method: 'PATCH', body: input }),
  confirm: (
    id: string,
    input: { customerId?: string; lines?: Array<{ productId: string; qty: number; unit: 'BASE' | 'MIN'; priceOverride?: number }>; learnAliases?: boolean },
    idemKey: string,
  ) =>
    request<DraftConfirmResultDTO>(`/drafts/${id}/confirm`, { method: 'POST', body: input, idemKey }),
  /** 废弃（仅 PENDING_REVIEW）；reason 选填，服务端 DTO 暂未收该字段（whitelist 剥离，不报错） */
  discard: (id: string, reason?: string) =>
    request<{ id: string; status: DraftStatusDTO }>(`/drafts/${id}/discard`, { method: 'POST', body: reason ? { reason } : {} }),
};

// ───────────────────────── 别名词典（P1-T12，Q13 确认转单自动学习） ─────────────────────────

export type AliasKindDTO = 'PRODUCT' | 'CUSTOMER';

export interface AliasEntryDTO {
  id: string;
  kind: AliasKindDTO;
  key: string;
  targetId: string;
  source: string; // MANUAL / AUTO_LEARNED
  hitCount: number;
  createdAt: string;
}

export const aliasesApi = {
  list: (kind: AliasKindDTO) => request<AliasEntryDTO[]>(`/aliases${qs({ kind })}`),
  /** key 服务端小写规范化且 ≥2 字符；同 (kind,key) upsert 覆盖目标 */
  add: (input: { kind: AliasKindDTO; key: string; targetId: string }) =>
    request<AliasEntryDTO>('/aliases', { method: 'POST', body: input }),
  remove: (id: string) => request<{ ok: boolean }>(`/aliases/${id}`, { method: 'DELETE' }),
};
