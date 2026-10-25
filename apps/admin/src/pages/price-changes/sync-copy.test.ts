import { describe, expect, it } from 'vitest';
import { customerSyncLabel } from './sync-copy';

describe('customerSyncLabel', () => {
  it('reports how many customer prices moved', () => {
    expect(customerSyncLabel({ customerSync: true, customerSyncResult: { customers: 3 } })).toBe('已平移 3 个客户的专属价');
  });

  it('says 不联动 when sync is off and does not claim prices stay unchanged', () => {
    expect(customerSyncLabel({ customerSync: false, customerSyncResult: null })).toBe('不联动');
  });
});
