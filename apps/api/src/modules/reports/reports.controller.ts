import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';
import { fallbackLineCost } from './cost-fallback';

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

  /** C组 M10-2 毛利分析: 期间签收订单(实收口径) × 行成本(出库批次成本; 无出库记录回退最新成本价)
   *  dimension: category | customer | rep | product; 赠品行收入 0 但成本计入(促销侵蚀毛利如实反映) */
  @Get('gross-profit')
  async grossProfit(@CurrentUser() user: AuthUser, @Query('month') month: string, @Query('dimension') dimension?: string): Promise<unknown> {
    if (!/^\d{4}-\d{2}$/.test(month ?? '')) throw new ConflictException('月份格式 YYYY-MM');
    const dim = (['category', 'customer', 'rep', 'product'] as const).includes(dimension as never) ? dimension : 'category';
    const start = dayjs(`${month}-01`).startOf('month').toDate();
    const end = dayjs(`${month}-01`).endOf('month').toDate();
    const orders = await this.prisma.salesOrder.findMany({
      where: { signedAt: { gte: start, lte: end }, status: { in: ['SIGNED', 'SETTLED'] } },
      include: {
        lines: { include: { product: { select: { category: true, skuCode: true } } } },
        signature: true,
        outbounds: { include: { lines: { include: { batch: { select: { unitCost: true } } } } } },
      },
    });
    // 行 → 成本: 出库行按批次成本×数量聚合; 无出库回退最新 COST 价（BASE 与 MIN，按换算率，LQ-FE-004）
    const baseCost = new Map<string, number>();
    const minCost = new Map<string, number>();
    {
      const rows = await this.prisma.price.findMany({
        where: { tenantId: user.tenantId, levelType: 'COST', unit: { in: ['BASE', 'MIN'] }, validFrom: { lte: new Date() } },
        orderBy: { validFrom: 'desc' },
      });
      for (const r of rows) {
        const bucket = r.unit === 'BASE' ? baseCost : minCost;
        if (!bucket.has(r.productId)) bucket.set(r.productId, Number(r.price));
      }
    }
    const agg = new Map<string, { key: string; name: string; revenue: number; cost: number; costKnown: boolean }>();
    const bump = (key: string, name: string, revenue: number, cost: number, lineCostKnown: boolean) => {
      const cur = agg.get(key) ?? { key, name, revenue: 0, cost: 0, costKnown: true };
      cur.revenue += revenue; cur.cost += cost; cur.costKnown = cur.costKnown && lineCostKnown;
      agg.set(key, cur);
    };
    let totalRevenue = 0; let totalCost = 0; let costKnown = true;
    const repIds = new Set<string>();
    for (const o of orders) {
      if (o.salespersonId) repIds.add(o.salespersonId);
      // 出库行成本按 orderLineId 归集
      const costByLine = new Map<string, number>();
      for (const ob of o.outbounds) {
        for (const ol of ob.lines) {
          costByLine.set(ol.orderLineId, (costByLine.get(ol.orderLineId) ?? 0) + Number(ol.qty) * Number(ol.batch.unitCost));
        }
      }
      const reversed = new Map<string, number>();
      for (const line of o.lines) if (line.reversalOfId) reversed.set(line.reversalOfId, (reversed.get(line.reversalOfId) ?? 0) + Number(line.qty));
      const actualLines = Array.isArray(o.signature?.actualLines) ? o.signature.actualLines as Array<{ orderLineId: string; actualQty: number }> : [];
      const ratioByLine = new Map<string, number>(); // 实收/净量(部分拒收按比例折收入与成本)
      for (const l of o.lines) {
        if (l.reversalOfId) continue;
        const netQty = Number(l.qty) + (reversed.get(l.id) ?? 0);
        const actual = actualLines.length ? Number(actualLines.find((x) => x.orderLineId === l.id)?.actualQty ?? 0) : netQty;
        ratioByLine.set(l.id, netQty > 0 ? Math.max(0, Math.min(netQty, actual)) / netQty : 0);
      }
      const customerName = o.customerName;
      for (const l of o.lines) {
        if (l.reversalOfId) continue;
        const ratio = ratioByLine.get(l.id) ?? 0;
        const revenue = Number((Number(l.amount) * ratio).toFixed(2));
        let cost = Number(((costByLine.get(l.id) ?? 0) * ratio).toFixed(2));
        let lineCostKnown = true;
        if (!costByLine.has(l.id)) {
          const fallback = fallbackLineCost({
            qty: Number(l.qty),
            unit: l.unit,
            conversionRate: Number(l.conversionRate) || 1,
            ratio,
            basePrice: baseCost.has(l.productId) ? baseCost.get(l.productId)! : null,
            minPrice: minCost.has(l.productId) ? minCost.get(l.productId)! : null,
          });
          if (fallback === null) { lineCostKnown = false; cost = 0; }
          else cost = fallback;
        }
        if (!lineCostKnown) costKnown = false;
        totalRevenue += revenue; totalCost += cost;
        if (dim === 'category') bump(String(l.product?.category ?? 'QITA'), String(l.product?.category ?? 'QITA'), revenue, cost, lineCostKnown);
        else if (dim === 'customer') bump(o.customerId, customerName, revenue, cost, lineCostKnown);
        else if (dim === 'product') bump(l.productId, l.productName, revenue, cost, lineCostKnown);
        else if (dim === 'rep') bump(o.salespersonId ?? 'NONE', o.salespersonId ?? '未归属', revenue, cost, lineCostKnown);
      }
    }
    const reps = repIds.size ? await this.prisma.user.findMany({ where: { id: { in: [...repIds] } }, select: { id: true, name: true } }) : [];
    const repName = (id: string) => reps.find((u) => u.id === id)?.name ?? '未归属';
    const CATEGORY_LABELS: Record<string, string> = { BAIJIU: '白酒', PIJIU: '啤酒', HONGJIU: '红酒', YANGJIU: '洋酒', YINLIAO: '饮料', QITA: '其他' };
    const rows = [...agg.values()].map((r) => {
      const profit = Number((r.revenue - r.cost).toFixed(2));
      const { costKnown: rowCostKnown, ...rest } = r;
      return {
        ...rest,
        name: dim === 'rep' ? repName(r.key) : dim === 'category' ? (CATEGORY_LABELS[r.key] ?? r.key) : r.name,
        revenue: Number(r.revenue.toFixed(2)), cost: Number(r.cost.toFixed(2)),
        profit, margin: r.revenue > 0 && rowCostKnown ? Number(((profit / r.revenue) * 100).toFixed(1)) : null,
      };
    }).sort((a, b) => b.profit - a.profit);
    const totalProfit = Number((totalRevenue - totalCost).toFixed(2));
    return {
      month, dimension: dim, rows,
      totals: {
        revenue: Number(totalRevenue.toFixed(2)), cost: Number(totalCost.toFixed(2)), profit: totalProfit,
        margin: totalRevenue > 0 && costKnown ? Number(((totalProfit / totalRevenue) * 100).toFixed(1)) : null,
        orderCount: orders.length,
      },
      caliber: '收入=期间签收实收口径(拒收部分剔除); 成本=出库批次成本(无记录回退最新 COST 价: 行单位与价目单位一致则直接相乘; 仅有箱价 BASE 而行为瓶 MIN 时按箱价÷换算率; 仅有瓶价 MIN 而行为箱 BASE 时按瓶价×换算率; 缺少成本时毛利率为空); 赠品行收入0成本照计(促销侵蚀如实反映)',
    };
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
