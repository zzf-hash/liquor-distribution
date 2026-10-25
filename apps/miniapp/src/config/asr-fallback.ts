const ASR_FLAG = 'ld_asr_unavailable'

/** 后端在未配置腾讯云密钥时返回的文案（asr.service / drafts.service）。 */
export function shouldFallbackVoiceToText(message: string): boolean {
  return /ASR 未配置|TENCENT_SECRET|语音转写失败/.test(message)
}

export function readAsrUnavailable(getItem: (key: string) => string): boolean {
  return getItem(ASR_FLAG) === '1'
}

export function markAsrUnavailable(setItem: (key: string, value: string) => void): void {
  setItem(ASR_FLAG, '1')
}
