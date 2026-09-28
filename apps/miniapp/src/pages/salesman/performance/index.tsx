import { useState } from 'react'
import { Button, Picker, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { LOGIN_PAGE, fmtMoney, getToken, getUserId, performanceApi, toNum } from '../../../services/api'
import type { PerfDTO, PerfItemDTO } from '../../../services/api'
import './index.scss'

/** 当月（YYYY-MM），绩效查询入参 */
function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 我的绩效（P1 全员端，rep）：GET /performance?month= 当月——
 * 回款/新客/拜访/提成四指标卡（按当前登录 rep 匹配，找不到且仅一条时兜底）+ 团队排行参照。
 */
export default function SalesmanPerformancePage() {
  const [month, setMonth] = useState(currentMonth())
  const [data, setData] = useState<PerfDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void load(currentMonth())
  })

  async function load(m: string) {
    setLoading(true)
    setError('')
    try {
      setData(await performanceApi.monthly(m))
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载绩效失败')
    } finally {
      setLoading(false)
    }
  }

  const items = data?.items ?? []
  const mine: PerfItemDTO | undefined =
    items.find((it) => it.repId === getUserId()) ?? (items.length === 1 ? items[0] : undefined)
  const visitTarget = toNum(mine?.visitTarget)

  return (
    <View className='page'>
      <View className='topbar'>
        <Text className='topbar__title'>我的绩效</Text>
        <Text className='topbar__link' onClick={() => Taro.navigateTo({ url: '/pages/salesman/home/index' })}>工作台</Text>
      </View>

      <Picker mode='date' fields='month' value={month} onChange={(e) => { setMonth(e.detail.value); void load(e.detail.value) }}>
        <View className='frow'>
          <Text className='frow__label'>月份</Text>
          <Text className='frow__value'>{month}</Text>
          <Text className='frow__arrow'>›</Text>
        </View>
      </Picker>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load(month) }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='tip'>正在加载绩效…</Text>
      ) : !mine ? (
        <View className='state'>
          <Text className='state__txt'>{month} 还没有您的绩效数据</Text>
        </View>
      ) : (
        <>
          {/* 四指标：回款 / 新客 / 拜访 / 提成 */}
          <View className='pf__grid'>
            <View className='metric'>
              <Text className='metric__label'>当月回款</Text>
              <Text className='metric__num'>{fmtMoney(mine.paymentAmount)}</Text>
              <Text className='metric__sub'>确认收款计入</Text>
            </View>
            <View className='metric'>
              <Text className='metric__label'>新增客户</Text>
              <Text className='metric__num'>{mine.newCustomers} 个</Text>
              <Text className='metric__sub'>转正客户计入</Text>
            </View>
            <View className='metric'>
              <Text className='metric__label'>拜访打卡</Text>
              <Text className='metric__num'>{mine.visitCount} 次</Text>
              <Text className='metric__sub'>{visitTarget > 0 ? `目标 ${visitTarget} 次` : '多跑多得'}</Text>
            </View>
            <View className='metric'>
              <Text className='metric__label'>当月提成</Text>
              <Text className='metric__num'>{fmtMoney(mine.commission)}</Text>
              <Text className='metric__sub'>退货冲减 {fmtMoney(mine.returnDeduction)}</Text>
            </View>
          </View>

          {/* 团队参照 */}
          <View className='card'>
            <Text className='card__title'>团队排行（{month}）</Text>
            {items.length === 0 ? (
              <Text className='tip'>本月暂无数据</Text>
            ) : (
              [...items]
                .sort((a, b) => toNum(b.paymentAmount) - toNum(a.paymentAmount))
                .map((it, i) => (
                  <View key={it.repId} className={`pf__rank ${it.repId === mine.repId ? 'pf__rank--me' : ''}`}>
                    <Text className='pf__rank-no'>{i + 1}</Text>
                    <Text className='pf__rank-name'>{it.name}{it.repId === mine.repId ? '（我）' : ''}</Text>
                    <Text className='pf__rank-amount'>{fmtMoney(it.paymentAmount)}</Text>
                  </View>
                ))
            )}
          </View>
          <Text className='tip'>提成=回款+拜访达成+新客加权（比例由后台配置），最终以工资表为准</Text>
        </>
      )}
    </View>
  )
}
