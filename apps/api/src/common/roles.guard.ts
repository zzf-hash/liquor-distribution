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
    if (!required || required.length === 0) return true;
    const user: AuthUser | undefined = context.switchToHttp().getRequest().user;
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
