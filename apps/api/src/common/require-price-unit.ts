import { HttpException, HttpStatus } from '@nestjs/common';
import { priceUnitErrorMessage, toPriceUnit, type PriceUnitCode } from '@liquor/shared';

/** 写入 PriceUnit 之前调用。无法映射时 422，文案带上允许的写法，不落到 Prisma 的 500。 */
export function requirePriceUnit(raw: unknown): PriceUnitCode {
  const unit = toPriceUnit(raw);
  if (!unit) throw new HttpException(priceUnitErrorMessage(raw), HttpStatus.UNPROCESSABLE_ENTITY);
  return unit;
}
