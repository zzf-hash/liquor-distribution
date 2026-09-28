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
  convert: (id: string) =>
    request<SpecialOrderConvertResultDTO>(`/special-orders/${id}/convert`, {
      method: 'POST',
      body: {},
      idemKey: genIdemKey(),
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

/** 收货预览：批次回冲 + 应收冲减摘要（可选能力，未就绪时降级直接确认） */
export interface ReturnReceivePreviewDTO {
  batches: Array<{ batchNo?: string | null; productId?: string; productName?: string | null; qty: Decimalish }>;
  arCredit: Decimalish;
}

export const returnsApi = {
  list: (params: { status?: string; page?: number; pageSize?: number }) =>
    request<PageResult<ReturnOrderDTO>>(`/returns${qs(params)}`),
  detail: (id: string) => request<ReturnOrderDTO>(`/returns/${id}`),
  create: (input: ReturnInput) =>
    request<ReturnOrderDTO>('/returns', { method: 'POST', body: input, idemKey: genIdemKey() }),
  /** 收货预览（回冲批次/应收冲减）；接口 404/未实现时调用方直接走确认 */
  previewReceive: (id: string) => request<ReturnReceivePreviewDTO>(`/returns/${id}/preview-receive`),
  /** 仓库收货确认：批次回冲 + 应收重算（幂等键防重放双写） */
  receive: (id: string) =>
    request<ReturnOrderDTO>(`/returns/${id}/receive`, { method: 'POST', body: {}, idemKey: genIdemKey() }),
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
  /** APPROVED → EFFECTIVE：插入新价格版本行（D08 只新增版本不覆盖历史） */
  effectuate: (id: string) =>
    request<{ id: string; status: PriceChangeStatusDTO; priceRowId: string }>(`/price-changes/${id}/effectuate`, {
      method: 'POST',
      body: {},
    }),
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
  create: (input: { customerId: string; category: string; qty: number; type: 'STANDALONE' | 'OUT'; note?: string }) =>
    request<PackageCreateResultDTO>('/packages', { method: 'POST', body: input, idemKey: genIdemKey() }),
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
  pay: (id: string, note?: string) =>
    request<{ purNo: string; status: PurchaseStatusDTO; amount: number }>(`/purchases/${id}/pay`, {
      method: 'POST',
      body: { note },
      idemKey: genIdemKey(),
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
