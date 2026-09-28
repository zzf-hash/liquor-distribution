import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const assert = require('assert');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PASSWORD = 'demo1234';

let passed = 0;
let failed = 0;

function logPass(msg) {
  console.log(`[PASS] ${msg}`);
  passed++;
}

function logFail(msg, err) {
  console.error(`[FAIL] ${msg}`, err);
  failed++;
}

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    // ignore json parse error
  }
  
  return { status: res.status, data };
}

async function login(username) {
  const res = await api('POST', '/auth/login', null, { username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status}`);
  return res.data.token;
}

async function main() {
  try {
    // 1. Login
    const clerkToken = await login('clerk');
    const ownerToken = await login('owner');
    const rep1Token = await login('rep1');
    const warehouseToken = await login('warehouse');
    logPass('1. Login all users');

    // 2. Create Special Order
    const soBody = {
      title: '测试宴席单',
      customerName: '测试客户',
      isBanquet: true,
      contactName: '张三',
      contactPhone: '13800000000',
      address: '测试路1号',
      lines: [{ productName: '测试白酒', unit: '箱', qty: 2, price: 1000 }]
    };
    const soRes = await api('POST', '/special-orders', rep1Token, soBody);
    if (soRes.status !== 201 && soRes.status !== 200) throw new Error(`Create SO failed: ${soRes.status}`);
    const soId = soRes.data.id;
    if (soRes.data.status !== 'DRAFT') throw new Error(`SO status not DRAFT: ${soRes.data.status}`);
    logPass('2. Create Special Order (DRAFT)');

    // 3. Submit for Approval
    const submitRes = await api('POST', `/special-orders/${soId}/submit`, rep1Token);
    if (submitRes.status !== 200) throw new Error(`Submit SO failed: ${submitRes.status}`);
    if (submitRes.data.status !== 'PENDING_PRICE') throw new Error(`SO status not PENDING_PRICE: ${submitRes.data.status}`);
    logPass('3. Submit Special Order (PENDING_PRICE)');

    // 4. Get Approval Todo
    const apprRes = await api('GET', '/approvals?status=PENDING', ownerToken);
    if (apprRes.status !== 200) throw new Error(`Get approvals failed: ${apprRes.status}`);
    const items = apprRes.data.items || [];
    const soApproval = items.find(i => i.entityType === 'SPECIAL_ORDER' && i.entityId === soId);
    if (!soApproval) throw new Error('Special Order approval not found in pending list');
    const approvalId = soApproval.id;
    logPass('4. Found Special Order Approval Todo');

    // 5. Unauthorized Approval (Clerk)
    const unauthorizedRes = await api('POST', `/approvals/${approvalId}/decide`, clerkToken, { action: 'approve', opinion: 'ok' });
    if (unauthorizedRes.status !== 403) throw new Error(`Expected 403 for clerk approval, got ${unauthorizedRes.status}`);
    logPass('5. Clerk Unauthorized Approval Blocked (403)');

    // 6. Owner Approves
    const approveRes = await api('POST', `/approvals/${approvalId}/decide`, ownerToken, { action: 'approve', opinion: 'ok' });
    if (approveRes.status !== 200) throw new Error(`Owner approval failed: ${approveRes.status}`);
    if (approveRes.data.approved !== true) throw new Error('Approval response missing approved=true');
    
    const soCheckRes = await api('GET', `/special-orders/${soId}`, rep1Token);
    if (soCheckRes.data.status !== 'APPROVED') throw new Error(`SO status not APPROVED: ${soCheckRes.data.status}`);
    logPass('6. Owner Approved Special Order');

    // 7. Convert to Formal Order
    const convertRes = await api('POST', `/special-orders/${soId}/convert`, clerkToken);
    if (convertRes.status !== 200 && convertRes.status !== 201) throw new Error(`Convert SO failed: ${convertRes.status}`);
    const orderId = convertRes.data.orderId;
    const orderNo = convertRes.data.orderNo;
    if (!orderId || !orderNo) throw new Error('Convert response missing orderId/orderNo');
    logPass('7. Converted Special Order to Formal Order');

    // 8. State Gate: Direct Convert of DRAFT
    const so2Body = {
      title: '测试宴席单2',
      customerName: '测试客户2',
      isBanquet: true,
      contactName: '李四',
      contactPhone: '13900000000',
      address: '测试路2号',
      lines: [{ productName: '测试红酒', unit: '瓶', qty: 1, price: 500 }]
    };
    const so2Res = await api('POST', '/special-orders', rep1Token, so2Body);
    const so2Id = so2Res.data.id;
    const gateRes = await api('POST', `/special-orders/${so2Id}/convert`, clerkToken);
    if (gateRes.status !== 409) throw new Error(`Expected 409 for direct convert of DRAFT, got ${gateRes.status}`);
    logPass('8. State Gate: Direct Convert of DRAFT Blocked (409)');

    // 9. Return Chain
    // Confirm
    const confirmRes = await api('POST', `/orders/${orderId}/confirm`, clerkToken);
    if (confirmRes.status !== 200) throw new Error(`Confirm order failed: ${confirmRes.status}`);
    
    // Outbound
    const outboundRes = await api('POST', `/orders/${orderId}/outbound`, warehouseToken);
    if (outboundRes.status !== 200) throw new Error(`Outbound failed: ${outboundRes.status}`);
    
    // Confirm Outbound (Idempotent)
    const idemKey = `idem-${Date.now()}`;
    const confirmOutRes = await api('POST', `/orders/${orderId}/confirm-outbound`, warehouseToken, { idemKey });
    if (confirmOutRes.status !== 200) throw new Error(`Confirm outbound failed: ${confirmOutRes.status}`);
    
    // Deliver
    const deliverRes = await api('POST', `/orders/${orderId}/deliver`, warehouseToken);
    if (deliverRes.status !== 200) throw new Error(`Deliver failed: ${deliverRes.status}`);
    
    // Sign
    const signRes = await api('POST', `/orders/${orderId}/sign`, clerkToken);
    if (signRes.status !== 200) throw new Error(`Sign failed: ${signRes.status}`);
    
    // Get Order Lines to find lineId
    const orderDetailRes = await api('GET', `/orders/${orderId}`, clerkToken);
    const lines = orderDetailRes.data.lines || [];
    if (lines.length === 0) throw new Error('No lines found in order');
    const orderLineId = lines[0].id;
    
    // Create Return
    const returnBody = {
      sourceOrderId: orderId,
      reason: '破损',
      lines: [{ orderLineId, qty: 1 }]
    };
    const returnRes = await api('POST', '/returns', clerkToken, returnBody);
    if (returnRes.status !== 201 && returnRes.status !== 200) throw new Error(`Create return failed: ${returnRes.status}`);
    const returnId = returnRes.data.id;
    if (returnRes.data.status !== 'PENDING_REVIEW') throw new Error(`Return status not PENDING_REVIEW: ${returnRes.data.status}`);
    logPass('9. Created Return (PENDING_REVIEW)');

    // 10. Owner Approves Return
    const returnApprRes = await api('GET', '/approvals?status=PENDING', ownerToken);
    const returnItems = returnApprRes.data.items || [];
    const returnApproval = returnItems.find(i => i.entityType === 'RETURN' && i.entityId === returnId);
    if (!returnApproval) throw new Error('Return approval not found');
    
    const returnApproveRes = await api('POST', `/approvals/${returnApproval.id}/decide`, ownerToken, { action: 'approve', opinion: 'ok' });
    if (returnApproveRes.status !== 200) throw new Error(`Approve return failed: ${returnApproveRes.status}`);
    
    const returnCheckRes = await api('GET', `/returns/${returnId}`, clerkToken);
    if (returnCheckRes.data.status !== 'APPROVED') throw new Error(`Return status not APPROVED: ${returnCheckRes.data.status}`);
    logPass('10. Owner Approved Return');

    // 11. Receive Return (Reverse Stock/AR)
    const receiveRes = await api('POST', `/returns/${returnId}/receive`, warehouseToken);
    if (receiveRes.status !== 200) throw new Error(`Receive return failed: ${receiveRes.status}`);
    if (receiveRes.data.status !== 'RECEIVED') throw new Error(`Return status not RECEIVED: ${receiveRes.data.status}`);
    if (receiveRes.data.arCredit <= 0) throw new Error(`arCredit not > 0: ${receiveRes.data.arCredit}`);
    logPass('11. Received Return (AR Credit > 0)');

    // 12. 24h Expiry Check (Mock)
    const finalApprRes = await api('GET', '/approvals', ownerToken);
    if (finalApprRes.status !== 200) throw new Error('Final approval check failed');
    logPass('12. Approval Endpoint Exists');

    if (failed === 0) {
      console.log('SMOKE-P1: ALL PASS');
      process.exit(0);
    } else {
      console.error(`SMOKE-P1: ${failed} FAILURES`);
      process.exit(1);
    }

  } catch (err) {
    logFail('Unexpected Error', err);
    process.exit(1);
  }
}

main();
