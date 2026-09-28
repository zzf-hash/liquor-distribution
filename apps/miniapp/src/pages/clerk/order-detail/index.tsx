import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import ReasonPopup from '../../../components/reason-popup'
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

function okTag(ok?: boolean): string {
  return ok ? '✓' : '✗'
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

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    setRole(getRole())
    const pages = Taro.getCurrentPages()
    const cur = pages[pages.length - 1]
    const q = (cur as { options?: Record<string, string> })?.options ?? {}
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
          <Text className='od__total-label'>订单金额</Text>
          <Text className='od__total'>{fmtMoney(order.totalAmount)}</Text>
        </View>
        {order.cancelReason ? (
          <View className='ocard__row'>
            <Text className='od__meta'>取消原因</Text>
            <Text className='od__cancel-reason'>{order.cancelReason}</Text>
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
                <Text className='oline__name'>{l.productName}{l.isGift ? '（赠）' : ''}</Text>
                <Text className='oline__amount'>{fmtMoney(l.amount)}</Text>
              </View>
              <Text className='oline__sub'>
                {l.specText ? `${l.specText} · ` : ''}
                {toNum(l.qty)}{UNIT_LABELS[l.unit] ?? l.unit} × {fmtMoney(l.unitPrice)}
                {reversed ? ' · 红字冲销' : ''}
              </Text>
            </View>
          )
        })}
      </View>

      {/* 审单预检（下单时快照；信用=额度-未结-在途） */}
      {precheck && (
        <View className='card'>
          <Text className='card__title'>审单预检快照</Text>
          {precheck.customer && (
            <View className='kv'>
              <Text className='kv__k'>客户状态</Text>
              <Text className={`od__check ${precheck.customer.ok ? 'od__check--ok' : 'od__check--bad'}`}>
                {okTag(precheck.customer.ok)} {precheck.customer.ok ? '可交易' : '不可交易'}
              </Text>
            </View>
          )}
          {precheck.credit && (
            <>
              <View className='kv'>
                <Text className='kv__k'>信用额度</Text>
                <Text className={`od__check ${precheck.credit.ok ? 'od__check--ok' : 'od__check--bad'}`}>
                  {okTag(precheck.credit.ok)} 需 {fmtMoney(precheck.credit.need)} / 可用 {fmtMoney(precheck.credit.available)}
                </Text>
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
              <Text className={`od__check ${inv.ok ? 'od__check--ok' : 'od__check--bad'}`}>
                {okTag(inv.ok)} 需 {toNum(inv.need)} / 可用 {toNum(inv.onHand) - toNum(inv.occupied)}
              </Text>
            </View>
          ))}
          {precheck.minOrder && (
            <View className='kv'>
              <Text className='kv__k'>起送金额</Text>
              <Text className={`od__check ${precheck.minOrder.ok ? 'od__check--ok' : 'od__check--bad'}`}>
                {okTag(precheck.minOrder.ok)} {fmtMoney(precheck.minOrder.amount)} / 最低 {fmtMoney(precheck.minOrder.min)}
              </Text>
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
        <View className='card'>
          <Text className='card__title'>操作</Text>
          {st === 'PENDING_CONFIRM' && (
            <Button
              className='btn-primary'
              loading={submitting}
              disabled={submitting}
              onClick={() => { void confirm() }}
            >
              确认订单
            </Button>
          )}
          <Button
            className='btn-ghost od__op'
            disabled={submitting}
            onClick={() => setPopup('cancel')}
          >
            取消订单
          </Button>
          {isOwner && (
            <Button
              className='btn-danger od__op'
              disabled={submitting}
              onClick={() => setPopup('special')}
            >
              特批放行
            </Button>
          )}
        </View>
      )}

      <ReasonPopup
        visible={popup !== null}
        title={popup === 'cancel' ? `取消订单 ${order.orderNo}` : `特批放行 ${order.orderNo}`}
        confirmText={popup === 'cancel' ? '确认取消' : '确认特批'}
        danger={popup === 'cancel'}
        placeholder={popup === 'cancel' ? '取消原因（必填）' : '特批理由（必填，留痕审批记录）'}
        onSubmit={(text) => { if (popup) void submitPopupText(popup, text) }}
        onClose={() => setPopup(null)}
      />
    </View>
  )
}
