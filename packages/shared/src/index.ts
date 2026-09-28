/**
 * @liquor/shared — liquor-distribution 三端共享契约
 *
 * P0-01 monorepo(技术栈§4.1: pnpm+Turborepo, packages/shared 承载跨端共享契约)。
 * apps/api(NestJS) / apps/admin(React) / apps/miniapp(Taro) 共同依赖本包,
 * 使"API 响应外壳"、"RBAC 角色"、"基础校验器"有唯一权威来源, 避免三端各写一套漂移。
 *
 * 设计铁律:
 *  - 纯 TypeScript, 无任何运行时第三方依赖 → 任意端零成本引入
 *  - 只承载"契约"类型 + 纯函数校验器, 不 import 任何 app 代码、不承载业务逻辑
 */

// ── API 统一响应外壳(对齐 apps/api 全局 ResponseInterceptor / HttpExceptionFilter) ──
// 成功: { code: 0, data }
// 失败: { code: <HTTP 状态码>, message }
//   401=认证失败 403=越权 409=状态机非法转换 422=业务预检拦截 500=内部错误
export interface ApiResponse<T = unknown> {
  code: 0;
  data: T;
}
export interface ApiFailure {
  code: number;
  message: string;
}
export type ApiResult<T = unknown> = ApiResponse<T> | ApiFailure;

/** 语义化状态码常量(与 http-exception.filter 的映射一致, 供三端前端断言 code 使用) */
export const ApiCodes = {
  OK: 0,
  Unauthorized: 401,
  Forbidden: 403,
  Conflict: 409,
  Validation: 422,
  Server: 500,
} as const;

/** 类型守卫: 区分成功外壳(code===0)与失败外壳 */
export function isApiOk<T>(r: ApiResult<T>): r is ApiResponse<T> {
  return r.code === ApiCodes.OK;
}

// ── RBAC 角色(对齐 prisma schema 的 Role 枚举, 五角色) ──
export type Role = 'OWNER' | 'REP' | 'CLERK' | 'WAREHOUSE' | 'CUSTOMER';
export const ROLES: readonly Role[] = ['OWNER', 'REP', 'CLERK', 'WAREHOUSE', 'CUSTOMER'];

/** 类型守卫: 字符串是否为合法角色 */
export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}

// ── 纯校验器(无依赖, 跨端复用; 服务端可再叠加框架级 class-validator) ──

/** 中国大陆手机号: 11 位, 1[3-9] 开头 */
export function isPhone(v: unknown): v is string {
  return typeof v === 'string' && /^1[3-9]\d{9}$/.test(v);
}

/** 正数: 有限且 > 0(金额/数量) */
export function isPositiveAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** 非空字符串(trim 后非空) */
export function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
