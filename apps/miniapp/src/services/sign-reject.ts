export interface RejectLine {
  name: string
  unitLabel: string
  rejected: number
}

/** 拒收按行说明。箱和瓶不能加成一个件数。 */
export function rejectConfirmText(lines: RejectLine[]): string | null {
  const rows = lines.filter((line) => line.rejected > 0)
  if (rows.length === 0) return null
  const detail = rows.map((line) => `${line.name} 拒收 ${line.rejected}${line.unitLabel}`).join('\n')
  return `${detail}\n以上按行回冲，不合并成一个件数。`
}
