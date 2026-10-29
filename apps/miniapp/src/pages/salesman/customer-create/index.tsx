import { useState } from 'react'
import { Button, Input, Picker, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { LOGIN_PAGE, customersApi, getToken, usersApi } from '../../../services/api'
import type { CreatedCustomerDTO } from '../../../services/api'
import {
  CREATE_CUSTOMER_PAGE,
  CUSTOMER_TYPE_LABELS,
  SETTLEMENT_OPTIONS,
  SIGN_MODE_OPTIONS,
  createCustomerPayload,
  emptyCreateCustomerDraft,
  friendlyCreateCustomerError,
  onboardingLabel,
  validateCreateCustomer,
  type CreateCustomerDraft,
} from '../../../services/create-customer'
import { deniedHomeForConfirmedRole } from '../../../services/route-guard'
import { confirmedRoleForGuard } from '../../../services/session-cache'
import { openAppPage } from '../../../services/navigation'
import './index.scss'

const TYPE_OPTIONS = Object.entries(CUSTOMER_TYPE_LABELS).map(([value, label]) => ({ value, label }))

function setField(draft: CreateCustomerDraft, key: keyof CreateCustomerDraft, value: string): CreateCustomerDraft {
  return { ...draft, [key]: value }
}

function Choice(props: {
  label: string
  required?: boolean
  options: Array<{ value: string; label: string }>
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  const current = props.options.find((option) => option.value === props.value)
  const index = Math.max(0, props.options.findIndex((option) => option.value === props.value))
  return (
    <Picker
      mode='selector'
      range={props.options.map((option) => option.label)}
      value={index}
      onChange={(e) => {
        const next = props.options[Number(e.detail.value)]
        if (next) props.onChange(next.value)
      }}
    >
      <View className='frow'>
        <Text className='frow__label'>
          {props.label}
          {props.required ? <Text className='frow__req'>*</Text> : null}
        </Text>
        <Text className={current ? 'frow__value' : 'frow__placeholder'}>{current ? current.label : props.placeholder}</Text>
        <Text className='frow__arrow'>›</Text>
      </View>
    </Picker>
  )
}

function Line(props: {
  label: string
  required?: boolean
  value: string
  placeholder: string
  number?: boolean
  onInput: (value: string) => void
}) {
  return (
    <View className='frow'>
      <Text className='frow__label'>
        {props.label}
        {props.required ? <Text className='frow__req'>*</Text> : null}
      </Text>
      <Input
        className='cc-form__ipt'
        type={props.number ? 'digit' : 'text'}
        placeholder={props.placeholder}
        value={props.value}
        onInput={(e) => props.onInput(e.detail.value)}
      />
    </View>
  )
}

/** 新建客户。不改开户四步，建档后停在「业务员录入」。 */
export default function CreateCustomerPage() {
  const [role, setRole] = useState('')
  const [draft, setDraft] = useState(emptyCreateCustomerDraft)
  const [reps, setReps] = useState<Array<{ id: string; name: string }>>([])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<CreatedCustomerDTO | null>(null)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    const confirmed = confirmedRoleForGuard()
    const home = deniedHomeForConfirmedRole(confirmed, CREATE_CUSTOMER_PAGE)
    if (home) {
      Taro.reLaunch({ url: home })
      return
    }
    setRole(confirmed)
    if (confirmed.trim().toUpperCase() === 'OWNER') {
      usersApi.listReps().then(setReps).catch(() => setReps([]))
    }
  })

  function back() {
    openAppPage(role.trim().toUpperCase() === 'OWNER' ? '/pages/boss/home/index' : '/pages/salesman/customers/index')
  }

  async function submit() {
    if (submitting) return
    const problem = validateCreateCustomer(draft)
    if (problem) {
      setError(problem)
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const saved = await customersApi.create(createCustomerPayload(draft, role))
      setCreated(saved)
    } catch (e) {
      setError(friendlyCreateCustomerError(e instanceof Error ? e.message : ''))
    } finally {
      setSubmitting(false)
    }
  }

  if (created) {
    const repName = reps.find((rep) => rep.id === created.salespersonId)?.name
    const ownerLine = role.trim().toUpperCase() === 'REP'
      ? '归属业务员：你本人'
      : repName
        ? `归属业务员：${repName}`
        : created.salespersonId
          ? '归属业务员已指定'
          : '未指定归属业务员'
    return (
      <View className='page'>
        <View className='page-head'>
          <View className='page-head__main'>
            <Text className='page-head__title'>客户已建档</Text>
            <Text className='page-head__sub'>需完成开户审批</Text>
          </View>
        </View>
        <View className='card'>
          <Text className='card__title'>{created.name}</Text>
          <Text className='tip'>{created.code}</Text>
          <Text className='cc-form__status'>开户状态：{onboardingLabel(created.onboarding)}</Text>
          <Text className='cc-form__note'>{ownerLine}</Text>
        </View>
        <Button className='btn-primary' onClick={back}>
          <Text className='btn-label'>返回</Text>
        </Button>
      </View>
    )
  }

  const monthly = draft.settlement === 'MONTHLY'
  const isRep = role.trim().toUpperCase() === 'REP'

  return (
    <View className='page'>
      <View className='page-head'>
        <View className='page-head__main'>
          <Text className='page-head__title'>新建客户</Text>
          <Text className='page-head__sub'>保存后进入开户审批，当前状态是业务员录入</Text>
        </View>
      </View>

      <View className='card'>
        <Text className='card__title'>门店</Text>
      <Line label='客户编码' required value={draft.code} placeholder='如 C1001' onInput={(value) => setDraft((prev) => setField(prev, 'code', value))} />
      <Line label='店名' required value={draft.name} placeholder='门店名称' onInput={(value) => setDraft((prev) => setField(prev, 'name', value))} />
      <Choice label='客户类型' required options={TYPE_OPTIONS} value={draft.type} placeholder='请选择' onChange={(value) => setDraft((prev) => setField(prev, 'type', value))} />
      <Line label='手机' required value={draft.phone} placeholder='联系电话' onInput={(value) => setDraft((prev) => setField(prev, 'phone', value))} />
      <Line label='证照号' value={draft.licenseNo} placeholder='选填' onInput={(value) => setDraft((prev) => setField(prev, 'licenseNo', value))} />
      <Line label='联系人' value={draft.contact} placeholder='选填' onInput={(value) => setDraft((prev) => setField(prev, 'contact', value))} />
      <Line label='区域' value={draft.region} placeholder='选填' onInput={(value) => setDraft((prev) => setField(prev, 'region', value))} />
      <Line label='地址' required value={draft.address} placeholder='收货地址' onInput={(value) => setDraft((prev) => setField(prev, 'address', value))} />
      </View>
      <View className='card'>
        <Text className='card__title'>结算</Text>
      <Choice
        label='结算方式'
        required
        options={[...SETTLEMENT_OPTIONS]}
        value={draft.settlement}
        placeholder='请选择'
        onChange={(value) => setDraft((prev) => setField(prev, 'settlement', value))}
      />
      <Line
        label='账期天数'
        required={monthly}
        number
        value={draft.termsDays}
        placeholder={monthly ? '月结必填，大于 0' : '现结可不填'}
        onInput={(value) => setDraft((prev) => setField(prev, 'termsDays', value))}
      />
      <Line label='信用额度' number value={draft.creditLimit} placeholder='选填' onInput={(value) => setDraft((prev) => setField(prev, 'creditLimit', value))} />
      <Line label='起送金额' number value={draft.minOrderAmount} placeholder='选填' onInput={(value) => setDraft((prev) => setField(prev, 'minOrderAmount', value))} />
      </View>
      <View className='card'>
        <Text className='card__title'>收货</Text>
      <Choice
        label='签收方式'
        options={[...SIGN_MODE_OPTIONS]}
        value={draft.signMode}
        placeholder='网签'
        onChange={(value) => setDraft((prev) => setField(prev, 'signMode', value))}
      />
      <Line label='收货时段' value={draft.receivingWindow} placeholder='选填' onInput={(value) => setDraft((prev) => setField(prev, 'receivingWindow', value))} />
      {isRep ? (
        <Text className='cc-form__note'>归属业务员不用选。保存后系统挂到你名下。</Text>
      ) : (
        <Choice
          label='归属业务员'
          options={[{ value: '', label: '不指定' }, ...reps.map((rep) => ({ value: rep.id, label: rep.name }))]}
          value={draft.salespersonId}
          placeholder='不指定'
          onChange={(value) => setDraft((prev) => setField(prev, 'salespersonId', value))}
        />
      )}
      <Line label='老板手机' value={draft.bossPhone} placeholder='选填' onInput={(value) => setDraft((prev) => setField(prev, 'bossPhone', value))} />
      </View>

      {error ? <Text className='cc-form__error'>{error}</Text> : null}
      <Button className='btn-primary' loading={submitting} disabled={submitting} onClick={() => { void submit() }}>
        <Text className='btn-label'>保存</Text>
      </Button>
    </View>
  )
}
