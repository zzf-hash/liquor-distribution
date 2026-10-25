import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, AuditAction } from '../../audit/audit.service';
import { rlsBypassContext, tenantContext } from '../../prisma/tenant-context';

export interface LoginResult {
  token: string;
  user: { id: string; username: string; name: string; role: string; dataScope: string };
}

// 登录限流(2026-10 审查修复: 原无任何爆破防护)。内存滑动窗口按 ip+用户名计数,
// 15 分钟内失败 ≥10 次拒绝; 单实例部署够用, 多实例应换 Redis 集中计数。
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const loginFails = new Map<string, { count: number; firstAt: number }>();

function pruneLoginFails(): void {
  if (loginFails.size < 5000) return;
  const now = Date.now();
  for (const [k, v] of loginFails) {
    if (now - v.firstAt >= LOGIN_WINDOW_MS) loginFails.delete(k);
  }
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

  async login(username: string, password: string, ip?: string, tenantCode?: string): Promise<LoginResult> {
    const code = tenantCode?.trim() || undefined;
    const limitKey = `${ip ?? '-'}|${code ?? '-'}|${username}`;
    pruneLoginFails();
    const hits = loginFails.get(limitKey);
    if (hits && hits.count >= LOGIN_MAX_FAILS && Date.now() - hits.firstAt < LOGIN_WINDOW_MS) {
      throw new HttpException('登录尝试次数过多, 请 15 分钟后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
    // 唯一约束是 (tenantId, username), 不能用不带排序的 findFirst: 同名账号会互相遮挡。
    // 带租户编码 → tenantId_username。不带编码时仅当用户名全局唯一才放行(旧客户端兼容);
    // 多个租户撞名则要求补编码, 不猜其中一个。
    const located = await this.findLoginUser(username, code);
    const user = located.user;
    // 先对口令。禁用账号配错口令也回「用户名或密码错误」, 避免用文案确认账号存在。
    // 口令正确但已禁用才回「账号已禁用」: 调用方已经证明知道口令, 需要知道为什么进不去,
    // 这次不计入口令失败次数(不是猜口令)。
    const passwordOk = Boolean(user?.passwordHash) && await bcrypt.compare(password, user!.passwordHash!);
    if (!user || !passwordOk) {
      const cur = loginFails.get(limitKey);
      if (!cur || Date.now() - cur.firstAt >= LOGIN_WINDOW_MS) loginFails.set(limitKey, { count: 1, firstAt: Date.now() });
      else cur.count += 1;
      await this.auditLoginFail(username, ip, user, located.tenantId);
      throw new UnauthorizedException('用户名或密码错误');
    }
    if (user.status === 'DISABLED') {
      await this.audit.log({
        user: { id: user.id, tenantId: user.tenantId, username: user.username, role: user.role },
        action: AuditAction.LOGIN_FAIL, entityType: 'User', entityId: user.id, ip,
        after: { reason: 'DISABLED' },
      });
      throw new UnauthorizedException('账号已禁用');
    }
    loginFails.delete(limitKey); // 成功登录清零失败计数

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

  private async auditLoginFail(
    username: string,
    ip: string | undefined,
    user: { id: string; tenantId: string; username: string; role: string } | null,
    tenantId: string | null,
  ): Promise<void> {
    // 没有租户就没有可挂的 AuditLog(tenantId 外键)。有用户必须写真实 id, 空串会撞 userId 外键。
    const tid = user?.tenantId ?? tenantId;
    if (!tid) return;
    await this.audit.log({
      user: { id: user?.id ?? '', tenantId: tid, username: user?.username ?? username, role: user?.role ?? '-' },
      action: AuditAction.LOGIN_FAIL, entityType: 'User', entityId: user?.id, ip,
    });
  }

  private async findLoginUser(username: string, tenantCode?: string): Promise<{
    user: Awaited<ReturnType<PrismaService['user']['findUnique']>>;
    tenantId: string | null;
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
    throw new BadRequestException('该用户名存在于多个租户, 请填写租户编码');
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
