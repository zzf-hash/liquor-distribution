import { useState } from 'react'
import { Button, Textarea, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

interface ReasonPopupProps {
  visible: boolean
  title: string
  /** 提交按钮文案（通过/驳回/确认取消/确认拒收…） */
  confirmText?: string
  /** 风险弹窗内的最终确认可用危险实心。页面上的入口仍只描边。 */
  danger?: boolean
  placeholder?: string
  /** 意见必填（审批/取消/特批/拒收均必填，服务端强校验） */
  required?: boolean
  /** 点选后写入文本域，不改变提交校验 */
  presets?: string[]
  onSubmit: (text: string) => void
  onClose: () => void
}

/**
 * 意见/原因输入弹层（P1 全员端共用）：遮罩 + 卡片 + 文本域 + 取消/提交。
 * 提交校验非空（必填场景），通过回调交给页面执行写操作；触控元素 ≥ $touch-min。
 */
export default function ReasonPopup(props: ReasonPopupProps) {
  const { visible, title, confirmText = '提交', danger = false, placeholder = '请填写意见（必填）', required = true, presets = [], onSubmit, onClose } = props
  const [text, setText] = useState('')
  const [focus, setFocus] = useState(false)

  if (!visible) return null

  const empty = required && !text.trim()

  function submit() {
    if (empty) {
      Taro.showToast({ title: '意见必填，请填写后再提交', icon: 'none' })
      return
    }
    onSubmit(text.trim())
  }

  function close() {
    setText('')
    onClose()
  }

  return (
    <View className='rp' onClick={close}>
      <View className='rp__panel' onClick={(e) => e.stopPropagation()}>
        <Text className='rp__title'>{title}</Text>
        <Text className='rp__sub'>{required ? '必填，将记录到审批日志' : '选填'}</Text>
        {presets.length > 0 ? (
          <View className='rp__chips'>
            {presets.map((item) => (
              <Text
                key={item}
                className={`rp__chip ${text === item ? 'rp__chip--on' : ''}`}
                onClick={() => setText(item)}
              >
                {item}
              </Text>
            ))}
          </View>
        ) : null}
        <View className='rp__box'>
          <Textarea
            className={`rp__ipt ${focus ? 'rp__ipt--focus' : ''}`}
            placeholder={placeholder}
            maxlength={500}
            value={text}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onInput={(e) => setText(e.detail.value)}
          />
          <Text className='rp__count'>{text.length}/500</Text>
        </View>
        <View className='rp__ops'>
          <Button className='rp__btn rp__btn--ghost' onClick={close}>取消</Button>
          <Button className={`rp__btn ${danger ? 'rp__btn--danger' : ''}`} disabled={empty} onClick={submit}>{confirmText}</Button>
        </View>
      </View>
    </View>
  )
}
