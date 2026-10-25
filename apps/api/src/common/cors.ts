/**
 * 浏览器跨域白名单。环境变量 CORS_ORIGINS，逗号分隔。
 *
 * 默认：
 * - 变量未设置且 NODE_ENV=production：不允许任何跨域（同源反代不受影响）。
 * - 变量未设置且不是 production：放行本地 H5（:10086）与管理端 Vite（:5173），
 *   这样本机小程序 H5 直连 API 时预检可以通过。
 * - 变量已设置（含空字符串）：只使用列出的来源，不再套用开发默认。
 *
 * 星号一律丢弃，origin 不会是 '*' 或 true（反射任意来源）。
 */
export const CORS_ORIGINS_ENV = 'CORS_ORIGINS';

export const DEV_CORS_ORIGINS = [
  'http://127.0.0.1:10086',
  'http://localhost:10086',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
] as const;

export interface CorsAllowlistOptions {
  origin: string[] | false;
  methods: string[];
  allowedHeaders: string[];
}

const METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
const HEADERS = ['Content-Type', 'Authorization', 'Idempotency-Key'];

export function parseCorsOrigins(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const origin = part.trim();
    if (!origin || origin === '*') continue;
    seen.add(origin);
  }
  return [...seen];
}

export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.CORS_ORIGINS !== undefined) return parseCorsOrigins(env.CORS_ORIGINS);
  if (env.NODE_ENV === 'production') return [];
  return [...DEV_CORS_ORIGINS];
}

export function buildCorsOptions(env: NodeJS.ProcessEnv = process.env): CorsAllowlistOptions {
  const origins = resolveCorsOrigins(env);
  return {
    origin: origins.length > 0 ? origins : false,
    methods: [...METHODS],
    allowedHeaders: [...HEADERS],
  };
}
