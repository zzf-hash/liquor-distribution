// P1 seed 补丁: 审批样例数据 + SystemConfig 默认键 (由 seed.ts 之后运行; qwen3.8-27b 生成+主agent修正)
// 用法: node prisma/seed-p1.js  (需已跑过 seed)
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { code: 'TENANT-DEMO' } });
  if (!tenant) throw new Error('先跑 pnpm seed (缺 TENANT-DEMO)');
  const [owner, clerk, rep1] = await Promise.all([
    prisma.user.findFirst({ where: { tenantId: tenant.id, username: 'owner' } }),
    prisma.user.findFirst({ where: { tenantId: tenant.id, username: 'clerk' } }),
    prisma.user.findFirst({ where: { tenantId: tenant.id, username: 'rep1' } }),
  ]);
  const customer = await prisma.customer.findFirst({ where: { tenantId: tenant.id, code: 'C0001' } });
  const product = await prisma.product.findFirst({ where: { tenantId: tenant.id, skuCode: 'SKU0001' } });
  const order = await prisma.salesOrder.findFirst({
    where: { tenantId: tenant.id, status: { in: ['SIGNED', 'SETTLED'] } },
    include: { lines: true }, orderBy: { createdAt: 'desc' },
  });
  const ids = { tenantId: tenant.id, owner, clerk, rep1, customerId: customer?.id, productId: product?.id, orderId: order?.id, orderLineId: order?.lines?.[0]?.id };

  // ① 样例特单(PENDING_PRICE) + 审批待办
  const existingSO = await prisma.specialOrder.findFirst({ where: { tenantId: ids.tenantId, title: '样例宴席特单(种子)' } });
  if (!existingSO) {
    const so = await prisma.specialOrder.create({
      data: {
        tenantId: ids.tenantId,
        specialNo: `SP-SEED-${Date.now().toString().slice(-6)}`,
        title: '样例宴席特单(种子)', customerId: ids.customerId, customerName: '张三烟酒店',
        isBanquet: true, eventDate: new Date('2026-10-20'), venue: '喜来登宴会厅',
        contactName: '张三', contactPhone: '13800000001', address: '示例街道1号',
        createdById: ids.rep1.id, status: 'PENDING_PRICE',
        lines: {
          create: [
            { tenantId: ids.tenantId, productId: ids.productId, productName: '飞天茅台53度500ml', unit: '箱', qty: 2, price: 2900 },
            { tenantId: ids.tenantId, productName: '宴席赠饮可乐(自由品名)', unit: '箱', qty: 1, price: 0 },
          ],
        },
      },
    });
    await prisma.approvalRecord.create({
      data: {
        tenantId: ids.tenantId, line: 'PRICE_SPECIAL', entityType: 'SPECIAL_ORDER', entityId: so.id,
        title: `特单定价 ${so.specialNo} 样例宴席特单`, amount: 5800, reason: '婚宴用酒议价(低于二批价)',
        payload: { specialNo: so.specialNo, signals: ['宴席/活动用酒', '低于可用价'] },
        applicantId: ids.rep1.id, status: 'PENDING',
      },
    });
    console.log('✓ 样例特单 + 审批待办');
  }

  // ② 历史退货样例(RECEIVED)——依赖已有已签收订单
  if (ids.orderId && ids.orderLineId && !(await prisma.returnOrder.findFirst({ where: { tenantId: ids.tenantId, reason: '种子样例退货' } }))) {
    await prisma.returnOrder.create({
      data: {
        tenantId: ids.tenantId,
        returnNo: `RT-SEED-${Date.now().toString().slice(-6)}`,
        sourceOrderId: ids.orderId, customerId: order.customerId,
        reason: '种子样例退货', status: 'RECEIVED',
        receivedAt: new Date(), receivedById: ids.owner.id, createdById: ids.clerk.id,
        lines: { create: [{ tenantId: ids.tenantId, orderLineId: ids.orderLineId, productId: ids.productId, qty: 1, note: '样例' }] },
      },
    });
    console.log('✓ 样例退货单');
  }

  // ③ SystemConfig 默认键(数值型默认值, 商户签字可否决)
  const configs = [
    { key: 'waive_single_max', value: { v: 50 } },
    { key: 'waive_monthly_max', value: { v: 500 } },
    { key: 'remind_days_before', value: { v: 7 } },
    { key: 'special_approve_threshold', value: { v: 2000 } },
    { key: 'low_stock_threshold', value: { v: 12 } },
  ];
  for (const c of configs) {
    if (!(await prisma.systemConfig.findFirst({ where: { tenantId: ids.tenantId, key: c.key } }))) {
      await prisma.systemConfig.create({ data: { tenantId: ids.tenantId, key: c.key, value: c.value, updatedBy: ids.owner.id } });
    }
  }
  console.log('✓ SystemConfig 5 键');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
