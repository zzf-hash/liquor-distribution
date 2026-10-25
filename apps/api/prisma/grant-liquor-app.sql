-- liquor_app: API 运行时角色。可重复执行。不要在本文件里写口令。
-- 由 MIGRATE_DATABASE_URL 的表主执行(prisma migrate deploy 之后)。
-- 口令由 deploy/deploy.sh 写入服务器 .env 的 LIQUOR_APP_PASSWORD, 启动脚本再 ALTER ROLE。
--
-- 只追加(SELECT/INSERT, 收回 UPDATE/DELETE/TRUNCATE):
--   AuditLog            审计哈希链, 应用层禁 update/delete
--   InventoryLedger     库存流水
--   ReceivableLedger    应收流水
--   SignatureRecord     签收凭证
--   ImportRowError      导入错误行
--   OrderLine           订单行写一次, 改单走红字新行
--   ReturnLine          退货行只增
--   IdempotencyRecord   幂等记录只插入
--   PackageRecord       包装台账只插入
--   Visit               拜访打卡只插入
-- 下面两张表在 0_init 里曾对 PUBLIC 收回 UPDATE, 但应用要改状态/实盘数, 所以 liquor_app 保留 UPDATE/DELETE:
--   ApprovalRecord      PENDING→APPROVED/REJECTED/EXPIRED
--   StocktakeLine       录入实盘数量
-- 其余业务表 SELECT/INSERT/UPDATE/DELETE。_prisma_migrations 不授权。
-- 新表: DEFAULT PRIVILEGES 先给全套 DML。新增只追加表时把表名加进下面的 REVOKE, 并在迁移后重跑本脚本。
-- 容器入口在每次 migrate deploy 之后都会重跑。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liquor_app') THEN
    CREATE ROLE liquor_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE liquor_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- 若 liquor_app 曾被误设成表主, 把对象交还给现有业务表的属主(没有则交给当前用户)。
DO $$
DECLARE
  r record;
  owner name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'User'
    AND pg_get_userbyid(c.relowner) <> 'liquor_app'
  LIMIT 1;
  IF owner IS NULL THEN
    owner := current_user;
  END IF;
  FOR r IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND pg_get_userbyid(c.relowner) = 'liquor_app'
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.nspname, r.relname, owner);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', r.nspname, r.relname, owner);
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO liquor_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO liquor_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO liquor_app;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  "AuditLog",
  "InventoryLedger",
  "ReceivableLedger",
  "SignatureRecord",
  "ImportRowError",
  "OrderLine",
  "ReturnLine",
  "IdempotencyRecord",
  "PackageRecord",
  "Visit"
FROM liquor_app;

REVOKE ALL ON TABLE "_prisma_migrations" FROM liquor_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO liquor_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO liquor_app;
