// 在测试文件 import Prisma 之前把 API 连接改成 liquor_app。
// 口令只活在本进程, 不写仓库、不打印。表主连接留在 MIGRATE_DATABASE_URL, 用来跑授权脚本。
const { randomBytes } = require('node:crypto');

const ownerUrl = process.env.DATABASE_URL;
if (!ownerUrl) {
  throw new Error('e2e 需要已 source 的 DATABASE_URL(表主), 见 apps/api/.env');
}
if (!process.env.MIGRATE_DATABASE_URL) process.env.MIGRATE_DATABASE_URL = ownerUrl;

const password = randomBytes(18).toString('hex');
if (!/^[0-9a-f]+$/.test(password)) throw new Error('e2e 口令生成失败');
process.env.E2E_APP_PASSWORD = password;

const url = new URL(ownerUrl);
url.username = 'liquor_app';
url.password = password;
url.searchParams.set('connection_limit', '5');
process.env.DATABASE_URL = url.toString();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  process.env.JWT_SECRET = 'local-dev-jwt-secret-not-for-production';
}
