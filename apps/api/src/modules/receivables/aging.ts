import type { PrismaService } from '../../prisma/prisma.service';

// ═══════════════ 账龄分档（M9-3, Q1 已确认口径） ═══════════════
// 档位租户级可配（SystemConfig key=aging_buckets, 数值型商户可否决）, 默认 30/50/90 天。
// bucket 语义（以默认值为例）: b1=(0,30] b2=(30,50] b3=(50,90] b4=(90,∞);
// 档位键是稳定 id, 展示文案由前后端按配置动态生成——改档位不改代码。

export type AgingBucket = 'not_due' | 'b1' | 'b2' | 'b3' | 'b4' | 'disputed';

export interface AgingConfig {
  b1: number; // 第一档上限(天)
  b2: number; // 第二档上限(天)
  b3: number; // 第三档上限(天)
}

/** Q1 已确认(2026-09-19): 30/50/90, 原文档"3/5/910"系编辑丢失尾零 */
export const DEFAULT_AGING_CONFIG: AgingConfig = { b1: 30, b2: 50, b3: 90 };

export const AGING_CONFIG_KEY = 'aging_buckets';

export function normalizeAgingConfig(raw: unknown): AgingConfig {
  const v = (raw ?? {}) as Partial<Record<keyof AgingConfig, unknown>>;
  const num = (x: unknown, dflt: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.floor(x) : dflt);
  const cfg: AgingConfig = {
    b1: num(v.b1, DEFAULT_AGING_CONFIG.b1),
    b2: num(v.b2, DEFAULT_AGING_CONFIG.b2),
    b3: num(v.b3, DEFAULT_AGING_CONFIG.b3),
  };
  if (!(cfg.b1 >= 1 && cfg.b2 > cfg.b1 && cfg.b3 > cfg.b2 && cfg.b3 <= 365)) return { ...DEFAULT_AGING_CONFIG };
  return cfg;
}

/** 兼容 seed/存量配置的 {v:{...}} 数值型包装与裸对象两种写法 */
export async function readAgingConfig(prisma: PrismaService, tenantId: string): Promise<AgingConfig> {
  const row = await prisma.systemConfig.findFirst({ where: { tenantId, key: AGING_CONFIG_KEY } });
  if (!row) return { ...DEFAULT_AGING_CONFIG };
  const value = row.value as { v?: unknown } | unknown;
  return normalizeAgingConfig((value as { v?: unknown })?.v ?? value);
}

/** 逾期天数 → 档位（争议款单列 D11） */
export function bucketOfDays(daysOverdue: number, cfg: AgingConfig): AgingBucket {
  if (daysOverdue <= 0) return 'not_due';
  if (daysOverdue <= cfg.b1) return 'b1';
  if (daysOverdue <= cfg.b2) return 'b2';
  if (daysOverdue <= cfg.b3) return 'b3';
  return 'b4';
}

/** 档位展示文案（前后端共用口径：档位键 + 配置 → label） */
export function agingBucketLabels(cfg: AgingConfig): Record<AgingBucket, string> {
  return {
    not_due: '未到期',
    b1: `逾期1-${cfg.b1}天`,
    b2: `逾期${cfg.b1 + 1}-${cfg.b2}天`,
    b3: `逾期${cfg.b2 + 1}-${cfg.b3}天`,
    b4: `逾期${cfg.b3}天以上`,
    disputed: '争议',
  };
}

/** B4 统一开账口径(与 ReceivablesService.arOpen 同式): settled/open 从流水投影 */
export function arOpenOf(
  total: number,
  ledger: Array<{ direction: string; amount: unknown; paymentId: string | null }>,
): { settled: number; open: number } {
  let settled = 0; let reversalNoPay = 0; let waived = 0; let writtenOff = 0; let returnCredit = 0;
  for (const l of ledger) {
    const amt = Number(l.amount);
    if (l.direction === 'SETTLE' || l.direction === 'REBATE_OFFSET') settled += amt;
    else if (l.direction === 'WAIVE') waived += amt;
    else if (l.direction === 'WRITEOFF') writtenOff += amt;
    else if (l.direction === 'RETURN_CREDIT') returnCredit += amt;
    else if (l.direction === 'REVERSAL') { if (l.paymentId) settled -= amt; else reversalNoPay += amt; }
  }
  return { settled, open: Math.max(0, total - settled - waived - writtenOff - returnCredit - reversalNoPay) };
}
