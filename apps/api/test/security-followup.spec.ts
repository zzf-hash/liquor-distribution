import { createServer } from 'node:http';
import path from 'node:path';
import { ExpressAdapter } from '@nestjs/platform-express';
import { assessDbRole } from '../src/prisma/db-role-check';
import { IP_ALERT_THRESHOLD, LOGIN_FAIL_THRESHOLD, loginDelayMs, LoginThrottle } from '../src/modules/auth/login-throttle';

// express is not hoisted. Load the copy nested next to @nestjs/platform-express,
// which Jest can resolve. A bare `from 'express'` fails once the full suite is loaded.
const nestEntry = Object.keys(require.cache).find((id) => id.includes(`${path.sep}@nestjs${path.sep}platform-express${path.sep}`));
if (!nestEntry) throw new Error('platform-express module path missing');
const nestModules = path.resolve(nestEntry.slice(0, nestEntry.indexOf(`${path.sep}@nestjs${path.sep}platform-express${path.sep}`)));
const express = require(path.join(nestModules, 'express')) as typeof import('express');
const expressEntry = Object.keys(require.cache).find((id) => id.endsWith(`${path.sep}express${path.sep}index.js`));
if (!expressEntry) throw new Error('express module path missing');
const proxyaddr = require(path.join(path.dirname(expressEntry), '..', 'proxy-addr')) as {
  compile: (value: string | string[]) => (addr: string, i: number) => boolean;
};
void ExpressAdapter;

describe('登录变慢 / 角色自检 / trust proxy', () => {
  it('超过阈值后延迟从 1 秒走到 3 秒, 不把次数变成拒绝', () => {
    expect(loginDelayMs(LOGIN_FAIL_THRESHOLD)).toBe(0);
    expect(loginDelayMs(LOGIN_FAIL_THRESHOLD + 1)).toBe(1000);
    expect(loginDelayMs(LOGIN_FAIL_THRESHOLD + 2)).toBe(1200);
    expect(loginDelayMs(100)).toBe(3000);
  });

  it('按 IP 的计数只标记告警, 不产生延迟', () => {
    const throttle = new LoginThrottle();
    let lastDelay = -1;
    let alertIp = false;
    for (let i = 0; i < IP_ALERT_THRESHOLD + 1; i += 1) {
      const penalty = throttle.noteFailure(`user-${i}`, '203.0.113.10');
      lastDelay = penalty.delayMs;
      alertIp = alertIp || penalty.alertIp;
    }
    expect(lastDelay).toBe(0);
    expect(alertIp).toBe(true);
    const again = throttle.noteFailure('user-extra', '203.0.113.10');
    expect(again.alertIp).toBe(false);
    expect(again.delayMs).toBe(0);
  });

  it('数据库角色: 超级用户或表主都不通过, liquor_app 形态通过', () => {
    expect(assessDbRole({ rolsuper: false, rolbypassrls: false }, []).ok).toBe(true);
    expect(assessDbRole({ rolsuper: true, rolbypassrls: false }, []).reasons.join(' ')).toContain('rolsuper');
    expect(assessDbRole({ rolsuper: false, rolbypassrls: true }, []).reasons.join(' ')).toContain('rolbypassrls');
    expect(assessDbRole({ rolsuper: false, rolbypassrls: false }, ['User']).ok).toBe(false);
    expect(assessDbRole(undefined, []).ok).toBe(false);
  });

  it('trust proxy 只信任回环和私网, 不信任公网地址', async () => {
    const trust = proxyaddr.compile(['loopback', 'uniquelocal']);
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('::1', 0)).toBe(true);
    expect(trust('10.1.2.3', 0)).toBe(true);
    expect(trust('172.18.0.4', 0)).toBe(true);
    expect(trust('192.168.1.9', 0)).toBe(true);
    expect(trust('8.8.8.8', 0)).toBe(false);
    expect(trust('203.0.113.9', 0)).toBe(false);

    const app = express();
    app.set('trust proxy', ['loopback', 'uniquelocal']);
    app.get('/', (req, res) => { res.json({ ip: req.ip }); });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
      expect(await res.json()).toEqual({ ip: '203.0.113.9' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
