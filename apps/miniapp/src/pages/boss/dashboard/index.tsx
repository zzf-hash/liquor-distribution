import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro'
import { LOGIN_PAGE, agingApi, dashboardApi, defaultArBucketLabels, fmtDateTime, fmtMoney, getToken, toNum } from '../../../services/api'
import type { ArBucket, FourQuestionsDTO } from '../../../services/api'
import RoleTabBar from '../../../components/RoleTabBar'
import './index.scss'

// 欠款分档（与后端 buckets 键对齐；配色=蓝未到期→橙短逾→红长逾→灰争议）
// M9-3: 档位文案按租户配置下发（默认 30/50/90），拉不到配置时用兜底文案
const BUCKET_TONES: Record<ArBucket, string> = {
  not_due: 'info',
  b1: 'warn',
  b2: 'warn2',
  b3: 'danger2',
  b4: 'danger',
  disputed: 'muted',
}

const BUCKET_ORDER: ArBucket[] = ['not_due', 'b1', 'b2', 'b3', 'b4', 'disputed']

function bucketsOf(labels: Record<ArBucket, string>): Array<{ key: ArBucket; label: string; tone: string }> {
  return BUCKET_ORDER.map((key) => ({ key, label: key === 'disputed' ? '争议款' : labels[key], tone: BUCKET_TONES[key] }))
}

/**
 * 老板四问看板（P1 全员端，GET /dashboard/four-questions）：
 * ①今日销售(签收口径) ②今日回款(确认收款) 两大数；
 * ③谁欠钱=分档条+Top欠款客户 ④什么货快没了=低库存 ⑤哪个业务员强=本月排行。
 * 下拉刷新；口径以后端代码注释为准（今日销售=当日签收净额）。
 */
export default function BossDashboardPage() {
  const [data, setData] = useState<FourQuestionsDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bucketLabels, setBucketLabels] = useState<Record<ArBucket, string>>(defaultArBucketLabels())

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void load()
    agingApi.get().then((r) => setBucketLabels(r.labels)).catch(() => {/* 用默认档位文案 */})
  })

  usePullDownRefresh(() => {
    void load().finally(() => Taro.stopPullDownRefresh())
  })

  async function load() {
    setLoading(true)
    setError('')
    try {
      setData(await dashboardApi.fourQuestions())
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载看板失败')
    } finally {
      setLoading(false)
    }
  }

  if (error) {
    return (
      <View className='page'>
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
        <RoleTabBar />
      </View>
    )
  }
  if (loading || !data) {
    return (
      <View className='page'>
        <Text className='tip'>正在加载看板…</Text>
        <RoleTabBar />
      </View>
    )
  }

  const debtTotal = toNum(data.debt?.total)
  const bucketRows = bucketsOf(bucketLabels).map((b) => ({ ...b, amount: toNum(data.debt?.buckets?.[b.key]) }))
  const barTotal = bucketRows.reduce((s, b) => s + b.amount, 0)

  return (
    <View className='page'>
      <View className='topbar'>
        <Text className='topbar__title'>四问看板</Text>
        <Text className='topbar__link' onClick={() => Taro.navigateTo({ url: '/pages/boss/home/index' })}>工作台</Text>
      </View>

      {/* ①② 今日两大数（销售=签收口径，回款=确认收款） */}
      <View className='dash__metrics'>
        <View className='metric'>
          <Text className='metric__label'>今日销售</Text>
          <Text className='metric__num'>{fmtMoney(data.salesToday?.amount)}</Text>
          <Text className='metric__sub'>签收 {data.salesToday?.orderCount ?? 0} 单（签收口径）</Text>
        </View>
        <View className='metric'>
          <Text className='metric__label'>今日回款</Text>
          <Text className='metric__num'>{fmtMoney(data.collectedToday?.amount)}</Text>
          <Text className='metric__sub'>确认 {data.collectedToday?.paymentCount ?? 0} 笔</Text>
        </View>
      </View>

      {/* ③ 谁欠钱：分档条 + 图例 */}
      <View className='card'>
        <Text className='card__title'>欠款总额 {fmtMoney(debtTotal)}</Text>
        <View className='bar'>
          {barTotal > 0 && bucketRows
            .filter((b) => b.amount > 0)
            .map((b) => (
              <View key={b.key} className={`bar__seg bar__seg--${b.tone}`} style={{ flex: `${b.amount}` }} />
            ))}
        </View>
        <View className='bar__legend'>
          {bucketRows.map((b) => (
            <View key={b.key} className='bar__row'>
              <View className={`bar__dot bar__dot--${b.tone}`} />
              <Text className='bar__label'>{b.label}</Text>
              <Text className='bar__amount'>{fmtMoney(b.amount)}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* ③ Top 欠款客户 */}
      <View className='card'>
        <Text className='card__title'>欠款最多的客户（Top {(data.debt?.topDebtors ?? []).length}）</Text>
        {(data.debt?.topDebtors ?? []).length === 0 ? (
          <Text className='tip'>当前没有欠款</Text>
        ) : (
          (data.debt?.topDebtors ?? []).map((d, i) => (
            <View key={d.customerId} className='dash__rank'>
              <Text className={`dash__rank-no ${i < 3 ? 'dash__rank-no--top' : ''}`}>{i + 1}</Text>
              <Text className='dash__rank-name'>{d.name}</Text>
              <Text className='dash__rank-amount'>{fmtMoney(d.open)}</Text>
            </View>
          ))
        )}
      </View>

      {/* ④ 什么货快没了 */}
      <View className='card'>
        <Text className='card__title'>低库存预警</Text>
        {(data.lowStock ?? []).length === 0 ? (
          <Text className='tip'>库存充足，暂无预警</Text>
        ) : (
          (data.lowStock ?? []).map((p) => (
            <View key={p.productId} className='kv'>
              <Text className='kv__k'>{p.name}{p.skuCode ? `（${p.skuCode}）` : ''}</Text>
              <Text className='dash__stock'>可用 {toNum(p.available)} / 在库 {toNum(p.onHand)}</Text>
            </View>
          ))
        )}
      </View>

      {/* ⑤ 哪个业务员强（本月签收净额） */}
      <View className='card'>
        <Text className='card__title'>业务员排行（本月）</Text>
        {(data.repRanking ?? []).length === 0 ? (
          <Text className='tip'>本月暂无签收数据</Text>
        ) : (
          (data.repRanking ?? []).map((r, i) => (
            <View key={r.userId} className='dash__rank'>
              <Text className={`dash__rank-no ${i < 3 ? 'dash__rank-no--top' : ''}`}>{i + 1}</Text>
              <View className='dash__rank-body'>
                <Text className='dash__rank-name'>{r.name}</Text>
                <Text className='dash__rank-sub'>签收 {r.orderCount} 单</Text>
              </View>
              <Text className='dash__rank-amount'>{fmtMoney(r.salesAmount)}</Text>
            </View>
          ))
        )}
      </View>

      <Text className='tip'>数据生成于 {fmtDateTime(data.generatedAt)}，下拉可刷新</Text>
      <RoleTabBar />
    </View>
  )
}
