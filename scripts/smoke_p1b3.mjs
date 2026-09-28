#!/usr/bin/env node
// scripts/smoke.mjs - P1B3 冒烟测试 (零依赖, Node ESM)
// 用法: SMOKE_BASE=http://127.0.0.1:3000/api node scripts/smoke.mjs

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000/api';

let passCount = 0;
let failCount = 0;

function logPass(msg) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

function logFail(msg, err) {
  console.error(`[FAIL] ${msg}`);
  if (err) console.error(`       ${err.message || err}`);
  failCount++;
}

// 通用 API 调用封装
async function api(method, path, { token, body, idemKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (idemKey) headers['Idempotency-Key'] = idemKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json;
  try {
    json = await res.json();
  } catch {
    json = { code: -1, message: 'Invalid JSON response' };
  }

  // 返回 { ok, status, data, code, message }
  return {
    ok: res.ok,
    status: res.status,
    data: json.data ?? null,
    code: json.code ?? -1,
    message: json.message ?? '',
    raw: json,
  };
}

// 断言辅助
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 登录
async function login(username, password) {
  const r = await api('POST', '/auth/login', { body: { username, password } });
  assert(r.ok && r.code === 0, `Login failed for ${username}: ${r.message} (status ${r.status})`);
  return r.data.token;
}

// 期望失败的断言
async function expectFail(promise, expectedStatus, msg) {
  try {
    const r = await promise;
    if (r.status === expectedStatus) {
      logPass(`${msg} (got expected ${expectedStatus})`);
      return r;
    }
    logFail(`${msg} - expected ${expectedStatus}, got ${r.status}`, new Error(r.message));
    return null;
  } catch (e) {
    logFail(`${msg} - unexpected error`, e);
    return null;
  }
}

async function main() {
  console.log('=== SMOKE-P1B3 START ===');

  // 1. 登录
  const [ownerToken, clerkToken, warehouseToken, rep1Token] = await Promise.all([
    login('owner', 'owner123'),
    login('clerk', 'clerk123'),
    login('warehouse', 'warehouse123'),
    login('rep1', 'rep1123'),
  ]);
  logPass('1. Login owner/clerk/warehouse/rep1');

  // 2. 创建盘点
  let takeId, takeNo, firstLineId, systemQty;
  try {
    const r = await api('POST', '/stocktakes', {
      token: warehouseToken,
      body: { type: 'SPOT' },
    });
    assert(r.ok && r.code === 0, `Create stocktake failed: ${r.message}`);
    takeNo = r.data.takeNo;
    takeId = r.data.id;
    const lines = r.data.lines;
    assert(Array.isArray(lines) && lines.length > 0, 'Stocktake lines should not be empty');
    assert(lines[0].systemQty !== undefined, 'First line should have systemQty snapshot');
    firstLineId = lines[0].id;
    systemQty = lines[0].systemQty;
    logPass(`2. Create stocktake SPOT: takeNo=${takeNo}, id=${takeId}, lines=${lines.length}`);
  } catch (e) {
    logFail('2. Create stocktake', e);
    return;
  }

  // 3. 录实盘
  try {
    const r = await api('POST', `/stocktakes/${takeId}/count`, {
      token: warehouseToken,
      body: { lines: [{ id: firstLineId, countedQty: systemQty - 10 }] },
    });
    assert(r.ok && r.code === 0, `Count failed: ${r.message}`);
    assert(r.data.status === 'COUNTED', `Expected status COUNTED, got ${r.data.status}`);
    logPass('3. Count stocktake: status=COUNTED');
  } catch (e) {
    logFail('3. Count stocktake', e);
    return;
  }

  // 4. 核对
  let stocktakeStatus;
  try {
    const r = await api('POST', `/stocktakes/${takeId}/reconcile`, {
      token: clerkToken,
    });
    assert(r.ok && r.code === 0, `Reconcile failed: ${r.message}`);
    stocktakeStatus = r.data.status;
    assert(
      stocktakeStatus === 'RECONCILED' || stocktakeStatus === 'PENDING_APPROVAL',
      `Unexpected status: ${stocktakeStatus}`
    );
    if (stocktakeStatus === 'PENDING_APPROVAL') {
      assert(r.data.thresholdOver !== undefined, 'PENDING_APPROVAL should include thresholdOver');
    }
    logPass(`4. Reconcile stocktake: status=${stocktakeStatus}`);
  } catch (e) {
    logFail('4. Reconcile stocktake', e);
    return;
  }

  // 5. 调账
  try {
    if (stocktakeStatus === 'PENDING_APPROVAL') {
      // 查找待审批的 STOCKTAKE 审批单
      const apprList = await api('GET', '/approvals', { token: ownerToken });
      assert(apprList.ok && apprList.code === 0, `List approvals failed: ${apprList.message}`);
      const pending = (apprList.data || []).find(
        (a) => a.type === 'STOCKTAKE' && a.status === 'PENDING'
      );
      assert(pending, 'No pending STOCKTAKE approval found');
      const apprR = await api('POST', `/approvals/${pending.id}/approve`, {
        token: ownerToken,
      });
      assert(apprR.ok && apprR.code === 0, `Approve failed: ${apprR.message}`);
      logPass('5a. Approve stocktake approval');
    }

    const adjR = await api('POST', `/stocktakes/${takeId}/adjust`, {
      token: clerkToken,
    });
    assert(adjR.ok && adjR.code === 0, `Adjust failed: ${adjR.message}`);
    assert(adjR.data.status === 'ADJUSTED', `Expected ADJUSTED, got ${adjR.data.status}`);
    logPass('5. Adjust stocktake: status=ADJUSTED');
  } catch (e) {
    logFail('5. Adjust stocktake', e);
    return;
  }

  // 6. 重复调账 → 期望 409
  await expectFail(
    api('POST', `/stocktakes/${takeId}/adjust`, { token: clerkToken }),
    409,
    '6. Duplicate adjust should return 409'
  );

  // 7. 返利互斥
  const customerId = 'C0001';
  try {
    const r1 = await api('POST', '/rebates/schemes', {
      token: clerkToken,
      body: { customerId, type: 'B', rate: 0.05 },
    });
    assert(r1.ok && r1.code === 0, `Create rebate scheme B failed: ${r1.message}`);
    logPass('7a. Create rebate scheme B');
  } catch (e) {
    logFail('7a. Create rebate scheme B', e);
    return;
  }

  await expectFail(
    api('POST', '/rebates/schemes', {
      token: clerkToken,
      body: { customerId, type: 'C', rate: 0.03 },
    }),
    409,
    '7b. Duplicate customer rebate scheme should return 409 (D02 mutual exclusion)'
  );

  // 8. 月末核算
  try {
    const r = await api('POST', '/rebates/settlements', {
      token: clerkToken,
      body: { customerId, period: '2026-09', settleType: 'INVOICE' },
    });
    assert(r.ok && r.code === 0, `Settlement failed: ${r.message}`);
    assert(r.data.rebateAmount >= 0, `rebateAmount should be >= 0, got ${r.data.rebateAmount}`);
    logPass(`8a. Settlement: rebateAmount=${r.data.rebateAmount}`);
  } catch (e) {
    logFail('8a. Settlement', e);
    return;
  }

  await expectFail(
    api('POST', '/rebates/settlements', {
      token: clerkToken,
      body: { customerId, period: '2026-09', settleType: 'INVOICE' },
    }),
    409,
    '8b. Duplicate settlement same month/customer should return 409'
  );

  // 9. 绩效
  try {
    const r = await api('GET', '/performance?month=2026-09', { token: ownerToken });
    assert(r.ok && r.code === 0, `Performance query failed: ${r.message}`);
    const items = r.data.items;
    assert(Array.isArray(items), 'Performance items should be an array');
    for (const item of items) {
      assert('paymentAmount' in item, 'Each item should have paymentAmount');
      assert('newCustomers' in item, 'Each item should have newCustomers');
    }
    logPass(`9. Performance: ${items.length} items, all have paymentAmount/newCustomers`);
  } catch (e) {
    logFail('9. Performance', e);
    return;
  }

  // 10. 工资表
  try {
    const genR = await api('POST', '/payroll/generate', {
      token: ownerToken,
      body: { month: '2026-09' },
    });
    assert(genR.ok && genR.code === 0, `Payroll generate failed: ${genR.message}`);
    assert(genR.data.totalAmount >= 0, `totalAmount should be >= 0, got ${genR.data.totalAmount}`);
    logPass(`10a. Payroll generate: totalAmount=${genR.data.totalAmount}`);

    const listR = await api('GET', '/payroll?month=2026-09', { token: ownerToken });
    assert(listR.ok && listR.code === 0, `Payroll list failed: ${listR.message}`);
    const payrollItems = listR.data.items;
    assert(Array.isArray(payrollItems) && payrollItems.length > 0, 'Payroll items should not be empty');
    logPass(`10b. Payroll list: ${payrollItems.length} items`);
  } catch (e) {
    logFail('10. Payroll', e);
    return;
  }

  await expectFail(
    api('POST', '/payroll/generate', {
      token: ownerToken,
      body: { month: '2026-09' },
    }),
    409,
    '10c. Duplicate payroll generate same month should return 409'
  );

  // 总结
  console.log(`\n=== SMOKE-P1B3: ${passCount} PASS, ${failCount} FAIL ===`);
  if (failCount === 0) {
    console.log('SMOKE-P1B3: ALL PASS');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Unexpected fatal error:', e);
  process.exit(1);
});
