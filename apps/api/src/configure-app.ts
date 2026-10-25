import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { tenantContext } from './prisma/tenant-context';

// B5 租户上下文中间件: 从 JWT 解出 tenantId, als.run 包裹下游整条链(守卫 enterWith 在部分环境不传播)。
// 仅解码不验签, 真鉴权仍在 AuthGuard。P7(未验签 JWT 当作租户上下文)留作后续。
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

/** 与生产入口相同的 HTTP 装配。e2e 复用这里, 避免 import main.ts 触发 listen。 */
export function configureApp(app: NestExpressApplication): void {
  // 只信任回环和私网这一跳(nginx / 本机代理)。公网直连伪造的 X-Forwarded-For 不采用。
  // proxy-addr 2.x 不拆逗号字符串, 必须传数组。
  app.set('trust proxy', ['loopback', 'uniquelocal']);
  app.use(json({ limit: '6mb' }));
  app.use(urlencoded({ extended: true, limit: '6mb' }));
  app.use(tenantContextMiddleware);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }));
  app.useGlobalFilters(new HttpExceptionFilter());
}
