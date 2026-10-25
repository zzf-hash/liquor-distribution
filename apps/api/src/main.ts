import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { buildCorsOptions } from './common/cors';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { tenantContext } from './prisma/tenant-context';
import type { Request, Response, NextFunction } from 'express';

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

// B5 租户上下文中间件: 从 JWT 解出 tenantId, als.run 包裹下游整条链(守卫enterWith在部分环境不传播——
// 实测生产 salesOrder.create 丢store报 "Argument tenant is missing", 此处为正解; 仅解码不验签,
// 真鉴权仍在 AuthGuard(DB级校验), 注入层只负责防漏写)
function tenantContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header: string | undefined = req.headers?.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payloadPart = header.slice(7).split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf-8')) as { tenantId?: string };
      if (payload.tenantId) {
        tenantContext.run({ tenantId: payload.tenantId }, next);
        return;
      }
    } catch {
      // 解码失败走原链, 由 AuthGuard 兜底 401
    }
  }
  next();
}

// 部署契约: 入口 dist/main.js, 监听 PORT 环境变量 (deploy/docker-compose.yml)
async function bootstrap(): Promise<void> {
  // bodyParser 自管: 签收页 canvas 签名/拍照凭证以 base64 dataURL 内联(M8-3, 对象存储未接前的过渡方案),
  // Nest 默认 100kb 会 413; 放宽到 6mb 仅影响 JSON 解析上限, 各端点仍有字段级校验
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'], bodyParser: false });
  // 预检要先于 body parser。来源只来自白名单，见 common/cors.ts（CORS_ORIGINS）。
  app.enableCors(buildCorsOptions());
  app.use(json({ limit: '6mb' }));
  app.use(urlencoded({ extended: true, limit: '6mb' }));
  app.use(tenantContextMiddleware); // 必须在路由前注册(先于守卫建立store)
  app.setGlobalPrefix('api'); // 统一 /api 前缀 (nginx 反代约定)
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`api listening on :${port}`);
}
void bootstrap();
