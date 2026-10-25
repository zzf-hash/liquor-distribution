import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { tenantContext, rlsBypassContext, currentRlsRole } from './tenant-context';
import { TENANT_MODELS } from './tenant-models';
import { readWithHiddenRelationFallback } from './relation-read';

export { TENANT_MODELS } from './tenant-models';

// ── 安全基线执行层 (docs/M0/安全评审-01.md) ──────────────────────────────
// B2/B3/B4 append-only 与写一次模型: 应用层禁 update/delete(裸 SQL 由 DB 层
//    REVOKE + RLS 兜底, 见 prisma/migrations/0_init/migration.sql 末尾)
// B5 租户强制注入: 业务表查询自动补 where.tenantId, 写入自动补 data.tenantId
//    (忘写 where 也不会跨租户泄漏; PostgreSQL RLS 为第二层防线, 20261025000000_enable_rls 启用)
// 实现注: Prisma6 已移除 $use 中间件, 用 $extends + 接口合并注入 Nest:
//    构造器返回扩展客户端实例, interface PrismaService extends typeof 合并类型。
//
// RLS 接线(事务局部, 不把租户留在连接池上):
//   有租户上下文时, 每条语句所在事务先 SELECT set_config('app.tenant_id', id, true)。
//   显式 rlsBypassContext 时再 set_config('app.rls_bypass','on', true)——只给登录前的
//   用户名探测和 seed。DailyTasksTimer / 库存日切先读无策略的 Tenant, 再
//   tenantContext.run 逐租户执行, 走 app.tenant_id, 不开 bypass。
//   单条查询包进交互事务; 已有的 $transaction(回调或批量)在入口处设置, 避免拆掉原子性。
// 必填 include 被 RLS 滤成 null 时, 列表跳过该行并 warn, 详情按不存在返回, 避免整页 500。

const APPEND_ONLY_MODELS = new Set<string>([
  'AuditLog', // B2
  'InventoryLedger', // B4
  'ReceivableLedger', // B4
  'SignatureRecord', // P1-6 签收凭证 append-only
  // 'ApprovalRecord' 移除(P1 修复): 审批单有状态流转(PENDING→APPROVED/REJECTED/EXPIRED_24H),
  //   decide/expireStale 必须 update; 防篡改由 AuditLog 哈希链兜底, 审批结果本身需可写。
  //   原黑名单与 P1 审批中心(f4e1076)自相矛盾, 冒烟未炸仅因当时无超24h待审单。
  'ImportRowError',
]);

const WRITE_ONCE_MODELS = new Set<string>([
  'OrderLine', // B3: 只允许 create(红字冲销走新行), 禁一切 update/delete
  'ReturnLine', // R4: 退货数量只增——行 append-only, 增量走追加行
]);

// 接受 where 的动作统一注入(含 findUnique 系——此前豁免是跨租户 IDOR 根源:
// 全部按 id 读单据的代码都是裸查; Prisma5+ 扩展唯一 where 允许附加非唯一字段,
// 注入后跨租户 id 直接 404/P2025)。upsert 不在此列: 现有调用点均用 tenantId_ 复合键。
const WHERE_ACTIONS = new Set<string>([
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'delete', 'deleteMany',
]);

type Ctx = { tenantId: string } | undefined;

function applyGuards(params: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const model = String(params.model ?? '');
  const action = String(params.action ?? '');
  const mutating = action === 'update' || action === 'delete' || action === 'updateMany' || action === 'deleteMany';
  if (mutating && (APPEND_ONLY_MODELS.has(model) || WRITE_ONCE_MODELS.has(model))) {
    const tag = APPEND_ONLY_MODELS.has(model) ? 'append-only(安全评审B2/B4)' : '写一次(安全评审B3, 改单只走红字冲销新行)';
    throw new ForbiddenException(`模型 ${model} 为 ${tag}, 禁止 ${action}`);
  }
  const args = (params.args ?? {}) as Record<string, any>;
  if (model === 'User' && (action === 'create' || action === 'createMany' || action === 'update' || action === 'updateMany' || action === 'upsert')) {
    rejectReservedUsername(args.data);
    if (action === 'upsert') rejectReservedUsername(args.update);
  }
  if (!ctx || !TENANT_MODELS.has(model)) return params;
  if (WHERE_ACTIONS.has(action)) {
    // 无 where 的集合查询此前整个被跳过(GET /users 等裸 findMany 全租户泄漏), 这里主动构造
    if (args.where === undefined) args.where = {};
    const where = args.where as Record<string, unknown>;
    const alreadyTenantScoped =
      where.tenantId !== undefined ||
      // tenantId_ 开头的复合唯一键(tenantId_key 等)构造即租户域, 不再叠加
      Object.keys(where).some((k) => k.startsWith('tenantId_'));
    if (!alreadyTenantScoped) where.tenantId = ctx.tenantId;
  }
  if (action === 'create' && args.data && typeof args.data === 'object' && args.data.tenantId === undefined) {
    args.data = { ...args.data, tenantId: ctx.tenantId };
  }
  if (action === 'createMany' && Array.isArray(args.data)) {
    args.data = args.data.map((d: Record<string, unknown>) => (d.tenantId === undefined ? { ...d, tenantId: ctx.tenantId } : d));
  }
  if (action === 'upsert' && args.create && args.create.tenantId === undefined) {
    args.create = { ...args.create, tenantId: ctx.tenantId };
  }
  params.args = args;
  return params;
}

// 外层交互事务回调期间为 true。不能单凭它跳过 RLS 包装:
// 回调里若用 this.prisma 而不是 tx, 查询在另一条连接上, kind 不是 itx/batch。
const inRlsTx = new AsyncLocalStorage<true>();
const rlsLogger = new Logger('PrismaRls');
// 关联回退正在逐行重查。内层扩展只执行语句, 不再包一层回退(否则递归)。
const inRelationFallback = new AsyncLocalStorage<true>();

type RlsQueryParams = {
  model?: string;
  operation: string;
  args: any;
  query: (args: any) => Prisma.PrismaPromise<unknown>;
  __internalParams?: { transaction?: { kind?: string } };
};

type TxClient = Prisma.TransactionClient;

function rejectReservedUsername(data: unknown): void {
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  for (const row of rows) {
    const name = (row as { username?: unknown } | null)?.username;
    if (typeof name === 'string' && name.trim().toLowerCase() === 'system') {
      throw new BadRequestException('用户名 system 为系统保留');
    }
  }
}

function needsRlsGuc(): boolean {
  return Boolean(tenantContext.getStore()?.tenantId || rlsBypassContext.getStore());
}

async function applyRlsGuc(tx: TxClient): Promise<void> {
  const role = currentRlsRole();
  // 先降权再设 GUC, 与「连接本身就是业务账号」的生产路径一致。SET LOCAL 随事务结束还原。
  if (role) await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
  const tenantId = tenantContext.getStore()?.tenantId;
  // is_local=true: 只活在当前事务, 连接归还池子后不会把租户带给下一个请求。
  if (tenantId) await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  if (rlsBypassContext.getStore()) await tx.$queryRaw`SELECT set_config('app.rls_bypass', 'on', true)`;
}

function runRead(model: string | undefined, operation: string, args: Record<string, unknown>, exec: (args: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
  // 回调必须 async: Prisma 查询惰性, 同步返回后 ALS 退出, 内层看不到 inRelationFallback。
  return readWithHiddenRelationFallback(model, operation, args, (next) => inRelationFallback.run(true, async () => exec(next)));
}

function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

const baseClient = new PrismaClient();

// 先声明, $extends 回调在首次查询时才读到赋值后的原方法。
// auth-guards 单测把 PrismaClient mock 成没有 $transaction 的桩, 这里不能无条件 bind。
let originalTransaction: PrismaClient['$transaction'] = (typeof baseClient.$transaction === 'function'
  ? baseClient.$transaction.bind(baseClient)
  : async () => {
      throw new Error('Prisma $transaction unavailable');
    }) as PrismaClient['$transaction'];

const extendedClient = baseClient.$extends({
  name: 'security-baseline',
  query: {
    $allModels: {
      async $allOperations(params: RlsQueryParams) {
        const { model, operation, query } = params;
        const args = params.args ?? {};
        // Prisma6: applyGuards 原地改 args 后把 args 原样传回 query()。
        // 不能把 {model,action,args} 整个回传——model/action 会被当作未知参数报
        // PrismaClientValidationError (Unknown argument `model`)
        applyGuards({ model, action: operation, args }, tenantContext.getStore());
        if (inRelationFallback.getStore()) return query(args);
        const txKind = params.__internalParams?.transaction?.kind;
        const insidePrismaTx = txKind === 'batch' || txKind === 'itx';
        if (!model || !needsRlsGuc() || insidePrismaTx) {
          return runRead(model, operation, args, query);
        }
        // inRlsTx 只说明外层回调还在跑。这条查询没有 itx/batch, 就是另一条连接。
        if (inRlsTx.getStore()) {
          rlsLogger.warn(`事务外查询 ${model}.${operation}: 回调里用了 this.prisma 而不是 tx, 已单独包一层 RLS 事务`);
        }
        // 单条查询: 包进交互事务, 先设 GUC 再在同一连接上执行。
        // 回退放在这一层: 内层 delegate 每次只跑一条 query(), 坏行可以逐条重查。
        return inRlsTx.run(true, () => originalTransaction(async (tx) => {
          await applyRlsGuc(tx);
          const key = delegateKey(model);
          const delegate = (tx as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>)[key];
          if (!delegate || typeof delegate[operation] !== 'function') {
            throw new Error(`RLS 事务包装找不到 ${model}.${operation}`);
          }
          return runRead(model, operation, args, (next) => delegate[operation](next));
        }));
      },
    },
  },
});

type ExtendedClient = typeof extendedClient;

function installRlsTransaction(client: ExtendedClient): void {
  const current = (client as unknown as { $transaction?: PrismaClient['$transaction'] }).$transaction;
  if (typeof current !== 'function') return;
  originalTransaction = current.bind(client) as PrismaClient['$transaction'];
  const patched = ((arg: unknown, opts?: unknown) => {
    if (!needsRlsGuc()) {
      return (originalTransaction as (a: unknown, o?: unknown) => Promise<unknown>)(arg, opts);
    }
    if (inRlsTx.getStore()) {
      rlsLogger.warn('事务外查询 $transaction: 回调里又开了事务, 已在新连接上单独设置 app.tenant_id');
    }
    if (typeof arg === 'function') {
      return originalTransaction(async (tx) => {
        await applyRlsGuc(tx);
        return inRlsTx.run(true, () => (arg as (tx: TxClient) => Promise<unknown>)(tx));
      }, opts as never);
    }
    if (Array.isArray(arg)) {
      const tenantId = tenantContext.getStore()?.tenantId;
      const role = currentRlsRole();
      const prefix: Prisma.PrismaPromise<unknown>[] = [];
      if (role) prefix.push(client.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`));
      if (tenantId) prefix.push(client.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      if (rlsBypassContext.getStore()) prefix.push(client.$queryRaw`SELECT set_config('app.rls_bypass', 'on', true)`);
      return inRlsTx.run(true, async () => {
        const result = await (originalTransaction as (queries: unknown[], o?: unknown) => Promise<unknown[]>)([...prefix, ...arg], opts);
        return result.slice(prefix.length);
      });
    }
    return (originalTransaction as (a: unknown, o?: unknown) => Promise<unknown>)(arg, opts);
  }) as PrismaClient['$transaction'];
  Object.defineProperty(client, '$transaction', { value: patched, writable: true, configurable: true });
}

installRlsTransaction(extendedClient);

// 接口合并: 类 + 接口同名, 消费方拿到完整扩展客户端类型
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PrismaService extends ExtendedClient {}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const client = extendedClient as unknown as Record<string, unknown>;
    // 生命周期方法挂到返回的扩展实例上(Nest 在实例上调用)
    client.onModuleInit = async (): Promise<void> => {
      await extendedClient.$connect();
    };
    client.onModuleDestroy = async (): Promise<void> => {
      await extendedClient.$disconnect();
    };
    return client as unknown as PrismaService;
  }

  // 类型占位(运行时被构造器返回的扩展实例上的同名方法取代)
  async onModuleInit(): Promise<void> {
    await extendedClient.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await extendedClient.$disconnect();
  }
}

// 审计专用原始访问(哈希链不经扩展层; 调用方在事务内自行 set_config, 用 advisory lock 而不是 FOR UPDATE)
export const rawClient = new PrismaClient();

export type { Prisma };
