// 演示数据 seed(A 组功能演示配套): 在 seed + seed-p1 之后运行
// 用法: node prisma/seed-demo.js   (幂等: 全部按"不存在才建"防重)
// 覆盖的演示点:
//   ① 账龄四档(30/50/90 口径) + 到期提醒(3天后到期) + 归档候选(已结满6个月)
//   ② 临期批次(12/26天后到期 + 已过期1个) + 低库存动销历史(库存预警 LOW 演示)
//   ③ 月结对账单(上月, SENT 状态→客户端可确认/提差异)
//   ④ 已签收订单(今日销售看板) + 待确认订单(审单演示) + 待确认收款(F9②演示)
//   ⑤ 返利方案(3%, 落在 1%-50% 新口径) + 拜访记录 + 语音转单草稿(qwen 解析结果)
const { PrismaClient } = require('@prisma/client');
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
  // 青岛啤酒: 7日销 4440 → 日均~634 → 阈值≈4440 > 在库4080 → LOW; 农夫山泉: 常规动销 OK
  if (!(await prisma.inventoryLedger.findFirst({ where: { tenantId: T, refNo: 'DEMO-SALES' } }))) {
    const batchOf = async (productId) => prisma.batchStock.findFirst({ where: { tenantId: T, productId }, orderBy: { createdAt: 'asc' } });
    const salesPlan = [
      { p: p3, perDay: [[6, 620], [5, 620], [4, 620], [3, 640], [2, 640], [1, 640], [0, 660]] }, // 合计 4440
      { p: p7, perDay: [[6, 420], [5, 420], [4, 420], [3, 440], [2, 440], [1, 440], [0, 420]] }, // 合计 3000
    ];
    for (const plan of salesPlan) {
      const batch = await batchOf(plan.p.id);
      if (!batch) throw new Error(`缺 ${plan.p.skuCode} 的批次, 先跑主 seed`);
      for (const [offset, qty] of plan.perDay) {
        await prisma.inventoryLedger.create({
          data: { tenantId: T, productId: plan.p.id, batchId: batch.id, direction: 'OUT', qty, refType: 'OUTBOUND', refNo: 'DEMO-SALES', createdBy: clerk.id, createdAt: dayOffset(-offset) },
        });
      }
    }
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
      let settled = 0; let waived = 0; let writtenOff = 0; let returnCredit = 0; let revNoPay = 0;
      let settledInPeriod = 0;
      for (const l of ar.ledger) {
        const amt = Number(l.amount);
        const inPeriod = l.createdAt >= start && l.createdAt <= end;
        if (l.direction === 'CHARGE') { if (ar.generatedAt >= start && ar.generatedAt <= end) totalCharged += amt; }
        else if (l.direction === 'SETTLE' || l.direction === 'REBATE_OFFSET') { settled += amt; if (inPeriod) { totalSettled += amt; settledInPeriod += amt; } }
        else if (l.direction === 'WAIVE') waived += amt;
        else if (l.direction === 'WRITEOFF') writtenOff += amt;
        else if (l.direction === 'RETURN_CREDIT') returnCredit += amt;
        else if (l.direction === 'REVERSAL') { if (l.paymentId) settled -= amt; else revNoPay += amt; }
      }
      const open = Math.max(0, Number(ar.total) - settled - waived - writtenOff - returnCredit - revNoPay);
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

  // ─── ⑦ 返利方案(3%, 1%-50% 新口径) / 拜访 / 语音草稿 / 待确认收款 ───
  if (!(await prisma.rebateScheme.findFirst({ where: { tenantId: T, note: '演示返利方案' } }))) {
    await prisma.rebateScheme.create({
      data: { tenantId: T, customerId: c2.id, type: 'C', rate: 0.03, note: '演示返利方案(定扣货款3%)', validTo: dateOnly('2026-12-31'), createdById: owner.id },
    });
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

  console.log('✓ 演示数据完成: 账龄四档/到期提醒/归档候选/临期批次/LOW动销/今日签收订单/待审单/SENT对账单/返利3%/拜访/语音草稿/待确认收款');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
