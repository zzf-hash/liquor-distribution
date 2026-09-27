// 真接口通道：统一 fetch 封装（{code:0,data} 信封 / 401 跳登录 / 幂等键）+ 各资源类型化方法。
// 接口契约对齐 apps/api：products/customers/prices(L3 自研) + orders/receivables/payments/imports/users。
import { clearAuth, getAuth } from './auth';
import type { Decimalish } from '../utils/format';

const BASE_URL: string = import.meta.env.VITE_API_BASE || '/api';

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

/** 资金/库存写接口幂等键（P0-03：服务端唯一索引兜底，重试不双写） */
export function genIdemKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  });

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
};

// ───────────────────────── 应收 / 收款（P0-T30~T31） ─────────────────────────

export type ArBucketDTO = 'not_due' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90p' | 'disputed';

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
  createPayment: (input: PaymentInput) =>
    request<PaymentDTO>('/payments', { method: 'POST', body: input, idemKey: genIdemKey() }),
  confirmPayment: (id: string) => request<PaymentDTO>(`/payments/${id}/confirm`, { method: 'POST', body: {} }),
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
