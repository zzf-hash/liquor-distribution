/** 新建客户。字段与后台 CustomerFormModal 对齐，并且都在 CreateCustomerDto 里。 */

export const CREATE_CUSTOMER_PAGE = '/pages/salesman/customer-create/index'

export const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  YANJIUDIAN: '烟酒店',
  CHAOSHI: '超市',
  CANYIN: '餐饮',
  PIFA: '批发',
  YECHANG: '夜场',
  QIYE: '企事业单位',
  QITA: '其他',
}

export const SETTLEMENT_OPTIONS = [
  { value: 'CASH', label: '现结' },
  { value: 'MONTHLY', label: '月结' },
] as const

export const SIGN_MODE_OPTIONS = [
  { value: 'E_SIGN', label: '网签' },
  { value: 'PAPER', label: '纸单' },
] as const

export const ONBOARDING_LABELS: Record<string, string> = {
  REP_DRAFT: '业务员录入',
  CLERK_CONFIRMED: '内勤已确认',
  PENDING_OWNER: '待老板终审',
  ACTIVE: '已生效',
  REJECTED: '已驳回',
}

const FIELD_LABELS: Record<string, string> = {
  code: '客户编码',
  name: '店名',
  type: '客户类型',
  phone: '手机',
  address: '地址',
  settlement: '结算方式',
  termsDays: '账期天数',
  creditLimit: '信用额度',
  minOrderAmount: '起送金额',
  signMode: '签收方式',
  salespersonId: '归属业务员',
  contact: '联系人',
  region: '区域',
  licenseNo: '证照号',
  receivingWindow: '收货时段',
  bossPhone: '老板手机',
}

export interface CreateCustomerDraft {
  code: string
  name: string
  type: string
  phone: string
  licenseNo: string
  contact: string
  region: string
  address: string
  settlement: string
  termsDays: string
  creditLimit: string
  minOrderAmount: string
  signMode: string
  receivingWindow: string
  salespersonId: string
  bossPhone: string
}

export function emptyCreateCustomerDraft(): CreateCustomerDraft {
  return {
    code: '',
    name: '',
    type: '',
    phone: '',
    licenseNo: '',
    contact: '',
    region: '',
    address: '',
    settlement: 'MONTHLY',
    termsDays: '30',
    creditLimit: '',
    minOrderAmount: '',
    signMode: 'E_SIGN',
    receivingWindow: '',
    salespersonId: '',
    bossPhone: '',
  }
}

/** 小程序只给老板和业务员建档。内勤、仓管、客户没有入口，守卫也不放行。 */
export function canCreateCustomer(role: string | null | undefined): boolean {
  const key = (role ?? '').trim().toUpperCase()
  return key === 'OWNER' || key === 'REP'
}

export function onboardingLabel(status: string | null | undefined): string {
  if (!status) return '未返回'
  return ONBOARDING_LABELS[status] ?? status
}

function integerAtLeast(raw: string, min: number): number | null {
  const text = raw.trim()
  if (!/^-?\d+$/.test(text)) return null
  const n = Number(text)
  if (!Number.isSafeInteger(n) || n < min) return null
  return n
}

function amountAtLeastZero(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/** 与 CreateCustomerDto 的必填项，以及 service 里「月结账期 > 0」同一条。 */
export function validateCreateCustomer(draft: CreateCustomerDraft): string | null {
  if (!draft.code.trim()) return '请输入客户编码'
  if (!draft.name.trim()) return '请输入店名'
  if (!CUSTOMER_TYPE_LABELS[draft.type]) return '请选择客户类型'
  if (!draft.phone.trim()) return '请输入手机'
  if (!draft.address.trim()) return '请输入地址'
  if (draft.settlement !== 'CASH' && draft.settlement !== 'MONTHLY') return '请选择结算方式'
  if (draft.settlement === 'MONTHLY' && integerAtLeast(draft.termsDays, 1) == null) {
    return '月结客户必须填写账期天数（>0）'
  }
  if (draft.settlement === 'CASH' && draft.termsDays.trim() && integerAtLeast(draft.termsDays, 0) == null) {
    return '账期天数须为不小于 0 的整数'
  }
  if (draft.creditLimit.trim() && amountAtLeastZero(draft.creditLimit) == null) return '信用额度须为不小于 0 的数字'
  if (draft.minOrderAmount.trim() && amountAtLeastZero(draft.minOrderAmount) == null) return '起送金额须为不小于 0 的数字'
  if (draft.signMode && draft.signMode !== 'E_SIGN' && draft.signMode !== 'PAPER') return '签收方式不正确'
  return null
}

/**
 * 业务员不传 salespersonId。POST /customers 在缺省时把归属写成当前用户。
 * 老板只有选了业务员才传。空的选填项不传，避免把空串写进档案。
 */
export function createCustomerPayload(draft: CreateCustomerDraft, role: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    code: draft.code.trim(),
    name: draft.name.trim(),
    type: draft.type,
    phone: draft.phone.trim(),
    address: draft.address.trim(),
    settlement: draft.settlement,
    signMode: draft.signMode || 'E_SIGN',
  }
  const optional = ['licenseNo', 'contact', 'region', 'receivingWindow', 'bossPhone'] as const
  for (const key of optional) {
    const value = draft[key].trim()
    if (value) payload[key] = value
  }
  if (draft.settlement === 'MONTHLY') payload.termsDays = integerAtLeast(draft.termsDays, 1)
  else if (draft.termsDays.trim()) payload.termsDays = integerAtLeast(draft.termsDays, 0)
  if (draft.creditLimit.trim()) payload.creditLimit = amountAtLeastZero(draft.creditLimit)
  if (draft.minOrderAmount.trim()) payload.minOrderAmount = amountAtLeastZero(draft.minOrderAmount)
  if (role.trim().toUpperCase() !== 'REP' && draft.salespersonId.trim()) {
    payload.salespersonId = draft.salespersonId.trim()
  }
  return payload
}

/** 后端中文错误原样展示。校验器的英文句子改成字段名。 */
export function friendlyCreateCustomerError(message: string): string {
  const text = message.trim()
  if (!text) return '创建失败，请稍后重试'
  if (/[\u4e00-\u9fff]/.test(text)) return text
  return text.split('；').map((part) => {
    const matched = part.match(/^([A-Za-z]+)\b/)
    const label = matched ? FIELD_LABELS[matched[1]] : undefined
    if (!label) return '创建失败，请检查填写后再试'
    if (part.includes('must be one of')) return `${label}不在允许的取值里`
    if (part.includes('must be an integer') || part.includes('must not be less than') || part.includes('must be a number')) {
      return `${label}须为不小于 0 的数字`
    }
    if (part.includes('must be a string') || part.includes('should not be empty')) return `请填写${label}`
    return `${label}填写不正确`
  }).join('；')
}
