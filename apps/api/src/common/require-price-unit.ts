import { HttpException, HttpStatus } from '@nestjs/common';
import { priceUnitErrorMessage, toPriceUnit, type PriceUnitCode } from '@liquor/shared';

/** 写入 PriceUnit 之前调用。无法映射时 422，文案带上允许的写法，不落到 Prisma 的 500。 */
export function requirePriceUnit(raw: unknown): PriceUnitCode {
  const unit = toPriceUnit(raw);
  if (!unit) throw new HttpException(priceUnitErrorMessage(raw), HttpStatus.UNPROCESSABLE_ENTITY);
  return unit;
}

/**
 * 校验前使用。能映射则收成 BASE/MIN（箱/件/主单位、瓶/个/最小单位）；
 * 不能映射则原样返回，让 @IsEnum 回 400，而不是先被枚举挡掉、到不了 requirePriceUnit。
 */
export function normalizePriceUnitInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return toPriceUnit(value) ?? value;
}
