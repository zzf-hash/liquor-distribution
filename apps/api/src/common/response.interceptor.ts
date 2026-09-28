import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import type { ApiResponse } from '@liquor/shared';

// API 约定: 成功 {code:0, data}, 失败 {code, message} (见 http-exception.filter)
// 外壳契约由 @liquor/shared 统一(三端共享), 此处仅复用其类型, 运行时零影响
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(_ctx: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    return next.handle().pipe(map((data) => ({ code: 0, data })));
  }
}
