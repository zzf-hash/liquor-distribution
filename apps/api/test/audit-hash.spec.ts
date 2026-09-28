/**
 * P0-03 单测: 审计哈希链的键序规范化
 * 根因(0929 实锤): before/after 是 JSONB, PG 落库会把 object 键按「键长/字典序」重排,
 * 而 JSON.stringify 保持插入序 → 写入哈希用的串 与 读取重算的串不同,
 * verifyChain 会对「键序被重排」的行误判断链(B2 校验自失效)。
 * 修复: 哈希用 stableStringify(键序无关) → 写/读两端一致。
 * 本测试锁住这一不变量: 同一对象的任意键序 → 同一规范化串 → 同一 rowHash。
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../src/audit/audit.service';

// 复刻 audit.service.ts 的 rowHash 算法(仅用 stableStringify 的规范化串)
function rowHash(prev: string, payload: Record<string, unknown>): string {
  return createHash('sha256').update(prev + '␟' + stableStringify(payload)).digest('hex');
}

describe('stableStringify(审计哈希规范化)', () => {
  it('对象键序无关: 不同插入序 → 同一串', () => {
    const a = stableStringify({ qty: 6, status: 'CONFIRMED' });
    const b = stableStringify({ status: 'CONFIRMED', qty: 6 });
    expect(a).toBe(b);
    expect(a).toBe('{"qty":6,"status":"CONFIRMED"}'); // 排序后 qty < status
  });

  it('JSONB 重排键序后 hash 不变(根因守卫)', () => {
    // 写入时 JS 插入序 {status,qty}; JSONB 落库后读出为 {qty,status}
    const written = rowHash('GENESIS', { qty: 6, status: 'CONFIRMED', reason: 'x' });
    const readBack = rowHash('GENESIS', { reason: 'x', status: 'CONFIRMED', qty: 6 });
    expect(written).toBe(readBack);
  });

  it('嵌套对象/数组保序且键序无关', () => {
    const a = stableStringify({ list: [{ b: 1, a: 2 }], obj: { y: 1, x: { z: 3, a: 1 } } });
    const b = stableStringify({ obj: { x: { a: 1, z: 3 }, y: 1 }, list: [{ a: 2, b: 1 }] });
    expect(a).toBe(b);
  });

  it('null/undefined/基础类型稳定', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify(5)).toBe('5');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify([1, 2, { b: 1, a: 2 }])).toBe('[1,2,{"a":2,"b":1}]');
  });

  it('内容不同 → 串不同(篡改可被检出)', () => {
    const h1 = rowHash('GENESIS', { due: 3050, status: 'OPEN' });
    const h2 = rowHash('GENESIS', { due: 0, status: 'SETTLED' });
    expect(h1).not.toBe(h2);
  });

  it('不同 prev → 不同 rowHash(链式)', () => {
    expect(rowHash('GENESIS', { a: 1 })).not.toBe(rowHash('prevX', { a: 1 }));
  });
});
