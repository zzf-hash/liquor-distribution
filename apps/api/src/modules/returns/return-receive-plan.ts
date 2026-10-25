import { ConflictException } from '@nestjs/common';

/** 与管理端 ReturnReceivePreviewDTO 对齐的批次回冲行。 */
export interface PlannedReturnBatch {
  batchId: string;
  batchNo: string | null;
  productId: string;
  productName: string | null;
  qty: number;
}

export interface ReturnReceivePlan {
  batches: PlannedReturnBatch[];
  arCredit: number;
}

interface PlanLine {
  orderLineId: string;
  productId: string;
  qty: number;
}

interface PlanOrderLine {
  id: string;
  productName: string;
  unit: string;
  conversionRate: number;
  unitPrice: number;
}

interface PlanOutboundLine {
  orderLineId: string;
  batchId: string;
  batchNo: string | null;
  qty: number;
}

/**
 * 收货预览和正式收货共用：按已确认出库批次顺序回冲，应收按原行单价×退货数量。
 * 超出已出库数量时拒绝，避免预览和落账各算一套。
 */
export function planReturnReceive(args: {
  lines: PlanLine[];
  orderLines: PlanOrderLine[];
  outboundLines: PlanOutboundLine[];
}): ReturnReceivePlan {
  const batches: PlannedReturnBatch[] = [];
  let arCredit = 0;
  for (const line of args.lines) {
    const orderLine = args.orderLines.find((row) => row.id === line.orderLineId);
    if (!orderLine) continue;
    const minQty = Number(line.qty) * (orderLine.unit === 'BASE' ? orderLine.conversionRate : 1);
    let remaining = minQty;
    for (const outbound of args.outboundLines) {
      if (outbound.orderLineId !== line.orderLineId) continue;
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(outbound.qty));
      if (take <= 0) continue;
      remaining -= take;
      batches.push({
        batchId: outbound.batchId,
        batchNo: outbound.batchNo,
        productId: line.productId,
        productName: orderLine.productName,
        qty: take,
      });
    }
    if (remaining > 0.0001) {
      throw new ConflictException(`退货行 ${line.orderLineId} 超过已确认出库数量，无法回冲库存`);
    }
    arCredit += Number(orderLine.unitPrice) * Number(line.qty);
  }
  return { batches, arCredit: Number(arCredit.toFixed(2)) };
}
