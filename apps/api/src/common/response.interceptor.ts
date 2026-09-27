import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

// API 约定: 成功 {code:0, data}, 失败 {code, message} (见 http-exception.filter)
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, { code: number; data: T }> {
  intercept(_ctx: ExecutionContext, next: CallHandler<T>): Observable<{ code: number; data: T }> {
    return next.handle().pipe(map((data) => ({ code: 0, data })));
  }
}
