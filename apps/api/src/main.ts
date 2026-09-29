import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { tenantContext } from './prisma/tenant-context';
import type { Request, Response, NextFunction } from 'express';

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
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
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
