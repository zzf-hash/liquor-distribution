export type HomeEntryKind = 'voice' | 'photo' | 'text'

/** 草稿接口（POST /drafts）角色：OWNER / CLERK / REP。客户角色没有该接口。 */
const DRAFT_ROLES = new Set(['OWNER', 'CLERK', 'REP'])

/**
 * 客户首页入口。
 * 语音：仅当当前登录角色能调草稿接口时保留，并跳到已有语音报单页。
 * 拍照识单：仓库没有识别或上传接口，不展示，也不提示「建设中」。
 * 文字下单：商城下单，始终保留。
 */
export function homeEntriesForRole(role: string | null | undefined): HomeEntryKind[] {
  const entries: HomeEntryKind[] = []
  if (DRAFT_ROLES.has((role ?? '').toUpperCase())) entries.push('voice')
  entries.push('text')
  return entries
}
