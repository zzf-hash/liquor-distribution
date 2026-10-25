import { BadRequestException, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, AuditAction } from '../../audit/audit.service';
import { NotifyService } from '../../common/notify.service';
import { rlsBypassContext, tenantContext } from '../../prisma/tenant-context';
import { loginThrottle, loginUserKey, type LoginPenalty } from './login-throttle';

/** cost 10, 与 seed / 创建用户的 bcrypt.hashSync(..., 10) 一致。明文不是任何账号的口令。 */
export const DUMMY_PASSWORD_HASH = '$2a$10$7Tx.KcmDiKd4ysRI2aVqY.xh7Y6RgceDzn3WzQasYp2iBA3YgzDY.';

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
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Optional() private readonly notify?: NotifyService,
  ) {}

  async login(username: string, password: string, ip?: string, tenantCode?: string): Promise<LoginResult> {
    const code = tenantCode?.trim() || undefined;
    const userKey = loginUserKey(code, username);
    // 唯一约束是 (tenantId, username)。带编码按 tenantId_username;
    // 不带编码时仅当用户名全局唯一才放行。多个租户撞名则要求补编码, 不猜其中一个。
    const located = await this.findLoginUser(username, code);
    const user = located.user;
    // 没有真实哈希时也做一次 cost 10 的 compare, 避免用响应时间区分「用户不存在 / 没设口令 / 租户不存在」。
    const hash = user?.passwordHash || DUMMY_PASSWORD_HASH;
    const compared = await bcrypt.compare(password, hash);
    const passwordOk = Boolean(user?.passwordHash) && compared;
    const disabled = Boolean(user && passwordOk && user.status === 'DISABLED');
    if (located.ambiguous) {
      // 文案保留。这次也计入按用户名的失败次数, 否则撞名探测可以绕过变慢。
      const penalty = loginThrottle.noteFailure(userKey, ip);
      await this.penalize(penalty, username, ip);
      this.logger.warn(`登录失败(用户名跨租户) username=${username} ip=${ip ?? '-'}`);
      throw new BadRequestException('该用户名存在于多个租户, 请填写租户编码');
    }
    // 找不到用户、口令错误、账号已禁用: 同一条 401, 同一套延迟。
    // 延迟只看失败次数, 不看口令对错, 变慢之后两边的响应时间仍然一致。
    // 真实原因只进审计(after.reason=DISABLED)。已签发令牌的禁用检查仍在 AuthGuard。
    if (!user || !passwordOk || disabled) {
      const penalty = loginThrottle.noteFailure(userKey, ip);
      await this.penalize(penalty, username, ip);
      const tid = user?.tenantId ?? located.tenantId;
      if (!tid) {
        this.logger.warn(`登录失败无法写入审计 username=${username} tenantCode=${code ?? '-'} ip=${ip ?? '-'}`);
      } else {
        await this.auditLoginFail(username, ip, user, tid, disabled ? 'DISABLED' : undefined);
      }
      throw new UnauthorizedException('用户名或密码错误');
    }
    loginThrottle.clearUser(userKey);

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

  private async penalize(penalty: LoginPenalty, username: string, ip?: string): Promise<void> {
    if (penalty.alertUser) {
      this.logger.error(`登录失败超过阈值, 开始延迟而不锁定 username=${username} ip=${ip ?? '-'} count=${penalty.userCount}`);
      await this.notify?.send('登录失败过多', [
        `username=${username}`,
        `ip=${ip ?? '-'}`,
        `count=${penalty.userCount}`,
        '已改为逐步延迟, 不锁定账号',
      ]).catch(() => false);
    }
    if (penalty.alertIp) {
      this.logger.warn(`同一 IP 登录失败过多(只告警, 不拦截) ip=${ip ?? '-'} count=${penalty.ipCount}`);
      await this.notify?.send('同一 IP 登录失败过多', [
        `ip=${ip ?? '-'}`,
        `count=${penalty.ipCount}`,
        '未拦截请求',
      ]).catch(() => false);
    }
    if (penalty.delayMs > 0) await loginThrottle.sleep(penalty.delayMs);
  }

  private async auditLoginFail(
    username: string,
    ip: string | undefined,
    user: { id: string; tenantId: string; username: string; role: string } | null,
    tenantId: string | null,
    reason?: string,
  ): Promise<void> {
    // 没有租户就没有可挂的 AuditLog(tenantId 外键)。有用户必须写真实 id, 空串会撞 userId 外键。
    const tid = user?.tenantId ?? tenantId;
    if (!tid) return;
    await this.audit.log({
      user: { id: user?.id ?? '', tenantId: tid, username: user?.username ?? username, role: user?.role ?? '-' },
      action: AuditAction.LOGIN_FAIL, entityType: 'User', entityId: user?.id, ip,
      after: reason ? { reason } : undefined,
    });
  }

  private async findLoginUser(username: string, tenantCode?: string): Promise<{
    user: Awaited<ReturnType<PrismaService['user']['findUnique']>>;
    tenantId: string | null;
    ambiguous?: boolean;
  }> {
    if (tenantCode) {
      const tenant = await this.prisma.tenant.findUnique({ where: { code: tenantCode } });
      if (!tenant) return { user: null, tenantId: null };
      // 回调必须是 async: Prisma 查询是惰性的, 同步 return 出去后 ALS 已退出, 扩展层读不到租户。
      const user = await tenantContext.run({ tenantId: tenant.id }, async () => this.prisma.user.findUnique({
        where: { tenantId_username: { tenantId: tenant.id, username } },
      }));
      return { user, tenantId: tenant.id };
    }
    // 跨租户数用户名: 此时还没有租户, 必须显式 bypass, 否则 FORCE RLS 下非超级用户读不到 User。
    const matches = await rlsBypassContext.run(true, async () => this.prisma.user.findMany({ where: { username } }));
    if (matches.length === 1) return { user: matches[0], tenantId: matches[0].tenantId };
    if (matches.length === 0) return { user: null, tenantId: null };
    return { user: null, tenantId: null, ambiguous: true };
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
