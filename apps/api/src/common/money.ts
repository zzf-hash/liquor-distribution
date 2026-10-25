import { Prisma } from '@prisma/client';

/** Integer cents. Money math in the fund/inventory fixes stays in cents, not binary floats. */
export type Cents = number;

export function toCents(value: Prisma.Decimal | number | string | null | undefined): Cents {
  if (value === null || value === undefined || value === '') return 0;
  const d = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  if (!d.isFinite()) return 0;
  return d.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

export function centsToDecimal(cents: Cents): Prisma.Decimal {
  return new Prisma.Decimal(cents).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function centsToNumber(cents: Cents): number {
  return centsToDecimal(cents).toNumber();
}

/** qty × unit price, rounded to the nearest cent. qty may be fractional or negative (red reversals). */
export function mulQtyPriceToCents(qty: Prisma.Decimal.Value, unitPrice: Prisma.Decimal.Value): Cents {
  return new Prisma.Decimal(qty).mul(unitPrice).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/** rate is a fraction (0.03 = 3%), not a percent. */
export function percentOfCents(cents: Cents, rate: number): Cents {
  return new Prisma.Decimal(cents).mul(rate).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}
