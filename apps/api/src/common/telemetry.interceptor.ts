import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { TelemetryService } from './telemetry.service';
import type { Request, Response } from 'express';

/**
 * TelemetryInterceptor: 全量请求埋点。
 * - 每请求落一行: method/path/status/耗时
 * - level: 2xx=info, 4xx=warn, 5xx=error; 慢请求(>1s)至少 warn
 * - 静态资源与遥测自身上报路径跳过, 防自激
 */
const SLOW_MS = 1000;

@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  constructor(private readonly telemetry: TelemetryService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const started = Date.now();
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request & { user?: { id?: string; role?: string } }>();
    const res = http.getResponse<Response>();
    const path = req.originalUrl?.split('?')[0] ?? '';
    if (path.startsWith('/telemetry') || path.startsWith('/api/telemetry') || path === '/api/health' || path === '/health') {
      return next.handle();
    }
    return next.handle().pipe(
      tap({
        next: () => this.write(req, res.statusCode, started, path),
        error: (err: unknown) => {
          const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status: number }).status) : 500;
          this.write(req, status, started, path);
        },
      }),
    );
  }

  private write(req: Request & { user?: { id?: string; role?: string } }, status: number, started: number, path: string): void {
    const durationMs = Date.now() - started;
    const level = status >= 500 || (status === 0 && durationMs > SLOW_MS) ? 'error' : status >= 400 || durationMs > SLOW_MS ? 'warn' : 'info';
    this.telemetry.record({
      source: 'api',
      kind: 'request',
      name: `request_${req.method}_${path}`,
      level,
      path,
      method: req.method,
      status,
      durationMs,
      userId: req.user?.id,
      role: req.user?.role,
      detail: { ua: req.headers?.['user-agent']?.slice(0, 200) },
    });
  }
}
