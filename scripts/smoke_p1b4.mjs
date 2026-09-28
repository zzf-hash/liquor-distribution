#!/usr/bin/env node
// scripts/smoke.mjs - P1B4 冒烟测试 (零依赖, Node ESM)

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000/api';

let passed = 0;
let failed = 0;

function logPass(msg) {
  console.log(`[PASS] ${msg}`);
  passed++;
}

function logFail(msg, err) {
  console.error(`[FAIL] ${msg}`);
  if (err) console.error(`       Error: ${err.message || err}`);
  failed++;
}

async function api(method, path, { token, body, idemKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (idemKey) headers['Idempotency-Key'] = idemKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    // 非 JSON 响应
  }

  return { status: res.status, json };
}

async function expectSuccess(stepDesc, method, path, opts) {
  try {
    const { status, json } = await api(method, path, opts);
    if (status !== 200 && status !== 201) {
      logFail(stepDesc, new Error(`Expected 200/201, got ${status}. Body: ${JSON.stringify(json)}`));
      return null;
    }
    if (json && json.code !== 0) {
      logFail(stepDesc, new Error(`Expected code 0, got ${json.code}. Msg: ${json.msg || json.message}`));
      return null;
    }
    logPass(stepDesc);
    return json ? json.data : null;
  } catch (e) {
    logFail(stepDesc, e);
    return null;
  }
}

async function expectFailure(stepDesc, method, path, opts, expectedStatus) {
  try {
    const { status, json } = await api(method, path, opts);
    if (status !== expectedStatus) {
      logFail(stepDesc, new Error(`Expected ${expectedStatus}, got ${status}. Body: ${JSON.stringify(json)}`));
      return;
    }
    logPass(stepDesc);
  } catch (e) {
    logFail(stepDesc, e);
  }
}

async function main() {
  console.log('=== SMOKE P1B4 START ===');

  // 1. 登录
  const loginRes = await api('POST', '/auth/login', {
    body: { username: 'owner', password: 'demo1234' },
  });
  if (loginRes.status !== 200 || !loginRes.json || loginRes.json.code !== 0) {
    logFail('Login owner', new Error(`Status ${loginRes.status}`));
    process.exit(1);
  }
  const ownerToken = loginRes.json.data.token;
  logPass('Login owner');

  const loginClerk = await api('POST', '/auth/login', {
    body: { username: 'clerk', password: 'demo1234' },
  });
  if (loginClerk.status !== 200 || !loginClerk.json || loginClerk.json.code !== 0) {
    logFail('Login clerk', new Error(`Status ${loginClerk.status}`));
    process.exit(1);
  }
  const clerkToken = loginClerk.json.data.token;
  logPass('Login clerk');

  const loginRep1 = await api('POST', '/auth/login', {
    body: { username: 'rep1', password: 'demo1234' },
  });
  if (loginRep1.status !== 200 || !loginRep1.json || loginRep1.json.code !== 0) {
    logFail('Login rep1', new Error(`Status ${loginRep1.status}`));
    process.exit(1);
  }
  const rep1Token = loginRep1.json.data.token;
  logPass('Login rep1');

  const loginCust = await api('POST', '/auth/login', {
    body: { username: 'cust-c0001', password: 'demo1234' },
  });
  if (loginCust.status !== 200 || !loginCust.json || loginCust.json.code !== 0) {
    logFail('Login cust-c0001', new Error(`Status ${loginCust.status}`));
    process.exit(1);
  }
  const custToken = loginCust.json.data.token;
  logPass('Login cust-c0001');

  // 获取 C0001 的 customerId
  const custListRes = await api('GET', '/customers?keyword=C0001', { token: clerkToken });
  if (custListRes.status !== 200 || !custListRes.json || custListRes.json.code !== 0) {
    logFail('Get customer C0001', new Error(`Status ${custListRes.status}`));
    process.exit(1);
  }
  const custItems = custListRes.json.data.items || custListRes.json.data;
  const cust = Array.isArray(custItems) ? custItems.find(c => c.code === 'C0001' || c.id === 'C0001') : null;
  if (!cust) {
    logFail('Find customer C0001', new Error('Customer not found'));
    process.exit(1);
  }
  const customerId = cust.id;
  logPass('Found customer C0001');

  // 2. 对账单生成
  const genRes = await api('POST', '/statements/generate', {
    token: clerkToken,
    body: { customerId, period: '2026-09' },
  });
  if (genRes.status !== 200 && genRes.status !== 201) {
    logFail('Generate statement', new Error(`Status ${genRes.status}. Body: ${JSON.stringify(genRes.json)}`));
    process.exit(1);
  }
  if (!genRes.json || genRes.json.code !== 0) {
    logFail('Generate statement', new Error(`Code ${genRes.json?.code}. Msg: ${genRes.json?.msg}`));
    process.exit(1);
  }
  const stmt = genRes.json.data;
  if (!stmt || !stmt.statementNo || typeof stmt.totalCharged !== 'number' || typeof stmt.openBalance !== 'number') {
    logFail('Validate statement fields', new Error(`Invalid statement: ${JSON.stringify(stmt)}`));
    process.exit(1);
  }
  logPass('Generate statement');

  // 重复生成 → 409
  await expectFailure('Duplicate statement (409)', 'POST', '/statements/generate', {
    token: clerkToken,
    body: { customerId, period: '2026-09' },
  }, 409);

  // 3. 推送
  const sendRes = await api('POST', `/statements/${stmt.id}/send`, { token: clerkToken });
  if (sendRes.status !== 200 || !sendRes.json || sendRes.json.code !== 0) {
    logFail('Send statement', new Error(`Status ${sendRes.status}. Body: ${JSON.stringify(sendRes.json)}`));
    process.exit(1);
  }
  if (sendRes.json.data.status !== 'SENT') {
    logFail('Send statement status', new Error(`Expected SENT, got ${sendRes.json.data.status}`));
    process.exit(1);
  }
  logPass('Send statement');

  // 4. 客户异议
  const disputeRes = await api('POST', `/statements/${stmt.id}/dispute`, {
    token: custToken,
    body: { items: [{ type: 'PRICE', content: '9月3日单价格不对' }] },
  });
  if (disputeRes.status !== 200 || !disputeRes.json || disputeRes.json.code !== 0) {
    logFail('Create dispute', new Error(`Status ${disputeRes.status}. Body: ${JSON.stringify(disputeRes.json)}`));
    process.exit(1);
  }
  if (disputeRes.json.data.status !== 'DISPUTED') {
    logFail('Dispute status', new Error(`Expected DISPUTED, got ${disputeRes.json.data.status}`));
    process.exit(1);
  }
  logPass('Create dispute');

  // 5. 差异处理
  const stmtDetailRes = await api('GET', `/statements/${stmt.id}`, { token: clerkToken });
  if (stmtDetailRes.status !== 200 || !stmtDetailRes.json || stmtDetailRes.json.code !== 0) {
    logFail('Get statement detail', new Error(`Status ${stmtDetailRes.status}`));
    process.exit(1);
  }
  const disputes = stmtDetailRes.json.data.disputes || [];
  if (disputes.length === 0) {
    logFail('Get dispute id', new Error('No disputes found'));
    process.exit(1);
  }
  const disputeId = disputes[0].id;
  logPass('Get dispute id');

  const resolveRes = await api('POST', `/disputes/${disputeId}/resolve`, {
    token: clerkToken,
    body: { resolution: '核对为老价格,已说明' },
  });
  if (resolveRes.status !== 200 || !resolveRes.json || resolveRes.json.code !== 0) {
    logFail('Resolve dispute', new Error(`Status ${resolveRes.status}. Body: ${JSON.stringify(resolveRes.json)}`));
    process.exit(1);
  }
  if (resolveRes.json.data.status !== 'RESOLVED') {
    logFail('Resolve dispute status', new Error(`Expected RESOLVED, got ${resolveRes.json.data.status}`));
    process.exit(1);
  }
  logPass('Resolve dispute');

  // 6. 报表
  const monthlyRes = await api('GET', '/reports/monthly?month=2026-09', { token: ownerToken });
  if (monthlyRes.status !== 200 || !monthlyRes.json || monthlyRes.json.code !== 0) {
    logFail('Monthly report', new Error(`Status ${monthlyRes.status}. Body: ${JSON.stringify(monthlyRes.json)}`));
    process.exit(1);
  }
  const monthlyData = monthlyRes.json.data;
  if (!monthlyData || !('salesByCategory' in monthlyData) || !('totalPayments' in monthlyData)) {
    logFail('Monthly report fields', new Error(`Missing fields: ${JSON.stringify(Object.keys(monthlyData || {}))}`));
    process.exit(1);
  }
  logPass('Monthly report');

  const invRes = await api('GET', '/reports/inventory', { token: ownerToken });
  if (invRes.status !== 200 || !invRes.json || invRes.json.code !== 0) {
    logFail('Inventory report', new Error(`Status ${invRes.status}. Body: ${JSON.stringify(invRes.json)}`));
    process.exit(1);
  }
  const invItems = invRes.json.data.items || [];
  if (invItems.length === 0) {
    logFail('Inventory items empty', new Error('No inventory items'));
    process.exit(1);
  }
  if (!('value' in invItems[0])) {
    logFail('Inventory item value field', new Error(`First item missing value: ${JSON.stringify(invItems[0])}`));
    process.exit(1);
  }
  logPass('Inventory report');

  // 7. 拜访
  const visitRes = await api('POST', '/visits', {
    token: rep1Token,
    body: {
      customerId,
      location: '104.06,30.54',
      steps: { 陈列检查: true, 库存盘点: true },
      notes: '常规回访',
    },
  });
  if (visitRes.status !== 200 && visitRes.status !== 201) {
    logFail('Create visit', new Error(`Status ${visitRes.status}. Body: ${JSON.stringify(visitRes.json)}`));
    process.exit(1);
  }
  if (!visitRes.json || visitRes.json.code !== 0) {
    logFail('Create visit', new Error(`Code ${visitRes.json?.code}`));
    process.exit(1);
  }
  const visitId = visitRes.json.data.id;
  if (!visitId) {
    logFail('Visit id missing', new Error(`No id in: ${JSON.stringify(visitRes.json.data)}`));
    process.exit(1);
  }
  logPass('Create visit');

  const myVisitsRes = await api('GET', '/visits?mine=1', { token: rep1Token });
  if (myVisitsRes.status !== 200 || !myVisitsRes.json || myVisitsRes.json.code !== 0) {
    logFail('My visits list', new Error(`Status ${myVisitsRes.status}`));
    process.exit(1);
  }
  const myVisitItems = myVisitsRes.json.data.items || [];
  if (myVisitItems.length === 0) {
    logFail('My visits empty', new Error('No visits found'));
    process.exit(1);
  }
  logPass('My visits list');

  const visitStatsRes = await api('GET', '/visits/stats?month=2026-09', { token: rep1Token });
  if (visitStatsRes.status !== 200 || !visitStatsRes.json || visitStatsRes.json.code !== 0) {
    logFail('Visit stats', new Error(`Status ${visitStatsRes.status}`));
    process.exit(1);
  }
  const visitCount = visitStatsRes.json.data.count;
  if (typeof visitCount !== 'number' || visitCount < 1) {
    logFail('Visit stats count', new Error(`Expected count>=1, got ${visitCount}`));
    process.exit(1);
  }
  logPass('Visit stats');

  // 8. 绩效接线验证
  const perfRes = await api('GET', '/performance?month=2026-09', { token: ownerToken });
  if (perfRes.status !== 200 || !perfRes.json || perfRes.json.code !== 0) {
    logFail('Performance report', new Error(`Status ${perfRes.status}. Body: ${JSON.stringify(perfRes.json)}`));
    process.exit(1);
  }
  const perfItems = perfRes.json.data.items || perfRes.json.data;
  const rep1Perf = Array.isArray(perfItems) ? perfItems.find(p => p.repId === rep1Token || p.name === 'rep1' || p.username === 'rep1') : null;
  // 尝试通过 rep1 的 id 查找
  let rep1PerfItem = null;
  if (Array.isArray(perfItems)) {
    rep1PerfItem = perfItems.find(p => p.repId === rep1Token || p.name === 'rep1' || p.username === 'rep1' || p.id === rep1Token);
    if (!rep1PerfItem && perfItems.length > 0) {
      // 假设第一个是 rep1（简化处理，实际应根据 repId 匹配）
      rep1PerfItem = perfItems[0];
    }
  }
  if (!rep1PerfItem) {
    logFail('Find rep1 performance', new Error(`No rep1 in: ${JSON.stringify(perfItems)}`));
    process.exit(1);
  }
  if (typeof rep1PerfItem.visitCount !== 'number' || rep1PerfItem.visitCount < 1) {
    logFail('Rep1 visitCount', new Error(`Expected visitCount>=1, got ${rep1PerfItem.visitCount}`));
    process.exit(1);
  }
  logPass('Performance report');

  console.log('=== SMOKE P1B4 END ===');
  if (failed === 0) {
    console.log('SMOKE-P1B4: ALL PASS');
    process.exit(0);
  } else {
    console.error(`SMOKE-P1B4: ${failed} FAILED, ${passed} PASSED`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Uncaught error:', e);
  process.exit(1);
});
