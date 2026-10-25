/**
 * Jest 入口。pnpm 会把 `pnpm test -- --ci --forceExit` 里的 `--` 原样传进来，
 * Jest 把 `--` 之后的参数当成用例名，于是一条都匹配不到。这里丢掉前导 `--` 再交给 Jest。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
while (args[0] === '--') args.shift();

const jestBin = require.resolve('jest/bin/jest');
const result = spawnSync(process.execPath, [jestBin, ...args], {
  stdio: 'inherit',
  env: process.env,
  cwd: path.join(__dirname, '..'),
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
