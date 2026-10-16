// ───────────────────────── 库存预警 + 自动报货（P2） ─────────────────────────
// 复用 services/api.ts 的统一封装; request/qs 为模块内私有函数 → 改为导出(仅本文件新增 export, 不影响既有引用)。
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

export interface StockAlertConfigDTO {
  windowDays: number;
  safetyDays: number;
  coverageDays: number;
  enabled: boolean;
  defaultSupplier: string;
  perProduct?: Record<string, { windowDays?: number; enabled?: boolean }>;
}

export interface StockReportItemDTO {
  id: string;
  skuCode: string;
  name: string;
  category: string;
  onHand: number;
  baseQty: number;
  unitLabel: string;
  sold3d: number;
  sold7d: number;
  soldWindow: number;
  dailyAvg: number;
  thresholdQty: number;
  inTransitQty: number;
  suggestedQty: number;
  level: 'OK' | 'LOW' | 'OUT';
  stockValue: number;
  restock: { id: string; requestId: string; status: string } | null;
}

export interface StockReportDTO {
  reportDate: string;
  summary: { totalValue: number; totalSkus: number; low: number; out: number };
  items: StockReportItemDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RestockRequestDTO {
  id: string;
  requestId: string;
  status: 'PENDING_CLERK' | 'SUBMITTED' | 'APPROVED' | 'DISMISSED' | 'CANCELLED';
  product: { id: string; skuCode: string; name: string; supplier: string | null; packSize: number; unitLabel: string };
  qty: number;
  baseQty: number;
  onHand: number;
  thresholdQty: number;
  dailyAvg: number;
  windowDays: number;
  purchaseId: string | null;
  approvalId: string | null;
  snapshot: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────── 临期预警（M2-3/M7-4 效期维度） ─────────────────────────

export interface ExpiryAlertConfigDTO {
  warnDays: number;
  enabled: boolean;
}

export interface ExpiryItemDTO {
  batchId: string;
  skuCode: string;
  productName: string;
  category: string;
  batchNo: string;
  location: string | null;
  expiryDate: string;
  daysLeft: number;
  level: 'EXPIRED' | 'WARNING';
  onHand: number;
  stockValue: number;
}

export interface ExpiryListDTO {
  warnDays: number;
  items: ExpiryItemDTO[];
  summary: { expired: number; warning: number; valueAtRisk: number };
}

export const stockAlertApi = {
  getConfig: () => request<StockAlertConfigDTO>('/stock-alert/config'),
  saveConfig: (input: Partial<StockAlertConfigDTO>) => request<StockAlertConfigDTO>('/stock-alert/config', { method: 'POST', body: input }),
  run: (create = false) => request<{ reportDate: string; rows: number; alerts: number; created: number }>(`/stock-alert/run${create ? '?create=1' : ''}`, { method: 'POST', body: {} }),
  report: (params: { date?: string; level?: string; page?: number; pageSize?: number }) => request<StockReportDTO>(`/stock-alert/report${qs(params)}`),
  restocks: (params: { status?: string; page?: number; pageSize?: number }) => request<{ items: RestockRequestDTO[]; total: number; page: number; pageSize: number }>(`/stock-alert/restocks${qs(params)}`),
  confirmRestock: (id: string, input: { qty?: number; supplier?: string; type?: string; note?: string }) => request<{ id: string; status: string; purchaseId: string; purNo: string; approvalId: string }>(`/stock-alert/restocks/${id}/confirm`, { method: 'POST', body: input }),
  dismissRestock: (id: string, reason: string) => request<{ id: string; status: string }>(`/stock-alert/restocks/${id}/dismiss`, { method: 'POST', body: { reason } }),
  // 临期预警
  expiry: () => request<ExpiryListDTO>('/stock-alert/expiry'),
  getExpiryConfig: () => request<ExpiryAlertConfigDTO>('/stock-alert/expiry/config'),
  saveExpiryConfig: (input: Partial<ExpiryAlertConfigDTO>) => request<ExpiryAlertConfigDTO>('/stock-alert/expiry/config', { method: 'POST', body: input }),
};
