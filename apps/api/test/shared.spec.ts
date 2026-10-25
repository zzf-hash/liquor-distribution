/**
 * P0-01 单测: 验证 @liquor/shared 共享契约(校验器 / 外壳守卫 / 角色)
 * 这是 @liquor/shared 的首个真实消费点, 使共享包非"空壳"。
 */
import {
  ApiCodes,
  PRICE_UNIT_INPUTS,
  isApiOk,
  isNonEmpty,
  isPhone,
  isPositiveAmount,
  isRole,
  priceUnitErrorMessage,
  ROLES,
  toPriceUnit,
} from '@liquor/shared';

describe('@liquor/shared 契约', () => {
  it('isPhone 只接受大陆手机号(1[3-9] 开头 11 位)', () => {
    expect(isPhone('13800138000')).toBe(true);
    expect(isPhone('19912345678')).toBe(true);
    expect(isPhone('12345')).toBe(false);
    expect(isPhone('13800138000x')).toBe(false);
    expect(isPhone(13800138000)).toBe(false); // 非字符串
  });

  it('isPositiveAmount 只接受有限正数', () => {
    expect(isPositiveAmount(0.01)).toBe(true);
    expect(isPositiveAmount(100)).toBe(true);
    expect(isPositiveAmount(0)).toBe(false);
    expect(isPositiveAmount(-3)).toBe(false);
    expect(isPositiveAmount(Infinity)).toBe(false);
    expect(isPositiveAmount('5')).toBe(false); // 非 number
  });

  it('isNonEmpty 拒绝空串与纯空白', () => {
    expect(isNonEmpty('ok')).toBe(true);
    expect(isNonEmpty('  x  ')).toBe(true);
    expect(isNonEmpty('')).toBe(false);
    expect(isNonEmpty('   ')).toBe(false);
    expect(isNonEmpty(0)).toBe(false);
  });

  it('isApiOk 区分成功外壳(code 0)与失败外壳', () => {
    expect(isApiOk({ code: 0, data: { a: 1 } })).toBe(true);
    expect(isApiOk({ code: 409, message: '状态机非法转换' })).toBe(false);
    expect(isApiOk({ code: 401, message: '登录已过期' })).toBe(false);
  });

  it('ApiCodes 对齐 http-exception.filter 语义码, ROLES 覆盖五角色', () => {
    expect(ApiCodes.OK).toBe(0);
    expect(ApiCodes.Conflict).toBe(409);
    expect(ApiCodes.Validation).toBe(422);
    expect(ROLES).toHaveLength(5);
    expect(isRole('OWNER')).toBe(true);
    expect(isRole('CUSTOMER')).toBe(true);
    expect(isRole('BOSS')).toBe(false);
  });

  it('toPriceUnit 把箱/件/主单位收成 BASE，瓶/个/最小单位收成 MIN', () => {
    expect(toPriceUnit('箱')).toBe('BASE');
    expect(toPriceUnit(' 件 ')).toBe('BASE');
    expect(toPriceUnit('主单位')).toBe('BASE');
    expect(toPriceUnit('BASE')).toBe('BASE');
    expect(toPriceUnit('瓶')).toBe('MIN');
    expect(toPriceUnit('个')).toBe('MIN');
    expect(toPriceUnit('最小单位')).toBe('MIN');
    expect(toPriceUnit('MIN')).toBe('MIN');
    expect(toPriceUnit('打')).toBeNull();
    expect(toPriceUnit('')).toBeNull();
    const message = priceUnitErrorMessage('打');
    for (const allowed of PRICE_UNIT_INPUTS) expect(message).toContain(allowed);
  });
});
