import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, AuditAction } from '../../audit/audit.service';

export interface LoginResult {
  token: string;
  user: { id: string; username: string; name: string; role: string; dataScope: string };
}

// P0-02 认证: 五角色 JWT
//  - B1: payload 带 tv(token_version); 禁用/改密/改角色 bump → 旧 token 下一请求即 401
//  - P1-1: aud 声明区分 staff/customer 信道; 客户 token 调内勤接口一律 403(RolesGuard)
//  - P1-2: 一人 token 只签一个活动身份(切角色=重新登录, 服务端不并存)
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(username: string, password: string, ip?: string): Promise<LoginResult> {
    const user = await this.prisma.user.findFirst({ where: { username } });
    const fail = async (): Promise<never> => {
      await this.audit.log({
        user: { id: '', tenantId: user?.tenantId ?? 'UNKNOWN', username, role: '-' },
        action: AuditAction.LOGIN_FAIL, entityType: 'User', ip,
      });
      throw new UnauthorizedException('用户名或密码错误');
    };
    if (!user || !user.passwordHash) return fail();
    if (user.status === 'DISABLED') throw new UnauthorizedException('账号已禁用');
    if (!(await bcrypt.compare(password, user.passwordHash))) return fail();

    const token = await this.jwt.signAsync({
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      aud: user.role === 'CUSTOMER' ? 'customer' : 'staff',
      tv: user.tokenVersion,
    });
    await this.audit.log({
      user: { id: user.id, tenantId: user.tenantId, username: user.username, role: user.role },
      action: AuditAction.LOGIN, entityType: 'User', entityId: user.id, ip,
    });
    return {
      token,
      user: { id: user.id, username: user.username, name: user.name, role: user.role, dataScope: user.dataScope },
    };
  }

  /** B1: 吊销该用户全部令牌(登出/禁用/改密/改角色时调用) */
  async revokeTokens(userId: string, reason: string): Promise<void> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    await this.audit.log({
      user: { id: user.id, tenantId: user.tenantId, username: user.username, role: user.role },
      action: AuditAction.TOKEN_REVOKE, entityType: 'User', entityId: userId,
      after: { reason },
    });
  }
}
