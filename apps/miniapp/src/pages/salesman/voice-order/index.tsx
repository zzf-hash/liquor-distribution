import { useRef, useState } from 'react'
import { Button, Text, Textarea, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { LOGIN_PAGE, draftsApi, fmtDateTime, getToken, toNum } from '../../../services/api'
import type { RepDraftDTO } from '../../../services/api'
import './index.scss'

/**
 * 业务员语音报单（P1-T12，rep token）：语音/文字两模式 → POST /drafts → 后端 qwen 解析成可编辑草稿。
 * 试点期端侧 ASR 转写未接入：录音仅本地留档（Taro.getRecorderManager），
 * 口述内容请敲成文字后提交（页面有简提示：试点期建议文字）；确认转单在内勤后台
 * 「转单草稿」工作台完成（客户测试期简化，本页只生成草稿）。触控元素均 ≥ $touch-min。
 */
export default function SalesmanVoiceOrderPage() {
  const [mode, setMode] = useState<'voice' | 'text'>('voice')
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [recordedSec, setRecordedSec] = useState(0)
  const [result, setResult] = useState<RepDraftDTO | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const rmRef = useRef<ReturnType<typeof Taro.getRecorderManager> | null>(null)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
    }
  })

  /** 录音（本地留档演示；ASR 转写后续接入。开始前重挂回调，录音中切文字模式自动停） */
  function toggleRecord() {
    if (recording) {
      rmRef.current?.stop()
      return
    }
    const rm = Taro.getRecorderManager()
    rm.onStart(() => setRecording(true))
    rm.onStop((res) => {
      setRecording(false)
      setRecordedSec(Math.round(Number(res.duration) / 1000))
    })
    rm.onError(() => {
      setRecording(false)
      Taro.showToast({ title: '录音失败，请改用文字模式', icon: 'none' })
    })
    rmRef.current = rm
    rm.start({ duration: 60000 })
  }

  function switchMode(next: 'voice' | 'text') {
    if (recording) rmRef.current?.stop()
    setMode(next)
  }

  async function submit() {
    if (submitting) return
    if (!text.trim()) {
      Taro.showToast({
        title: mode === 'voice' ? '请先把口述内容敲成文字' : '请填写报单内容',
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
              onClick={toggleRecord}
            >
              {recording ? '■ 停止录音' : recordedSec ? `已录音 ${recordedSec}s（点此重录）` : '🎙️ 开始录音（口述报单）'}
            </Button>
            <Text className='vo__hint'>
              试点期语音转写未接入：录音仅留档，请把口述内容敲成下方文字后提交（建议直接用文字模式）
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
    </View>
  )
}
