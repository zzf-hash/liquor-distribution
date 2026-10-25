// 演示数据 seed(A 组功能演示配套): 在 seed + seed-p1 之后运行
// 用法: node prisma/seed-demo.js   (幂等: 全部按"不存在才建"防重)
// 覆盖的演示点:
//   ① 账龄四档(30/50/90 口径) + 到期提醒(3天后到期) + 归档候选(已结满6个月)
//   ② 临期批次(12/26天后到期 + 已过期1个) + 低库存动销历史(库存预警 LOW 演示)
//   ③ 月结对账单(上月, SENT 状态→客户端可确认/提差异)
//   ④ 已签收订单(今日销售看板) + 待确认订单(审单演示) + 待确认收款(F9②演示)
//   ⑤ 返利方案(3%, 落在 1%-50% 新口径) + 拜访记录 + 语音转单草稿(qwen 解析结果)
const { PrismaClient } = require('@prisma/client');
const { planDemoOutbound } = require('./demo-stock-plan');
const prisma = new PrismaClient();

const DAY = 24 * 3600 * 1000;
const now = new Date();
const dayOffset = (n) => new Date(now.getTime() + n * DAY);
const dateOnly = (d) => new Date(`${d}T10:00:00.000Z`);

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { code: 'TENANT-DEMO' } });
  if (!tenant) throw new Error('先跑 pnpm seed (缺 TENANT-DEMO)');
  const T = tenant.id;
  const [owner, clerk, rep1] = await Promise.all([
    prisma.user.findFirst({ where: { tenantId: T, username: 'owner' } }),
    prisma.user.findFirst({ where: { tenantId: T, username: 'clerk' } }),
    prisma.user.findFirst({ where: { tenantId: T, username: 'rep1' } }),
  ]);
  const cust = async (code) => prisma.customer.findFirst({ where: { tenantId: T, code } });
  const prod = async (sku) => prisma.product.findFirst({ where: { tenantId: T, skuCode: sku } });
  const [c1, c2, c3, c5] = await Promise.all([cust('C0001'), cust('C0002'), cust('C0003'), cust('C0005')]);
  const [p1, p2, p3, p4, p5, p7] = await Promise.all([prod('SKU0001'), prod('SKU0002'), prod('SKU0003'), prod('SKU0004'), prod('SKU0005'), prod('SKU0007')]);

  // ─── ① SystemConfig: 账龄档位(30/50/90, Q1 口径显式落库) + 临期预警窗口 ───
  const configs = [
    { key: 'aging_buckets', value: { v: { b1: 30, b2: 50, b3: 90 } }, note: '账龄分档档位(天)' },
    { key: 'expiry_alert_config', value: { warnDays: 30, enabled: true }, note: '临期预警配置' },
  ];
  for (const c of configs) {
    if (!(await prisma.systemConfig.findFirst({ where: { tenantId: T, key: c.key } }))) {
      await prisma.systemConfig.create({ data: { tenantId: T, key: c.key, value: c.value, updatedBy: owner.id, note: c.note } });
    }
  }

  // ─── ② 期初应收: 账龄四档 + 到期提醒 + 归档候选 ───
  const receivables = [
    { sourceDocNo: '初0005', customerId: c2.id, total: 6800, generatedAt: '2026-09-01', dueDate: '2026-10-01', note: '演示: 逾期15天 → 第一档(1-30)' },
    { sourceDocNo: '初0006', customerId: (await cust('C0004')).id, total: 9800, generatedAt: '2026-09-19', dueDate: '2026-10-19', note: '演示: 3天后到期 → 到期提醒' },
    // 初0008 已结满6个月 → 自动归档任务候选(带收款+SETTLE流水)
    { sourceDocNo: '初0008', customerId: (await cust('C0006')).id, total: 5200, generatedAt: '2026-01-10', dueDate: '2026-02-10', note: '演示: 已结满6个月 → 归档候选', settledOn: '2026-03-20' },
  ];
  for (const r of receivables) {
    const ar = await prisma.receivable.upsert({
      where: { tenantId_sourceType_sourceDocNo: { tenantId: T, sourceType: 'INITIAL', sourceDocNo: r.sourceDocNo } },
      update: {},
      create: {
        tenantId: T, sourceType: 'INITIAL', sourceDocNo: r.sourceDocNo, customerId: r.customerId,
        total: r.total, dueDate: dateOnly(r.dueDate), generatedAt: dateOnly(r.generatedAt), note: r.note,
      },
    });
    if (!(await prisma.receivableLedger.findFirst({ where: { receivableId: ar.id, direction: 'CHARGE' } }))) {
      await prisma.receivableLedger.create({
        data: { tenantId: T, receivableId: ar.id, direction: 'CHARGE', amount: r.total, createdBy: clerk.id, createdAt: dateOnly(r.generatedAt) },
      });
    }
    if (r.settledOn) {
      const settledAt = dateOnly(r.settledOn);
      const pay = await prisma.payment.findFirst({ where: { tenantId: T, paymentNo: `PAY-DEMO-${r.sourceDocNo}` } });
      const payment = pay ?? await prisma.payment.create({
        data: {
          tenantId: T, paymentNo: `PAY-DEMO-${r.sourceDocNo}`, customerId: r.customerId,
          amount: r.total, kind: 'PAYMENT', method: '转账', voucher: 'DEMO-转账凭证',
          enteredById: clerk.id, status: 'CONFIRMED', confirmedAt: settledAt, createdAt: settledAt, note: '演示: 历史已销账',
        },
      });
      if (!(await prisma.receivableLedger.findFirst({ where: { receivableId: ar.id, direction: 'SETTLE' } }))) {
        await prisma.receivableLedger.create({
          data: { tenantId: T, receivableId: ar.id, paymentId: payment.id, direction: 'SETTLE', amount: r.total, note: `FIFO 核销 ${payment.paymentNo}`, createdBy: clerk.id, createdAt: settledAt },
        });
      }
    }
  }

  // ─── ③ 临期批次(啤酒) + 已过期批次 ───
  const batches = [
    { p: p3, batchNo: 'PJ-临期演示A', produceDate: '2026-09-20', expiryDate: dayOffset(12), location: 'A-02', unitCost: 4.0, qty: 960 },   // 12天后到期 → 临期
    { p: p4, batchNo: 'XH-临期演示B', produceDate: '2026-09-15', expiryDate: dayOffset(26), location: 'A-02', unitCost: 3.5, qty: 1200 },  // 26天后到期 → 临期
    { p: p3, batchNo: 'PJ-过期演示', produceDate: '2026-04-01', expiryDate: dateOnly('2026-09-30'), location: 'A-03', unitCost: 4.2, qty: 240 }, // 已过期(FEFO 自动排除拣货)
  ];
  for (const b of batches) {
    const batch = await prisma.batchStock.upsert({
      where: { tenantId_productId_batchNo: { tenantId: T, productId: b.p.id, batchNo: b.batchNo } },
      update: {},
      create: { tenantId: T, productId: b.p.id, batchNo: b.batchNo, produceDate: dateOnly('2026-09-20'), expiryDate: b.expiryDate, location: b.location, unitCost: b.unitCost, isInitial: true },
    });
    if (!(await prisma.inventoryLedger.findFirst({ where: { batchId: batch.id, refType: 'INITIAL_IMPORT', direction: 'IN' } }))) {
      await prisma.inventoryLedger.create({
        data: { tenantId: T, productId: b.p.id, batchId: batch.id, direction: 'IN', qty: b.qty, refType: 'INITIAL_IMPORT', refNo: b.batchNo, createdBy: owner.id },
      });
    }
  }

  // ─── ④ 动销历史(库存预警 LOW 演示): 近7日 OUT 流水 ───
  // 青岛啤酒: 7日销 4440，期初+临期入库只有 4080。直接出 4440 会把净库存打成 -360。
  // 销量超过现存时先补一笔入库（补在最早批次、时间早于动销窗口），出库后再分摊到各批次余量上，
  // 出库后在库仍是 4080，且没有任何批次为负。农夫山泉现存够出，不补。
  if (!(await prisma.inventoryLedger.findFirst({ where: { tenantId: T, refNo: 'DEMO-SALES' } }))) {
    const salesPlan = [
      { p: p3, perDay: [[6, 620], [5, 620], [4, 620], [3, 640], [2, 640], [1, 640], [0, 660]] }, // 合计 4440
      { p: p7, perDay: [[6, 420], [5, 420], [4, 420], [3, 440], [2, 440], [1, 440], [0, 420]] }, // 合计 3000
    ];
    for (const plan of salesPlan) {
      const batches = await prisma.batchStock.findMany({
        where: { tenantId: T, productId: plan.p.id },
        include: { ledger: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!batches.length) throw new Error(`缺 ${plan.p.skuCode} 的批次, 先跑主 seed`);
      const nets = batches.map((b) => ({
        id: b.id,
        net: b.ledger.reduce((s, l) => s + (l.direction === 'IN' ? Number(l.qty) : -Number(l.qty)), 0),
      }));
      const planned = planDemoOutbound(nets, plan.perDay.map(([, qty]) => qty));
      if (planned.topUp > 0) {
        await prisma.inventoryLedger.create({
          data: {
            tenantId: T, productId: plan.p.id, batchId: planned.topUpBatchId, direction: 'IN', qty: planned.topUp,
            refType: 'INITIAL_IMPORT', refNo: 'DEMO-SALES-TOPUP', note: '动销演示补入库，避免净库存为负',
            createdBy: owner.id, createdAt: dayOffset(-8),
          },
        });
      }
      for (let i = 0; i < plan.perDay.length; i++) {
        const [offset] = plan.perDay[i];
        for (const row of planned.perDay[i]) {
          await prisma.inventoryLedger.create({
            data: {
              tenantId: T, productId: plan.p.id, batchId: row.batchId, direction: 'OUT', qty: row.qty,
              refType: 'OUTBOUND', refNo: 'DEMO-SALES', createdBy: clerk.id, createdAt: dayOffset(-offset),
            },
          });
        }
      }
    }
  }

  // 已落下的旧演示出库如果把批次打成负数，再跑 seed 时补一笔入库冲平。不改历史 OUT。
  const repairBatches = await prisma.batchStock.findMany({ where: { tenantId: T }, include: { ledger: true } });
  for (const b of repairBatches) {
    const net = b.ledger.reduce((s, l) => s + (l.direction === 'IN' ? Number(l.qty) : -Number(l.qty)), 0);
    if (net >= -0.0001) continue;
    const refNo = `DEMO-STOCK-REPAIR:${b.id}`;
    if (await prisma.inventoryLedger.findFirst({ where: { tenantId: T, batchId: b.id, refNo } })) continue;
    await prisma.inventoryLedger.create({
      data: {
        tenantId: T, productId: b.productId, batchId: b.id, direction: 'IN', qty: Math.round(-net * 1000) / 1000,
        refType: 'INITIAL_IMPORT', refNo, note: '种子修复负库存', createdBy: owner.id,
      },
    });
  }

  // ─── ⑤ 已签收订单(今日销售看板) + 待确认订单(审单演示) ───
  const priceVersionOf = async (productId, levelType) => {
    const row = await prisma.price.findFirst({ where: { tenantId: T, productId, unit: 'BASE', levelType }, orderBy: { validFrom: 'desc' } });
    return row ? `${row.id}|${row.validFrom.toISOString().slice(0, 10)}` : 'seed|2026-09-01';
  };
  async function demoOrder(orderNo, customer, source, status, signedAgo, lineSpecs) {
    const existing = await prisma.salesOrder.findUnique({ where: { tenantId_orderNo: { tenantId: T, orderNo } } });
    if (existing) return existing;
    const signedAt = signedAgo === null ? null : dayOffset(-signedAgo);
    const createdAt = signedAt ?? dayOffset(0);
    const lines = [];
    let total = 0;
    for (const s of lineSpecs) {
      const amount = Number((s.qty * s.price).toFixed(2));
      total += amount;
      lines.push({
        tenantId: T, productId: s.p.id, productName: s.p.name, specText: s.p.specText,
        unit: 'BASE', conversionRate: s.p.packSize, qty: s.qty, unitPrice: s.price, amount,
        priceType: s.priceType, priceVersion: await priceVersionOf(s.p.id, s.priceType === 'CUSTOMER_EXCLUSIVE' ? 'TIER1' : s.priceType),
        createdById: clerk.id,
      });
    }
    const order = await prisma.salesOrder.create({
      data: {
        tenantId: T, orderNo, customerId: customer.id, customerName: customer.name,
        salespersonId: rep1.id, source, signMode: customer.signMode ?? 'E_SIGN', status,
        totalAmount: total, addressSnapshot: customer.address,
        createdById: clerk.id, createdAt, signedAt,
        lines: { create: lines },
      },
    });
    // 签收即生成应收(D4 口径): 到期日=签收日+账期
    if (status === 'SIGNED' && signedAt) {
      const due = new Date(signedAt.getTime() + (customer.termsDays ?? 0) * DAY);
      const ar = await prisma.receivable.create({
        data: {
          tenantId: T, sourceType: 'ORDER', sourceDocNo: orderNo, customerId: customer.id,
          total, dueDate: due, generatedAt: signedAt, note: `演示订单 ${orderNo}`,
        },
      });
      await prisma.receivableLedger.create({
        data: { tenantId: T, receivableId: ar.id, direction: 'CHARGE', amount: total, createdBy: clerk.id, createdAt: signedAt },
      });
    }
    return order;
  }

  await demoOrder('SO-DEMO-0001', c1, 'CUSTOMER', 'SIGNED', 0, [
    { p: p1, qty: 1, price: 3050, priceType: 'CUSTOMER_EXCLUSIVE' }, // C0001 专属价(一客一价演示)
    { p: p3, qty: 5, price: 68, priceType: 'TERMINAL' },
  ]);
  await demoOrder('SO-DEMO-0002', c2, 'REP', 'SIGNED', 0, [
    { p: p2, qty: 2, price: 1020, priceType: 'TIER2' },
    { p: p3, qty: 10, price: 60, priceType: 'CUSTOMER_EXCLUSIVE' }, // C0002 专属价
  ]);
  await demoOrder('SO-DEMO-0003', c3, 'CLERK', 'SIGNED', 3, [
    { p: p5, qty: 4, price: 175, priceType: 'TERMINAL' },
  ]);
  await demoOrder('SO-DEMO-0004', c5, 'CUSTOMER', 'PENDING_CONFIRM', null, [
    { p: p7, qty: 3, price: 36, priceType: 'TERMINAL' },
  ]); // 演示: 待审单(现结客户)

  // ─── ⑥ 月结对账单(上月, SENT): 客户端可确认/提差异 ───
  const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7); // 上月 YYYY-MM
  if (!(await prisma.statement.findUnique({ where: { tenantId_customerId_period: { tenantId: T, customerId: c1.id, period } } }))) {
    // 口径复刻 statements.service: 当期发生=期间内 CHARGE; 期末未结=当前全部未结
    const ars = await prisma.receivable.findMany({ where: { tenantId: T, customerId: c1.id, archivedAt: null }, include: { ledger: true } });
    const start = new Date(`${period}-01T00:00:00.000Z`);
    const end = new Date(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).getTime() - 1);
    const lines = [];
    let totalCharged = 0;
    let totalSettled = 0;
    let openBalance = 0;
    for (const ar of ars) {
      let settled = 0; let waived = 0; let writtenOff = 0; let returnCredit = 0; let revNoPay = 0; let feeOffset = 0;
      let settledInPeriod = 0;
      for (const l of ar.ledger) {
        const amt = Number(l.amount);
        const inPeriod = l.createdAt >= start && l.createdAt <= end;
        if (l.direction === 'CHARGE') { if (ar.generatedAt >= start && ar.generatedAt <= end) totalCharged += amt; }
        else if (l.direction === 'SETTLE' || l.direction === 'REBATE_OFFSET') { settled += amt; if (inPeriod) { totalSettled += amt; settledInPeriod += amt; } }
        else if (l.direction === 'WAIVE') waived += amt;
        else if (l.direction === 'WRITEOFF') writtenOff += amt;
        else if (l.direction === 'RETURN_CREDIT') returnCredit += amt;
        else if (l.direction === 'FEE_OFFSET') feeOffset += amt;
        else if (l.direction === 'REVERSAL') { if (l.paymentId) settled -= amt; else revNoPay += amt; }
      }
      const open = Math.max(0, Number(ar.total) - settled - waived - writtenOff - returnCredit - feeOffset - revNoPay);
      openBalance += open;
      const generatedInPeriod = ar.generatedAt >= start && ar.generatedAt <= end;
      if (generatedInPeriod || settledInPeriod > 0.0001) {
        lines.push({ docNo: ar.sourceDocNo, type: ar.sourceType, total: Number(ar.total), settledInPeriod: Number(settledInPeriod.toFixed(2)), open: Number(open.toFixed(2)), generatedAt: ar.generatedAt.toISOString().slice(0, 10), dueDate: ar.dueDate.toISOString().slice(0, 10), dispute: ar.disputeFlag, generatedBeforePeriod: !generatedInPeriod });
      }
    }
    await prisma.statement.create({
      data: {
        tenantId: T, statementNo: `DZ${period.replace('-', '')}-0001`, customerId: c1.id, period,
        totalCharged, totalSettled, openBalance: Number(openBalance.toFixed(2)),
        lines, generatedById: clerk.id, status: 'SENT', sentAt: dayOffset(-2),
      },
    });
  }

  // ─── ⑦ 返利方案(3%, 1%-50% 新口径) / 坎级方案 / 随单赠规则 / 拜访 / 语音草稿 / 待确认收款 ───
  if (!(await prisma.rebateScheme.findFirst({ where: { tenantId: T, note: '演示返利方案' } }))) {
    await prisma.rebateScheme.create({
      data: { tenantId: T, customerId: c2.id, type: 'C', rate: 0.03, note: '演示返利方案(定扣货款3%)', validTo: dateOnly('2026-12-31'), createdById: owner.id },
    });
  }
  // C组: 坎级阶梯方案(月回款≥1万→2%, ≥5万→5%; 未达1万无返利)——C0004
  {
    const c4 = await cust('C0004');
    if (c4 && !(await prisma.rebateScheme.findFirst({ where: { tenantId: T, note: { contains: '演示坎级' } } }))) {
      await prisma.rebateScheme.create({
        data: {
          tenantId: T, customerId: c4.id, type: 'B', rate: 0.05,
          tiers: [{ minAmount: 10000, rate: 0.02 }, { minAmount: 50000, rate: 0.05 }],
          note: '演示坎级返利(≥1万2%, ≥5万5%)', createdById: owner.id,
        },
      });
    }
  }
  // C组: 随单赠规则——青岛啤酒 买10箱送1箱(下单管线自动挂赠品行)
  {
    const p3row = await prisma.product.findFirst({ where: { tenantId: T, skuCode: 'SKU0003' } });
    if (p3row && !(await prisma.promotion.findFirst({ where: { tenantId: T, productId: p3row.id } }))) {
      await prisma.promotion.create({
        data: { tenantId: T, productId: p3row.id, buyQty: 10, giftQty: 1, unit: 'BASE', note: '演示: 买10箱送1箱', createdById: owner.id },
      });
    }
  }
  if (!(await prisma.visit.findFirst({ where: { tenantId: T, notes: '演示拜访' } }))) {
    await prisma.visit.createMany({
      data: [
        { tenantId: T, repId: rep1.id, customerId: c1.id, visitedAt: dayOffset(-2), location: '浙江省杭州市西湖区文三路100号附近', steps: {陈列检查:true,库存盘点:true,收单:true,收款:false,宣传物料:true,客情:true,竞品:false,设备:false}, notes: '演示拜访', abcLevel: 'A' },
        { tenantId: T, repId: rep1.id, customerId: c2.id, visitedAt: dayOffset(-5), location: '浙江省杭州市拱墅区莫干山路200号附近', steps: {陈列检查:true,库存盘点:true,收单:true,收款:true,宣传物料:false,客情:true,竞品:true,设备:false}, notes: '演示拜访', abcLevel: 'A' },
      ],
    });
  }
  if (!(await prisma.orderDraft.findFirst({ where: { tenantId: T, rawText: { contains: '演示语音单' } } }))) {
    await prisma.orderDraft.create({
      data: {
        tenantId: T, draftNo: `DR-DEMO-${Date.now().toString().slice(-6)}`, source: 'VOICE',
        rawText: '演示语音单: 王五超市要5箱青岛和2箱农夫山泉 按老价格 明天送',
        customerHint: '王五超市', customerId: c2.id,
        items: [
          { productName: '青岛啤酒500ml', productId: p3.id, qty: 5, unit: '箱', priceHint: 60, aliasMatched: true },
          { productName: '农夫山泉550ml', productId: p7.id, qty: 2, unit: '箱', priceHint: 36, aliasMatched: true },
        ],
        confidence: 0.88, engine: 'qwen3.8-27b', createdById: rep1.id,
      },
    });
  }
  if (!(await prisma.payment.findFirst({ where: { tenantId: T, note: '演示: 待确认收款' } }))) {
    await prisma.payment.create({
      data: {
        tenantId: T, paymentNo: `PAY-DEMO-${Date.now().toString().slice(-6)}`, customerId: c3.id,
        amount: 2000, kind: 'PAYMENT', method: '现金', voucher: 'DEMO-手写收据',
        reportedById: rep1.id, status: 'REPORTED', note: '演示: 待确认收款(F9②)',
      },
    });
  }

  // ─── ⑧ B组费用域: 开瓶费政策/回收单/费用台账/冲抵流水 ───
  // 政策: 青岛=回瓶盖兑付(0.5/瓶); 雪花=不回瓶盖自动计提(0.3/瓶×80%)
  const policyDefs = [
    { p: p3, perBottleFee: 0.5, requireCap: true, noCapRate: 1 },
    { p: p4, perBottleFee: 0.3, requireCap: false, noCapRate: 0.8 },
  ];
  for (const d of policyDefs) {
    await prisma.capFeePolicy.upsert({
      where: { productId: d.p.id },
      update: {},
      create: { tenantId: T, productId: d.p.id, perBottleFee: d.perBottleFee, requireCap: d.requireCap, noCapRate: d.noCapRate, createdById: owner.id },
    });
  }
  // 回收单: C0003 待出纳确认(青岛瓶盖200个=¥100, 确认后生成费用单进审批)
  if (!(await prisma.capRecycleOrder.findFirst({ where: { tenantId: T, note: '演示: 待确认瓶盖回收' } }))) {
    await prisma.capRecycleOrder.create({
      data: {
        tenantId: T, recycleNo: `GAI-DEMO-${Date.now().toString().slice(-6)}`, customerId: c3.id,
        status: 'PENDING_CONFIRM',
        lines: [{ productId: p3.id, productName: p3.name, qty: 200, perBottleFee: 0.5, amount: 100 }],
        totalAmount: 100, note: '演示: 待确认瓶盖回收', createdById: rep1.id,
      },
    });
  }
  // 费用台账: 上月油费(已付) + 办公(已付) + 陈列费(已冲抵, 带 FEE_OFFSET 流水) + 本月办公(待审批+审批待办)
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const mkExpense = async (no, data) => {
    if (await prisma.expense.findUnique({ where: { tenantId_expenseNo: { tenantId: T, expenseNo: no } } })) return;
    await prisma.expense.create({ data: { tenantId: T, expenseNo: no, createdById: clerk.id, ...data } });
  };
  await mkExpense('FY-DEMO-0001', { category: 'FUEL_TOLL', title: '上月配送油费·路桥(演示)', amount: 360, payee: '中石化', occurredAt: lastMonth, payMode: 'CASH', status: 'PAID', paidAt: lastMonth, paidById: clerk.id, note: '演示: 已付运营费' });
  await mkExpense('FY-DEMO-0002', { category: 'OFFICE', title: '上月办公用品(演示)', amount: 150, payee: '文具批发', occurredAt: lastMonth, payMode: 'CASH', status: 'PAID', paidAt: lastMonth, paidById: clerk.id, note: '演示: M4-3 办公费用' });
  await mkExpense('FY-DEMO-0003', {
    category: 'DISPLAY', title: '王五超市端架陈列费(演示)', amount: 500, customerId: c2.id,
    occurredAt: lastMonth, payMode: 'AR_OFFSET', status: 'PAID', paidAt: dayOffset(-1), paidById: clerk.id,
    note: '演示: 陈列费冲抵货款', source: 'MANUAL',
  });
  // 上面的冲抵落 FEE_OFFSET 流水: 打在 C0002 最早未结单(初0003)上
  {
    const ar3 = await prisma.receivable.findUnique({ where: { tenantId_sourceType_sourceDocNo: { tenantId: T, sourceType: 'INITIAL', sourceDocNo: '初0003' } } });
    const exp3 = await prisma.expense.findUnique({ where: { tenantId_expenseNo: { tenantId: T, expenseNo: 'FY-DEMO-0003' } } });
    if (ar3 && exp3 && !(await prisma.receivableLedger.findFirst({ where: { tenantId: T, direction: 'FEE_OFFSET' } }))) {
      await prisma.receivableLedger.create({
        data: { tenantId: T, receivableId: ar3.id, direction: 'FEE_OFFSET', amount: 500, note: `费用冲抵 ${exp3.expenseNo}: ${exp3.title}`, createdBy: clerk.id, createdAt: dayOffset(-1) },
      });
    }
  }
  {
    // 本月办公费用: 待审批 + 审批中心待办(EXPENSE 线, ≤2000 出纳可批)
    await mkExpense('FY-DEMO-0004', { category: 'OFFICE', title: '本月仓库耗材(演示)', amount: 800, payee: '包装材料行', payMode: 'CASH', status: 'PENDING_APPROVAL', note: '演示: EXPENSE 审批线待办' });
    const exp4 = await prisma.expense.findUnique({ where: { tenantId_expenseNo: { tenantId: T, expenseNo: 'FY-DEMO-0004' } } });
    if (exp4 && !(await prisma.approvalRecord.findFirst({ where: { tenantId: T, entityId: exp4.id, line: 'EXPENSE' } }))) {
      const ap = await prisma.approvalRecord.create({
        data: {
          tenantId: T, line: 'EXPENSE', entityType: 'EXPENSE', entityId: exp4.id,
          title: `费用单 ${exp4.expenseNo} 办公费用·本月仓库耗材(演示)`, amount: 800,
          reason: '演示: EXPENSE 审批线待办', payload: { expenseNo: exp4.expenseNo, category: 'OFFICE', payMode: 'CASH' },
          applicantId: clerk.id, status: 'PENDING',
        },
      });
      await prisma.expense.update({ where: { id: exp4.id }, data: { approvalId: ap.id } });
    }
  }

  console.log('✓ 演示数据完成: 账龄四档/到期提醒/归档候选/临期批次/LOW动销/今日签收订单/待审单/SENT对账单/返利3%/拜访/语音草稿/待确认收款 + B组(开瓶费政策/回收待确认/费用台账四笔/FEE_OFFSET冲抵/EXPENSE审批待办)');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
