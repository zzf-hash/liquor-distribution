// B5: 带 tenantId 的业务模型(查询/写入强制注入)。
// 2026-10 安全审查: 清单曾漏一半模型; 2026-10-25 又漏了 Expense / Promotion /
// CapFeePolicy / CapRecycleOrder。清单必须与 schema 全量对齐(Tenant 自身没有
// tenantId 列; TelemetryEvent 无租户列, 两者都不在这里)。
// test/tenant-models.spec.ts 会解析 schema, 漏模型即失败。
export const TENANT_MODELS: ReadonlySet<string> = new Set<string>([
  'User', 'Product', 'Price', 'CustomerPrice', 'Customer', 'BatchStock',
  'InventoryLedger', 'SalesOrder', 'OrderLine', 'ApprovalRecord', 'Outbound',
  'OutboundLine', 'SignatureRecord', 'Receivable', 'Payment', 'ReceivableLedger',
  'SpecialOrder', 'SpecialOrderLine', 'ReturnOrder', 'ReturnLine',
  'PriceChangeRequest', 'PackageRecord', 'PurchaseOrder', 'PurchaseLine',
  'Stocktake', 'StocktakeLine', 'RebateScheme', 'RebateSettlement', 'Payroll',
  'Statement', 'DisputeItem', 'Visit', 'OrderDraft', 'AliasEntry',
  'AuditLog', 'ImportBatch', 'ImportRowError', 'IdempotencyRecord', 'SystemConfig',
  'DailyStockReport', 'RestockRequest',
  'Expense', 'CapFeePolicy', 'CapRecycleOrder', 'Promotion',
]);
