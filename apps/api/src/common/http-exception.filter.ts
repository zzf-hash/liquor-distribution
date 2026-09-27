import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

// 失败统一 {code, message}: code = HTTP 状态码; 409=状态机非法转换, 403=越权, 401=认证, 422=业务预检拦截
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : String((body as Record<string, unknown>).message ?? exception.message);
      void res.status(exception.getStatus()).json({ code: exception.getStatus(), message });
      return;
    }
    this.logger.error('unhandled', exception instanceof Error ? exception.stack : String(exception));
    void res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ code: 500, message: '服务内部错误' });
  }
}
