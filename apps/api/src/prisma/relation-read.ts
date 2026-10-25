import { Logger, NotFoundException } from '@nestjs/common';

const logger = new Logger('TenantRead');

const READS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow']);

export function isHiddenRelationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Inconsistent query result');
}

function relationField(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /Field (\w+) is required/.exec(message)?.[1] ?? 'relation';
}

type Exec = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * 列表+count 不要放进 Prisma 批量事务。批量执行时, 必填关联被 RLS 滤掉的错误
 * 抛在 batch 层, 单条查询的回退接不到, 整页变成 500。逐条执行后每条查询自己回退。
 * 这些调用都是读, 列表和 total 差一条写入的窗口可以接受。写事务仍走 $transaction。
 */
export async function sequential<T extends unknown[]>(
  queries: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const out: unknown[] = [];
  for (const query of queries) out.push(await query);
  return out as T;
}

/**
 * 必填关联指向别的租户时, RLS 把关联行滤成 null, Prisma 对整次查询抛
 * Inconsistent query result, 列表接口变成 500。
 * 列表: 逐行重查, 关联仍不可见的行跳过并 warn。
 * 详情: 按不存在返回(null / 404), 调用方原有的 NotFound 文案保持不变。
 */
export async function readWithHiddenRelationFallback(
  model: string | undefined,
  operation: string,
  args: Record<string, unknown>,
  exec: Exec,
): Promise<unknown> {
  if (!model || !READS.has(operation) || !args.include) return exec(args);
  try {
    return await exec(args);
  } catch (error) {
    if (!isHiddenRelationError(error)) throw error;
    if (operation === 'findMany') return recoverList(model, args, exec, error);
    const id = typeof (args.where as { id?: unknown } | undefined)?.id === 'string'
      ? (args.where as { id: string }).id
      : '';
    logger.warn(`详情 ${model}${id ? `#${id}` : ''} 的必填关联 ${relationField(error)} 被 RLS 滤掉, 按不存在返回`);
    if (operation === 'findUniqueOrThrow' || operation === 'findFirstOrThrow') {
      throw new NotFoundException('记录不存在或关联数据不可见');
    }
    return null;
  }
}

async function recoverList(
  model: string,
  args: Record<string, unknown>,
  exec: Exec,
  original: unknown,
): Promise<unknown[]> {
  const include = args.include;
  const rest = { ...args };
  delete rest.include;
  let idRows: Array<{ id: string }>;
  try {
    idRows = await exec({ ...rest, select: { id: true } }) as Array<{ id: string }>;
  } catch {
    throw original;
  }
  const kept: unknown[] = [];
  for (const row of idRows) {
    try {
      const one = await exec({ where: { id: row.id }, include, take: 1 });
      if (Array.isArray(one) && one[0]) kept.push(one[0]);
    } catch (error) {
      if (isHiddenRelationError(error)) {
        logger.warn(`跳过 ${model}#${row.id}: 必填关联 ${relationField(error)} 被 RLS 滤掉, 列表不返回该行`);
        continue;
      }
      throw error;
    }
  }
  return kept;
}
