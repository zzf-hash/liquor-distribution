/** 管理端 API 根。空配置走开发代理 `/api`；绝对地址只拼一次 `/api`。 */
export function apiBase(raw = import.meta.env.VITE_API_BASE): string {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return '/api';
  return value.endsWith('/api') ? value : `${value}/api`;
}
