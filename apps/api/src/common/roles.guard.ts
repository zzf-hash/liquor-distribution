import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from './current-user.decorator';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: AuthUser['role'][]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles) as MethodDecorator & ClassDecorator;

// P0-02 RBAC: 接口守卫用 role(能力面), 行范围由 service 按 dataScope 过滤(安全评审 2.1 两张正交表)
// P1-1: staff 信道接口对 customer token 一律 403
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AuthUser['role'][]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const user: AuthUser | undefined = context.switchToHttp().getRequest().user;
    // 2026-10 安全审查(P1): 无 @Roles 元数据的路由原先无条件放行(fail-open), CUSTOMER token 可达
    // telemetry/summary、health/notify-status 等内勤接口。信道分离原则(P1-1): 客户信道必须显式
    // 声明 @Roles('CUSTOMER'), 未声明路由一律对 customer aud 关闭; staff 信道维持放行(auth/me、logout 等自身操作)。
    if (!required || required.length === 0) {
      if (user?.aud === 'customer') throw new ForbiddenException('客户身份不可调用内勤接口');
      return true;
    }
    if (!user) return false;
    if (user.aud === 'customer' && !required.includes('CUSTOMER')) {
      throw new ForbiddenException('客户身份不可调用内勤接口');
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenException('当前角色无权限执行该操作');
    }
    return true;
  }
}
