import { useRef, useState } from 'react'
import { Button, Text, Textarea, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { markAsrUnavailable, readAsrUnavailable, shouldFallbackVoiceToText } from '../../../config/asr-fallback'
import { LOGIN_PAGE, draftsApi, fmtDateTime, getToken, toNum } from '../../../services/api'
import RoleTabBar from '../../../components/RoleTabBar'
import type { RepDraftDTO } from '../../../services/api'
import './index.scss'

/** 录音文件 → base64（weapp: FileSystemManager；H5: FileReader） */
function audioToBase64(filePath: string): Promise<string> {
  if (filePath.startsWith('blob:') || filePath.startsWith('http')) {
    return fetch(filePath)
      .then((r) => r.blob())
      .then((blob) => new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = () => reject(new Error('录音读取失败'))
        fr.readAsDataURL(blob)
      }))
  }
  return new Promise<string>((resolve, reject) => {
    Taro.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (r) => resolve(String(r.data)),
      fail: () => reject(new Error('录音读取失败')),
    })
  })
}

/**
 * 业务员语音报单（P1-T12 + C组 ASR，rep token）：
 * 语音模式=按住流程录音 → 停止后自动上传（POST /drafts audioBase64）→ 腾讯云 ASR 转写
 * → qwen 解析成可编辑草稿；转写文本落 rawText 可编辑兜底（红线不变）。
 * ASR 未配置/失败时回退：提示后把录音丢弃，改文字模式提交。确认转单在内勤后台「转单草稿」。
 */
export default function SalesmanVoiceOrderPage() {
  const [mode, setMode] = useState<'voice' | 'text'>(() => (
    readAsrUnavailable((key) => String(Taro.getStorageSync(key) ?? '')) ? 'text' : 'voice'
  ))
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [recordedSec, setRecordedSec] = useState(0)
  const [transcribing, setTranscribing] = useState(false)
  const [result, setResult] = useState<RepDraftDTO | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const rmRef = useRef<ReturnType<typeof Taro.getRecorderManager> | null>(null)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    if (readAsrUnavailable((key) => String(Taro.getStorageSync(key) ?? ''))) {
      setMode('text')
    }
  })

  function fallbackToText(message: string): void {
    if (!shouldFallbackVoiceToText(message)) return
    markAsrUnavailable((key, value) => Taro.setStorageSync(key, value))
    setMode('text')
  }

  /** 停止录音后：录音 → base64 → 后端 ASR+qwen → 草稿（失败回退文字模式） */
  async function submitVoice(res: { tempFilePath: string; duration: number }): Promise<void> {
    setTranscribing(true)
    try {
      const audioBase64 = await audioToBase64(res.tempFilePath)
      const draft = await draftsApi.createVoice({
        audioBase64,
        audioFormat: 'mp3',
        rawText: text.trim() || undefined, // 手敲文字非空时优先人工文本(兜底红线)
      })
      setResult(draft)
      setRecordedSec(Math.round(Number(res.duration) / 1000))
      setText('')
      Taro.showToast({ title: `识别完成, 草稿 ${draft.draftNo}`, icon: 'success' })
    } catch (e) {
      const message = e instanceof Error ? e.message : '语音提交失败, 请改用文字'
      fallbackToText(message)
      Taro.showToast({
        title: shouldFallbackVoiceToText(message) ? '语音识别未配置，已改为文字报单' : message,
        icon: 'none',
        duration: 3000,
      })
    } finally {
      setTranscribing(false)
      setRecordedSec(0)
    }
  }

  /** 录音(C组: 停止即上传转写, 不再只本地留档) */
  function toggleRecord() {
    if (transcribing) return
    if (readAsrUnavailable((key) => String(Taro.getStorageSync(key) ?? ''))) {
      setMode('text')
      Taro.showToast({ title: '语音识别未配置，请直接填写文字', icon: 'none' })
      return
    }
    if (recording) {
      rmRef.current?.stop()
      return
    }
    const rm = Taro.getRecorderManager()
    rm.onStart(() => { setRecording(true); setRecordedSec(0) })
    rm.onStop((res) => {
      setRecording(false)
      void submitVoice(res as unknown as { tempFilePath: string; duration: number })
    })
    rm.onError(() => {
      setRecording(false)
      setMode('text')
      Taro.showToast({ title: '录音失败，已改为文字模式', icon: 'none' })
    })
    rmRef.current = rm
    rm.start({ duration: 60000, format: 'mp3' })
  }

  function switchMode(next: 'voice' | 'text') {
    if (recording) rmRef.current?.stop()
    setMode(next)
  }

  async function submit() {
    if (submitting) return
    if (!text.trim()) {
      Taro.showToast({
        title: mode === 'voice' ? '请先录音或填写口述内容' : '请填写报单内容',
        icon: 'none',
      })
      return
    }
    setSubmitting(true)
    try {
      const res = await draftsApi.create({ source: mode === 'voice' ? 'VOICE' : 'TEXT', text: text.trim() })
      setResult(res)
      setText('')
      setRecordedSec(0)
      Taro.showToast({ title: `草稿已生成 ${res.draftNo}`, icon: 'success' })
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '提交失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className='vo'>
      {/* 报单表单卡 */}
      <View className='vo__card'>
        <Text className='vo__title'>语音报单</Text>

        <View className='vo__modes'>
          <View className={`vo__mode ${mode === 'voice' ? 'vo__mode--on' : ''}`} onClick={() => switchMode('voice')}>
            <Text className='vo__mode-txt'>语音🎙️</Text>
          </View>
          <View className={`vo__mode ${mode === 'text' ? 'vo__mode--on' : ''}`} onClick={() => switchMode('text')}>
            <Text className='vo__mode-txt'>文字📝</Text>
          </View>
        </View>

        {mode === 'voice' && (
          <View className='vo__voice'>
            <Button
              className={`vo__rec ${recording ? 'vo__rec--on' : ''}`}
              loading={transcribing}
              disabled={transcribing}
              onClick={toggleRecord}
            >
              {transcribing
                ? '语音识别中…'
                : recording
                  ? '■ 停止录音并识别'
                  : recordedSec
                    ? `已识别（重录点此）`
                    : '🎙️ 开始录音（口述报单，≤60秒）'}
            </Button>
            <Text className='vo__hint'>
              停止录音后自动上传识别生成草稿（识别文本可编辑兜底）；识别失败或口语过重时，请改用文字模式
            </Text>
          </View>
        )}

        <Text className='vo__label'>报单内容（客户名/电话 + 商品 数量 单位）</Text>
        <Textarea
          className='vo__ipt'
          placeholder='示例：张三店 13800001234 要 泸州老窖特曲 5箱 茅台飞天 2瓶'
          maxlength={1000}
          value={text}
          onInput={(e) => setText(e.detail.value)}
        />

        <Button
          className='btn-primary'
          loading={submitting}
          disabled={submitting}
          onClick={() => { void submit() }}
        >
          生成草稿
        </Button>
      </View>

      {/* 解析结果卡（低置信度红条强提示；确认动作在内勤后台） */}
      {result && (
        <View className='vo__card'>
          <Text className='vo__title'>解析结果 {result.draftNo}</Text>

          {result.lowConfidence && (
            <View className='vo__alert'>
              <Text className='vo__alert-txt'>低置信度，必须逐项人工核对</Text>
            </View>
          )}

          <View className='vo__meta'>
            <Text className='vo__meta-conf'>置信度 {Math.round(toNum(result.confidence) * 100)}%</Text>
            <Text className='vo__meta-time'>{fmtDateTime(result.createdAt)}</Text>
          </View>

          {(result.items ?? []).length === 0 ? (
            <Text className='vo__empty'>引擎未解析出商品行，后台人工填写</Text>
          ) : (
            (result.items ?? []).map((it, i) => (
              <View key={i} className='vo__item'>
                <View className='vo__item-name'>
                  <Text className='vo__item-txt'>{it.productName}</Text>
                  {it.productId ? (
                    it.aliasMatched ? <Text className='vo__tag vo__tag--alias'>别名</Text> : null
                  ) : (
                    <Text className='vo__tag vo__tag--warn'>未匹配</Text>
                  )}
                </View>
                <Text className='vo__item-qty'>{toNum(it.qty)}{it.unit}</Text>
              </View>
            ))
          )}

          {result.ambiguities?.length ? (
            <View className='vo__amb'>
              {result.ambiguities.map((a, i) => (
                <Text key={i} className='vo__amb-txt'>⚠ {a}</Text>
              ))}
            </View>
          ) : null}

          <View className='vo__go'>
            <Text className='vo__go-title'>去后台确认</Text>
            <Text className='vo__go-txt'>
              草稿已进入后台工作台，请到内勤后台「转单草稿」逐项核对并确认转单；转单只进订单池，不会直接出库。
            </Text>
          </View>
        </View>
      )}
      <RoleTabBar />
    </View>
  )
}
