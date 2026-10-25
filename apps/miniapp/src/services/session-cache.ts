/** 本地会话键。退出和切换账号时 token、姓名、角色、用户 id 一起清掉。 */
export const SESSION_KEYS = {
  token: 'ld_token',
  name: 'ld_user',
  role: 'ld_role',
  id: 'ld_uid',
} as const

export interface MemorySession {
  token: string
  role: string
  name: string
  id: string
}

export function emptySession(): MemorySession {
  return { token: '', role: '', name: '', id: '' }
}

export function clearMemorySession(): MemorySession {
  return emptySession()
}

/** 守卫只用这份内存角色。它只在服务端身份写入或清空时更新，不读 ld_role。 */
let confirmedRole = ''

export function setConfirmedRole(role: string | null | undefined): void {
  confirmedRole = (role ?? '').trim()
}

export function confirmedRoleForGuard(): string {
  return confirmedRole
}

export function clearConfirmedRole(): void {
  confirmedRole = ''
}

/**
 * 已有 token 时先吊销，再清本地。logout 失败也清本地，避免旧令牌还留在存储里。
 * 没有 token 时什么都不做。
 */
export async function revokePreviousSession(input: {
  hasToken: boolean
  logout: () => Promise<unknown>
  clear: () => void
}): Promise<'revoked' | 'cleared-after-failure' | 'skipped'> {
  if (!input.hasToken) return 'skipped'
  try {
    await input.logout()
    input.clear()
    return 'revoked'
  } catch {
    input.clear()
    return 'cleared-after-failure'
  }
}

export function sessionFromLogin(login: {
  token: string
  user?: { id?: string | null; name?: string | null; role?: string | null } | null
}): MemorySession {
  return {
    token: login.token,
    role: login.user?.role ?? '',
    name: login.user?.name ?? '',
    id: login.user?.id ?? '',
  }
}

export type MeOutcome =
  | { ok: true; user: { id?: string | null; name?: string | null; role?: string | null } }
  | { ok: false; unauthorized: boolean }

/**
 * 启动时用缓存 token 对过一次后端身份之后的会话。
 * /auth/me 没有成功（401、403、网络失败）或服务端没有 role：清掉 token 和角色，回登录页。
 * 不保留本地 ld_role。没有 token 时不做校验。
 * 成功时角色以服务端为准，覆盖本地缓存。
 */
export function sessionAfterMe(
  session: MemorySession,
  outcome: MeOutcome,
): { session: MemorySession; redirectToLogin: boolean } {
  if (!session.token) return { session, redirectToLogin: false }
  if (!outcome.ok) return { session: emptySession(), redirectToLogin: true }
  const role = (outcome.user.role ?? '').trim()
  if (!role) return { session: emptySession(), redirectToLogin: true }
  return {
    session: {
      token: session.token,
      role,
      name: outcome.user.name ?? session.name,
      id: outcome.user.id ?? session.id,
    },
    redirectToLogin: false,
  }
}
