import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { fmtDate, fmtMoney, getToken, receivablesApi } from '../../../services/api'
import type { CustomerReceivableDTO } from '../../../services/api'
import './index.scss'

// 到期前 N 天高亮提醒（N 先取 7；后续可随商户配置下发）
const DUE_SOON_DAYS = 7

type TabKey = 'open' | 'settled'

interface DueInfo {
  text: string
  tone: 'danger' | 'warn' | 'muted'
}

function dueInfo(r: CustomerReceivableDTO): DueInfo {
  if (r.daysOverdue > 0) return { text: `已逾期 ${r.daysOverdue} 天`, tone: 'danger' }
  const due = new Date(r.dueDate).getTime()
  const days = Math.ceil((due - Date.now()) / 86400000)
  if (days >= 0 && days <= DUE_SOON_DAYS) {
    return { text: days === 0 ? '今天到期' : `${days} 天后到期`, tone: 'warn' }
  }
  return { text: `到期日 ${fmtDate(r.dueDate)}`, tone: 'muted' }
}

/**
 * 待结单据（P0-T51）：GET /receivables（客户 token 只返回自己的未归档单据）。
 * 同页双 tab：待结（open>0，含到期高亮）/ 已结（open<=0，可查最近6个月）。
 * 文案红线：只用「待结金额」，不出现"信用额度/欠款"等内部术语。
 */
export default function CustomerReceivablesPage() {
  const [rows, setRows] = useState<CustomerReceivableDTO[]>([])
  const [serverOpenTotal, setServerOpenTotal] = useState<number | null>(null)
  const [tab, setTab] = useState<TabKey>('open')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: '/pages/customer/login/index' })
      return
    }
    void load()
  })

  async function load() {
    setLoading(true)
    setError('')
    try {
      const res = await receivablesApi.mine()
      setRows(res.items ?? [])
      setServerOpenTotal(typeof res.openTotal === 'number' ? res.openTotal : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载待结单据失败')
    } finally {
      setLoading(false)
    }
  }

  // 待结/已结按 open 字段在前端分档（已结数据由后端支持后自动出现）
  const openRows = rows.filter((r) => r.open > 0.005)
  const settledRows = rows.filter((r) => r.open <= 0.005)
  const openTotal = serverOpenTotal ?? openRows.reduce((s, r) => s + r.open, 0)

  return (
    <View className='rlist'>
      <View className='rlist__tabs'>
        <Button
          className={`tabbtn ${tab === 'open' ? 'tabbtn--on' : ''}`}
          onClick={() => setTab('open')}
        >
          待结（{openRows.length}）
        </Button>
        <Button
          className={`tabbtn ${tab === 'settled' ? 'tabbtn--on' : ''}`}
          onClick={() => setTab('settled')}
        >
          已结（{settledRows.length}）
        </Button>
      </View>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='rlist__tip'>正在加载…</Text>
      ) : tab === 'open' ? (
        <View className='rlist__body'>
          <View className='sumcard'>
            <Text className='sumcard__label'>待结金额合计</Text>
            <Text className='sumcard__amount'>{fmtMoney(openTotal)}</Text>
            <Text className='sumcard__note'>按先到期先结的顺序结算；到期前请备好款项</Text>
          </View>
          {openRows.length === 0 ? (
            <Text className='rlist__tip'>当前没有待结单据</Text>
          ) : openRows.map((r) => {
            const due = dueInfo(r)
            return (
              <View key={r.id} className='rcard'>
                <View className='rcard__row'>
                  <Text className='rcard__no'>{r.sourceDocNo}</Text>
                  <Text className={`tag tag--${due.tone}`}>{due.text}</Text>
                </View>
                <View className='rcard__row'>
                  <Text className='rcard__meta'>{r.sourceType === 'ORDER' ? '订单' : '单据'} · 到期日 {fmtDate(r.dueDate)}</Text>
                  <Text className='rcard__amount'>待结 {fmtMoney(r.open)}</Text>
                </View>
              </View>
            )
          })}
        </View>
      ) : (
        <View className='rlist__body'>
          {settledRows.length === 0 ? (
            <Text className='rlist__tip'>近 6 个月没有已结单据</Text>
          ) : settledRows.map((r) => (
            <View key={r.id} className='rcard'>
              <View className='rcard__row'>
                <Text className='rcard__no'>{r.sourceDocNo}</Text>
                <Text className='tag tag--ok'>已结清</Text>
              </View>
              <View className='rcard__row'>
                <Text className='rcard__meta'>{r.sourceType === 'ORDER' ? '订单' : '单据'} · 到期日 {fmtDate(r.dueDate)}</Text>
                <Text className='rcard__amount--settled'>{fmtMoney(r.total)}</Text>
              </View>
            </View>
          ))}
          <Text className='rlist__tip'>已结单据可查最近 6 个月，更早的请联系商家查询</Text>
        </View>
      )}
    </View>
  )
}
