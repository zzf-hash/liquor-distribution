import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { rawClient } from '../prisma/prisma.service';
import type { AuthUser } from '../common/current-user.decorator';

// B2: 审计流水 DB 层 append-only + 每租户哈希链
//   - 应用层: 本服务只 INSERT; PrismaService 禁 update/delete; DB 层 REVOKE(见 migration)
//   - 哈希链: rowHash = sha256(prevRowHash ‖ tenantId ‖ action ‖ entityType ‖ entityId ‖ before ‖ after ‖ ts)
//     prevRowHash 取链尾(FOR UPDATE 防并发分叉); 改任一历史行都会使后续校验失败 → 内部人改库可检测
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

  /** 记审计(不阻断业务: 审计自身失败仅告警——写入失败时业务已提交, 由对账 job 兜底) */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.append(entry);
    } catch (e) {
      this.logger.error(`audit append failed: ${String(e).slice(0, 200)}`);
    }
  }

  /** 哈希链校验: 重放全链验证 rowHash 连续性(每日对账 job / 人工核查用) */
  async verifyChain(tenantId: string): Promise<{ ok: boolean; brokenAt?: string }> {
    const rows = await rawClient.auditLog.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
    const { Prisma } = await import('@prisma/client');
    await rawClient.$transaction(
      async (tx) => {
        // 链尾加锁, 防并发分叉 (FOR UPDATE)
        const tail: Array<{ rowHash: string }> = await tx.$queryRaw(
          Prisma.sql`SELECT row_hash AS "rowHash" FROM "AuditLog"
                     WHERE tenant_id = ${entry.user.tenantId}
                     ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`,
        );
        const prev = tail[0]?.rowHash ?? 'GENESIS';
        const now = new Date();
        const payload = {
          tenantId: entry.user.tenantId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? '',
          before: entry.before ?? null,
          after: entry.after ?? null,
          ts: now.toISOString(),
        };
        const rowHash = createHash('sha256')
          .update(prev + '␟' + JSON.stringify(payload))
          .digest('hex');
        await tx.auditLog.create({
          data: {
            tenantId: entry.user.tenantId,
            userId: entry.user.id,
            username: entry.user.username,
            role: String(entry.user.role),
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            before: (entry.before ?? undefined) as never,
            after: (entry.after ?? undefined) as never,
            ip: entry.ip,
            channel: entry.channel ?? 'web',
            prevRowHash: prev,
            rowHash,
            createdAt: now,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
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
    return createHash('sha256').update(prev + '␟' + JSON.stringify(payload)).digest('hex');
  }
}
