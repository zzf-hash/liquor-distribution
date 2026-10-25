import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ApiCodes } from '@liquor/shared';
import type { Response } from 'express';
import { joinExceptionMessage } from './validation-message';

// 失败统一 {code, message}，422 预检另附受控 data（不含堆栈）。
// code = HTTP 状态码; 409=状态机非法转换, 403=越权, 401=认证, 422=业务预检拦截
// 语义码常量来自 @liquor/shared.ApiCodes(三端共享同一套码值)
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const rawMessage = typeof body === 'string' ? body : (body as { message?: unknown }).message;
      const message = joinExceptionMessage(rawMessage, exception.message);
      const payload: { code: number; message: string; data?: unknown } = { code: status, message };
      const data = status === HttpStatus.UNPROCESSABLE_ENTITY ? controlledData(body) : undefined;
      if (data !== undefined) payload.data = data;
      void res.status(status).json(payload);
      return;
    }
    this.logger.error('unhandled', exception instanceof Error ? exception.stack : String(exception));
    void res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ code: ApiCodes.Server, message: '服务内部错误' });
  }
}

/** 只回传业务方显式放进 HttpException body.data 的对象，不把 Error/堆栈带出去。 */
function controlledData(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('data' in body)) return undefined;
  const data = (body as { data?: unknown }).data;
  if (data === undefined || data === null || data instanceof Error) return undefined;
  return data;
}
