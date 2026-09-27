import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../prisma/tenant-context';
import type { AuthUser } from './current-user.decorator';

// 全局 JWT 守卫: 每请求回库校验 token_version + 账号状态 (B1 即时吊销, ≤1 请求周期生效)
// 同时 enterWith 建立租户上下文(B5 第一层), 后续 PrismaService $extends 强制注入 tenantId
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    if (req.path === '/api/health' || req.path === '/api/auth/login') return true;
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('未登录');
    let payload: { sub: string; tv: number };
    try {
      payload = await this.jwt.verifyAsync(header.slice(7));
    } catch {
      throw new UnauthorizedException('令牌无效或已过期');
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('账号不存在');
    if (user.status === 'DISABLED') throw new UnauthorizedException('账号已禁用'); // B1
    if (user.tokenVersion !== payload.tv) throw new UnauthorizedException('令牌已失效, 请重新登录'); // B1
    tenantContext.enterWith({ tenantId: user.tenantId }); // B5
    req.user = {
      id: user.id,
      tenantId: user.tenantId,
      username: user.username,
      name: user.name,
      role: user.role,
      dataScope: user.dataScope,
      customerId: user.customerId ?? undefined,
      aud: user.role === 'CUSTOMER' ? 'customer' : 'staff', // P1-1 信道分离
    } satisfies AuthUser;
    return true;
  }
}
