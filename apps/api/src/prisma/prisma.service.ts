import { Injectable, OnModuleDestroy, OnModuleInit, ForbiddenException } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { tenantContext } from './tenant-context';

// ── 安全基线执行层 (docs/M0/安全评审-01.md) ──────────────────────────────
// B2/B3/B4 append-only 与写一次模型: 应用层禁 update/delete(裸 SQL 由 DB 层
//    REVOKE + RLS 兜底, 见 prisma/migrations/0_init/migration.sql 末尾)
// B5 租户强制注入: 业务表查询自动补 where.tenantId, 写入自动补 data.tenantId
//    (忘写 where 也不会跨租户泄漏; PostgreSQL RLS 为第二层防线)
// 实现注: Prisma6 已移除 $use 中间件, 用 $extends + 接口合并注入 Nest:
//    构造器返回扩展客户端实例, interface PrismaService extends typeof 合并类型。

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

// B5: 带 tenantId 的业务模型(查询/写入强制注入)。
// 2026-10 安全审查: 清单曾漏一半模型, 导致 statements/rebates/visits/special-orders/
// purchases/stocktakes/drafts 等查询跨租户泄漏——清单必须与 schema 全量对齐。
// 生成方式: 取 prisma/schema.prisma 中所有带 tenantId 字段的模型(Tenant 自身除外)。
export const TENANT_MODELS = new Set<string>([
  'User', 'Product', 'Price', 'CustomerPrice', 'Customer', 'BatchStock',
  'InventoryLedger', 'SalesOrder', 'OrderLine', 'ApprovalRecord', 'Outbound',
  'OutboundLine', 'SignatureRecord', 'Receivable', 'Payment', 'ReceivableLedger',
  'SpecialOrder', 'SpecialOrderLine', 'ReturnOrder', 'ReturnLine',
  'PriceChangeRequest', 'PackageRecord', 'PurchaseOrder', 'PurchaseLine',
  'Stocktake', 'StocktakeLine', 'RebateScheme', 'RebateSettlement', 'Payroll',
  'Statement', 'DisputeItem', 'Visit', 'OrderDraft', 'AliasEntry',
  'AuditLog', 'ImportBatch', 'ImportRowError', 'IdempotencyRecord', 'SystemConfig',
  'DailyStockReport', 'RestockRequest',
  // S1: these have tenantId but were missing, so id updates/reads were not scoped.
  'Expense', 'CapRecycleOrder', 'CapFeePolicy', 'Promotion',
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
  if (!ctx || !TENANT_MODELS.has(model)) return params;
  const args = (params.args ?? {}) as Record<string, any>;
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

const extendedClient = new PrismaClient().$extends({
  name: 'security-baseline',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        // Prisma6: applyGuards 原地改 args 后把 args 原样传回 query()。
        // 不能把 {model,action,args} 整个回传——model/action 会被当作未知参数报
        // PrismaClientValidationError (Unknown argument `model`)
        applyGuards({ model, action: operation, args: args ?? {} }, tenantContext.getStore());
        return query(args as never);
      },
    },
  },
});

type ExtendedClient = typeof extendedClient;

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

// 审计专用原始访问(哈希链 FOR UPDATE 查询, 不经扩展层)
export const rawClient = new PrismaClient();

export type { Prisma };
