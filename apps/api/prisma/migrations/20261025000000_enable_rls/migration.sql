-- LQ1-014: 租户表补齐 RLS 策略, 并 ENABLE + FORCE ROW LEVEL SECURITY。
--
-- 0_init 只 CREATE POLICY(39 张), 没有 ENABLE。之后新增的
-- DailyStockReport / RestockRequest / Expense / CapFeePolicy / CapRecycleOrder / Promotion
-- 连策略都没有。
--
-- 策略(PERMISSIVE, 多条取 OR):
--   tenant_isolation  行可见/可写 ⇔ "tenantId" = current_setting('app.tenant_id', true)
--   tenant_rls_bypass 仅当本事务 set_config('app.rls_bypass','on', true) 时放行
-- 两者都未设置时, 受 RLS 约束的角色看不到任何行、也不能写入(失败关闭)。
--
-- 谁不受约束(已知问题, 部署前由运维处理, 见 PR):
--   * 超级用户、以及带 BYPASSRLS 的角色, 即使 FORCE 也绕过 RLS。
--   * 未 FORCE 时表主也绕过; 本迁移对租户表执行了 FORCE, 非超级用户的表主会受策略约束。
--   官方 postgres 镜像里 POSTGRES_USER 是超级用户兼表主, 应用连接在切换账号前仍然绕过 RLS。
--   应用层 TENANT_MODELS 注入是这之前的实际隔离; RLS 在切换到非超级用户、非表主的业务账号后生效。
--
-- 没有租户上下文的路径(登录探测、seed)通过事务内 set_config('app.rls_bypass','on', true) 放行。
-- 定时任务先读无 RLS 的 Tenant, 再按租户 set_config('app.tenant_id', …, true), 不需要 bypass。
--
-- 回滚(在目标库执行, 不删 0_init 里原有的 tenant_isolation, 那些策略当时就存在, 只是没启用):
-- DO $$
-- DECLARE t text;
-- BEGIN
--   FOREACH t IN ARRAY ARRAY[
--     'User','Product','Price','CustomerPrice','Customer','BatchStock',
--     'InventoryLedger','SalesOrder','OrderLine','ApprovalRecord','Outbound',
--     'OutboundLine','SignatureRecord','Receivable','Payment','ReceivableLedger',
--     'SpecialOrder','SpecialOrderLine','ReturnOrder','ReturnLine',
--     'PriceChangeRequest','PackageRecord','PurchaseOrder','PurchaseLine',
--     'Stocktake','StocktakeLine','RebateScheme','RebateSettlement','Payroll',
--     'Statement','DisputeItem','Visit','OrderDraft','AliasEntry',
--     'AuditLog','ImportBatch','ImportRowError','IdempotencyRecord','SystemConfig',
--     'DailyStockReport','RestockRequest','Expense','CapFeePolicy','CapRecycleOrder','Promotion'
--   ]
--   LOOP
--     EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
--     EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
--     EXECUTE format('DROP POLICY IF EXISTS tenant_rls_bypass ON %I', t);
--   END LOOP;
--   FOREACH t IN ARRAY ARRAY['DailyStockReport','RestockRequest','Expense','CapFeePolicy','CapRecycleOrder','Promotion']
--   LOOP
--     EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
--   END LOOP;
-- END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['DailyStockReport','RestockRequest','Expense','CapFeePolicy','CapRecycleOrder','Promotion']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)) WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))',
        t
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User','Product','Price','CustomerPrice','Customer','BatchStock',
    'InventoryLedger','SalesOrder','OrderLine','ApprovalRecord','Outbound',
    'OutboundLine','SignatureRecord','Receivable','Payment','ReceivableLedger',
    'SpecialOrder','SpecialOrderLine','ReturnOrder','ReturnLine',
    'PriceChangeRequest','PackageRecord','PurchaseOrder','PurchaseLine',
    'Stocktake','StocktakeLine','RebateScheme','RebateSettlement','Payroll',
    'Statement','DisputeItem','Visit','OrderDraft','AliasEntry',
    'AuditLog','ImportBatch','ImportRowError','IdempotencyRecord','SystemConfig',
    'DailyStockReport','RestockRequest','Expense','CapFeePolicy','CapRecycleOrder','Promotion'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_rls_bypass'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_rls_bypass ON %I USING (current_setting(''app.rls_bypass'', true) = ''on'') WITH CHECK (current_setting(''app.rls_bypass'', true) = ''on'')',
        t
      );
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
