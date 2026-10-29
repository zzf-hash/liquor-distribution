import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import TabsScroll from '../../../components/TabsScroll'
import Taro, { useDidShow } from '@tarojs/taro'
import {
  LOGIN_PAGE,
  agingApi,
  mergeArBucketLabels,
  fmtDate,
  fmtMoney,
  getToken,
  receivablesApi,
} from '../../../services/api'
import type { ArBucket, CustomerReceivableDTO } from '../../../services/api'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'
import HeroHeader from '../../../components/HeroHeader'

// 账龄分档 tab（bucket 对齐后端 AgingBucket；'' = 全部未结）
// M9-3: 档位文案按租户配置下发（默认 30/50/90），tab 短标签取档位天数
const TAB_TONES: Record<string, string> = {
  not_due: 'info',
  b1: 'warn',
  b2: 'warn',
  b3: 'danger',
  b4: 'danger',
  disputed: 'muted',
}

function tabsOf(_labels: Record<ArBucket, string>): Array<{ key: string; label: string; tone: string }> {
  return [
    { key: '', label: '全部', tone: '' },
    { key: 'not_due', label: '未到期', tone: TAB_TONES.not_due },
    { key: 'b1', label: '逾期≤一档', tone: TAB_TONES.b1 },
    { key: 'b2', label: '二档', tone: TAB_TONES.b2 },
    { key: 'b3', label: '三档', tone: TAB_TONES.b3 },
    { key: 'b4', label: '最高档', tone: TAB_TONES.b4 },
    { key: 'disputed', label: '争议', tone: TAB_TONES.disputed },
  ]
}

function displayBucket(labels: Record<ArBucket, string>, key: string): string {
  if (!key) return '全部'
  if (key === 'disputed') return '争议款'
  const raw = labels[key as ArBucket] ?? key
  return raw.replace(/^逾期(?=\d)/, '逾期 ').replace(/天/, ' 天').replace(/\s+/g, ' ').trim()
}

/**
 * 应收台账（P1 全员端，内勤）：GET /receivables?bucket= 分档 tab（未到期/逾期4档/争议）；
 * 行显示 未结 open / 到期日 / 账龄，列表顺序即 FIFO 核销顺序（最早到期在前）。
 */
const PAGE_SIZE = 50

export default function ClerkReceivablesPage() {
  const [tab, setTab] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [openTotal, setOpenTotal] = useState<number | null>(null)
  const [items, setItems] = useState<CustomerReceivableDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bucketLabels, setBucketLabels] = useState(mergeArBucketLabels())

  const tabs = tabsOf(bucketLabels)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void load()
    agingApi.get().then((r) => setBucketLabels(mergeArBucketLabels(r?.labels))).catch(() => setBucketLabels(mergeArBucketLabels()))
  })

  async function load(bucket?: string, nextPage = 1) {
    setLoading(true)
    setError('')
    try {
      const res = await receivablesApi.list({
        bucket: (bucket ?? tab) || undefined,
        page: nextPage,
        pageSize: PAGE_SIZE,
      })
      setItems(res.items ?? [])
      setTotal(res.total ?? res.items?.length ?? 0)
      setOpenTotal(typeof res.openTotal === 'number' ? res.openTotal : null)
      setPage(nextPage)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载应收台账失败')
    } finally {
      setLoading(false)
    }
  }

  function switchTab(next: string) {
    if (tab === next) return
    setTab(next)
    void load(next, 1)
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <View className='page'>
            <HeroHeader title='应收台账' />

      <TabsScroll intoView={`ar-${tab || 'all'}`}>
        {tabs.map((t) => (
          <Button
            id={`ar-${t.key || 'all'}`}
            key={t.key || 'all'}
            className={`tabs__btn ${tab === t.key ? 'tabs__btn--on' : ''}`}
            onClick={() => switchTab(t.key)}
          >
            {displayBucket(bucketLabels, t.key)}
          </Button>
        ))}
      </TabsScroll>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='tip'>正在加载…</Text>
      ) : (
        <>
          <View className='card'>
            <Text className='card__title'>未结合计 · {displayBucket(bucketLabels, tab)}</Text>
            <Text className={`num num--lg ${tab && tab !== 'not_due' && tab !== 'disputed' ? 'num--danger' : ''}`}>
              {openTotal === null ? '—' : fmtMoney(openTotal)}
            </Text>
            <Text className='ar__note'>共 {total} 单</Text>
            <Text className='ar__note'>合计是筛选后的全部未结，不是本页相加。第 {page}/{pageCount} 页，本页 {items.length} 单。</Text>
            <Text className='ar__note'>按到期先后排序，收款按「先到期先结」核销</Text>
          </View>
          {items.length === 0 ? (
            <View className='state'>
              <Text className='state__txt'>该分档下没有未结单据</Text>
            </View>
          ) : (
            items.map((r) => (
              <View key={r.id} className='card arcard'>
                <View className='arcard__row'>
                  <Text className='arcard__doc'>{r.sourceDocNo}</Text>
                  <Text className={`arcard__open num ${r.daysOverdue > 0 ? 'num--danger' : ''}`}>未结 {fmtMoney(r.open)}</Text>
                </View>
                <View className='arcard__row'>
                  <Text className='arcard__cust'>{r.customerName}</Text>
                  <Text className='arcard__due'>到期 {fmtDate(r.dueDate)}</Text>
                </View>
                <View className='arcard__row'>
                  <Text className='arcard__meta'>单据 {fmtMoney(r.total)} · 已结 {fmtMoney(r.settled)}</Text>
                  {r.disputeFlag ? (
                    <Text className='tag tag--muted'>争议款</Text>
                  ) : r.daysOverdue > 0 ? (
                    <Text className='tag tag--danger'>逾期 {r.daysOverdue} 天</Text>
                  ) : (
                    <Text className='tag tag--info'>未到期</Text>
                  )}
                </View>
              </View>
            ))
          )}
          {pageCount > 1 ? (
            <View className='tabs'>
              <Button className='tabs__btn' disabled={page <= 1} onClick={() => { void load(tab, page - 1) }}>上一页</Button>
              <Button className='tabs__btn' disabled={page >= pageCount} onClick={() => { void load(tab, page + 1) }}>下一页</Button>
            </View>
          ) : null}
        </>
      )}
      <RoleTabBar />
    </View>
  )
}
