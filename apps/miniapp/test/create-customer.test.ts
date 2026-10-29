import { describe, expect, it } from 'vitest'
import { ROLE_HOME_PAGE } from '../src/config/role-home'
import {
  canCreateCustomer,
  createCustomerPayload,
  emptyCreateCustomerDraft,
  friendlyCreateCustomerError,
  onboardingLabel,
  validateCreateCustomer,
} from '../src/services/create-customer'
import { deniedHomeForConfirmedRole, guardRedirect } from '../src/services/route-guard'

const CREATE_PAGE = '/pages/salesman/customer-create/index'

function readyDraft() {
  return {
    ...emptyCreateCustomerDraft(),
    code: 'C1001',
    name: '西湖烟酒店',
    type: 'YANJIUDIAN',
    phone: '13800001111',
    address: '杭州市西湖区文三路 1 号',
    settlement: 'MONTHLY',
    termsDays: '30',
    salespersonId: 'rep-other',
  }
}

describe('create customer form', () => {
  it('matches the backend required fields and the monthly terms rule', () => {
    expect(validateCreateCustomer(emptyCreateCustomerDraft())).toBe('请输入客户编码')
    const named = { ...emptyCreateCustomerDraft(), code: 'C1', name: '店' }
    expect(validateCreateCustomer(named)).toBe('请选择客户类型')
    const monthly = { ...readyDraft(), termsDays: '0' }
    expect(validateCreateCustomer(monthly)).toBe('月结客户必须填写账期天数（>0）')
    expect(validateCreateCustomer({ ...readyDraft(), termsDays: '-3' })).toBe('月结客户必须填写账期天数（>0）')
    expect(validateCreateCustomer({ ...readyDraft(), settlement: 'CASH', termsDays: '' })).toBeNull()
    expect(validateCreateCustomer(readyDraft())).toBeNull()
  })

  it('lets a rep omit the salesperson so the server assigns the current user', () => {
    const payload = createCustomerPayload(readyDraft(), 'REP')
    expect(payload.salespersonId).toBeUndefined()
    expect(payload).toMatchObject({
      code: 'C1001',
      name: '西湖烟酒店',
      type: 'YANJIUDIAN',
      settlement: 'MONTHLY',
      termsDays: 30,
      signMode: 'E_SIGN',
    })
    expect(createCustomerPayload({ ...readyDraft(), salespersonId: 'rep-9' }, 'owner').salespersonId).toBe('rep-9')
    expect(createCustomerPayload({ ...readyDraft(), licenseNo: '  ', contact: '' }, 'OWNER').licenseNo).toBeUndefined()
  })

  it('keeps a Chinese server message and translates a duplicate-style validator line', () => {
    expect(friendlyCreateCustomerError('客户编码「C1001」已存在（租户内唯一）')).toBe('客户编码「C1001」已存在（租户内唯一）')
    expect(friendlyCreateCustomerError('月结客户必须填写账期天数（>0）')).toContain('账期')
    expect(friendlyCreateCustomerError('type must be one of the following values: YANJIUDIAN, CHAOSHI')).toBe('客户类型不在允许的取值里')
    expect(onboardingLabel('REP_DRAFT')).toBe('业务员录入')
  })

  it('shows the entry only to the owner and the rep', () => {
    expect(canCreateCustomer('REP')).toBe(true)
    expect(canCreateCustomer('owner')).toBe(true)
    expect(canCreateCustomer('CLERK')).toBe(false)
    expect(canCreateCustomer('WAREHOUSE')).toBe(false)
    expect(canCreateCustomer('CUSTOMER')).toBe(false)
    expect(canCreateCustomer('')).toBe(false)
  })

  it('blocks clerk, warehouse and customer from the create page', () => {
    expect(guardRedirect('REP', `#${CREATE_PAGE}`)).toBeNull()
    expect(guardRedirect('OWNER', `${CREATE_PAGE}?from=url`)).toBeNull()
    expect(guardRedirect('CLERK', CREATE_PAGE)).toBe(ROLE_HOME_PAGE.CLERK)
    expect(guardRedirect('WAREHOUSE', CREATE_PAGE)).toBe(ROLE_HOME_PAGE.WAREHOUSE)
    expect(guardRedirect('CUSTOMER', CREATE_PAGE)).toBe(ROLE_HOME_PAGE.CUSTOMER)
    expect(guardRedirect('', CREATE_PAGE)).toBe('/pages/staff/login/index')
    expect(deniedHomeForConfirmedRole('CLERK', CREATE_PAGE)).toBe(ROLE_HOME_PAGE.CLERK)
    expect(deniedHomeForConfirmedRole('', CREATE_PAGE)).toBeNull()
    expect(guardRedirect('CLERK', '/pages/salesman/customers/index')).toBeNull()
  })
})
