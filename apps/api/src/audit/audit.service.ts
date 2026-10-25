import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { rawClient } from '../prisma/prisma.service';
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
    const rows = await rawClient.$transaction(async (tx) => {
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
    const { Prisma } = await import('@prisma/client');
    await rawClient.$transaction(
      async (tx) => {
        // rawClient 不走扩展层, 这里自行把租户放进本事务, 否则 FORCE RLS 下非超级用户插不进 AuditLog。
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${entry.user.tenantId}, true)`;
        // 链尾加锁, 防并发分叉 (FOR UPDATE)
        // 列名必须与 schema 一致: 本仓 Prisma 用 camelCase 映射且不设 @map,
        // PG 物理列是 "rowHash"/"tenantId"/"createdAt"(与 0_init 迁移一致)。
        // 0929 实锤: 此前写 snake_case 导致 42703 column "row_hash" does not exist,
        // 每次 audit 追加失败被 log() 吞掉 → 审计链从不落库(B2 失效)。
        const tail: Array<{ rowHash: string }> = await tx.$queryRaw(
          Prisma.sql`SELECT "rowHash" FROM "AuditLog"
                     WHERE "tenantId" = ${entry.user.tenantId}
                     ORDER BY "createdAt" DESC, id DESC LIMIT 1 FOR UPDATE`,
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
          .update(prev + '␟' + stableStringify(payload))
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
    return createHash('sha256').update(prev + '␟' + stableStringify(payload)).digest('hex');
  }
}
