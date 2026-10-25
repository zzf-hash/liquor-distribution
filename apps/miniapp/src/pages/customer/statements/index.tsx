import { useRef, useState } from 'react'
import { rememberIdemKey } from '../../../services/idempotency'
import type { IdemSlot } from '../../../services/idempotency'
import { Button, Picker, Text, Textarea, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import {
  DISPUTE_TYPE_LABELS,
  STATEMENT_STATUS_LABELS,
  fmtDate,
  fmtMoney,
  getToken,
  statementsApi,
} from '../../../services/api'
import type { DisputeType, StatementDTO } from '../../../services/api'
import { APP_ROLE } from '../../../config/app-role'
import TabsScroll from '../../../components/TabsScroll'
import { loggedOutLoginPage } from '../../../services/package-login-gate'
import { redirectIfStaffOnCustomerPage } from '../../../services/customer-page-redirect'
import './index.scss'

type TabKey = 'SENT' | 'CONFIRMED' | 'DISPUTED' | 'ALL'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'SENT', label: '待我确认' },
  { key: 'CONFIRMED', label: '已确认' },
  { key: 'DISPUTED', label: '有异议' },
  { key: 'ALL', label: '全部' },
]

const STATUS_TONES: Record<string, string> = {
  GENERATED: 'muted',
  SENT: 'warn',
  CONFIRMED: 'ok',
  DISPUTED: 'danger',
  RESOLVED: 'ok',
}

interface DisputeDraft {
  type: DisputeType
  content: string
}

/**
 * 月结对账单（M9-5 客户侧）：内勤生成并推送后，客户在这里
 * 查看当期应收/核销/期末未结 → 「确认无误」或「提差异」（漏单/价格/赠品/退货四类，
 * 提交后进内勤差异工作池逐条处理）。文案红线：只说"待结金额"口径。
 */
export default function CustomerStatementsPage() {
  const [tab, setTab] = useState<TabKey>('SENT')
  const [rows, setRows] = useState<StatementDTO[]>([])
  const [expandedId, setExpandedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [disputeFor, setDisputeFor] = useState<StatementDTO | null>(null)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: loggedOutLoginPage(APP_ROLE) })
      return
    }
    if (redirectIfStaffOnCustomerPage('pages/customer/statements/index')) return
    void load(tab)
  })

  async function load(status: TabKey) {
    setLoading(true)
    setError('')
    try {
      const res = await statementsApi.list(status === 'ALL' ? undefined : status)
      setRows(res ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载对账单失败')
    } finally {
      setLoading(false)
    }
  }

  function switchTab(next: TabKey) {
    if (tab === next) return
    setTab(next)
    setExpandedId('')
    void load(next)
  }

  async function toggleDetail(s: StatementDTO) {
    if (expandedId === s.id) {
      setExpandedId('')
      return
    }
    setExpandedId(s.id)
    if (!s.lines) {
      try {
        const detail = await statementsApi.detail(s.id)
        setRows((prev) => prev.map((r) => (r.id === s.id ? { ...r, lines: detail.lines ?? [] } : r)))
      } catch (e) {
        Taro.showToast({ title: e instanceof Error ? e.message : '加载明细失败', icon: 'none' })
      }
    }
  }

  async function confirmStatement(s: StatementDTO) {
    if (confirming) return
    const ok = await new Promise<boolean>((resolve) => {
      Taro.showModal({
        title: `确认 ${s.period} 对账单`,
        content: `当期应付 ¥${fmtMoney(s.totalCharged).slice(1)}，已结 ¥${fmtMoney(s.totalSettled).slice(1)}，期末待结 ¥${fmtMoney(s.openBalance).slice(1)}。确认数字无误吗？`,
        confirmText: '确认无误',
        confirmColor: '#7A1F2B',
        success: (r) => resolve(Boolean(r.confirm)),
        fail: () => resolve(false),
      })
    })
    if (!ok) return
    setConfirming(true)
    try {
      await statementsApi.confirm(s.id)
      Taro.showToast({ title: '已确认', icon: 'success' })
      void load(tab)
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '确认失败', icon: 'none' })
    } finally {
      setConfirming(false)
    }
  }

  return (
    <View className='slist'>
      <View className='topbar'>
        <Text className='topbar__title'>月结对账单</Text>
        <Text className='topbar__link' onClick={() => Taro.navigateBack()}>返回</Text>
      </View>

      <TabsScroll>
        {TABS.map((t) => (
          <Button
            key={t.key}
            className={`tabs__btn ${tab === t.key ? 'tabs__btn--on' : ''}`}
            onClick={() => switchTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </TabsScroll>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load(tab) }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='slist__tip'>正在加载…</Text>
      ) : rows.length === 0 ? (
        <View className='state'>
          <Text className='state__txt'>暂无对账单</Text>
          <Text className='slist__tip'>每月初系统自动生成上月对账单并推送</Text>
        </View>
      ) : (
        <View className='slist__body'>
          {rows.map((s) => (
            <View key={s.id} className='scard'>
              <View className='scard__row' onClick={() => { void toggleDetail(s) }}>
                <View className='scard__head'>
                  <Text className='scard__no'>{s.period} 对账单</Text>
                  <Text className={`tag tag--${STATUS_TONES[s.status] ?? 'muted'}`}>
                    {STATEMENT_STATUS_LABELS[s.status] ?? s.status}
                  </Text>
                </View>
                <Text className='scard__arrow'>{expandedId === s.id ? '收起 ▲' : '明细 ▼'}</Text>
              </View>

              <View className='scard__row'>
                <Text className='scard__meta'>当期应付 {fmtMoney(s.totalCharged)} · 已结 {fmtMoney(s.totalSettled)}</Text>
                <Text className='scard__amount'>待结 {fmtMoney(s.openBalance)}</Text>
              </View>
              {s.sentAt && (
                <View className='scard__row'>
                  <Text className='scard__meta'>推送于 {fmtDate(s.sentAt)} · {s.statementNo}</Text>
                </View>
              )}

              {expandedId === s.id && (
                <View className='scard__lines'>
                  {(s.lines ?? []).length === 0 ? (
                    <Text className='scard__meta'>该期无发生额明细</Text>
                  ) : (s.lines ?? []).map((l, i) => (
                    <View key={`${l.docNo}-${i}`} className='sline'>
                      <View className='sline__row'>
                        <Text className='sline__doc'>{l.docNo}{l.generatedBeforePeriod ? '（往期单）' : ''}</Text>
                        <Text className='sline__open'>待结 {fmtMoney(l.open)}</Text>
                      </View>
                      <View className='sline__row'>
                        <Text className='sline__meta'>单据 {fmtMoney(l.total)} · 当期已结 {fmtMoney(l.settledInPeriod)}</Text>
                        <Text className='sline__meta'>到期 {fmtDate(l.dueDate)}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}

              {s.status === 'SENT' && (
                <View className='scard__ops'>
                  <Button
                    className='btn-primary btn-sm'
                    disabled={confirming}
                    onClick={() => { void confirmStatement(s) }}
                  >
                    确认无误
                  </Button>
                  <Button className='btn-ghost btn-sm' onClick={() => setDisputeFor(s)}>
                    提差异
                  </Button>
                </View>
              )}
              {s.status === 'DISPUTED' && (
                <Text className='scard__note'>差异已提交，商家处理中；全部处理完自动转「已处理」</Text>
              )}
            </View>
          ))}
          <Text className='slist__tip'>对账口径：当期应付=期间内生成单据；已结=期间内核销（含往期单）；待结=当前未结合计</Text>
        </View>
      )}

      {disputeFor && (
        <DisputePopup
          statement={disputeFor}
          onClose={() => setDisputeFor(null)}
          onSubmitted={() => { setDisputeFor(null); void load(tab) }}
        />
      )}
    </View>
  )
}

// ───────────────────────── 差异提交（四类 + 描述，可多条） ─────────────────────────

const DISPUTE_TYPES: DisputeType[] = ['MISSING_ORDER', 'PRICE', 'GIFT', 'RETURN']

function DisputePopup({
  statement, onClose, onSubmitted,
}: {
  statement: StatementDTO
  onClose: () => void
  onSubmitted: () => void
}) {
  const [items, setItems] = useState<DisputeDraft[]>([{ type: 'MISSING_ORDER', content: '' }])
  const [submitting, setSubmitting] = useState(false)
  const idemRef = useRef<IdemSlot | null>(null)

  function setItem(i: number, patch: Partial<DisputeDraft>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }

  async function submit() {
    const valid = items.filter((it) => it.content.trim())
    if (valid.length === 0) {
      Taro.showToast({ title: '请至少填写一条差异描述', icon: 'none' })
      return
    }
    setSubmitting(true)
    try {
      const rows = valid.map((it) => ({ type: it.type, content: it.content.trim() }))
      await statementsApi.dispute(statement.id, rows, rememberIdemKey(idemRef, { id: statement.id, rows }))
      idemRef.current = null
      Taro.showToast({ title: '差异已提交', icon: 'success' })
      onSubmitted()
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '提交失败', icon: 'none' })
      setSubmitting(false)
    }
  }

  return (
    <View className='dpop'>
      <View className='dpop__mask' onClick={onClose} />
      <View className='dpop__panel'>
        <Text className='dpop__title'>{statement.period} 对账单 · 提差异</Text>
        {items.map((it, i) => (
          <View key={i} className='dpop__item'>
            <Picker
              mode='selector'
              range={DISPUTE_TYPES.map((t) => DISPUTE_TYPE_LABELS[t])}
              value={DISPUTE_TYPES.indexOf(it.type)}
              onChange={(e) => setItem(i, { type: DISPUTE_TYPES[Number(e.detail.value)] ?? it.type })}
            >
              <View className='dpop__type'>
                <Text>{DISPUTE_TYPE_LABELS[it.type]}</Text>
                <Text className='dpop__arrow'>›</Text>
              </View>
            </Picker>
            <Textarea
              className='dpop__input'
              placeholder='差异描述（必填），如：10月3日送的一箱青岛没在对账单里'
              value={it.content}
              maxlength={200}
              onInput={(e) => setItem(i, { content: e.detail.value })}
            />
            {items.length > 1 && (
              <Text className='dpop__del' onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}>删除本条</Text>
            )}
          </View>
        ))}
        <Button
          className='btn-inline btn-inline--ghost'
          onClick={() => setItems((prev) => [...prev, { type: 'MISSING_ORDER', content: '' }])}
        >
          ＋ 再加一条
        </Button>
        <View className='dpop__ops'>
          <Button className='btn-neutral' disabled={submitting} onClick={onClose}>取消</Button>
          <Button className='btn-primary' disabled={submitting} onClick={() => { void submit() }}>提交差异</Button>
        </View>
      </View>
    </View>
  )
}
