import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import ReasonPopup from '../../../components/reason-popup'
import RoleTabBar from '../../../components/RoleTabBar'
import {
  APPROVAL_LINE_LABELS,
  APPROVAL_STATUS_LABELS,
  ApiError,
  LOGIN_PAGE,
  approvalsApi,
  fmtDateTime,
  fmtMoney,
  getToken,
  toNum,
} from '../../../services/api'
import type { ApprovalItemDTO } from '../../../services/api'
import './index.scss'

type TabKey = 'pending' | 'done'

const STATUS_TONES: Record<string, string> = {
  PENDING: 'warn',
  APPROVED: 'ok',
  REJECTED: 'danger',
  EXPIRED_24H: 'muted',
}

/** payload Json 展示：扁平键值（对象/数组 JSON 化，长文本换行截断） */
function payloadEntries(payload: Record<string, unknown> | null | undefined): Array<[string, string]> {
  if (!payload) return []
  return Object.entries(payload).map(([k, v]) => {
    const text = v === null || v === undefined ? '-'
      : typeof v === 'object' ? JSON.stringify(v)
        : String(v)
    return [k, text.length > 120 ? `${text.slice(0, 120)}…` : text] as [string, string]
  })
}

/**
 * 审批中心（P1 全员端，老板/内勤）：tab 待办(PENDING)/已决(APPROVED+REJECTED)，
 * 行展开看 payload 详情；「通过/驳回」弹层意见必填 → POST /approvals/:id/decide。
 * 金额路由（仅老板线/超阈值）由服务端硬校验，行内 approverHint 提示。
 */
export default function BossApprovalsPage() {
  const [tab, setTab] = useState<TabKey>('pending')
  const [items, setItems] = useState<ApprovalItemDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState('')
  const [deciding, setDeciding] = useState<{ id: string; action: 'approve' | 'reject'; title: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void load()
  })

  async function load(which: TabKey = tab) {
    setLoading(true)
    setError('')
    try {
      if (which === 'pending') {
        const res = await approvalsApi.list('PENDING')
        setItems(res.items ?? [])
      } else {
        // 已决 = 已通过 + 已驳回 合并（接口单状态查询），按时间倒序
        const [okRes, rejRes] = await Promise.all([
          approvalsApi.list('APPROVED'),
          approvalsApi.list('REJECTED'),
        ])
        const merged = [...(okRes.items ?? []), ...(rejRes.items ?? [])].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        setItems(merged)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载审批列表失败')
    } finally {
      setLoading(false)
    }
  }

  function switchTab(next: TabKey) {
    if (tab === next) return
    setTab(next)
    setExpanded('')
    void load(next)
  }

  async function decide(opinion: string) {
    if (!deciding || submitting) return
    setSubmitting(true)
    try {
      await approvalsApi.decide(deciding.id, deciding.action, opinion)
      Taro.showToast({ title: deciding.action === 'approve' ? '已通过' : '已驳回', icon: 'success' })
      setDeciding(null)
      void load()
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 403
        ? '该审批须老板本人处理（金额路由）'
        : e instanceof Error ? e.message : '操作失败'
      Taro.showToast({ title: msg, icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className='page'>
      <View className='topbar'>
        <Text className='topbar__title'>审批中心</Text>
        <Text className='topbar__link' onClick={() => Taro.navigateTo({ url: '/pages/boss/home/index' })}>工作台</Text>
      </View>

      <View className='tabs tabs--segment'>
        <Button className={`tabs__btn ${tab === 'pending' ? 'tabs__btn--on' : ''}`} onClick={() => switchTab('pending')}>待办</Button>
        <Button className={`tabs__btn ${tab === 'done' ? 'tabs__btn--on' : ''}`} onClick={() => switchTab('done')}>已决</Button>
      </View>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='tip'>正在加载…</Text>
      ) : items.length === 0 ? (
        <View className='state'>
          <Text className='state__title'>{tab === 'pending' ? '审批都处理完了' : '还没有已决审批'}</Text>
          <Text className='state__txt'>{tab === 'pending' ? '新的审批会在这里提醒你' : '处理过的审批会留在这里'}</Text>
        </View>
      ) : (
        items.map((it) => {
          const open = expanded === it.id
          return (
            <View key={it.id} className='card appr'>
              <View className='appr__head' onClick={() => setExpanded(open ? '' : it.id)}>
                <View className='appr__head-main'>
                  <Text className='appr__title'>{it.title}</Text>
                  <Text className='appr__meta'>
                    {APPROVAL_LINE_LABELS[it.line] ?? it.line} · {it.applicant?.name ?? '-'} · {fmtDateTime(it.createdAt)}
                  </Text>
                </View>
                <Text className='appr__arrow'>{open ? '▾' : '▸'}</Text>
              </View>

              <View className='appr__row'>
                {it.amount !== null && it.amount !== undefined ? (
                  <Text className='appr__amount'>{fmtMoney(toNum(it.amount))}</Text>
                ) : (
                  <Text className='appr__amount appr__amount--none'>无金额</Text>
                )}
                {tab === 'pending' ? (
                  <Text className='tag tag--info'>{it.approverHint ?? ''}</Text>
                ) : (
                  <Text className={`tag tag--${STATUS_TONES[it.status] ?? 'muted'}`}>
                    {APPROVAL_STATUS_LABELS[it.status] ?? it.status}
                  </Text>
                )}
              </View>

              {open && (
                <View className='appr__detail'>
                  <View className='kv'>
                    <Text className='kv__k'>申请理由</Text>
                    <Text className='kv__v'>{it.reason || '-'}</Text>
                  </View>
                  {payloadEntries(it.payload).map(([k, v]) => (
                    <View key={k} className='kv'>
                      <Text className='kv__k'>{k}</Text>
                      <Text className='kv__v'>{v}</Text>
                    </View>
                  ))}
                  {payloadEntries(it.payload).length === 0 && (
                    <Text className='tip'>该审批没有附加明细</Text>
                  )}
                </View>
              )}

              {tab === 'pending' && (
                <View className='appr__ops'>
                  <Button
                    className='btn-inline btn-inline--danger'
                    disabled={submitting}
                    onClick={() => setDeciding({ id: it.id, action: 'reject', title: `驳回：${it.title}` })}
                  >
                    驳回
                  </Button>
                  <Button
                    className='btn-inline'
                    disabled={submitting}
                    onClick={() => setDeciding({ id: it.id, action: 'approve', title: `通过：${it.title}` })}
                  >
                    通过
                  </Button>
                </View>
              )}
            </View>
          )
        })
      )}

      <ReasonPopup
        visible={deciding !== null}
        title={deciding?.title ?? ''}
        confirmText={deciding?.action === 'reject' ? '确认驳回' : '确认通过'}
        danger={deciding?.action === 'reject'}
        presets={deciding?.action === 'reject' ? ['资料不完整', '金额不符', '其他'] : ['同意', '老客户信用良好', '其他']}
        placeholder='审批意见（必填，留痕到审批记录）'
        onSubmit={(text) => { void decide(text) }}
        onClose={() => setDeciding(null)}
      />
      <RoleTabBar />
    </View>
  )
}
