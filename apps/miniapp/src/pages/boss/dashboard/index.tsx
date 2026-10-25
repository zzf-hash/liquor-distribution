import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Icon from '../../../components/Icon'
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

  const salesCount = data.salesToday?.orderCount ?? 0
  const payCount = data.collectedToday?.paymentCount ?? 0
  const debtors = data.debt?.topDebtors ?? []
  const low = data.lowStock ?? []
  const ranking = data.repRanking ?? []

  return (
    <View className='page'>
      <View className='page-head'>
        <View className='page-head__main'>
          <Text className='page-head__title'>四问看板</Text>
          <Text className='page-head__sub'>更新于 {fmtDateTime(data.generatedAt)}</Text>
        </View>
        <Text className='tag tag--brand'>老板</Text>
      </View>

      <View className='dash__metrics'>
        {salesCount <= 0 ? (
          <View className='card state'>
            <Text className='state__title'>今天还没有签收</Text>
            <Text className='state__txt'>有签收后，这里显示今日销售</Text>
          </View>
        ) : (
          <View className='metric'>
            <Text className='metric__label'>今日销售</Text>
            <Text className='metric__num'>{fmtMoney(data.salesToday?.amount)}</Text>
            <Text className='metric__sub'>签收 {salesCount} 单</Text>
          </View>
        )}
        {payCount <= 0 ? (
          <View className='card state'>
            <Text className='state__title'>今天还没有回款</Text>
            <Text className='state__txt'>确认收款后显示在这里</Text>
          </View>
        ) : (
          <View className='metric'>
            <Text className='metric__label'>今日回款</Text>
            <Text className='metric__num'>{fmtMoney(data.collectedToday?.amount)}</Text>
            <Text className='metric__sub'>已确认 {payCount} 笔</Text>
          </View>
        )}
      </View>

      {debtTotal <= 0 ? (
        <View className='card state'>
          <View className='state__icon'><Icon name='wallet' color='#B3A9A4' size={72} /></View>
          <Text className='state__title'>当前没有欠款</Text>
          <Text className='state__txt'>未结金额出现后，会按账龄分档显示</Text>
        </View>
      ) : (
        <View className='card'>
          <View className='dash__hd'>
            <Text className='card__title'>欠款总额</Text>
            <Text className='num num--md'>{fmtMoney(debtTotal)}</Text>
          </View>
          <View className='bar'>
            {bucketRows.filter((b) => b.amount > 0).map((b) => (
              <View key={b.key} className={`bar__seg bar__seg--${b.key}`} style={{ flex: `${b.amount}` }} />
            ))}
          </View>
          <View className='bar__legend'>
            {bucketRows.map((b) => (
              <View key={b.key} className='bar__row'>
                <View className={`bar__dot bar__dot--${b.key}`} />
                <Text className='bar__label'>{b.label}</Text>
                <Text className='num bar__amount'>{fmtMoney(b.amount)}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {debtors.length === 0 ? null : (
        <View className='card'>
          <Text className='card__title'>欠款最多的客户</Text>
          {debtors.map((d, i) => (
            <View key={d.customerId} className='dash__rank'>
              <Text className={`dash__rank-no ${i === 0 ? 'dash__rank-no--gold' : ''}`}>{i + 1}</Text>
              <Text className='dash__rank-name'>{d.name}</Text>
              <Text className='num dash__rank-amount'>{fmtMoney(d.open)}</Text>
            </View>
          ))}
        </View>
      )}

      {low.length === 0 ? (
        <View className='card state'>
          <Text className='state__title'>库存充足</Text>
          <Text className='state__txt'>暂时没有低库存预警</Text>
        </View>
      ) : (
        <View className='card'>
          <View className='dash__hd'>
            <Text className='card__title'>低库存预警</Text>
            <Text className='tag tag--danger'>{low.length} 项</Text>
          </View>
          {low.map((p) => {
            const available = toNum(p.available)
            return (
              <View key={p.productId} className='kv'>
                <Text className='kv__k'>{p.name}{p.skuCode ? `（${p.skuCode}）` : ''}</Text>
                <Text className={`num dash__stock ${available <= 0 ? 'dash__stock--bad' : 'dash__stock--warn'}`}>
                  可用 {available} / 在库 {toNum(p.onHand)}
                </Text>
              </View>
            )
          })}
        </View>
      )}

      {ranking.length === 0 ? (
        <View className='card state'>
          <Text className='state__title'>本月还没有排行</Text>
          <Text className='state__txt'>有签收后，这里显示业务员回款</Text>
        </View>
      ) : (
        <View className='card'>
          <Text className='card__title'>业务员排行（本月回款）</Text>
          {ranking.map((r, i) => (
            <View key={r.userId} className='dash__rank'>
              <Text className={`dash__rank-no ${i === 0 ? 'dash__rank-no--gold' : ''}`}>{i + 1}</Text>
              <View className='dash__rank-body'>
                <Text className='dash__rank-name'>{r.name}</Text>
                <Text className='dash__rank-sub'>签收 {r.orderCount} 单</Text>
              </View>
              <Text className='num dash__rank-amount'>{fmtMoney(r.paymentAmount || r.salesAmount)}</Text>
            </View>
          ))}
        </View>
      )}

      <View className='dash__links'>
        <Button className='btn-primary' onClick={() => Taro.navigateTo({ url: '/pages/boss/approvals/index' })}>审批中心</Button>
        <Button className='btn-ghost' onClick={() => Taro.navigateTo({ url: '/pages/clerk/orders/index' })}>订单池</Button>
      </View>
      <RoleTabBar />
    </View>
  )
}
