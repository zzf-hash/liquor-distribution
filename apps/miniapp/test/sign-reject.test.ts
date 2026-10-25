import { describe, expect, it } from 'vitest'
import { rejectConfirmText } from '../src/services/sign-reject'

describe('sign reject copy', () => {
  it('lists each unit instead of one total', () => {
    const text = rejectConfirmText([
      { name: '白酒', unitLabel: '箱', rejected: 1 },
      { name: '啤酒', unitLabel: '瓶', rejected: 2 },
      { name: '足额行', unitLabel: '箱', rejected: 0 },
    ])
    expect(text).toBe('白酒 拒收 1箱\n啤酒 拒收 2瓶\n以上按行回冲，不合并成一个件数。')
    expect(text).not.toContain('共拒收')
  })

  it('returns null when nothing is rejected', () => {
    expect(rejectConfirmText([{ name: '白酒', unitLabel: '箱', rejected: 0 }])).toBeNull()
  })
})
