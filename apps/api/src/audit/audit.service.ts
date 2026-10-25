import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { rawClient } from '../prisma/prisma.service';
import { NotifyService } from '../common/notify.service';
import type { AuthUser } from '../common/current-user.decorator';

/**
 * 递归稳定序列化(键序无关, 数组保序): 与 idempotency.service 同算法。
 * 0929 实锤: before/after 是 JSONB, PG 落库时会按「键长/字典序」重排 object 键,
 * 而 JSON.stringify 保持插入序 → 写入时哈希用的串 与 读取时(键被重排)重算的串不同,
 * 导致 verifyChain 对「键序被 JSONB 重排」的行误判断链(B2 校验自失效)。
 * 统一用本函数的规范化串算哈希 → 写/读两端一致, 链校验才可靠。
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

// B2: 审计流水 DB 层 append-only + 每租户哈希链
//   - 应用层: 本服务只 INSERT; PrismaService 禁 update/delete; DB 层 REVOKE(见 migration)
//   - 哈希链: rowHash = sha256(prevRowHash ‖ tenantId ‖ action ‖ entityType ‖ entityId ‖ before ‖ after ‖ ts)
//     userId 不进哈希。系统任务写 null 与历史行(有 userId)同一套算法, verifyChain 不用分支。
//     prevRowHash 取链尾。并发用 pg_advisory_xact_lock(按租户), 不锁行:
//     AuditLog 对业务账号 REVOKE 了 UPDATE, FOR UPDATE 会 42501。
//     改任一历史行都会使后续校验失败 → 内部人改库可检测
// 红线动作(P0-T03 枚举, 安全评审§3.1 清单): 全部走这里留痕
export const AuditAction = {
  LOGIN: 'LOGIN',
  LOGIN_FAIL: 'LOGIN_FAIL',
  MASTER_UPDATE: 'MASTER_UPDATE', // 主数据变更(含改价 F7 落点)
  PRICE_CHANGE: 'PRICE_CHANGE', // 改价执行
  CUSTOMER_ONBOARDING: 'CUSTOMER_ONBOARDING',
  CREDIT_RELEASE: 'CREDIT_RELEASE', // 信用拦截放行(特批)
  SPECIAL_APPROVE: 'SPECIAL_APPROVE', // 特单/价格特批
  PRECHECK_BLOCK: 'PRECHECK_BLOCK', // 审单预检拦截留痕
  ORDER_CREATE: 'ORDER_CREATE',
  ORDER_GIFT_MANUAL: 'ORDER_GIFT_MANUAL', // 手工赠品参考价超过阈值（只记审计，不拦截）
  ORDER_CONFIRM: 'ORDER_CONFIRM',
  ORDER_DELIVER: 'ORDER_DELIVER',
  ORDER_MODIFY: 'ORDER_MODIFY', // 红字冲销
  ORDER_CANCEL: 'ORDER_CANCEL',
  OUTBOUND_CONFIRM: 'OUTBOUND_CONFIRM', // 出库(影响库存)
  SIGN: 'SIGN', // 签收
  REJECT: 'REJECT', // 拒收/状态回滚
  SETTLE: 'SETTLE', // 收款销账
  PAYMENT_CONFIRM: 'PAYMENT_CONFIRM',
  PAYMENT_REVERSE: 'PAYMENT_REVERSE', // 收款冲正(只准红字新单)
  WAIVE_APPROVE: 'WAIVE_APPROVE', // 抹零审批生效(§D7, 老板; 核减应收走 WAIVE 流水)
  BAD_DEBT_WRITEOFF: 'BAD_DEBT_WRITEOFF', // 坏账核销(§D7, 老板; WRITEOFF 流水)
  STOCK_CORRECT: 'STOCK_CORRECT', // 出入库修正/盘点差异调账(P1-T07, 差异走红字不直改余额 B4)
  RETURN_QTY_CHANGE: 'RETURN_QTY_CHANGE', // 退货数量变更(R4 只增方向; 减少方向 4xx 拒绝也留痕)
  STOCKTAKE_ADJUST: 'STOCKTAKE_ADJUST', // 盘点调账(仓管盘+内勤核对)
  IMPORT_PREVIEW: 'IMPORT_PREVIEW',
  IMPORT_COMMIT: 'IMPORT_COMMIT', // 期初迁移批改
  IMPORT_ROLLBACK: 'IMPORT_ROLLBACK',
  USER_DISABLE: 'USER_DISABLE',
  TOKEN_REVOKE: 'TOKEN_REVOKE', // B1 吊销
} as const;
export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  user: Pick<AuthUser, 'id' | 'tenantId' | 'username' | 'role'> | { id: string; tenantId: string; username: string; role: string };
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  channel?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');
  private db: PrismaClient = rawClient;

  constructor(@Optional() private readonly notify?: NotifyService) {}

  /** 测试注入业务角色连接。生产用 rawClient(应用 DATABASE_URL)。 */
  bindClient(client: PrismaClient): this {
    this.db = client;
    return this;
  }

  /**
   * 记审计。失败不让业务请求失败: 多数调用点在单据事务提交之后, 再抛错会让客户端重试并产生重复单据;
   * 登录此时也已经签发令牌。失败必须留下 error 日志, 并走飞书告警(未配置时 NotifyService 返回 false, 日志仍在)。
   * 缺口由 verifyChain / 对账发现。
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.append(entry);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `audit append failed: action=${entry.action} tenant=${entry.user.tenantId} entity=${entry.entityType}:${entry.entityId ?? ''} ${message.slice(0, 400)}`,
      );
      if (!this.notify) return;
      try {
        await this.notify.send('审计写入失败', [
          `action=${entry.action}`,
          `tenant=${entry.user.tenantId}`,
          `user=${entry.user.username}`,
          `entity=${entry.entityType}:${entry.entityId ?? ''}`,
          message.slice(0, 300),
        ]);
      } catch (alertErr) {
        this.logger.error(`audit alert failed: ${String(alertErr).slice(0, 200)}`);
      }
    }
  }

  /** 哈希链校验: 重放全链验证 rowHash 连续性(每日对账 job / 人工核查用) */
  async verifyChain(tenantId: string): Promise<{ ok: boolean; brokenAt?: string }> {
    const rows = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.auditLog.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });
    let prev = 'GENESIS';
    for (const r of rows) {
      const expect = this.hash(prev, r);
      if (expect !== r.rowHash) return { ok: false, brokenAt: r.id };
      prev = r.rowHash;
    }
    return { ok: true };
  }

  private async append(entry: AuditEntry): Promise<void> {
    const tenantId = entry.user.tenantId;
    // userId 外键指向 User。空串(还不知道是谁)和定时任务的 id='system'(表里没有这行)都写成 null,
    // username 原样保留(系统任务是 'system')。列在 0_init 里已是可空 TEXT, 不必再迁移。
    // null 不进 rowHash(见 hash), 插在已有链中间也不会让后续校验失败。
    const userId = entry.user.id && entry.user.id !== 'system' ? entry.user.id : null;
    // 只认定时任务的 id。用户名碰巧叫 system 的登录失败不能记成 SYSTEM/cron。
    const systemActor = entry.user.id === 'system';
    const role = systemActor ? 'SYSTEM' : String(entry.user.role);
    const channel = entry.channel ?? (systemActor ? 'cron' : 'web');
    await this.db.$transaction(async (tx) => {
      // rawClient 不走扩展层, 这里自行把租户放进本事务, 否则 FORCE RLS 下非超级用户插不进 AuditLog。
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      // 按租户串行化链尾。pg_advisory_xact_lock 返回 void, $queryRaw 会报不支持 void;
      // $executeRaw 只执行。锁在事务结束时释放, 不需要 AuditLog 的 UPDATE 权限。
      // 列名必须与 schema 一致: 本仓 Prisma 用 camelCase 映射且不设 @map,
      // PG 物理列是 "rowHash"/"tenantId"/"createdAt"(与 0_init 迁移一致)。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), 0)`;
      const tail = await tx.$queryRaw<Array<{ rowHash: string }>>(
        Prisma.sql`SELECT "rowHash" FROM "AuditLog"
                   WHERE "tenantId" = ${tenantId}
                   ORDER BY "createdAt" DESC, id DESC LIMIT 1`,
      );
      const prev = tail[0]?.rowHash ?? 'GENESIS';
      const now = new Date();
      const payload = {
        tenantId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? '',
        before: entry.before ?? null,
        after: entry.after ?? null,
        ts: now.toISOString(),
      };
      const rowHash = createHash('sha256')
        .update(prev + '␟' + stableStringify(payload))
        .digest('hex');
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          username: entry.user.username,
          role,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          before: (entry.before ?? undefined) as never,
          after: (entry.after ?? undefined) as never,
          ip: entry.ip,
          channel,
          prevRowHash: prev,
          rowHash,
          createdAt: now,
        },
      });
    });
  }

  private hash(prev: string, r: { tenantId: string; action: string; entityType: string; entityId: string | null; before: unknown; after: unknown; createdAt: Date }): string {
    const payload = {
      tenantId: r.tenantId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId ?? '',
      before: r.before ?? null,
      after: r.after ?? null,
      ts: r.createdAt.toISOString(),
    };
    return createHash('sha256').update(prev + '␟' + stableStringify(payload)).digest('hex');
  }
}
