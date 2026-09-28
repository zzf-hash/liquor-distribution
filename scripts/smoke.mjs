const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000/api';

// --- 小工具 ---
function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function api(method, path, { token, body, idemKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (idemKey) headers['idempotency-key'] = idemKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Non-JSON response from ${method} ${path} (status ${res.status})`);
  }

  // 信封: { code, data, message? }
  if (json.code !== 0) {
    const msg = json.message || `code=${json.code}`;
    throw new Error(`API error ${method} ${path}: ${msg} (code=${json.code})`);
  }
  return json.data;
}

// --- 主流程 ---
async function main() {
  let step = 0;
  const fail = (name, err) => {
    console.log(`[FAIL] ${name}: ${err.message}`);
    console.log(`SMOKE: FAILED at ${name}`);
    process.exit(1);
  };

  // 1. 健康检查
  step = 1;
  try {
    const d = await api('GET', '/health');
    assert(d.ok === true, 'health ok should be true');
    console.log(`[PASS] 1.健康检查 ok=true`);
  } catch (e) { return fail('1.健康检查', e); }

  // 2. 登录 clerk
  step = 2;
  let clerkTok;
  try {
    const d = await api('POST', '/auth/login', { body: { username: 'clerk', password: 'demo1234' } });
    clerkTok = d.token;
    assert(d.user && d.user.role === 'CLERK', 'clerk role should be CLERK');
    console.log(`[PASS] 2.登录clerk role=CLERK`);
  } catch (e) { return fail('2.登录clerk', e); }

  // 3. 登录 warehouse
  step = 3;
  let warehouseTok;
  try {
    const d = await api('POST', '/auth/login', { body: { username: 'warehouse', password: 'demo1234' } });
    warehouseTok = d.token;
    console.log(`[PASS] 3.登录warehouse`);
  } catch (e) { return fail('3.登录warehouse', e); }

  // 4. 登录 owner
  step = 4;
  let ownerTok;
  try {
    const d = await api('POST', '/auth/login', { body: { username: 'owner', password: 'demo1234' } });
    ownerTok = d.token;
    console.log(`[PASS] 4.登录owner`);
  } catch (e) { return fail('4.登录owner', e); }

  // 5. B1 验证: logout 后旧 token 失效
  step = 5;
  try {
    await api('POST', '/auth/logout', { token: ownerTok, body: {} });
    let got401 = false;
    try {
      await api('GET', '/orders', { token: ownerTok });
    } catch (e) {
      // 期望 code=401
      if (e.message.includes('code=401') || e.message.includes('401')) got401 = true;
    }
    assert(got401, 'old owner token should be rejected with 401 after logout');
    // 重新登录 owner
    const d = await api('POST', '/auth/login', { body: { username: 'owner', password: 'demo1234' } });
    ownerTok = d.token;
    console.log(`[PASS] 5.B1验证 logout后旧token=401, 重新登录成功`);
  } catch (e) { return fail('5.B1验证', e); }

  // 6. 越权验证: warehouseTok GET /audit → 403
  step = 6;
  try {
    let got403 = false;
    try {
      await api('GET', '/audit', { token: warehouseTok });
    } catch (e) {
      if (e.message.includes('code=403') || e.message.includes('403')) got403 = true;
    }
    assert(got403, 'warehouse should get 403 on /audit');
    console.log(`[PASS] 6.越权验证 warehouse→/audit=403`);
  } catch (e) { return fail('6.越权验证', e); }

  // 7. 查商品
  step = 7;
  let productId, packSize;
  try {
    const d = await api('GET', '/products?q=茅台&page=1&pageSize=5', { token: clerkTok });
    const items = d.items || d;
    assert(Array.isArray(items) && items.length > 0, 'products items should be non-empty');
    productId = items[0].id;
    packSize = items[0].packSize;
    console.log(`[PASS] 7.查商品 productId=${productId} packSize=${packSize}`);
  } catch (e) { return fail('7.查商品', e); }

  // 8. 查客户
  step = 8;
  let customerId;
  try {
    const d = await api('GET', '/customers?q=C0001', { token: clerkTok });
    const items = d.items || d;
    assert(Array.isArray(items) && items.length > 0, 'customers items should be non-empty');
    customerId = items[0].id;
    console.log(`[PASS] 8.查客户 customerId=${customerId}`);
  } catch (e) { return fail('8.查客户', e); }

  // 9. 库存基线
  step = 9;
  let stockBefore = null;
  try {
    const d = await api('GET', `/products/${productId}`, { token: clerkTok });
    // 尝试常见库存字段
    stockBefore = d.stock ?? d.quantity ?? d.available ?? null;
    console.log(`[PASS] 9.库存基线 stock=${stockBefore ?? 'N/A'}`);
  } catch (e) { return fail('9.库存基线', e); }

  // 10. 下单
  step = 10;
  let orderId, orderNo, totalAmount;
  try {
    const d = await api('POST', '/orders', {
      token: clerkTok,
      body: {
        customerId,
        source: 'CLERK',
        lines: [{ productId, qty: 1, unit: 'BASE' }],
      },
    });
    orderId = d.id ?? d.orderId;
    orderNo = d.orderNo ?? d.no;
    totalAmount = d.totalAmount ?? d.amount;
    assert(orderId, 'orderId should exist');
    assert(orderNo, 'orderNo should exist');
    assert(totalAmount > 0, `totalAmount should > 0, got ${totalAmount}`);
    assert(d.status === 'PENDING_CONFIRM', `status should be PENDING_CONFIRM, got ${d.status}`);
    console.log(`[PASS] 10.下单 orderNo=${orderNo} totalAmount=${totalAmount} status=PENDING_CONFIRM`);
  } catch (e) { return fail('10.下单', e); }

  // 11. 确认
  step = 11;
  try {
    const d = await api('POST', `/orders/${orderId}/confirm`, { token: clerkTok });
    assert(d.status === 'CONFIRMED', `status should be CONFIRMED, got ${d.status}`);
    console.log(`[PASS] 11.确认 status=CONFIRMED`);
  } catch (e) { return fail('11.确认', e); }

  // 12. 出库单
  step = 12;
  let outboundNo;
  try {
    const d = await api('POST', `/orders/${orderId}/outbound`, { token: warehouseTok });
    outboundNo = d.outboundNo ?? d.no;
    const suggestions = d.suggestions;
    assert(outboundNo, 'outboundNo should exist');
    assert(Array.isArray(suggestions) && suggestions.length > 0, 'suggestions should be non-empty');
    console.log(`[PASS] 12.出库单 outboundNo=${outboundNo} suggestions=${suggestions.length}`);
  } catch (e) { return fail('12.出库单', e); }

  // 13. 出库复核
  step = 13;
  const idemKey = crypto.randomUUID();
  try {
    const d = await api('POST', `/orders/outbounds/${outboundNo}/confirm`, {
      token: warehouseTok,
      idemKey,
    });
    assert(d.confirmed === true, 'confirmed should be true');
    console.log(`[PASS] 13.出库复核 confirmed=true idemKey=${idemKey}`);
  } catch (e) { return fail('13.出库复核', e); }

  // 14. 幂等重放
  step = 14;
  try {
    const d = await api('POST', `/orders/outbounds/${outboundNo}/confirm`, {
      token: warehouseTok,
      idemKey,
    });
    assert(d.replay === true, 'replay should be true on idempotent replay');
    console.log(`[PASS] 14.幂等重放 replay=true`);
  } catch (e) { return fail('14.幂等重放', e); }

  // 15. 发运
  step = 15;
  try {
    const d = await api('POST', `/orders/${orderId}/deliver`, { token: warehouseTok });
    assert(d.status === 'DELIVERING', `status should be DELIVERING, got ${d.status}`);
    console.log(`[PASS] 15.发运 status=DELIVERING`);
  } catch (e) { return fail('15.发运', e); }

  // 16. 签收
  step = 16;
  let acceptedAmount;
  try {
    const d = await api('POST', `/orders/${orderId}/sign`, {
      token: warehouseTok,
      body: { type: 'E_SIGN', signerName: '张三' },
    });
    assert(d.status === 'SIGNED', `status should be SIGNED, got ${d.status}`);
    assert(d.receivableGenerated === true, 'receivableGenerated should be true');
    acceptedAmount = d.acceptedAmount ?? d.amount;
    assert(acceptedAmount > 0, `acceptedAmount should > 0, got ${acceptedAmount}`);
    console.log(`[PASS] 16.签收 status=SIGNED acceptedAmount=${acceptedAmount}`);
  } catch (e) { return fail('16.签收', e); }

  // 17. 业务员上报收款
  step = 17;
  const payIdemKey = crypto.randomUUID();
  try {
    const d = await api('POST', '/payments', {
      token: clerkTok,
      idemKey: payIdemKey,
      body: {
        customerId,
        amount: acceptedAmount,
        method: '现金',
      },
    });
    const hasPaymentNo = !!d.paymentNo;
    const hasApplied = !!d.applied;
    assert(hasPaymentNo || hasApplied, 'payment should have paymentNo or applied');
    console.log(`[PASS] 17.上报收款 paymentNo=${d.paymentNo || 'N/A'} applied=${d.applied || false}`);
  } catch (e) { return fail('17.上报收款', e); }

  // 18. 订单销账验证
  step = 18;
  try {
    const d = await api('GET', `/orders/${orderId}`, { token: clerkTok });
    assert(d.status === 'SETTLED', `status should be SETTLED, got ${d.status}`);
    console.log(`[PASS] 18.订单销账 status=SETTLED`);
  } catch (e) { return fail('18.订单销账', e); }

  // 19. 应收核销验证
  step = 19;
  try {
    const d = await api('GET', '/receivables?bucket=not_due', { token: clerkTok });
    const items = d.items || d;
    const found = Array.isArray(items) && items.some((r) => r.sourceDocNo === orderNo);
    assert(!found, `receivable for ${orderNo} should NOT appear in not_due bucket`);
    console.log(`[PASS] 19.应收核销 orderNo=${orderNo} 不在not_due`);
  } catch (e) { return fail('19.应收核销', e); }

  // 20. 审计链
  step = 20;
  try {
    const d = await api('GET', '/audit?action=ORDER_CREATE&page=1&pageSize=5', { token: clerkTok });
    const items = d.items || d;
    assert(Array.isArray(items) && items.length > 0, 'audit items should be non-empty');
    assert(items[0].rowHash, 'audit item should have rowHash');
    console.log(`[PASS] 20.审计链 items=${items.length} rowHash=${items[0].rowHash}`);
  } catch (e) { return fail('20.审计链', e); }

  // 21. 状态机非法转换
  step = 21;
  try {
    let got409 = false;
    try {
      await api('POST', `/orders/${orderId}/cancel`, {
        token: clerkTok,
        body: { reason: '测试' },
      });
    } catch (e) {
      if (e.message.includes('code=409') || e.message.includes('409')) got409 = true;
    }
    assert(got409, 'cancel on SETTLED order should return 409');
    console.log(`[PASS] 21.状态机非法转换 cancel→409`);
  } catch (e) { return fail('21.状态机非法转换', e); }

  // 22. B3 写一次守卫(间接)
  step = 22;
  try {
    const d = await api('GET', `/orders/${orderId}`, { token: clerkTok });
    const lines = d.lines ?? d.items ?? d.orderLines;
    assert(Array.isArray(lines) && lines.length > 0, 'order detail lines should exist');
    console.log(`[PASS] 22.B3写一次守卫 明细行存在 lines=${lines.length}`);
  } catch (e) { return fail('22.B3写一次守卫', e); }

  console.log('SMOKE: ALL PASS');
  process.exit(0);
}

main().catch((e) => {
  console.error(`SMOKE: FAILED at unknown: ${e.message}`);
  process.exit(1);
});
