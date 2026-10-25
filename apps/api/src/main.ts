import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

// 本地 dev 的 .env 加载(项目未用 @nestjs/config, 此前 JWT_SECRET 静默回退硬编码才"能用";
// auth.module 已 fail-fast, 缺它本地起不来)。已存在的环境变量不覆盖(docker 部署以真实 env 为准)。
function loadDotEnv(): void {
  try {
    const file = path.join(process.cwd(), '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/^['"]|['"]$/g, '');
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* .env 读取失败不阻断启动, 由各模块自身的校验兜底 */ }
}
loadDotEnv();

// 部署契约: 入口 dist/main.js, 监听 PORT 环境变量 (deploy/docker-compose.yml)
async function bootstrap(): Promise<void> {
  // bodyParser 自管: 签收页 canvas 签名/拍照凭证以 base64 dataURL 内联(M8-3, 对象存储未接前的过渡方案),
  // Nest 默认 100kb 会 413; 放宽到 6mb 仅影响 JSON 解析上限, 各端点仍有字段级校验
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'], bodyParser: false });
  configureApp(app);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`api listening on :${port}`);
}
void bootstrap();
