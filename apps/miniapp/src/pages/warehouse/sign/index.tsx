import { useEffect, useRef, useState } from 'react'
import { rememberIdemKey } from '../../../services/idempotency'
import type { IdemSlot } from '../../../services/idempotency'
import { Button, Canvas, Image, Input, Picker, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { readRouteQuery } from '../../../services/route-param'
import ReasonPopup from '../../../components/reason-popup'
import { rejectConfirmText } from '../../../services/sign-reject'
import { bumpReceivedQty, receivedQtyForSubmit } from '../../../services/sign-qty'
import {
  LOGIN_PAGE,
  UNIT_LABELS,
  fmtMoney,
  getUserName,
  getToken,
  ordersApi,
  toNum,
} from '../../../services/api'
import type { OrderDetailDTO, OrderLineDTO } from '../../../services/api'
import './index.scss'

// 回包装品类（与服务端押金单价 cfg 默认对齐：周转箱15/啤酒瓶0.5/白酒盒2）
const PACKAGE_CATEGORIES: string[] = ['周转箱', '啤酒瓶', '白酒盒']

const SIGN_TYPES: Array<{ key: 'E_SIGN' | 'PHOTO' | 'PAPER'; label: string }> = [
  { key: 'E_SIGN', label: '电子签（手写签名）' },
  { key: 'PHOTO', label: '拍照签收（拍签收单/现场）' },
  { key: 'PAPER', label: '纸单回录（拍纸质单，回仓录入）' },
]

const CANVAS_ID = 'signCanvas'

/** 图片转 base64 dataURL（weapp 本地临时文件 / H5 blob 两态；对象存储未接入前的内联方案 M8-3） */
function fileToDataUrl(path: string): Promise<string> {
  if (path.startsWith('blob:') || path.startsWith('http')) {
    return fetch(path)
      .then((r) => r.blob())
      .then((blob) => new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = () => reject(new Error('图片读取失败'))
        fr.readAsDataURL(blob)
      }))
  }
  return new Promise<string>((resolve, reject) => {
    Taro.getFileSystemManager().readFile({
      filePath: path,
      encoding: 'base64',
      success: (r) => resolve(`data:image/jpeg;base64,${r.data}`),
      fail: () => reject(new Error('图片读取失败')),
    })
  })
}

interface SignLine {
  line: OrderLineDTO
  net: number
  actual: string
}

/** 每行净可签量（扣红字冲销，口径与服务端 sign() netByLine 一致） */
function netLines(lines: OrderLineDTO[]): SignLine[] {
  const reversals = new Map<string, number>()
  for (const l of lines) {
    if (l.reversalOfId) reversals.set(l.reversalOfId, (reversals.get(l.reversalOfId) ?? 0) + toNum(l.qty))
  }
  return lines
    .filter((l) => !l.reversalOfId)
    .map((l) => {
      const net = toNum(l.qty) + (reversals.get(l.id) ?? 0)
      return { line: l, net, actual: String(net) }
    })
    .filter((s) => s.net > 0)
}

/**
 * 签收页（P1 全员端，仓配；订单参数传入）：逐行实收（默认=净量，差额即拒收量回冲库存）、
 * 签收类型（电子签/纸单回录）、回包装品类+数量动态行、签名文本（选填）→ POST /orders/:id/sign；
 * 整单拒收单独按钮（POST :id/reject 输原因）。
 */
export default function WarehouseSignPage() {
  const [id, setId] = useState('')
  const [orderNo, setOrderNo] = useState('')
  const [order, setOrder] = useState<OrderDetailDTO | null>(null)
  const [signLines, setSignLines] = useState<SignLine[]>([])
  const [typeIdx, setTypeIdx] = useState(0)
  const [signerName, setSignerName] = useState('')
  const [photoPath, setPhotoPath] = useState('')
  const [packages, setPackages] = useState<Array<{ category: string; qty: string }>>([])
  const [showReject, setShowReject] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // canvas 手写签名（2d）：node/ctx 挂 ref，hasDrawn 控制可提交性
  const canvasNode = useRef<{ node: unknown; ctx: CanvasRenderingContext2D; rect: { left: number; top: number } } | null>(null)
  const drawing = useRef(false)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)
  const hasDrawn = useRef(false)
  const idemRef = useRef<IdemSlot | null>(null)

  useEffect(() => {
    // 页面渲染完成后再取 canvas 节点（2d 模式必须 node 方式拿 context）
    const timer = setTimeout(() => { initCanvas() }, 200)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function initCanvas() {
    try {
      const query = Taro.createSelectorQuery()
      query.select(`#${CANVAS_ID}`).fields({ node: true, size: true, rect: true }).exec((res) => {
        const info = res?.[0] as { node: unknown; width: number; height: number; left: number; top: number } | undefined
        if (!info?.node) return
        const dpr = Taro.getSystemInfoSync().pixelRatio || 2
        const canvas = info.node as { width: number; height: number; getContext: (t: '2d') => CanvasRenderingContext2D }
        canvas.width = info.width * dpr
        canvas.height = info.height * dpr
        const ctx = canvas.getContext('2d')
        ctx.scale(dpr, dpr)
        ctx.lineWidth = 3
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.strokeStyle = '#2b2422'
        canvasNode.current = { node: canvas, ctx, rect: { left: info.left, top: info.top } }
      })
    } catch {
      // canvas 初始化失败(极旧基础库): 仍可提交, 签名板留空
    }
  }

  function touchPos(e: { touches: Array<{ x?: number; y?: number; clientX?: number; clientY?: number }> }): { x: number; y: number } | null {
    const t = e.touches?.[0]
    const rect = canvasNode.current?.rect
    if (!t) return null
    if (typeof t.x === 'number' && typeof t.y === 'number') return { x: t.x, y: t.y } // weapp: 画布相对坐标
    if (typeof t.clientX === 'number' && typeof t.clientY === 'number' && rect) return { x: t.clientX - rect.left, y: t.clientY - rect.top } // H5
    return null
  }

  function onTouchStart(e: { touches: Array<{ x?: number; y?: number; clientX?: number; clientY?: number }> }) {
    const p = touchPos(e)
    if (!p) return
    drawing.current = true
    lastPoint.current = p
    hasDrawn.current = true
  }

  function onTouchMove(e: { touches: Array<{ x?: number; y?: number; clientX?: number; clientY?: number }> }) {
    if (!drawing.current) return
    const p = touchPos(e)
    const ctx = canvasNode.current?.ctx
    if (!p || !ctx || !lastPoint.current) return
    ctx.beginPath()
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    lastPoint.current = p
  }

  function onTouchEnd() {
    drawing.current = false
    lastPoint.current = null
  }

  function clearSignature() {
    const c = canvasNode.current
    if (!c) return
    const canvas = c.node as { width: number; height: number }
    c.ctx.clearRect(0, 0, canvas.width, canvas.height)
    hasDrawn.current = false
  }

  /** 导出签名为 dataURL；未画过返回 undefined */
  function exportSignature(): string | undefined {
    if (!hasDrawn.current || !canvasNode.current) return undefined
    const canvas = canvasNode.current.node as { toDataURL: (t: string) => string }
    try {
      return canvas.toDataURL('image/png')
    } catch {
      return undefined
    }
  }

  async function takePhoto() {
    try {
      const res = await Taro.chooseImage({ count: 1, sizeType: ['compressed'] })
      const p = res.tempFilePaths?.[0]
      if (p) setPhotoPath(p)
    } catch {
      /* 用户取消 */
    }
  }

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    const q = readRouteQuery()
    const paramId = q.id ?? ''
    const paramNo = q.no ?? ''
    setOrderNo(paramNo)
    setSignerName((prev) => prev || getUserName())
    if (paramId && paramId !== id) {
      setId(paramId)
      void load(paramId)
    }
  })

  async function load(orderId: string) {
    setLoading(true)
    setError('')
    try {
      const res = await ordersApi.detail(orderId)
      setOrder(res)
      setSignLines(netLines(res.lines ?? []))
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载订单失败')
    } finally {
      setLoading(false)
    }
  }

  function setActual(i: number, v: string) {
    setSignLines((prev) => prev.map((s, idx) => (idx === i ? { ...s, actual: v } : s)))
  }

  function bumpActual(i: number, delta: number) {
    setSignLines((prev) => prev.map((s, idx) => (
      idx === i ? { ...s, actual: bumpReceivedQty(s.actual, s.net, delta) } : s
    )))
  }

  function setPackage(idx: number, patch: Partial<{ category: string; qty: string }>) {
    setPackages((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)))
  }

  async function submit() {
    if (!order || submitting) return
    const lines: Array<{ orderLineId: string; actualQty: number }> = []
    for (let i = 0; i < signLines.length; i++) {
      const s = signLines[i]
      const actualQty = receivedQtyForSubmit(s.actual, s.net)
      if (actualQty === null) {
        Taro.showToast({ title: `${s.line.productName} 实收须在 0~${s.net} 之间`, icon: 'none' })
        return
      }
      lines.push({ orderLineId: s.line.id, actualQty })
    }
    const returnPackages = packages
      .map((p) => ({ category: p.category, qty: Math.trunc(Number(p.qty)) }))
      .filter((p) => Number.isFinite(p.qty) && p.qty > 0)
    const type = SIGN_TYPES[typeIdx]?.key ?? 'E_SIGN'
    if (type === 'E_SIGN' && !exportSignature()) {
      Taro.showToast({ title: '电子签请先手写签名', icon: 'none' })
      return
    }
    if ((type === 'PHOTO' || type === 'PAPER') && !photoPath) {
      Taro.showToast({ title: '请先拍摄签收凭证', icon: 'none' })
      return
    }
    const rejectText = rejectConfirmText(signLines.map((s) => ({
      name: s.line.productName,
      unitLabel: UNIT_LABELS[s.line.unit] ?? s.line.unit,
      rejected: s.net - Number(s.actual || 0),
    })))
    if (rejectText) {
      const ok = await new Promise<boolean>((resolve) => {
        Taro.showModal({
          title: '存在拒收数量',
          content: rejectText,
          confirmText: '确认提交',
          confirmColor: '#7A1F2B',
          success: (r) => resolve(Boolean(r.confirm)),
          fail: () => resolve(false),
        })
      })
      if (!ok) return
    }
    setSubmitting(true)
    try {
      const signatureData = type === 'E_SIGN' ? exportSignature() : undefined
      const photoUrl = (type === 'PHOTO' || type === 'PAPER') && photoPath ? await fileToDataUrl(photoPath) : undefined
      const body = {
        type,
        signerName: signerName.trim() || undefined,
        signatureData,
        photoUrl,
        deviceInfo: `${Taro.getSystemInfoSync().platform ?? ''} sign-canvas`,
        returnPackages: returnPackages.length ? returnPackages : undefined,
        lines,
      }
      const res = await ordersApi.sign(order.id, body, rememberIdemKey(idemRef, { id: order.id, ...body }))
      idemRef.current = null
      Taro.showToast({
        title: res.status === 'REJECTED' ? '已按整单拒收处理' : `签收成功 ${fmtMoney(res.acceptedAmount)}`,
        icon: 'success',
      })
      setTimeout(() => Taro.navigateBack(), 800)
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '签收失败', icon: 'none' })
      setSubmitting(false)
    }
  }

  async function reject(reason: string) {
    if (!order || submitting) return
    setSubmitting(true)
    try {
      await ordersApi.reject(order.id, reason)
      Taro.showToast({ title: '已整单拒收', icon: 'success' })
      setShowReject(false)
      setTimeout(() => Taro.navigateBack(), 600)
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '拒收失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  if (error) {
    return (
      <View className='page'>
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => Taro.navigateBack()}>返回</Button>
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

  return (
    <View className='page'>
      <View className='topbar'>
        <Text className='topbar__title'>签收 {order.orderNo || orderNo}</Text>
      </View>

      {/* 逐行实收 */}
      <View className='card'>
        <Text className='card__title'>实收数量（默认=净量，改小即拒收）</Text>
        {signLines.map((s, i) => {
          const rejected = s.net - Number(s.actual || 0)
          return (
            <View key={s.line.id} className='sline'>
              <View className='sline__row'>
                <Text className='sline__name'>{s.line.productName}{s.line.isGift ? '（赠）' : ''}</Text>
                <Text className='sline__net'>净 {s.net}{UNIT_LABELS[s.line.unit] ?? s.line.unit}</Text>
              </View>
              <View className='sline__ops'>
                <Text className='sline__label'>实收</Text>
                <Input
                  className='sline__ipt'
                  type='digit'
                  value={s.actual}
                  onInput={(e) => setActual(i, e.detail.value)}
                />
                <View className='stepper'>
                  <Button className='stepper__btn' disabled={Number(s.actual) <= 0} onClick={() => bumpActual(i, -1)}>−</Button>
                  <Text className='stepper__num'>{s.actual}</Text>
                  <Button className='stepper__btn' disabled={Number(s.actual) >= s.net} onClick={() => bumpActual(i, 1)}>＋</Button>
                </View>
                <Text className={`sline__rej ${rejected > 0 ? 'sline__rej--on' : ''}`}>
                  {rejected > 0 ? `拒收 ${rejected}` : '足额'}
                </Text>
              </View>
            </View>
          )
        })}
        {signLines.length === 0 && <Text className='tip'>订单没有可签收的商品行</Text>}
      </View>

      {/* 签收类型与签名 */}
      <View className='card'>
        <Text className='card__title'>签收方式</Text>
        <Picker
          mode='selector'
          range={SIGN_TYPES.map((t) => t.label)}
          value={typeIdx}
          onChange={(e) => setTypeIdx(Number(e.detail.value))}
        >
          <View className='frow'>
            <Text className='frow__label'>类型</Text>
            <Text className='frow__value'>{SIGN_TYPES[typeIdx]?.label}</Text>
            <Text className='frow__arrow'>›</Text>
          </View>
        </Picker>
        <View className='frow'>
          <Text className='frow__label'>签收人</Text>
          <Input
            className='sign__ipt'
            placeholder='客户签收人姓名'
            value={signerName}
            onInput={(e) => setSignerName(e.detail.value)}
          />
        </View>

        {/* M8-3 电子网签: canvas 手写签名(替代原签名文本框) */}
        {SIGN_TYPES[typeIdx]?.key === 'E_SIGN' && (
          <View className='signpad'>
            <View className='signpad__head'>
              <Text className='signpad__label'>请让客户手写签名</Text>
              <Button className='btn-neutral btn-sm signpad__clear' onClick={clearSignature}>清除重写</Button>
            </View>
            <Canvas
              type='2d'
              id={CANVAS_ID}
              canvasId={CANVAS_ID}
              className='signpad__canvas'
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
            />
            <Text className='signpad__tip'>签名将随签收单存证。未手写签名不能提交。</Text>
          </View>
        )}

        {(SIGN_TYPES[typeIdx]?.key === 'PHOTO' || SIGN_TYPES[typeIdx]?.key === 'PAPER') && (
          <View className='signpad'>
            <Text className='signpad__label'>
              {SIGN_TYPES[typeIdx]?.key === 'PAPER' ? '拍一张纸质签收单，没有照片不能提交' : '拍一张签收凭证（签收单/卸货现场），没有照片不能提交'}
            </Text>
            {photoPath ? (
              <View className='signpad__preview' onClick={() => { void takePhoto() }}>
                <Image src={photoPath} mode='aspectFill' className='signpad__photo' />
                <Text className='signpad__tip'>点击重拍</Text>
              </View>
            ) : (
              <Button className='btn-inline btn-inline--ghost' onClick={() => { void takePhoto() }}>拍照 / 从相册选择</Button>
            )}
          </View>
        )}
      </View>

      {/* 回包装动态行 */}
      <View className='card'>
        <Text className='card__title'>回包装回填（选填，落押金台账）</Text>
        {packages.map((p, i) => (
          <View key={i} className='pkgrow'>
            <Picker
              mode='selector'
              range={PACKAGE_CATEGORIES}
              value={Math.max(0, PACKAGE_CATEGORIES.indexOf(p.category))}
              onChange={(e) => setPackage(i, { category: PACKAGE_CATEGORIES[Number(e.detail.value)] ?? p.category })}
            >
              <View className='pkgrow__cat'>
                <Text className='pkgrow__cat-txt'>{p.category}</Text>
                <Text className='frow__arrow'>›</Text>
              </View>
            </Picker>
            <Input
              className='pkgrow__ipt'
              type='number'
              placeholder='数量'
              value={p.qty}
              onInput={(e) => setPackage(i, { qty: e.detail.value })}
            />
            <Text className='pkgrow__del' onClick={() => setPackages((prev) => prev.filter((_, idx) => idx !== i))}>删除</Text>
          </View>
        ))}
        <Button
          className='btn-inline btn-inline--ghost'
          onClick={() => setPackages((prev) => [...prev, { category: PACKAGE_CATEGORIES[0], qty: '' }])}
        >
          ＋ 添加回包装
        </Button>
      </View>

      <Button
        className='btn-primary'
        loading={submitting}
        disabled={submitting || signLines.length === 0}
        onClick={() => { void submit() }}
      >
        确认签收
      </Button>
      <Button className='btn-danger sign__reject' disabled={submitting} onClick={() => setShowReject(true)}>
        整单拒收
      </Button>
      <Text className='tip'>签收即生成应收；拒收部分自动回冲库存，请与客户当面点清</Text>

      <ReasonPopup
        visible={showReject}
        title={`整单拒收 ${order.orderNo || orderNo}`}
        confirmText='确认拒收'
        danger
        placeholder='拒收原因（必填，如破损/临期/客户拒收）'
        onSubmit={(text) => { void reject(text) }}
        onClose={() => setShowReject(false)}
      />
    </View>
  )
}
