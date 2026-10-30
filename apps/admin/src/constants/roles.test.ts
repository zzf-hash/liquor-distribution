import { describe, expect, it } from 'vitest';
import { isAdminRole, routesForRole, shellEntry } from './roles';

describe('admin home for each role', () => {
  it('sends a rep to the first menu they can see', () => {
    expect(shellEntry('rep')).toEqual({ kind: 'home', path: '/special-orders' });
  });

  it('keeps owner, clerk and warehouse on the order pool', () => {
    expect(shellEntry('owner')).toEqual({ kind: 'home', path: '/orders' });
    expect(shellEntry('clerk')).toEqual({ kind: 'home', path: '/orders' });
    expect(shellEntry('warehouse')).toEqual({ kind: 'home', path: '/orders' });
  });

  it('does not treat a missing role as the owner', () => {
    expect(shellEntry(undefined)).toEqual({ kind: 'login' });
    expect(shellEntry(null)).toEqual({ kind: 'login' });
    expect(shellEntry('')).toEqual({ kind: 'login' });
  });

  it('puts customer management second for the owner and the clerk', () => {
    expect(routesForRole('owner').slice(0, 2).map((r) => r.path)).toEqual(['/orders', '/customers']);
    expect(routesForRole('clerk').slice(0, 2).map((r) => r.path)).toEqual(['/orders', '/customers']);
    expect(routesForRole('owner').find((r) => r.path === '/customers')?.name).toBe('客户管理');
    expect(routesForRole('owner').find((r) => r.path === '/master-data')?.name).toBe('商品与价格');
    expect(routesForRole('warehouse').some((r) => r.path === '/customers')).toBe(false);
    expect(routesForRole('rep').some((r) => r.path === '/customers')).toBe(false);
  });

  it('keeps a customer out of the admin', () => {
    expect(isAdminRole('customer')).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isAdminRole('rep')).toBe(true);
    expect(shellEntry('customer')).toEqual({ kind: 'denied' });
  });
});
