export const VISIT_PHOTO_UNSAVED = '照片只在本机预览，没有上传接口，打卡记录不会保存照片。'

/** 提交体不含 photoUrl。本地临时路径不能写成 pending: 地址。 */
export function visitCreateBody(input: {
  customerId: string
  location?: string
  steps: Record<string, boolean>
  notes?: string
}): { customerId: string; location?: string; steps: Record<string, boolean>; notes?: string } {
  return {
    customerId: input.customerId,
    ...(input.location ? { location: input.location } : {}),
    steps: input.steps,
    ...(input.notes ? { notes: input.notes } : {}),
  }
}
