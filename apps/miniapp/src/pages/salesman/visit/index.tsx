import { useRef, useState } from 'react'
import { rememberIdemKey } from '../../../services/idempotency'
import type { IdemSlot } from '../../../services/idempotency'
import { Button, Image, Picker, Text, Textarea, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { LOGIN_PAGE, fmtDateTime, getToken, visitsApi } from '../../../services/api'
import { VISIT_PHOTO_UNSAVED, visitCreateBody } from '../../../services/visit-photo'
import type { VisitCustomerDTO, VisitDTO, VisitSteps } from '../../../services/api'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

// 标准八步骤（任务书 P1-T13：陈列检查/库存盘点/收单/收款/宣传物料/客情沟通/竞品信息/设备检查）
const VISIT_STEPS: Array<{ key: string; label: string }> = [
  { key: 'displayCheck', label: '陈列检查' },
  { key: 'stockCount', label: '库存盘点' },
  { key: 'orderTaking', label: '收单' },
  { key: 'payment', label: '收款' },
  { key: 'materials', label: '宣传物料' },
  { key: 'communication', label: '客情沟通' },
  { key: 'competitor', label: '竞品信息' },
  { key: 'equipment', label: '设备检查' },
]

const EMPTY_STEPS: VisitSteps = VISIT_STEPS.reduce((m, s) => {
  m[s.key] = false
  return m
}, {} as VisitSteps)

/** 当月（YYYY-MM），拜访月度统计入参 */
function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function stepDone(v: VisitDTO): number {
  return Object.values(v.steps ?? {}).filter(Boolean).length
}

/**
 * 业务员拜访打卡（P1-T13）：选客户（rep token 只见名下客户）→ 定位（失败可跳过）
 * → 水印照片（只在本机预览，不上传）→ 八步骤勾选 → 提交；
 * 下方「我的拜访」时间线 + 月度统计（本月 X 次）。触控元素均 ≥88px 计量红线。
 */
export default function SalesmanVisitPage() {
  const idemRef = useRef<IdemSlot | null>(null)
  const [customers, setCustomers] = useState<VisitCustomerDTO[]>([])
  const [customerId, setCustomerId] = useState('')
  const [located, setLocated] = useState('')
  const [locating, setLocating] = useState(false)
  const [photo, setPhoto] = useState('')
  const [photoAt, setPhotoAt] = useState('')
  const [steps, setSteps] = useState<VisitSteps>({ ...EMPTY_STEPS })
  const [notes, setNotes] = useState('')
  const [visits, setVisits] = useState<VisitDTO[]>([])
  const [monthCount, setMonthCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void load()
  })

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [custRes, mineRes, statsRes] = await Promise.all([
        visitsApi.customers(),
        visitsApi.mine(),
        visitsApi.stats(currentMonth()),
      ])
      setCustomers(custRes.items ?? [])
      setVisits(mineRes.items ?? [])
      setMonthCount(Number(statsRes?.count ?? 0))
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载拜访数据失败')
    } finally {
      setLoading(false)
    }
  }

  /** 定位（Taro.getLocation）：失败可跳过（不影响提交） */
  async function pickLocation() {
    if (locating) return
    setLocating(true)
    try {
      const res = await Taro.getLocation({ type: 'gcj02' })
      setLocated(`${res.latitude.toFixed(5)},${res.longitude.toFixed(5)}`)
    } catch {
      Taro.showToast({ title: '定位失败，可跳过', icon: 'none' })
    } finally {
      setLocating(false)
    }
  }

  /** 拍照只做本机预览。没有上传接口，提交时不带 photoUrl。 */
  function choosePhoto() {
    void Taro.chooseImage({ count: 1, sizeType: ['compressed'] })
      .then((res) => {
        const p = res.tempFilePaths?.[0]
        if (p) {
          setPhoto(p)
          setPhotoAt(fmtDateTime(new Date().toISOString()))
        }
      })
      .catch(() => undefined)
  }

  function toggleStep(key: string) {
    setSteps((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  async function submit() {
    if (submitting) return
    if (!customerId) {
      Taro.showToast({ title: '请选择拜访客户', icon: 'none' })
      return
    }
    const done = Object.values(steps).filter(Boolean).length
    if (done === 0) {
      Taro.showToast({ title: '请至少勾选一个拜访步骤', icon: 'none' })
      return
    }
    setSubmitting(true)
    const hadPhoto = Boolean(photo)
    try {
      const payload = visitCreateBody({
        customerId,
        location: located || undefined,
        steps,
        notes: notes.trim() || undefined,
      })
      await visitsApi.create(payload, rememberIdemKey(idemRef, payload))
      idemRef.current = null
      if (hadPhoto) {
        await Taro.showModal({ title: '打卡已提交', content: VISIT_PHOTO_UNSAVED, showCancel: false })
      } else {
        Taro.showToast({ title: '打卡成功', icon: 'success' })
      }
      setCustomerId('')
      setLocated('')
      setPhoto('')
      setPhotoAt('')
      setSteps({ ...EMPTY_STEPS })
      setNotes('')
      void load()
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '提交失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  const customerNames = customers.map((c) => c.name)
  const selected = customers.find((c) => c.id === customerId)
  const doneCount = Object.values(steps).filter(Boolean).length

  return (
    <View className='visit'>
      {/* 月度统计 */}
      <View className='visit__stat'>
        <Text className='visit__stat-label'>本月拜访</Text>
        <Text className='visit__stat-num'>{monthCount} 次</Text>
      </View>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
      ) : (
        <>
          {/* 打卡表单 */}
          <View className='fcard'>
            <Text className='fcard__title'>拜访打卡</Text>

            <Text className='fcard__label'>拜访客户（必选）</Text>
            <Picker
              mode='selector'
              range={customerNames}
              onChange={(e) => setCustomerId(customers[Number(e.detail.value)]?.id ?? '')}
            >
              <View className='fcard__row'>
                <Text className={selected ? 'fcard__value' : 'fcard__placeholder'}>
                  {selected ? selected.name : '点此选择客户'}
                </Text>
                <Text className='fcard__arrow'>›</Text>
              </View>
            </Picker>

            <Text className='fcard__label'>定位（失败可跳过）</Text>
            <View className='fcard__row' onClick={() => { void pickLocation() }}>
              <Text className={located ? 'fcard__value' : 'fcard__placeholder'}>
                {located ? `已定位 ${located}` : '点此获取定位'}
              </Text>
              <Text className='fcard__arrow'>{locating ? '…' : '›'}</Text>
            </View>

            <Text className='fcard__label'>水印照片（选填，仅本机预览）</Text>
            {photo ? (
              <View className='photo'>
                <View className='photo__frame'>
                  <Image className='photo__img' src={photo} mode='aspectFill' onClick={() => Taro.previewImage({ urls: [photo] })} />
                  <Text className='photo__mark'>{photoAt}{located ? ` ${located}` : ''} 本机水印</Text>
                </View>
                <View className='photo__ops'>
                  <Text className='photo__op' onClick={choosePhoto}>重拍</Text>
                  <Text className='photo__op' onClick={() => { setPhoto(''); setPhotoAt('') }}>删除</Text>
                </View>
              </View>
            ) : (
              <View className='photo photo--empty' onClick={choosePhoto}>
                <Text className='photo__add'>＋</Text>
                <Text className='photo__hint'>拍照打卡</Text>
              </View>
            )}

            <Text className='fcard__label'>八步骤（已选 {doneCount}/8）</Text>
            <View className='chips'>
              {VISIT_STEPS.map((s) => (
                <View
                  key={s.key}
                  className={`chip ${steps[s.key] ? 'chip--on' : ''}`}
                  onClick={() => toggleStep(s.key)}
                >
                  <Text className={`chip__box ${steps[s.key] ? 'chip__box--on' : ''}`}>
                    {steps[s.key] ? '✓' : ''}
                  </Text>
                  <Text className='chip__label'>{s.label}</Text>
                </View>
              ))}
            </View>

            <Text className='fcard__label'>备注（选填）</Text>
            <Textarea
              className='notes'
              placeholder='竞品动态、客户需求等'
              maxlength={200}
              value={notes}
              onInput={(e) => setNotes(e.detail.value)}
            />

            <Button
              className='btn-primary'
              loading={submitting}
              disabled={submitting}
              onClick={() => { void submit() }}
            >
              提交打卡
            </Button>
          </View>

          {/* 我的拜访时间线 */}
          <View className='fcard'>
            <Text className='fcard__title'>我的拜访（{visits.length}）</Text>
            {loading ? (
              <Text className='visit__tip'>正在加载…</Text>
            ) : visits.length === 0 ? (
              <Text className='visit__tip'>还没有拜访记录，完成上方打卡后展示</Text>
            ) : (
              <View className='tl'>
                {visits.map((v) => (
                  <View key={v.id} className='tl__item'>
                    <View className='tl__rail'>
                      <View className='tl__dot' />
                    </View>
                    <View className='tl__card'>
                      <View className='tl__row'>
                        <Text className='tl__cust'>{v.customer?.name ?? v.customerId}</Text>
                        <Text className='tl__steps'>步骤 {stepDone(v)}/8</Text>
                      </View>
                      <Text className='tl__time'>{fmtDateTime(v.visitedAt)}</Text>
                      {v.notes ? <Text className='tl__notes'>{v.notes}</Text> : null}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        </>
      )}
      <RoleTabBar />
    </View>
  )
}
