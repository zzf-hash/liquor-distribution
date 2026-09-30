import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { NotifyService } from '../../common/notify.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { PurchasesService } from '../purchases/purchases.service';
import type { AuthUser } from '../../common/current-user.decorator';

// ═══════════════ P2 库存预警 + 自动报货 (每日库存报表/动态阈值/内勤确认制) ═══════════════
// 口径: 库存 = InventoryLedger 流水投影(B4, 不另立账); 净销 = 近N日 OUT 流水(REJECT_RETURN/RETURN_IN/ADJUST 视为回冲)
// 动态阈值 = ceil(窗口日均净销 × 安全天数); 窗口默认10日(SystemConfig inventory_alert_config 可改, 商品级 product.alert 覆盖)
// 报货量 = ceil(覆盖天数×日均 − 现有 − 在途) 向上取整到整箱(packSize)
// 流程: 日切/手动扫描 → 预警落 DailyStockReport + 自动建报货单 PENDING_CLERK → 内勤确认转采购单并提审(固定老板)
// → 驳回/忽略 DISMISSED(次日可重新评估); 审批通过回链 RestockRequest.APPROVED(采购单继续 付款→收货)
// 防重: 同商品存在 PENDING_CLERK/SUBMITTED 的报货单, 或在途采购已覆盖缺口 → 不再生成

/** 预警配置(SystemConfig key=inventory_alert_config): {windowDays, safetyDays, coverageDays, enabled, perProduct: {skuCode|productId: {windowDays?}}} */
export interface AlertConfig {
  windowDays: number; // 销量窗口(日)
  safetyDays: number; // 阈值安全天数
  coverageDays: number; // 报货覆盖天数
  enabled: boolean; // 关闭后仅出报表不生成报货单
  defaultSupplier: string; // 商品无 supplier 字段时的兜底供应商
  perProduct?: Record<string, { windowDays?: number; enabled?: boolean }>; // 商品级覆盖(键=productId)
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  windowDays: 10,
  safetyDays: 7,
  coverageDays: 14,
  enabled: true,
  defaultSupplier: '默认供应商',
};

/** 出库消耗: OUT 且 refType=OUTBOUND; 其余 OUT 流水(红字冲销 REVERSAL_OUT 等)同为库存减少, 一并计入净销消耗 */
const SALE_OUT_TYPES = new Set(['OUTBOUND']);

@Injectable()
export class StockAlertService {
  private readonly logger = new Logger('StockAlert');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly approvals: ApprovalsService,
    private readonly purchases: PurchasesService,
  ) {}

  /** 读配置(全局 SystemConfig, 未配置用默认); 商品级覆盖在扫描时应用 */
  async getConfig(tenantId: string): Promise<AlertConfig> {
    const row = await this.prisma.systemConfig.findFirst({ where: { tenantId, key: 'inventory_alert_config' } });
    const base = { ...DEFAULT_ALERT_CONFIG };
    if (!row) return base;
    const v = row.value as Partial<AlertConfig> | undefined;
    if (v) {
      if (typeof v.windowDays === 'number' && v.windowDays >= 1) base.windowDays = Math.floor(v.windowDays);
      if (typeof v.safetyDays === 'number' && v.safetyDays >= 0) base.safetyDays = Math.floor(v.safetyDays);
      if (typeof v.coverageDays === 'number' && v.coverageDays >= 1) base.coverageDays = Math.floor(v.coverageDays);
      if (typeof v.enabled === 'boolean') base.enabled = v.enabled;
      if (typeof v.defaultSupplier === 'string' && v.defaultSupplier.trim()) base.defaultSupplier = v.defaultSupplier.trim();
      if (v.perProduct && typeof v.perProduct === 'object') base.perProduct = v.perProduct;
    }
    return base;
  }

  async saveConfig(user: AuthUser, patch: Partial<AlertConfig>): Promise<AlertConfig> {
    const cur = await this.getConfig(user.tenantId);
    const next: AlertConfig = { ...cur, ...patch, perProduct: patch.perProduct ?? cur.perProduct };
    if (next.windowDays < 1 || next.coverageDays < 1 || next.safetyDays < 0) throw new BadRequestException('窗口/覆盖天数须≥1, 安全天数须≥0');
    await this.prisma.systemConfig.upsert({
      where: { tenantId_key: { tenantId: user.tenantId, key: 'inventory_alert_config' } },
      create: { tenantId: user.tenantId, key: 'inventory_alert_config', value: next as never, updatedBy: user.id, note: '库存预警/自动报货配置' },
      update: { value: next as never, updatedBy: user.id },
    });
    await this.audit.log({ user, action: 'ALERT_CONFIG_SAVE', entityType: 'SystemConfig', entityId: 'inventory_alert_config', before: cur as never, after: next as never });
    return next;
  }

  /** 单商品近N日净销(最小单位): OUT(REJECT_RETURN/RETURN_IN 等回冲型)记 −1, OUTBOUND 记 +1, PURCHASE_IN/INITIAL 忽略 */
  private async netSales(tenantId: string, productIds: string[], sinceMap: Map<number, Date>): Promise<Map<string, Map<number, number>>> {
    const rows = await this.prisma.inventoryLedger.findMany({
      where: { tenantId, productId: { in: productIds }, direction: 'OUT', createdAt: { gte: new Date(Math.min(...[...sinceMap.values()].map((d) => d.getTime()))) }, refType: { in: ['OUTBOUND', 'REJECT_RETURN', 'RETURN_IN', 'ADJUST', 'REVERSAL_IN'] } },
      select: { productId: true, qty: true, refType: true, createdAt: true },
    });
    const out = new Map<string, Map<number, number>>();
    for (const r of rows) {
      const sign = SALE_OUT_TYPES.has(r.refType) ? 1 : -1; // 回冲型 OUT(退货入回冲/红字) = 库存增加 → 抵减销量
      const m = out.get(r.productId) ?? new Map<number, number>();
      for (const [days, since] of sinceMap) {
        if (r.createdAt >= since) m.set(days, (m.get(days) ?? 0) + sign * Number(r.qty));
      }
      out.set(r.productId, m);
    }
    for (const id of productIds) if (!out.has(id)) out.set(id, new Map());
    return out;
  }

  /** 在途采购(未收货且未取消的采购单行, 最小单位) */
  private async inTransit(tenantId: string, productIds: string[]): Promise<Map<string, number>> {
    const rows = await this.prisma.purchaseLine.groupBy({
      by: ['productId'],
      where: { tenantId, productId: { in: productIds }, purchase: { status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PAID'] } } },
      _sum: { qty: true },
    });
    return new Map(rows.map((r) => [r.productId, Number(r._sum.qty ?? 0)]));
  }

  /**
   * 日切核心: 生成当日快照 + 扫描预警 + 自动建报货单(PENDING_CLERK)。
   * @param actor 系统任务传 SYSTEM_USER; 手动触发传登录用户(仅 OWNER/CLERK)
   * @returns {rows, alerts, created} 行数/预警数/新建报货单数
   */
  async runScan(actor: AuthUser, opts: { date?: string; createRestocks?: boolean } = {}): Promise<{ reportDate: string; rows: number; alerts: number; created: number }> {
    const tenantId = actor.tenantId;
    const cfg = await this.getConfig(tenantId);
    const today = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? dayjs(opts.date) : dayjs();
    const reportDate = today.format('YYYY-MM-DD');
    const createRestocks = opts.createRestocks ?? cfg.enabled;
    await this.autoSubmitStale(); // 内勤确认制兜底: 超24h未确认的报货单自动提审
    const windowMax = Math.max(cfg.windowDays, ...Object.values(cfg.perProduct ?? {}).map((p) => p.windowDays ?? 0), 7);

    // 1. 全量在售商品 + 批次(成本/效期) + 库存投影
    const [products, batches] = await Promise.all([
      this.prisma.product.findMany({ where: { tenantId, status: 'ON_SALE' } }),
      this.prisma.batchStock.findMany({ where: { tenantId, product: { status: 'ON_SALE' } }, select: { productId: true, unitCost: true, expiryDate: true } }),
    ]);
    if (products.length === 0) return { reportDate, rows: 0, alerts: 0, created: 0 };

    const sinceMap = new Map<number, Date>([
      [3, today.subtract(3, 'day').toDate()],
      [7, today.subtract(7, 'day').toDate()],
      [windowMax, today.subtract(windowMax, 'day').toDate()],
    ]);
    const ids = products.map((p) => p.id);
    const [salesMap, transitMap, ledgerAgg] = await Promise.all([
      this.netSales(tenantId, ids, sinceMap),
      this.inTransit(tenantId, ids),
      // 流水投影现存量: IN−OUT 全类型(含期初/采购)
      this.prisma.inventoryLedger.groupBy({ by: ['productId', 'direction'], where: { tenantId, productId: { in: ids } }, _sum: { qty: true } }),
    ]);
    const onHandMap = new Map<string, number>();
    for (const g of ledgerAgg) {
      const cur = onHandMap.get(g.productId) ?? 0;
      onHandMap.set(g.productId, cur + (g.direction === 'IN' ? 1 : -1) * Number(g._sum.qty ?? 0));
    }
    const costMap = new Map<string, number>();
    for (const b of batches) costMap.set(b.productId, Number(b.unitCost)); // 移动加权简化: 取最新批次成本

    // 2. 逐商品算阈值/等级/建议量
    const now = new Date();
    const rows: Array<Prisma.DailyStockReportCreateManyInput & { _packSize: number; _name: string; _sku: string }> = [];
    for (const p of products) {
      const per = cfg.perProduct?.[p.id] ?? cfg.perProduct?.[p.skuCode];
      if (per?.enabled === false) continue;
      const win = Math.max(1, per?.windowDays ?? cfg.windowDays);
      const s = salesMap.get(p.id) ?? new Map<number, number>();
      const soldWindow = Math.max(0, s.get(win) ?? 0);
      const dailyAvg = soldWindow / win;
      const onHand = onHandMap.get(p.id) ?? 0;
      const threshold = Math.ceil(dailyAvg * cfg.safetyDays);
      const inTransitQty = transitMap.get(p.id) ?? 0;
      const level = onHand <= 0 ? 'OUT' : onHand <= threshold && soldWindow > 0 ? 'LOW' : 'OK';
      // 建议量: 目标覆盖天数×日均 − 现有 − 在途, 向上取整整箱; 非预警品为 0
      const gap = dailyAvg * cfg.coverageDays - onHand - inTransitQty;
      const pack = Math.max(1, p.packSize);
      const suggested = level === 'OK' ? 0 : Math.max(0, Math.ceil(gap / pack) * pack);
      rows.push({
        tenantId, reportDate: today.toDate(), productId: p.id,
        onHand: new Prisma.Decimal(onHand.toFixed(3)),
        baseQty: new Prisma.Decimal((onHand / Math.max(1, p.packSize)).toFixed(3)),
        sold3d: new Prisma.Decimal(Math.max(0, s.get(3) ?? 0).toFixed(3)),
        sold7d: new Prisma.Decimal(Math.max(0, s.get(7) ?? 0).toFixed(3)),
        soldWindow: new Prisma.Decimal(soldWindow.toFixed(3)),
        dailyAvg: new Prisma.Decimal(dailyAvg.toFixed(3)),
        thresholdQty: new Prisma.Decimal(threshold.toFixed(3)),
        inTransitQty: new Prisma.Decimal(inTransitQty.toFixed(3)),
        suggestedQty: new Prisma.Decimal(suggested.toFixed(3)),
        level, stockValue: new Prisma.Decimal((Math.max(0, onHand) * (costMap.get(p.id) ?? 0)).toFixed(2)),
        restockStatus: null, restockId: null,
        _packSize: pack, _name: p.name, _sku: p.skuCode,
      });
    }

    // 3. 幂等落库: 当日已有 → 覆盖(delete+createMany, 无外键入向引用先删)
    await this.prisma.$transaction(async (tx) => {
      await tx.dailyStockReport.deleteMany({ where: { tenantId, reportDate: today.toDate(), restockId: null } });
      await tx.dailyStockReport.createMany({ data: rows.map(({ _packSize, _name, _sku, ...r }) => r) });
    });

    // 4. 预警品建报货单(防重: 该商品已有待确认/在途报货单 → 跳过)
    let created = 0;
    const alertRows = rows.filter((r) => r.level !== 'OK' && (Number(r.suggestedQty) > 0 || r.level === 'OUT'));
    if (createRestocks && alertRows.length > 0) {
      const open = await this.prisma.restockRequest.findMany({
        where: { tenantId, productId: { in: alertRows.map((r) => r.productId) }, status: { in: ['PENDING_CLERK', 'SUBMITTED'] } },
        select: { productId: true },
      });
      const openSet = new Set(open.map((o) => o.productId));
      const day = today.format('YYYYMMDD');
      let seq = (await this.prisma.restockRequest.count({ where: { tenantId, requestId: { startsWith: `RQ${day}` } } })) + 1;
      for (const r of alertRows) {
        if (openSet.has(r.productId)) continue;
        const suggested = Number(r.suggestedQty);
        if (suggested <= 0) continue; // OUT 但无销量基数 → 无法估量, 仅预警不建单
        const req = await this.prisma.restockRequest.create({
          data: {
            tenantId, requestId: `RQ${day}-${String(seq++).padStart(4, '0')}`, productId: r.productId,
            qty: new Prisma.Decimal(suggested.toFixed(3)),
            baseQty: new Prisma.Decimal((suggested / r._packSize).toFixed(3)),
            onHand: r.onHand, thresholdQty: r.thresholdQty, dailyAvg: r.dailyAvg, windowDays: Math.max(1, cfg.perProduct?.[r.productId]?.windowDays ?? cfg.windowDays),
            status: 'PENDING_CLERK', snapshot: { reportDate, sold3d: Number(r.sold3d), sold7d: Number(r.sold7d), soldWindow: Number(r.soldWindow), coverageDays: cfg.coverageDays, safetyDays: cfg.safetyDays, packSize: r._packSize, name: r._name, skuCode: r._sku } as never,
          },
        });
        await this.prisma.dailyStockReport.updateMany({ where: { tenantId, reportDate: today.toDate(), productId: r.productId }, data: { restockId: req.id, restockStatus: 'PENDING_CLERK' } });
        created += 1;
      }
    }

    // 5. 审计 + 通知(每日摘要)
    const lowCount = rows.filter((r) => r.level === 'LOW').length;
    const outCount = rows.filter((r) => r.level === 'OUT').length;
    const totalValue = rows.reduce((s, r) => s + Number(r.stockValue), 0);
    await this.audit.log({
      user: actor, action: 'STOCK_REPORT_RUN', entityType: 'DailyStockReport', entityId: reportDate,
      after: { reportDate, rows: rows.length, lowCount, outCount, created, totalValue: Number(totalValue.toFixed(2)) },
    });
    if (lowCount + outCount > 0 || created > 0) {
      const lines = [
        `日期: ${reportDate}`,
        `预警: ${lowCount} 个商品低于动态阈值, 缺货 ${outCount} 个`,
        `自动报货单: 新建 ${created} 张待内勤确认`,
        `库存总值(成本): ¥${totalValue.toFixed(2)}`,
      ];
      try { await this.notify.send(`每日库存报表 ${reportDate}`, lines); } catch { /* 通知失败不阻断 */ }
    }
    void now;
    return { reportDate, rows: rows.length, alerts: lowCount + outCount, created };
  }

  /**
   * 内勤确认制兜底: PENDING_CLERK 超 24h 无人处理 → 以 SYSTEM 身份自动提审(固定老板审)。
   * 单据数量/供应商用生成时建议值(内勤没改就是没意见); 逐张 try/catch, 一张失败不拖垮批次。
   */
  private async autoSubmitStale(): Promise<void> {
    const stale = await this.prisma.restockRequest.findMany({
      where: { status: 'PENDING_CLERK', createdAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } },
      include: { product: true },
      take: 50,
    });
    for (const r of stale) {
      try {
        const sys = { id: 'system', tenantId: r.tenantId, username: 'system', name: '系统', role: 'OWNER', dataScope: 'ALL', aud: 'staff' } as AuthUser;
        await this.confirm(sys, r.id, {}); // 走与内勤完全相同的确认链路(审计记 SYSTEM)
        this.logger.log(`restock ${r.requestId} auto-submitted after 24h pending`);
      } catch (e) {
        this.logger.warn(`restock ${r.requestId} auto-submit failed: ${String(e).slice(0, 200)}`); // 常见: 供应商为空 → 留待人工
      }
    }
  }

  /** 当日快照(无则惰性补生成 — 没人到后台的日子报表也不断档) */
  async ensureToday(user: AuthUser): Promise<string> {
    const today = dayjs().format('YYYY-MM-DD');
    const n = await this.prisma.dailyStockReport.count({ where: { tenantId: user.tenantId, reportDate: dayjs(today).toDate() } });
    if (n === 0) await this.runScan(user, { createRestocks: false }); // 惰性补只出报表, 不自动建报货单(避免非日切时点惊扰)
    return today;
  }

  /** 报表查询(默认当日; level 过滤; 分页) */
  async listReport(user: AuthUser, q: { date?: string; level?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const date = await this.ensureToday(user);
    const reportDate = dayjs(q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : date).toDate();
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const where: Prisma.DailyStockReportWhereInput = { tenantId: user.tenantId, reportDate, level: q.level as never };
    const [items, total, agg] = await this.prisma.$transaction([
      this.prisma.dailyStockReport.findMany({
        where, orderBy: [{ level: 'desc' }, { productId: 'asc' }], skip: (page - 1) * pageSize, take: pageSize,
        include: { product: { select: { skuCode: true, name: true, category: true, baseUnit: true, minUnit: true, packSize: true } }, restock: { select: { id: true, requestId: true, status: true } } },
      }),
      this.prisma.dailyStockReport.count({ where }),
      this.prisma.dailyStockReport.aggregate({ where: { tenantId: user.tenantId, reportDate }, _sum: { stockValue: true }, _count: { id: true } }),
    ]);
    const levelCount = await this.prisma.dailyStockReport.groupBy({ by: ['level'], where: { tenantId: user.tenantId, reportDate }, _count: { id: true } });
    return {
      reportDate: dayjs(reportDate).format('YYYY-MM-DD'),
      summary: {
        totalValue: Number(agg._sum.stockValue ?? 0), totalSkus: agg._count.id,
        low: levelCount.find((l) => l.level === 'LOW')?._count.id ?? 0,
        out: levelCount.find((l) => l.level === 'OUT')?._count.id ?? 0,
      },
      items: items.map((r) => ({
        id: r.id, skuCode: r.product.skuCode, name: r.product.name, category: r.product.category,
        onHand: Number(r.onHand), baseQty: Number(r.baseQty), unitLabel: `${r.product.baseUnit}/${r.product.minUnit}`,
        sold3d: Number(r.sold3d), sold7d: Number(r.sold7d), soldWindow: Number(r.soldWindow), dailyAvg: Number(r.dailyAvg),
        thresholdQty: Number(r.thresholdQty), inTransitQty: Number(r.inTransitQty), suggestedQty: Number(r.suggestedQty),
        level: r.level, stockValue: Number(r.stockValue),
        restock: r.restock ? { id: r.restock.id, requestId: r.restock.requestId, status: r.restock.status } : null,
      })),
      total, page, pageSize,
    };
  }

  /** 报货单列表(内勤待办入口) */
  async listRestocks(user: AuthUser, q: { status?: string; page?: number; pageSize?: number }): Promise<unknown> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where: Prisma.RestockRequestWhereInput = { tenantId: user.tenantId, status: q.status as never };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.restockRequest.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { product: { select: { skuCode: true, name: true, baseUnit: true, minUnit: true, packSize: true, supplier: true } } },
      }),
      this.prisma.restockRequest.count({ where }),
    ]);
    return {
      items: items.map((r) => ({
        id: r.id, requestId: r.requestId, status: r.status,
        product: { id: r.productId, skuCode: r.product.skuCode, name: r.product.name, supplier: r.product.supplier, packSize: r.product.packSize, unitLabel: `${r.product.baseUnit}/${r.product.minUnit}` },
        qty: Number(r.qty), baseQty: Number(r.baseQty), onHand: Number(r.onHand), thresholdQty: Number(r.thresholdQty), dailyAvg: Number(r.dailyAvg), windowDays: r.windowDays,
        purchaseId: r.purchaseId, approvalId: r.approvalId, snapshot: r.snapshot,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
      })),
      total, page, pageSize,
    };
  }

  /** 内勤忽略(不报货): DISMISSED; 次日重新评估仍会再生成 */
  async dismiss(user: AuthUser, id: string, reason: string): Promise<unknown> {
    if (!reason?.trim()) throw new BadRequestException('忽略必须填写原因');
    if (user.role !== 'OWNER' && user.role !== 'CLERK') throw new ForbiddenException('仅老板/内勤可处理报货单');
    const r = await this.prisma.restockRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('报货单不存在');
    if (r.status !== 'PENDING_CLERK') throw new ConflictException(`仅待确认可忽略(当前 ${r.status})`);
    await this.prisma.$transaction([
      this.prisma.restockRequest.update({ where: { id }, data: { status: 'DISMISSED', dismissedBy: user.id, dismissReason: reason.trim() } }),
      this.prisma.dailyStockReport.updateMany({ where: { restockId: id }, data: { restockStatus: 'DISMISSED' } }),
    ]);
    await this.audit.log({ user, action: 'RESTOCK_DISMISS', entityType: 'RestockRequest', entityId: id, before: { status: 'PENDING_CLERK' }, after: { reason: reason.trim() } });
    return { id, status: 'DISMISSED' };
  }

  /**
   * 内勤确认 → 转正式采购单(DRAFT) → 立即提审(PURCHASE 审批线, 固定老板: amount 不设, payload.autoRestock=true)。
   * 同单内勤可改数量(supplier/type 可带), 商品 supplier 缺失用配置 defaultSupplier。
   */
  async confirm(user: AuthUser, id: string, input: { qty?: number; supplier?: string; type?: 'PREPAID' | 'POSTPAID'; note?: string }): Promise<unknown> {
    if (user.role !== 'OWNER' && user.role !== 'CLERK') throw new ForbiddenException('仅老板/内勤可确认报货单');
    const r = await this.prisma.restockRequest.findUnique({ where: { id }, include: { product: true } });
    if (!r) throw new NotFoundException('报货单不存在');
    if (r.status !== 'PENDING_CLERK') throw new ConflictException(`仅待确认可提交(当前 ${r.status})`);
    const cfg = await this.getConfig(user.tenantId);
    const qty = input.qty !== undefined ? input.qty : Number(r.qty);
    if (!(qty > 0)) throw new BadRequestException('数量须>0');
    const supplier = (input.supplier ?? r.product.supplier ?? cfg.defaultSupplier).trim();
    if (!supplier) throw new BadRequestException('供应商为空: 请在商品档案或预警配置中补全');
    const type = input.type ?? 'POSTPAID'; // 默认后付 F4: 审批→收货→付款
    // 转采购单(走 PurchasesService 复用校验/审计/单号), 再提审(固定老板路由见 decide 硬闸)
    const created = (await this.purchases.create(user, {
      supplier, type, note: `自动报货 ${r.requestId}${input.note ? ` | ${input.note}` : ''}`, // RQ 标记必须保留: 审批回链靠它
      lines: [{ productId: r.productId, batchNo: '期初', qty, unitCost: await this.lastCost(user.tenantId, r.productId) }],
    })) as { id: string; purNo: string };
    const submitted = (await this.purchases.submit(user, created.id)) as { approvalId: string };
    await this.prisma.$transaction([
      this.prisma.restockRequest.update({ where: { id }, data: { status: 'SUBMITTED', purchaseId: created.id, approvalId: submitted.approvalId, qty: new Prisma.Decimal(qty) } }),
      this.prisma.dailyStockReport.updateMany({ where: { restockId: id }, data: { restockStatus: 'SUBMITTED' } }),
    ]);
    await this.audit.log({ user, action: 'RESTOCK_CONFIRM', entityType: 'RestockRequest', entityId: id, after: { purchaseId: created.id, purNo: created.purNo, approvalId: submitted.approvalId, qty, supplier } });
    return { id, status: 'SUBMITTED', purchaseId: created.id, purNo: created.purNo, approvalId: submitted.approvalId };
  }

  /** 最近成本(采购行→COST 价→0) */
  private async lastCost(tenantId: string, productId: string): Promise<number> {
    const pl = await this.prisma.purchaseLine.findFirst({ where: { tenantId, productId }, orderBy: { id: 'desc' }, select: { unitCost: true } });
    if (pl) return Number(pl.unitCost);
    const price = await this.prisma.price.findFirst({ where: { tenantId, productId, levelType: 'COST' }, orderBy: { validFrom: 'desc' }, select: { price: true } });
    return price ? Number(price.price) : 0;
  }
}
