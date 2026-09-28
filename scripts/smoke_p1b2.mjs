#!/usr/bin/env node
// scripts/smoke-p1b2.mjs
// Zero-dependency Node ESM smoke test for P1B2 flows.
// Usage: SMOKE_BASE=http://127.0.0.1:3000/api node scripts/smoke-p1b2.mjs

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

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

async function api(method, path, { token, body, idemKey } = {}) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (idemKey) headers['Idempotency-Key'] = idemKey;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  // Standard envelope: { code: 0, data: ... }
  if (json.code !== 0) {
    const err = new Error(`API Error: code=${json.code}, msg=${json.message || json.msg || 'unknown'}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json.data;
}

async function login(username, password) {
  const data = await api('POST', '/auth/login', { body: { username, password } });
  return data.token;
}

async function run() {
  const steps = [];

  // Step 1: Login
  steps.push(async () => {
    const ownerToken = await login('owner', 'demo1234');
    const clerkToken = await login('clerk', 'demo1234');
    const warehouseToken = await login('warehouse', 'demo1234');
    assert(ownerToken, 'owner token missing');
    assert(clerkToken, 'clerk token missing');
    assert(warehouseToken, 'warehouse token missing');
    return { ownerToken, clerkToken, warehouseToken };
  });

  // Step 2: Price Change Chain - Create
  steps.push(async (ctx) => {
    const { clerkToken } = ctx;
    const products = await api('GET', '/products?q=茅台', { token: clerkToken });
    const product = Array.isArray(products) ? products[0] : products;
    assert(product && product.id, 'Product not found for 茅台');
    const productId = product.id;

    const priceChange = await api('POST', '/price-changes', {
      token: clerkToken,
      body: {
        productId,
        unit: 'BASE',
        levelType: 'TERMINAL',
        newPrice: 3380,
        effectiveDate: '2026-12-01',
        reason: '旺季调价'
      }
    });

    assert(priceChange.id, 'priceChange.id missing');
    assert(priceChange.status === 'DRAFT', `Expected DRAFT, got ${priceChange.status}`);
    assert(priceChange.stockImpact && typeof priceChange.stockImpact.onHandQty === 'number', 'stockImpact.onHandQty missing');

    ctx.productId = productId;
    ctx.priceChangeId = priceChange.id;
  });

  // Step 3: Submit & Approve
  steps.push(async (ctx) => {
    const { clerkToken, ownerToken } = ctx;
    const submitted = await api('POST', `/price-changes/${ctx.priceChangeId}/submit`, { token: clerkToken });
    assert(submitted.status === 'PENDING', `Expected PENDING, got ${submitted.status}`);

    const approvals = await api('GET', '/approvals?status=PENDING', { token: ownerToken });
    const approval = Array.isArray(approvals) ? approvals.find(a => a.entityType === 'PRICE_CHANGE' && a.entityId === ctx.priceChangeId) : null;
    assert(approval, 'Pending approval for PRICE_CHANGE not found');

    await api('POST', `/approvals/${approval.id}/approve`, { token: ownerToken });
  });

  // Step 4: Effectuate
  steps.push(async (ctx) => {
    const { clerkToken } = ctx;
    const effected = await api('POST', `/price-changes/${ctx.priceChangeId}/effectuate`, { token: clerkToken });
    assert(effected.status === 'EFFECTIVE', `Expected EFFECTIVE, got ${effected.status}`);

    const prices = await api('GET', `/products/${ctx.productId}/prices`, { token: clerkToken });
    const priceList = Array.isArray(prices) ? prices : prices.items || [];
    const newPrice = priceList.find(p => p.validFrom === '2026-12-01' && p.levelType === 'TERMINAL');
    assert(newPrice, 'New TERMINAL price with validFrom=2026-12-01 not found');
  });

  // Step 5: Idempotency Check
  steps.push(async (ctx) => {
    const { clerkToken } = ctx;
    try {
      await api('POST', `/price-changes/${ctx.priceChangeId}/effectuate`, { token: clerkToken });
      throw new Error('Expected 409 error but request succeeded');
    } catch (err) {
      assert(err.status === 409, `Expected 409, got ${err.status}`);
      assert(err.message.includes('409') || err.body?.code === 409 || err.message.includes('conflict') || err.message.includes('already'), `Error message should indicate conflict: ${err.message}`);
    }
  });

  // Step 6: Package In (Standalone)
  steps.push(async (ctx) => {
    const { clerkToken } = ctx;
    const customers = await api('GET', '/customers?q=C0001', { token: clerkToken });
    const customer = Array.isArray(customers) ? customers[0] : customers;
    assert(customer && customer.id, 'Customer C0001 not found');
    ctx.customerId = customer.id;

    const idemKey = `smoke-pkg-in-${Date.now()}`;
    const pkg = await api('POST', '/packages', {
      token: clerkToken,
      idemKey,
      body: {
        customerId: ctx.customerId,
        category: '周转箱',
        qty: 10,
        type: 'STANDALONE'
      }
    });

    assert(pkg.depositPaid > 0, `Expected depositPaid > 0, got ${pkg.depositPaid}`);

    const summary = await api('GET', '/packages/summary', { token: clerkToken });
    const items = summary.items || [];
    const boxItem = items.find(i => i.category === '周转箱');
    assert(boxItem, '周转箱 not found in package summary');
  });

  // Step 7: Package Out (Deposit Return)
  steps.push(async (ctx) => {
    const { clerkToken } = ctx;
    const summaryBefore = await api('GET', '/packages/summary', { token: clerkToken });
    const depositBefore = summaryBefore.depositBalance || 0;

    const idemKey = `smoke-pkg-out-${Date.now()}`;
    await api('POST', '/packages', {
      token: clerkToken,
      idemKey,
      body: {
        customerId: ctx.customerId,
        category: '周转箱',
        qty: 4,
        type: 'OUT'
      }
    });

    const summaryAfter = await api('GET', '/packages/summary', { token: clerkToken });
    const depositAfter = summaryAfter.depositBalance || 0;
    assert(depositAfter < depositBefore, `Expected deposit balance to decrease. Before: ${depositBefore}, After: ${depositAfter}`);
  });

  // Step 8: Purchase Create (Postpaid)
  steps.push(async (ctx) => {
    const { clerkToken } = ctx;
    const purchase = await api('POST', '/purchases', {
      token: clerkToken,
      body: {
        supplier: '测试供应商',
        type: 'POSTPAID',
        lines: [
          {
            productId: ctx.productId,
            batchNo: 'CG-20261201',
            qty: 60,
            unitCost: 100
          }
        ]
      }
    });

    assert(purchase.purNo, 'purNo missing');
    assert(purchase.status === 'DRAFT', `Expected DRAFT, got ${purchase.status}`);
    ctx.purchaseId = purchase.id;
  });

  // Step 9: Purchase Submit & Approve
  steps.push(async (ctx) => {
    const { clerkToken, ownerToken } = ctx;
    const submitted = await api('POST', `/purchases/${ctx.purchaseId}/submit`, { token: clerkToken });
    assert(submitted.status === 'PENDING', `Expected PENDING, got ${submitted.status}`);

    const approvals = await api('GET', '/approvals?status=PENDING', { token: ownerToken });
    const approval = Array.isArray(approvals) ? approvals.find(a => a.entityType === 'PURCHASE' && a.entityId === ctx.purchaseId) : null;
    assert(approval, 'Pending approval for PURCHASE not found');

    await api('POST', `/approvals/${approval.id}/approve`, { token: ownerToken });

    const updated = await api('GET', `/purchases/${ctx.purchaseId}`, { token: clerkToken });
    assert(updated.status === 'APPROVED', `Expected APPROVED, got ${updated.status}`);
  });

  // Step 10: Postpaid Receive (Allowed)
  steps.push(async (ctx) => {
    const { clerkToken, ownerToken } = ctx;
    const received = await api('POST', `/purchases/${ctx.purchaseId}/receive`, { token: clerkToken });
    assert(received.status === 'RECEIVED', `Expected RECEIVED, got ${received.status}`);

    const dashboard = await api('GET', '/dashboard/four-questions', { token: ownerToken });
    const lowStock = dashboard.lowStock || [];
    const item = lowStock.find(i => i.productId === ctx.productId);
    assert(item, 'Product not found in lowStock list');
    assert(item.available >= 60, `Expected available >= 60, got ${item.available}`);
  });

  // Step 11: Postpaid Pay
  steps.push(async (ctx) => {
    const { clerkToken } = ctx;
    const paid = await api('POST', `/purchases/${ctx.purchaseId}/pay`, { token: clerkToken });
    assert(paid.status === 'PAID', `Expected PAID, got ${paid.status}`);
  });

  // Step 12: Prepaid Order Sequence Gate
  steps.push(async (ctx) => {
    const { clerkToken, ownerToken } = ctx;

    // Create Prepaid Purchase
    const purchase = await api('POST', '/purchases', {
      token: clerkToken,
      body: {
        supplier: '测试供应商',
        type: 'PREPAID',
        lines: [
          {
            productId: ctx.productId,
            batchNo: 'CG-20261202',
            qty: 10,
            unitCost: 100
          }
        ]
      }
    });
    ctx.prepaidPurchaseId = purchase.id;

    // Submit
    await api('POST', `/purchases/${ctx.prepaidPurchaseId}/submit`, { token: clerkToken });

    // Approve
    const approvals = await api('GET', '/approvals?status=PENDING', { token: ownerToken });
    const approval = Array.isArray(approvals) ? approvals.find(a => a.entityType === 'PURCHASE' && a.entityId === ctx.prepaidPurchaseId) : null;
    assert(approval, 'Pending approval for PREPAID PURCHASE not found');
    await api('POST', `/approvals/${approval.id}/approve`, { token: ownerToken });

    // Try to receive before paying -> Expect 409
    try {
      await api('POST', `/purchases/${ctx.prepaidPurchaseId}/receive`, { token: clerkToken });
      throw new Error('Expected 409 error but request succeeded');
    } catch (err) {
      assert(err.status === 409, `Expected 409, got ${err.status}`);
    }

    // Pay
    const paid = await api('POST', `/purchases/${ctx.prepaidPurchaseId}/pay`, { token: clerkToken });
    assert(paid.status === 'PAID', `Expected PAID, got ${paid.status}`);

    // Receive after paying
    const received = await api('POST', `/purchases/${ctx.prepaidPurchaseId}/receive`, { token: clerkToken });
    assert(received.status === 'RECEIVED', `Expected RECEIVED, got ${received.status}`);
  });

  // Execute steps sequentially
  const ctx = {};
  for (let i = 0; i < steps.length; i++) {
    const stepName = `Step ${i + 1}`;
    try {
      await steps[i](ctx);
      logPass(stepName);
    } catch (err) {
      logFail(stepName, err);
      // If a critical step fails, we might want to stop, but for smoke tests,
      // continuing to see all failures is often better. However, if ctx is missing,
      // subsequent steps will fail. We'll continue but they will likely fail.
    }
  }

  if (failCount === 0) {
    console.log('SMOKE-P1B2: ALL PASS');
    process.exit(0);
  } else {
    console.log(`SMOKE-P1B2: ${failCount} FAILED`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
