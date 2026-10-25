import { useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import Icon from '../../../components/Icon'
import Taro, { useDidShow } from '@tarojs/taro'
import ReasonPopup from '../../../components/reason-popup'
import { readRouteQuery } from '../../../services/route-param'
import {
  ApiError,
  LOGIN_PAGE,
  ORDER_SOURCE_LABELS,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONES,
  SETTLEMENT_LABELS,
  UNIT_LABELS,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  getRole,
  getToken,
  ordersApi,
  toNum,
} from '../../../services/api'
import type { OrderDetailDTO, PrecheckView } from '../../../services/api'
import './index.scss'

type PopupKind = 'cancel' | 'special' | null

function okIcon(ok?: boolean) {
  return <Icon name={ok ? 'check' : 'x'} color={ok ? '#276A2B' : '#B3261E'} size={32} />
}

const PROGRESS = ['待确认', '已确认', '拣货中', '配送中', '已签收']

function progressIndex(status: string): number {
  if (status === 'SIGNED' || status === 'SETTLED') return 4
  if (status === 'DELIVERING') return 3
  if (status === 'OUTBOUND') return 2
  if (status === 'CONFIRMED') return 1
  if (status === 'PENDING_CONFIRM') return 0
  return -1
}

function precheckIssueCount(precheck: PrecheckView | null): number {
  if (!precheck) return 0
  let count = 0
  if (precheck.customer && precheck.customer.ok === false) count += 1
  if (precheck.credit && precheck.credit.ok === false) count += 1
  for (const row of precheck.inventory ?? []) {
    if (row.ok === false) count += 1
  }
  if (precheck.minOrder && precheck.minOrder.ok === false) count += 1
  return count
}

/**
 * 订单详情（P1 全员端，内勤/老板/仓配共用）：行明细+审单预检+客户信息；
 * 操作按状态与角色显隐——确认(内勤/老板)、取消(输原因)、特批(仅老板, ORDER_SPECIAL)。
 * 确认时信用复核不过返回 422，提示需老板特批（数据在 ApiError.body）。
 */
export default function ClerkOrderDetailPage() {
  const [id, setId] = useState('')
  const [order, setOrder] = useState<OrderDetailDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [popup, setPopup] = useState<PopupKind>(null)
  const [submitting, setSubmitting] = useState(false)
  const [role, setRole] = useState('')
  const [reverseId, setReverseId] = useState('')
  const [reverseQty, setReverseQty] = useState('')
  const [reverseReason, setReverseReason] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    setRole(getRole())
    const q = readRouteQuery()
    const paramId = q.id ?? ''
    if (paramId && paramId !== id) {
      setId(paramId)
      void load(paramId)
    }
  })

  async function load(orderId: string) {
    setLoading(true)
    setError('')
    try {
      setOrder(await ordersApi.detail(orderId))
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载订单失败')
    } finally {
      setLoading(false)
    }
  }

  async function confirm() {
    if (!order || submitting) return
    setSubmitting(true)
    try {
      await ordersApi.confirm(order.id)
      Taro.showToast({ title: '已确认', icon: 'success' })
      void load(order.id)
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        Taro.showModal({
          title: '信用复核未通过',
          content: '该单超出客户可用额度，需老板特批放行（订单页「特批放行」按钮）或调整订单。',
          showCancel: false,
        })
      } else {
        Taro.showToast({ title: e instanceof Error ? e.message : '确认失败', icon: 'none' })
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function makeOutbound() {
    if (!order || submitting) return
    setSubmitting(true)
    try {
      await ordersApi.outbound(order.id)
      Taro.showToast({ title: '已生成拣货单', icon: 'success' })
      void load(order.id)
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '生成拣货单失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  async function submitReverse() {
    if (!order || submitting || !reverseId) return
    const line = (order.lines ?? []).find((l) => l.id === reverseId)
    if (!line) return
    const qty = Number(reverseQty)
    const reversed = (order.lines ?? [])
      .filter((l) => l.reversalOfId === line.id)
      .reduce((s, l) => s + toNum(l.qty), 0)
    const net = toNum(line.qty) + reversed
    if (!(qty > 0) || qty > net) {
      Taro.showToast({ title: `冲销数量须在 0 到 ${net} 之间`, icon: 'none' })
      return
    }
    if (!reverseReason.trim()) {
      Taro.showToast({ title: '请填写冲销原因', icon: 'none' })
      return
    }
    setSubmitting(true)
    try {
      await ordersApi.reverseLine(order.id, line.id, qty, reverseReason.trim())
      Taro.showToast({ title: '已冲销', icon: 'success' })
      setReverseId('')
      setReverseQty('')
      setReverseReason('')
      void load(order.id)
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '冲销失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  async function submitPopupText(kind: Exclude<PopupKind, null>, text: string) {
    if (!order || submitting) return
    setSubmitting(true)
    try {
      if (kind === 'cancel') {
        await ordersApi.cancel(order.id, text)
        Taro.showToast({ title: '已取消', icon: 'success' })
      } else {
        await ordersApi.approveSpecial(order.id, text, 'ORDER_SPECIAL')
        Taro.showToast({ title: '特批已放行', icon: 'success' })
      }
      setPopup(null)
      void load(order.id)
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '操作失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  if (error) {
    return (
      <View className='page'>
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => id && void load(id)}>重新加载</Button>
        </View>
      </View>
    )
  }
  if (loading || !order) {
    return (
      <View className='page'>
        <Text className='tip'>正在加载订单…</Text>
      </View>
    )
  }

  const precheck = (order.precheck ?? null) as PrecheckView | null
  const canOperate = role === 'CLERK' || role === 'OWNER'
  const isOwner = role === 'OWNER'
  const st = order.status

  return (
    <View className='page'>
      <View className='page-head'>
        <View className='page-head__main'>
          <Text className='page-head__title'>订单详情</Text>
          <Text className='page-head__sub'>{order.orderNo}</Text>
        </View>
      </View>
      {/* 单头 */}
      <View className='card'>
        <View className='ocard__row'>
          <Text className='od__no'>{order.orderNo}</Text>
          <Text className={`tag tag--${ORDER_STATUS_TONES[st] ?? 'muted'}`}>
            {order.statusLabel || (ORDER_STATUS_LABELS[st] ?? st)}
          </Text>
        </View>
        <View className='ocard__row'>
          <Text className='od__meta'>
            {ORDER_SOURCE_LABELS[order.source] ?? order.source} · {fmtDateTime(order.createdAt)}
          </Text>
          {order.specialApproved ? <Text className='tag tag--warn'>已特批</Text> : null}
        </View>
        <View className='ocard__row'>
          <Text className='od__total-label'>合计</Text>
          <Text className='num num--lg'>{fmtMoney(order.totalAmount)}</Text>
        </View>
        {order.cancelReason ? (
          <View className='ocard__row'>
            <Text className='od__meta'>取消原因</Text>
            <Text className='od__cancel-reason'>{order.cancelReason}</Text>
          </View>
        ) : null}
        {progressIndex(st) >= 0 ? (
          <View className='steps'>
            {PROGRESS.map((label, index) => (
              <View key={label} className={`steps__item ${index <= progressIndex(st) ? 'steps__item--on' : ''}`}>
                <View className='steps__bar' />
                <Text className='steps__label'>{label}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/* 客户信息 */}
      <View className='card'>
        <Text className='card__title'>客户信息</Text>
        <View className='kv'><Text className='kv__k'>名称</Text><Text className='kv__v'>{order.customer?.name}</Text></View>
        <View className='kv'><Text className='kv__k'>编码</Text><Text className='kv__v'>{order.customer?.code || '-'}</Text></View>
        <View className='kv'><Text className='kv__k'>电话</Text><Text className='kv__v'>{order.customer?.phone || '-'}</Text></View>
        <View className='kv'>
          <Text className='kv__k'>结算方式</Text>
          <Text className='kv__v'>
            {SETTLEMENT_LABELS[order.customer?.settlement ?? ''] ?? order.customer?.settlement ?? '-'}
            {order.customer?.termsDays ? `（账期 ${order.customer.termsDays} 天）` : ''}
          </Text>
        </View>
        <View className='kv'><Text className='kv__k'>送货地址</Text><Text className='kv__v'>{order.addressSnapshot || '-'}</Text></View>
        <View className='kv'><Text className='kv__k'>要求送达</Text><Text className='kv__v'>{order.deliveryDate ? fmtDate(order.deliveryDate) : '-'}</Text></View>
      </View>

      {/* 行明细（红字冲销行灰显负数） */}
      <View className='card'>
        <Text className='card__title'>商品行（{(order.lines ?? []).length}）</Text>
        {(order.lines ?? []).map((l) => {
          const reversed = Boolean(l.reversalOfId)
          return (
            <View key={l.id} className={`oline ${reversed ? 'oline--reversal' : ''}`}>
              <View className='oline__row'>
                <View className='oline__main'>
                  <Text className='oline__name'>{l.productName}{l.isGift ? '（赠）' : ''}</Text>
                  <Text className='oline__sub'>
                    {l.specText ? `${l.specText} · ` : ''}
                    {toNum(l.qty)}{UNIT_LABELS[l.unit] ?? l.unit} × {fmtMoney(l.unitPrice)}
                    {reversed ? ' · 红字冲销' : ''}
                  </Text>
                </View>
                <Text className='oline__amount'>{fmtMoney(l.amount)}</Text>
                {canOperate && !reversed && (st === 'PENDING_CONFIRM' || st === 'CONFIRMED') && (
                  <Text
                    className='oline__reverse'
                    onClick={() => {
                      setReverseId(l.id)
                      const already = (order.lines ?? [])
                        .filter((x) => x.reversalOfId === l.id)
                        .reduce((s, x) => s + toNum(x.qty), 0)
                      setReverseQty(String(toNum(l.qty) + already))
                      setReverseReason('')
                    }}
                  >
                    冲销此行
                  </Text>
                )}
              </View>
            </View>
          )
        })}
        {reverseId && (
          <View className='oline'>
            <Text className='oline__name'>冲销数量与原因</Text>
            <Input
              type='digit'
              value={reverseQty}
              placeholder='冲销数量'
              onInput={(e) => setReverseQty(e.detail.value)}
            />
            <Input
              value={reverseReason}
              placeholder='冲销原因（必填）'
              onInput={(e) => setReverseReason(e.detail.value)}
            />
            <Button className='btn-danger btn-sm' loading={submitting} onClick={() => { void submitReverse() }}>
              <Text className='btn-label'>确认冲销</Text>
            </Button>
          </View>
        )}
      </View>

      {/* 审单预检（下单时快照；信用=额度-未结-在途） */}
      {precheck && (
        <View className={`card ${precheckIssueCount(precheck) > 0 ? 'card--warn' : ''}`}>
          <Text className='card__title'>
            {precheckIssueCount(precheck) > 0 ? `审单预检：${precheckIssueCount(precheck)} 项需注意` : '审单预检'}
          </Text>
          {precheck.customer && (
            <View className='kv'>
              <Text className='kv__k'>客户状态</Text>
              <View className={`od__check ${precheck.customer.ok ? 'od__check--ok' : 'od__check--bad'}`}>
                {okIcon(precheck.customer.ok)}
                <Text>{precheck.customer.ok ? '可交易' : '不可交易'}</Text>
              </View>
            </View>
          )}
          {precheck.credit && (
            <>
              <View className='kv'>
                <Text className='kv__k'>信用额度</Text>
                <View className={`od__check ${precheck.credit.ok ? 'od__check--ok' : 'od__check--bad'}`}>
                  {okIcon(precheck.credit.ok)}
                  <Text>需 {fmtMoney(precheck.credit.need)} / 可用 {fmtMoney(precheck.credit.available)}</Text>
                </View>
              </View>
              <View className='kv'>
                <Text className='kv__k'>占用明细</Text>
                <Text className='kv__v'>
                  未结 {fmtMoney(precheck.credit.openAr)} · 在途 {fmtMoney(precheck.credit.inTransit)} · 额度 {fmtMoney(precheck.credit.limit)}
                </Text>
              </View>
            </>
          )}
          {(precheck.inventory ?? []).map((inv, i) => (
            <View key={i} className='kv'>
              <Text className='kv__k'>库存 · {inv.productName ?? ''}</Text>
              <View className={`od__check ${inv.ok ? 'od__check--ok' : 'od__check--bad'}`}>
                {okIcon(inv.ok)}
                <Text>需 {toNum(inv.need)} / 可用 {toNum(inv.onHand) - toNum(inv.occupied)}</Text>
              </View>
            </View>
          ))}
          {precheck.minOrder && (
            <View className='kv'>
              <Text className='kv__k'>起送金额</Text>
              <View className={`od__check ${precheck.minOrder.ok ? 'od__check--ok' : 'od__check--bad'}`}>
                {okIcon(precheck.minOrder.ok)}
                <Text>{fmtMoney(precheck.minOrder.amount)} / 最低 {fmtMoney(precheck.minOrder.min)}</Text>
              </View>
            </View>
          )}
        </View>
      )}

      {/* 出库批次（已出库/配送中可见） */}
      {(order.outbounds ?? []).length > 0 && (
        <View className='card'>
          <Text className='card__title'>出库批次</Text>
          {(order.outbounds ?? []).map((ob) => (
            <View key={ob.outboundNo} className='kv'>
              <Text className='kv__k'>{ob.outboundNo}</Text>
              <Text className='kv__v'>
                {(ob.lines ?? []).map((l) => l.batch?.batchNo ?? '-').join('、') || '-'}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* 操作区：内勤/老板；特批仅老板（D01: 信用放行须老板本人） */}
      {canOperate && (st === 'PENDING_CONFIRM' || st === 'CONFIRMED') && (
        <View className='action-bar'>
          <Button
            className='btn-neutral'
            disabled={submitting}
            onClick={() => setPopup('cancel')}
          >
            <Text className='btn-label'>取消订单</Text>
          </Button>
          {isOwner && (
            <Button
              className='btn-danger'
              disabled={submitting}
              onClick={() => setPopup('special')}
            >
              <Text className='btn-label'>特批放行</Text>
            </Button>
          )}
          {st === 'PENDING_CONFIRM' && (
            <Button
              className='btn-primary'
              loading={submitting}
              disabled={submitting}
              onClick={() => { void confirm() }}
            >
              <Text className='btn-label'>确认订单</Text>
            </Button>
          )}
          {st === 'CONFIRMED' && !(order.outbounds ?? []).length && (
            <Button
              className='btn-primary'
              loading={submitting}
              disabled={submitting}
              onClick={() => { void makeOutbound() }}
            >
              <Text className='btn-label'>生成拣货单</Text>
            </Button>
          )}
        </View>
      )}

      <ReasonPopup
        visible={popup !== null}
        title={popup === 'cancel' ? `取消订单 ${order.orderNo}` : `特批放行 ${order.orderNo}`}
        confirmText={popup === 'cancel' ? '确认取消' : '确认放行'}
        danger={popup === 'special'}
        presets={popup === 'special' ? ['老客户信用良好', '已承诺本周回款', '其他'] : ['客户改单', '重复下单', '其他']}
        placeholder={popup === 'cancel' ? '取消原因（必填）' : '特批理由（必填，留痕审批记录）'}
        onSubmit={(text) => { if (popup) void submitPopupText(popup, text) }}
        onClose={() => setPopup(null)}
      />
    </View>
  )
}
