import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/current-user.decorator';

// P0-03 要求③: 资金/库存写接口幂等键统一基座
//   - 客户端生成 Idempotency-Key 头; 服务端 (tenantId, key) 唯一索引兜底
//   - 同 key 重试: 请求指纹一致 → 回放首次响应(不双写); 指纹不一致 → 409
//   - endpoint 入指纹: 同 key 跨端点复用=参数冲突, 防串用
//   - 记录落 IdempotencyRecord(append-only 只 INSERT, 与审计/流水同规约)
// 各模块原内联 findUnique+create 逐步收编到本服务; 已收编端点见调用点注释
export class IdempotencyResult {
  /** true=重放(返回首次响应, 业务不再执行) */
  readonly replay: boolean;
  /** 首次(或重放)的响应摘要 */
  readonly summary?: unknown;
  constructor(replay: boolean, summary?: unknown) {
    this.replay = replay;
    this.summary = summary;
  }
}

/** 递归稳定序列化: 对象键序无关, 数组保序, 与 JSON 往返一致 → 跨请求同参同指纹 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /** 请求指纹(静态, 供调用方在业务事务内自行落库时复用同一算法): endpoint + 稳定参数序列化 */
  static requestHash(endpoint: string, payload: Record<string, unknown>): string {
    return createHash('sha256').update(`${endpoint}␟${stableStringify(payload)}`).digest('hex');
  }

  /**
   * 幂等检查(业务写之前调):
   * 返回 {replay:true, summary} = 重放, 调用方直接返回 summary;
   * 返回 null = 新请求, 调用方执行业务, 成功后调 complete() 落记录。
   */
  async check(user: Pick<AuthUser, 'id' | 'tenantId'>, endpoint: string, idemKey: string, payload: Record<string, unknown>): Promise<IdempotencyResult | null> {
    if (!idemKey) return null; // 强制校验由路由层/调用方保证(各资金接口已 BadRequest)
    const h = IdempotencyService.requestHash(endpoint, payload);
    const dup = await this.prisma.idempotencyRecord.findUnique({ where: { tenantId_key: { tenantId: user.tenantId, key: idemKey } } });
    if (!dup) return null;
    if (dup.requestHash !== h) {
      // 兼容: 0923 前的内联记录用旧格式哈希(非 sha256), 无法比对 → 视同同请求回放(不双写)
      const legacy = !/^[a-f0-9]{64}$/.test(dup.requestHash);
      if (!legacy) {
        throw new ConflictException(`Idempotency-Key ${idemKey} 已被不同参数的请求使用(${endpoint}), 防串用拒绝(P0-03)`);
      }
    }
    return new IdempotencyResult(true, dup.responseSummary);
  }

  /** 业务成功后落幂等记录(与业务同事务时传 tx) */
  async complete(user: Pick<AuthUser, 'id' | 'tenantId'>, endpoint: string, idemKey: string, payload: Record<string, unknown>, responseSummary: unknown, tx?: PrismaService): Promise<void> {
    if (!idemKey) return;
    const db = tx ?? this.prisma;
    const h = IdempotencyService.requestHash(endpoint, payload);
    try {
      await db.idempotencyRecord.create({
        data: {
          tenantId: user.tenantId,
          key: idemKey,
          endpoint,
          requestHash: h,
          responseSummary: responseSummary as never,
          createdBy: user.id,
        },
      });
    } catch (e) {
      // 并发竞态: 唯一索引撞车 = 另一请求已落同一 key+hash → 视同成功(幂等语义)
      if ((e as { code?: string })?.code === 'P2002') return;
      throw e;
    }
  }
}
