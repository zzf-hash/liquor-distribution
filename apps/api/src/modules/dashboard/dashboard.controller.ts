import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/roles.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P0-T40 老板四问看板 ═══════════════
// 口径(代码注释即口径, 数据延迟=实时直查):
//   ①今日卖多少 = 当日"签收"订单净额(红字已含)——签收即成立应收, 与 D4 账龄口径一致
//   ②今日收多少 = 当日确认的 PAYMENT 收款(抹零/坏账不计入回款)
//   ③谁欠钱     = 应收未结(open>0, 含争议单列), 按 bucket 分档 + top 欠款客户
//   ④什么货快没了 = 可用库存(在库−占用, B4 流水投影)低于阈值的商品
//   ⑤哪个业务员强 = 本月签收订单净额按 owner 快照聚合(D5), 回款归属 P1-T09 精细化
@Controller('dashboard')
@Roles('OWNER', 'CLERK')
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('four-questions')
  async fourQuestions(@CurrentUser() user: AuthUser): Promise<unknown> {
    const todayStart = dayjs().startOf('day').toDate();
    const monthStart = dayjs().startOf('month').toDate();

    // ① 今日销售(签收口径) + ② 今日回款
    const [salesAgg, collectedAgg] = await this.prisma.$transaction([
      this.prisma.salesOrder.aggregate({
        where: { signedAt: { gte: todayStart }, status: { in: ['SIGNED', 'SETTLED'] } },
        _sum: { totalAmount: true }, _count: { id: true },
      }),
      this.prisma.payment.aggregate({
        where: { status: 'CONFIRMED', kind: 'PAYMENT', confirmedAt: { gte: todayStart } },
        _sum: { amount: true }, _count: { id: true },
      }),
    ]);

    // ③ 谁欠钱: 未结应收 + 分档 + top 客户
    const ars = await this.prisma.receivable.findMany({
      where: { archivedAt: null },
      include: { customer: { select: { id: true, name: true } }, ledger: true },
    });
    const buckets: Record<string, number> = { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0, disputed: 0 };
    const debtor = new Map<string, { customerId: string; name: string; open: number }>();
    let debtTotal = 0;
    for (const ar of ars) {
      let settled = 0; let waived = 0; let writtenOff = 0; let revNoPay = 0; let returnCredit = 0;
      for (const l of ar.ledger) {
        const amt = Number(l.amount);
        if (l.direction === 'SETTLE' || l.direction === 'REBATE_OFFSET') settled += amt;
        else if (l.direction === 'WAIVE') waived += amt;
        else if (l.direction === 'WRITEOFF') writtenOff += amt;
        else if (l.direction === 'RETURN_CREDIT') returnCredit += amt;
        else if (l.direction === 'REVERSAL') { if (l.paymentId) settled -= amt; else revNoPay += amt; }
      }
      const open = Number(ar.total) - settled - waived - writtenOff - returnCredit - revNoPay;
      if (open <= 0.0001) continue;
      debtTotal += open;
      const days = ar.disputeFlag ? -1 : dayjs().startOf('day').diff(dayjs(ar.dueDate).startOf('day'), 'day');
      const bucket = ar.disputeFlag ? 'disputed' : days <= 0 ? 'not_due' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90p';
      buckets[bucket] += open;
      const d = debtor.get(ar.customerId) ?? { customerId: ar.customerId, name: ar.customer.name, open: 0 };
      d.open += open;
      debtor.set(ar.customerId, d);
    }
    const topDebtors = [...debtor.values()].sort((a, b) => b.open - a.open).slice(0, 8);

    // ④ 库存: 可用 = 流水在库 − 待出库占用(与 OrdersService.stockProjection 同口径, 看板直查)
    const lowThreshold = 12; // 最小单位瓶; 商户签字后入 SystemConfig(low_stock_threshold)
    const cfg = await this.prisma.systemConfig.findFirst({ where: { key: 'low_stock_threshold' } });
    const cfgV = cfg ? Number((cfg.value as { v?: unknown })?.v ?? cfg.value) : NaN;
    const threshold = Number.isFinite(cfgV) ? cfgV : lowThreshold;
    const ledgerGroups = await this.prisma.inventoryLedger.groupBy({
      by: ['productId', 'direction'], _sum: { qty: true },
    });
    const onHandMap = new Map<string, number>();
    for (const g of ledgerGroups) {
      const q = Number(g._sum.qty ?? 0);
      onHandMap.set(g.productId, (onHandMap.get(g.productId) ?? 0) + (g.direction === 'IN' ? q : -q));
    }
    const occupiedRows = await this.prisma.orderLine.findMany({
      where: { order: { status: { in: ['PENDING_CONFIRM', 'CONFIRMED'] } } },
      select: { productId: true, qty: true, unit: true, conversionRate: true },
    });
    const occupiedMap = new Map<string, number>();
    for (const l of occupiedRows) {
      const q = Number(l.qty) * (l.unit === 'BASE' ? l.conversionRate : 1);
      occupiedMap.set(l.productId, (occupiedMap.get(l.productId) ?? 0) + q);
    }
    const candidateIds = [...onHandMap.keys()].filter((pid) => (onHandMap.get(pid) ?? 0) - (occupiedMap.get(pid) ?? 0) < threshold);
    const lowProducts = candidateIds.length
      ? await this.prisma.product.findMany({ where: { id: { in: candidateIds }, status: 'ON_SALE' }, select: { id: true, skuCode: true, name: true } })
      : [];
    const lowStock = lowProducts
      .map((p) => {
        const onHand = onHandMap.get(p.id) ?? 0;
        return { productId: p.id, skuCode: p.skuCode, name: p.name, onHand, occupied: occupiedMap.get(p.id) ?? 0, available: onHand - (occupiedMap.get(p.id) ?? 0) };
      })
      .sort((a, b) => a.available - b.available)
      .slice(0, 10);

    // ⑤ 业务员排行: 本月签收订单净额(owner 快照, D5)
    const rankRows = await this.prisma.salesOrder.groupBy({
      by: ['salespersonId'],
      where: { signedAt: { gte: monthStart }, status: { in: ['SIGNED', 'SETTLED'] } },
      _sum: { totalAmount: true }, _count: { id: true },
    });
    const repIds = rankRows.map((r) => r.salespersonId).filter((x): x is string => Boolean(x));
    const reps = repIds.length ? await this.prisma.user.findMany({ where: { id: { in: repIds } }, select: { id: true, name: true } }) : [];
    const repRanking = rankRows
      .filter((r) => r.salespersonId)
      .map((r) => {
        const rep = reps.find((u) => u.id === r.salespersonId);
        return { userId: r.salespersonId!, name: rep?.name ?? '未知', salesAmount: Number(r._sum.totalAmount ?? 0), orderCount: r._count.id, paymentAmount: 0 };
      })
      .sort((a, b) => b.salesAmount - a.salesAmount)
      .slice(0, 5);

    void user;
    return {
      salesToday: { amount: Number(salesAgg._sum.totalAmount ?? 0), orderCount: salesAgg._count.id },
      collectedToday: { amount: Number(collectedAgg._sum.amount ?? 0), paymentCount: collectedAgg._count.id },
      debt: { total: debtTotal, buckets, topDebtors },
      lowStock,
      repRanking,
      generatedAt: new Date().toISOString(),
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
