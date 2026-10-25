import { Prisma } from '@prisma/client';
import { mulQtyPriceToCents } from '../../common/money';

/** Sum of return qty × original order-line unit price, in cents. */
export function returnLinesCents(
  lines: Array<{ orderLineId: string; qty: Prisma.Decimal.Value }>,
  orderLines: Array<{ id: string; unitPrice: Prisma.Decimal.Value }>,
): number {
  const price = new Map(orderLines.map((l) => [l.id, l.unitPrice]));
  let cents = 0;
  for (const line of lines) {
    const unit = price.get(line.orderLineId);
    if (unit === undefined) continue;
    cents += mulQtyPriceToCents(line.qty, unit);
  }
  return cents;
}
