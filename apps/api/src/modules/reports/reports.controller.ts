import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P1-T11 一键报表 (口径与台账一致: 流水投影, 不另立账) ═══════════════
// 月报表: 销售(签收口径)/回款/退货/采购 + 品类/业务员/Top商品 维度
// 库存表: 商品×批次 在库数量×单位成本 = 库存金额(B4 流水投影)

@Controller('reports')
@Roles('OWNER', 'CLERK')
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('monthly')
  async monthly(@CurrentUser() user: AuthUser, @Query('month') month: string): Promise<unknown> {
    if (!/^\d{4}-\d{2}$/.test(month ?? '')) throw new ConflictException('月份格式 YYYY-MM');
    const start = dayjs(`${month}-01`).startOf('month').toDate();
    const end = dayjs(`${month}-01`).endOf('month').toDate();
    // 销售: 期间签收订单(含明细, 按品类聚合 + top 商品)
    const orders = await this.prisma.salesOrder.findMany({
      where: { signedAt: { gte: start, lte: end }, status: { in: ['SIGNED', 'SETTLED'] } },
      include: { lines: { include: { product: { select: { category: true } } } }, signature: true },
    });
    const salesByCategory: Record<string, number> = {};
    const productAgg = new Map<string, { name: string; qty: number; amount: number }>();
    const repAgg = new Map<string, { amount: number; orderCount: number }>();
    let totalSales = 0;
    for (const o of orders) {
      const reversed = new Map<string, number>();
      for (const line of o.lines) if (line.reversalOfId) reversed.set(line.reversalOfId, (reversed.get(line.reversalOfId) ?? 0) + Number(line.qty));
      const actualLines = Array.isArray(o.signature?.actualLines) ? o.signature.actualLines as Array<{ orderLineId: string; actualQty: number }> : [];
      let orderNet = 0;
      for (const l of o.lines) {
        if (l.reversalOfId) continue;
        const netQty = Number(l.qty) + (reversed.get(l.id) ?? 0);
        const actual = actualLines.length ? Number(actualLines.find((x) => x.orderLineId === l.id)?.actualQty ?? 0) : netQty;
        const acceptedQty = Math.max(0, Math.min(netQty, actual));
        const amt = Number((acceptedQty * Number(l.unitPrice)).toFixed(2));
        orderNet += amt;
        totalSales += amt;
        const cat = String(l.product?.category ?? 'QITA');
        salesByCategory[cat] = (salesByCategory[cat] ?? 0) + amt;
        const cur = productAgg.get(l.productId) ?? { name: l.productName, qty: 0, amount: 0 };
        cur.qty += acceptedQty; cur.amount += amt;
        productAgg.set(l.productId, cur);
      }
      if (o.salespersonId) {
        const rep = repAgg.get(o.salespersonId) ?? { amount: 0, orderCount: 0 };
        rep.amount += orderNet; rep.orderCount += 1; repAgg.set(o.salespersonId, rep);
      }
    }
    const topProducts = [...productAgg.values()].sort((a, b) => b.amount - a.amount).slice(0, 10);
    const repIds = [...repAgg.keys()];
    const reps = repIds.length ? await this.prisma.user.findMany({ where: { id: { in: repIds } }, select: { id: true, name: true } }) : [];
    // 回款/退货/采购汇总
    const [payAgg, returnAgg, purchaseAgg, arAgg] = await this.prisma.$transaction([
      this.prisma.payment.aggregate({ where: { status: 'CONFIRMED', kind: 'PAYMENT', confirmedAt: { gte: start, lte: end } }, _sum: { amount: true } }),
      this.prisma.returnOrder.count({ where: { status: 'RECEIVED', receivedAt: { gte: start, lte: end } } }),
      this.prisma.purchaseOrder.aggregate({ where: { receivedAt: { gte: start, lte: end } }, _sum: { totalAmount: true } }),
      this.prisma.receivable.aggregate({ where: { archivedAt: null }, _sum: { total: true } }),
    ]);
    void user;
    return {
      month, totalSales: Number(totalSales.toFixed(2)), salesByCategory,
      topProducts,
      salesByRep: [...repAgg].map(([id, row]) => ({ name: reps.find((u) => u.id === id)?.name ?? '未知', amount: Number(row.amount.toFixed(2)), orderCount: row.orderCount })),
      totalPayments: Number(payAgg._sum.amount ?? 0),
      returnCount: returnAgg,
      totalPurchases: Number(purchaseAgg._sum.totalAmount ?? 0),
      totalReceivable: Number(arAgg._sum.total ?? 0),
    };
  }

  @Get('inventory')
  async inventory(@CurrentUser() user: AuthUser): Promise<unknown> {
    const batches = await this.prisma.batchStock.findMany({
      where: { tenantId: user.tenantId },
      include: { product: { select: { skuCode: true, name: true, category: true } }, ledger: true },
      orderBy: [{ productId: 'asc' }, { createdAt: 'asc' }],
    });
    let totalValue = 0;
    const items = batches.map((b) => {
      const qty = b.ledger.reduce((s, l) => s + (l.direction === 'IN' ? Number(l.qty) : -Number(l.qty)), 0);
      const value = Number((qty * Number(b.unitCost)).toFixed(2));
      totalValue += value;
      return { productId: b.productId, skuCode: b.product.skuCode, name: b.product.name, category: b.product.category, batchNo: b.batchNo, expiryDate: b.expiryDate, onHand: qty, unitCost: Number(b.unitCost), value };
    }).filter((x) => x.onHand !== 0);
    void user;
    return { items, totalValue: Number(totalValue.toFixed(2)), generatedAt: new Date().toISOString() };
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
