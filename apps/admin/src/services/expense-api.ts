// ───────────────────────── B组 费用域: 费用台账 + 开瓶费 ─────────────────────────
// 复用统一信封封装(与 stock-alert-api.ts 同款轻量 request)。
import { ApiError } from './api';
import { clearAuth, getAuth } from './auth';

const BASE_URL: string = import.meta.env.VITE_API_BASE || '/api';

interface RequestOptions {
  method?: string;
  body?: unknown;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const auth = getAuth();
  const headers = new Headers();
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  if (auth?.token) headers.set('Authorization', `Bearer ${auth.token}`);
  const res = await fetch(`${BASE_URL}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) {
    clearAuth();
    window.location.href = '/login';
    throw new ApiError('登录已过期，请重新登录', 401, 401, null);
  }
  let envelope: { code: number; data?: T; message?: string } | null = null;
  try { envelope = (await res.json()) as { code: number; data?: T; message?: string }; } catch { envelope = null; }
  if (!res.ok || !envelope || envelope.code !== 0) {
    throw new ApiError(envelope?.message || `请求失败（HTTP ${res.status}）`, res.status, envelope?.code ?? res.status, null);
  }
  return envelope.data as T;
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ───────────────────────── 类型 ─────────────────────────

export type ExpenseCategoryDTO = 'OFFICE' | 'FUEL_TOLL' | 'REPAIR' | 'HANDLING' | 'UTILITY' | 'DISPLAY' | 'ENTRY' | 'CAP_FEE' | 'OTHER';
export type ExpenseStatusDTO = 'PENDING_APPROVAL' | 'APPROVED' | 'PAID' | 'REJECTED' | 'CANCELLED';
export type ExpensePayModeDTO = 'CASH' | 'AR_OFFSET';

export interface ExpenseDTO {
  id: string;
  expenseNo: string;
  category: ExpenseCategoryDTO;
  categoryLabel: string;
  title: string;
  amount: number;
  customer: { code: string; name: string } | null;
  payee: string | null;
  occurredAt: string;
  payMode: ExpensePayModeDTO;
  status: ExpenseStatusDTO;
  approvalId: string | null;
  voucherUrl: string | null;
  paidAt: string | null;
  paidNote: string | null;
  note: string | null;
  source: string | null;
  createdAt: string;
}

export interface ExpenseListResultDTO {
  items: ExpenseDTO[];
  total: number;
  amountSum: number;
  page: number;
  pageSize: number;
}

export interface ExpenseSummaryDTO {
  month: string;
  byCategory: Record<string, number>;
  categoryLabels: Record<string, string>;
  paidTotal: number;
  pendingTotal: number;
  offsetTotal: number;
  total: number;
}

export interface CreateExpenseInput {
  category: Exclude<ExpenseCategoryDTO, 'CAP_FEE'>;
  title: string;
  amount: number;
  customerId?: string;
  payee?: string;
  occurredAt?: string;
  payMode?: ExpensePayModeDTO;
  note?: string;
}

export interface CapFeePolicyDTO {
  id: string;
  productId: string;
  skuCode: string;
  productName: string;
  unitLabel: string;
  packSize: number;
  perBottleFee: number;
  requireCap: boolean;
  noCapRate: number;
  validFrom: string;
}

export interface CapRecycleDTO {
  id: string;
  recycleNo: string;
  customerId: string;
  customer: { code: string; name: string };
  status: 'PENDING_CONFIRM' | 'CONFIRMED' | 'CANCELLED';
  lines: Array<{ productId: string; productName: string; qty: number; perBottleFee: number; amount: number }>;
  totalAmount: number;
  expenseId: string | null;
  note: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export const expensesApi = {
  list: (params: { category?: string; status?: string; customerId?: string; month?: string; page?: number; pageSize?: number }) =>
    request<ExpenseListResultDTO>(`/expenses${qs(params)}`),
  summary: (month?: string) => request<ExpenseSummaryDTO>(`/expenses/summary${qs({ month })}`),
  create: (input: CreateExpenseInput) => request<ExpenseDTO>('/expenses', { method: 'POST', body: input }),
  pay: (id: string, input: { voucherUrl?: string; note?: string }) => request<unknown>(`/expenses/${id}/pay`, { method: 'POST', body: input }),
  cancel: (id: string, reason: string) => request<unknown>(`/expenses/${id}/cancel`, { method: 'POST', body: { reason } }),
};

export const capFeesApi = {
  policies: () => request<CapFeePolicyDTO[]>('/cap-fees/policies'),
  savePolicy: (input: { productId: string; perBottleFee: number; requireCap?: boolean; noCapRate?: number }) =>
    request<CapFeePolicyDTO>('/cap-fees/policies', { method: 'POST', body: input }),
  closePolicy: (id: string) => request<unknown>(`/cap-fees/policies/${id}/close`, { method: 'POST', body: {} }),
  recycles: (params?: { status?: string; page?: number; pageSize?: number }) =>
    request<{ items: CapRecycleDTO[]; total: number }>(`/cap-fees/recycles${qs(params ?? {})}`),
  confirmRecycle: (id: string, input: { payMode?: ExpensePayModeDTO }) =>
    request<unknown>(`/cap-fees/recycles/${id}/confirm`, { method: 'POST', body: input }),
  cancelRecycle: (id: string, reason: string) => request<unknown>(`/cap-fees/recycles/${id}/cancel`, { method: 'POST', body: { reason } }),
  accrue: (period?: string) => request<{ period: string; customers: number; expenses: number; totalAmount: number; skipped: number }>(`/cap-fees/accrue${qs({ period })}`, { method: 'POST', body: {} }),
};
