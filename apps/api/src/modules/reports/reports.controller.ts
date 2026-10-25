import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';
import { centsToNumber, toCents } from '../../common/money';
import { assembleGrossProfit, fallbackCostCents, GROSS_PROFIT_CALIBER, marginPercent, type CustomerErosion, type GrossRowIn } from './gross-profit';

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
    // 行 → 成本: 出库行按批次成本×数量(分); 无出库回退 BASE 或 MIN 成本价，按行单位换算（LQ1-006）
    const baseCost = new Map<string, number>();
    const minCost = new Map<string, number>();
    {
      const rows = await this.prisma.price.findMany({
        where: { tenantId: user.tenantId, levelType: 'COST', unit: { in: ['BASE', 'MIN'] }, validFrom: { lte: new Date() } },
        orderBy: { validFrom: 'desc' },
      });
      for (const r of rows) {
        const map = r.unit === 'BASE' ? baseCost : minCost;
        if (!map.has(r.productId)) map.set(r.productId, toCents(r.price));
      }
    }
    const agg = new Map<string, GrossRowIn>();
    const bump = (key: string, name: string, revenueCents: number, costCents: number, costKnown: boolean) => {
      const cur = agg.get(key) ?? { key, name, revenueCents: 0, costCents: 0, costKnown: true };
      cur.revenueCents += revenueCents;
      cur.costCents += costCents;
      if (!costKnown) cur.costKnown = false;
      agg.set(key, cur);
    };
    const repIds = new Set<string>();
    for (const o of orders) {
      if (o.salespersonId) repIds.add(o.salespersonId);
      const costByLine = new Map<string, number>();
      for (const ob of o.outbounds) {
        for (const ol of ob.lines) {
          const cents = new Prisma.Decimal(ol.qty).mul(ol.batch.unitCost).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
          costByLine.set(ol.orderLineId, (costByLine.get(ol.orderLineId) ?? 0) + cents);
        }
      }
      const reversed = new Map<string, Prisma.Decimal>();
      for (const line of o.lines) {
        if (line.reversalOfId) reversed.set(line.reversalOfId, (reversed.get(line.reversalOfId) ?? new Prisma.Decimal(0)).add(line.qty));
      }
      const actualLines = Array.isArray(o.signature?.actualLines) ? o.signature.actualLines as Array<{ orderLineId: string; actualQty: number }> : [];
      const ratioByLine = new Map<string, Prisma.Decimal>();
      for (const l of o.lines) {
        if (l.reversalOfId) continue;
        const netQty = new Prisma.Decimal(l.qty).add(reversed.get(l.id) ?? 0);
        const actual = actualLines.length ? new Prisma.Decimal(actualLines.find((x) => x.orderLineId === l.id)?.actualQty ?? 0) : netQty;
        const accepted = Prisma.Decimal.max(0, Prisma.Decimal.min(netQty, actual));
        ratioByLine.set(l.id, netQty.gt(0) ? accepted.div(netQty) : new Prisma.Decimal(0));
      }
      const customerName = o.customerName;
      for (const l of o.lines) {
        if (l.reversalOfId) continue;
        const ratio = ratioByLine.get(l.id) ?? new Prisma.Decimal(0);
        const revenueCents = new Prisma.Decimal(l.amount).mul(ratio).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
        let costCents = 0;
        let costKnown = true;
        if (costByLine.has(l.id)) {
          costCents = new Prisma.Decimal(costByLine.get(l.id)!).mul(ratio).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
        } else {
          const fallback = fallbackCostCents({
            qty: l.qty, unit: l.unit, conversionRate: l.conversionRate, ratio,
            quote: { baseCents: baseCost.get(l.productId) ?? null, minCents: minCost.get(l.productId) ?? null },
          });
          if (fallback === null) { costKnown = false; costCents = 0; }
          else costCents = fallback;
        }
        if (dim === 'category') bump(String(l.product?.category ?? 'QITA'), String(l.product?.category ?? 'QITA'), revenueCents, costCents, costKnown);
        else if (dim === 'customer') bump(o.customerId, customerName, revenueCents, costCents, costKnown);
        else if (dim === 'product') bump(l.productId, l.productName, revenueCents, costCents, costKnown);
        else if (dim === 'rep') bump(o.salespersonId ?? 'NONE', o.salespersonId ?? '未归属', revenueCents, costCents, costKnown);
      }
    }
    const [ledgers, cashRebates] = await this.prisma.$transaction([
      this.prisma.receivableLedger.findMany({
        where: { tenantId: user.tenantId, direction: { in: ['REBATE_OFFSET', 'FEE_OFFSET'] }, createdAt: { gte: start, lte: end } },
        select: { direction: true, amount: true, receivable: { select: { customerId: true } } },
      }),
      this.prisma.expense.findMany({
        where: { tenantId: user.tenantId, category: 'REBATE', status: { in: ['APPROVED', 'PAID'] }, occurredAt: { gte: start, lte: end } },
        select: { amount: true, customerId: true },
      }),
    ]);
    const erosionMap = new Map<string, CustomerErosion>();
    const touch = (customerId: string): CustomerErosion => {
      const cur = erosionMap.get(customerId) ?? { customerId, rebateCents: 0, feeCents: 0 };
      erosionMap.set(customerId, cur);
      return cur;
    };
    for (const l of ledgers) {
      const row = touch(l.receivable.customerId);
      if (l.direction === 'REBATE_OFFSET') row.rebateCents += toCents(l.amount);
      else row.feeCents += toCents(l.amount);
    }
    for (const e of cashRebates) {
      if (!e.customerId) continue;
      touch(e.customerId).rebateCents += toCents(e.amount);
    }
    const reps = repIds.size ? await this.prisma.user.findMany({ where: { id: { in: [...repIds] } }, select: { id: true, name: true } }) : [];
    const repName = (id: string) => reps.find((u) => u.id === id)?.name ?? '未归属';
    const CATEGORY_LABELS: Record<string, string> = { BAIJIU: '白酒', PIJIU: '啤酒', HONGJIU: '红酒', YANGJIU: '洋酒', YINLIAO: '饮料', QITA: '其他' };
    const named = [...agg.values()].map((r) => ({
      ...r,
      name: dim === 'rep' ? repName(r.key) : dim === 'category' ? (CATEGORY_LABELS[r.key] ?? r.key) : r.name,
    }));
    const missingCustomerIds = [...erosionMap.keys()].filter((id) => !named.some((r) => r.key === id));
    const extraCustomers = dim === 'customer' && missingCustomerIds.length
      ? await this.prisma.customer.findMany({ where: { id: { in: missingCustomerIds } }, select: { id: true, name: true } })
      : [];
    const customerNames = new Map(extraCustomers.map((c) => [c.id, c.name]));
    const assembled = assembleGrossProfit({
      dimension: dim as 'category' | 'customer' | 'rep' | 'product',
      rows: named,
      erosions: [...erosionMap.values()],
      customerNames,
    });
    const yuanRow = (r: typeof assembled.rows[number]) => ({
      key: r.key,
      name: r.name,
      revenue: centsToNumber(r.revenueCents),
      cost: centsToNumber(r.costCents),
      profitBeforeErosion: centsToNumber(r.profitBeforeCents),
      rebateErosion: centsToNumber(r.rebateCents),
      feeErosion: centsToNumber(r.feeCents),
      profit: centsToNumber(r.profitCents),
      margin: r.margin,
    });
    const rows = assembled.rows.map(yuanRow).sort((a, b) => b.profit - a.profit);
    const t = assembled.totals;
    return {
      month, dimension: dim, rows,
      totals: {
        revenue: centsToNumber(t.revenueCents),
        cost: centsToNumber(t.costCents),
        profitBeforeErosion: centsToNumber(t.profitBeforeCents),
        rebateErosion: centsToNumber(t.rebateCents),
        feeErosion: centsToNumber(t.feeCents),
        profit: centsToNumber(t.profitCents),
        margin: marginPercent(t.profitCents, t.revenueCents, t.costKnown),
        orderCount: orders.length,
      },
      caliber: GROSS_PROFIT_CALIBER,
    };
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
