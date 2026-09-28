#!/usr/bin/env node
// scripts/smoke-mobile.mjs
// 零依赖 Node ESM 冒烟脚本：五角色移动端登录与核心动作
// 风格同 scripts/smoke.mjs: api(method, path, {token, body, idemKey}) -> {code:0, data}
// 期望失败用 try/catch 断言状态码

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000/api';

let passCount = 0;
let failCount = 0;

function logPass(msg) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

function logFail(msg, err) {
  console.error(`[FAIL] ${msg}`);
  if (err) console.error(`       Error: ${err.message || err}`);
  failCount++;
}

// 通用 API 调用封装
async function api(method, path, opts = {}) {
  const { token, body, idemKey } = opts;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (idemKey) headers['Idempotency-Key'] = idemKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  // 如果 HTTP 状态码非 2xx，抛出错误以便 try/catch 捕获
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  // 信封校验: {code: 0, data: ...}
  if (json.code !== 0) {
    const err = new Error(`API code ${json.code}: ${json.message || 'unknown'}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json.data;
}

// 断言辅助
function assert(cond, msg) {
  if (cond) {
    logPass(msg);
  } else {
    logFail(msg);
  }
}

// 期望失败断言
async function expectFail(promise, expectedStatus, msg) {
  try {
    await promise;
    logFail(`${msg} (expected ${expectedStatus}, but succeeded)`);
  } catch (err) {
    if (err.status === expectedStatus) {
      logPass(`${msg} (got ${err.status})`);
    } else {
      logFail(`${msg} (expected ${expectedStatus}, got ${err.status})`, err);
    }
  }
}

// 获取当月 YYYY-MM
function currentMonth() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function main() {
  console.log('=== SMOKE-MOBILE: 五角色移动端登录与核心动作 ===\n');

  // 1. 五角色各自登录
  const roles = [
    { username: 'owner', expectedRole: 'OWNER' },
    { username: 'clerk', expectedRole: 'CLERK' },
    { username: 'rep1', expectedRole: 'REP' },
    { username: 'warehouse', expectedRole: 'WAREHOUSE' },
    { username: 'cust-c0001', expectedRole: 'CUSTOMER' },
  ];

  const tokens = {};
  for (const r of roles) {
    try {
      const data = await api('POST', '/auth/login', {
        body: { username: r.username, password: 'demo1234' },
      });
      if (data.user && data.user.role === r.expectedRole) {
        tokens[r.username] = data.token || data.accessToken || data.jwt;
        logPass(`Login ${r.username} → role=${r.expectedRole}`);
      } else {
        logFail(`Login ${r.username} → expected role ${r.expectedRole}, got ${data.user?.role}`);
        tokens[r.username] = data.token || data.accessToken || data.jwt;
      }
    } catch (err) {
      logFail(`Login ${r.username} failed`, err);
      tokens[r.username] = null;
    }
  }

  const ownerToken = tokens['owner'];
  const clerkToken = tokens['clerk'];
  const rep1Token = tokens['rep1'];
  const warehouseToken = tokens['warehouse'];
  const custToken = tokens['cust-c0001'];

  // 2. 老板端
  try {
    const dash = await api('GET', '/dashboard/four-questions', { token: ownerToken });
    assert(dash && 'salesToday' in dash, 'Owner: GET /dashboard/four-questions → salesToday exists');
  } catch (err) {
    logFail('Owner: GET /dashboard/four-questions', err);
  }

  try {
    const approvals = await api('GET', '/approvals?status=PENDING', { token: ownerToken });
    assert(Array.isArray(approvals.items), 'Owner: GET /approvals?status=PENDING → items array');
  } catch (err) {
    logFail('Owner: GET /approvals?status=PENDING', err);
  }

  // 3. 内勤端
  try {
    const orders = await api('GET', '/orders?status=PENDING_CONFIRM', { token: clerkToken });
    assert(Array.isArray(orders.items), 'Clerk: GET /orders?status=PENDING_CONFIRM → items');
  } catch (err) {
    logFail('Clerk: GET /orders?status=PENDING_CONFIRM', err);
  }

  try {
    const receivables = await api('GET', '/receivables?bucket=not_due', { token: clerkToken });
    assert(Array.isArray(receivables.items), 'Clerk: GET /receivables?bucket=not_due → items');
  } catch (err) {
    logFail('Clerk: GET /receivables?bucket=not_due', err);
  }

  try {
    const payments = await api('GET', '/payments?status=REPORTED', { token: clerkToken });
    assert(Array.isArray(payments.items), 'Clerk: GET /payments?status=REPORTED → items');
  } catch (err) {
    logFail('Clerk: GET /payments?status=REPORTED', err);
  }

  // 4. 仓配端
  try {
    const outbounds = await api('GET', '/orders/outbounds?status=PICKING', { token: warehouseToken });
    assert(Array.isArray(outbounds.items), 'Warehouse: GET /orders/outbounds?status=PICKING → items array');
  } catch (err) {
    logFail('Warehouse: GET /orders/outbounds?status=PICKING', err);
  }

  // 5. 业务员端
  try {
    const customers = await api('GET', '/customers', { token: rep1Token });
    assert(Array.isArray(customers.items) && customers.items.length > 0, 'Rep1: GET /customers → items non-empty');
  } catch (err) {
    logFail('Rep1: GET /customers', err);
  }

  try {
    const perf = await api('GET', `/performance?month=${currentMonth()}`, { token: ownerToken });
    assert(Array.isArray(perf.items), 'Owner: GET /performance?month=<current> → items');
  } catch (err) {
    logFail('Owner: GET /performance', err);
  }

  // 6. 越权
  await expectFail(
    api('GET', '/dashboard/four-questions', { token: warehouseToken }),
    403,
    'Warehouse: GET /dashboard/four-questions → 403'
  );

  await expectFail(
    api('POST', '/payments', {
      token: custToken,
      body: { customerId: 'c0001', amount: 1, method: '现金' },
    }),
    403,
    'Customer: POST /payments → 403'
  );

  // 7. 客户端
  try {
    const products = await api('GET', '/shop/products', { token: custToken });
    assert(Array.isArray(products.items), 'Customer: GET /shop/products → items array');
  } catch (err) {
    logFail('Customer: GET /shop/products', err);
  }

  // 8. 真实动作一例
  // 先获取 rep1 的客户列表，取第一个客户 ID
  let repCustomerId = null;
  try {
    const custList = await api('GET', '/customers', { token: rep1Token });
    if (Array.isArray(custList.items) && custList.items.length > 0) {
      repCustomerId = custList.items[0].id || custList.items[0].customerId;
    }
  } catch (err) {
    logFail('Rep1: GET /customers for action', err);
  }

  if (repCustomerId) {
    const idemKey = `smoke-mobile-${Date.now()}`;
    let paymentId = null;
    try {
      const payData = await api('POST', '/payments', {
        token: rep1Token,
        body: { customerId: repCustomerId, amount: 1, method: '现金' },
        idemKey,
      });
      paymentId = payData.id || payData.paymentId;
      assert(payData.status === 'REPORTED', 'Rep1: POST /payments → status=REPORTED');
    } catch (err) {
      logFail('Rep1: POST /payments', err);
    }

    if (paymentId) {
      try {
        const confirmData = await api('POST', `/payments/${paymentId}/confirm`, {
          token: clerkToken,
        });
        assert(
          Array.isArray(confirmData.applied) && confirmData.applied.length >= 1,
          'Clerk: POST /payments/:id/confirm → applied array (FIFO 1元)'
        );
      } catch (err) {
        logFail('Clerk: POST /payments/:id/confirm', err);
      }
    }
  } else {
    logFail('No customer found for rep1, skipping real action');
  }

  // 总结
  console.log(`\n=== Summary: ${passCount} passed, ${failCount} failed ===`);
  if (failCount === 0) {
    console.log('SMOKE-MOBILE: ALL PASS');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
