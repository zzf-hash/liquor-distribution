# 部署

`./deploy/deploy.sh` 在本机构建 api 和 web 镜像，推到服务器后 `docker compose up`。API 容器入口是 `apps/api/docker-entrypoint.sh`：用表主账号跑 `prisma migrate deploy` 和 `prisma/grant-liquor-app.sql`，再用 `liquor_app` 启动进程。

## 环境变量

服务器 `~/liquor/.env`（不进 git）。`deploy.sh` 第一次生成；已经有的键不会覆盖。

| 变量 | 用途 |
| --- | --- |
| `POSTGRES_PASSWORD` | Postgres 超级用户 `liquor`（表主）。只给迁移和授权 |
| `LIQUOR_APP_PASSWORD` | `liquor_app` 的口令。`openssl rand -hex 24`，已存在则不重新生成 |
| `JWT_SECRET` | 签发登录令牌 |
| `TAG` | 镜像标签 |

API 容器：

- `DATABASE_URL=postgresql://liquor_app:${LIQUOR_APP_PASSWORD}@postgres:5432/liquor`
- `MIGRATE_DATABASE_URL=postgresql://liquor:${POSTGRES_PASSWORD}@postgres:5432/liquor`

本地开发可以暂时让两个 URL 都指向 `liquor`。这样 RLS 被超级用户绕过，进程会打 error 日志「数据库角色不符合 RLS 基线」并尝试告警，但仍然启动。上线不要这样做。

## 授权

`apps/api/prisma/grant-liquor-app.sql` 可重复执行：

- `CREATE ROLE liquor_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`，并保证它不拥有任何表
- 业务表 `SELECT/INSERT/UPDATE/DELETE`
- 只追加的表只留 `SELECT/INSERT`：`AuditLog`、`InventoryLedger`、`ReceivableLedger`、`SignatureRecord`、`ImportRowError`、`OrderLine`、`ReturnLine`、`IdempotencyRecord`、`PackageRecord`、`Visit`
- `ApprovalRecord`、`StocktakeLine` 应用会更新，保留 UPDATE/DELETE（`0_init` 里对 PUBLIC 的 REVOKE 挡不住表主，业务账号必须显式授权）
- sequence `USAGE/SELECT`
- `ALTER DEFAULT PRIVILEGES`，以后新建的表默认给全套 DML
- 不授权 `_prisma_migrations`

新增只追加表时，把表名加进脚本的 `REVOKE`，迁移后再跑一遍。容器每次启动都会在 `migrate deploy` 之后重跑该脚本。

手动：

```bash
DATABASE_URL="$MIGRATE_DATABASE_URL" pnpm --filter @liquor/api exec prisma db execute --schema apps/api/prisma/schema.prisma --file apps/api/prisma/grant-liquor-app.sql
```

## 上线后验证

在业务库用 `liquor_app` 执行：

```sql
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname = current_user;
-- rolsuper 和 rolbypassrls 都应为 f, rolname 应为 liquor_app

SELECT count(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity
  AND c.relforcerowsecurity;
-- 应为 45

SELECT count(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND pg_get_userbyid(c.relowner) = current_user
  AND c.relname <> '_prisma_migrations';
-- liquor_app 应为 0
```

API 启动日志应有「不是超级用户, 不绕过 RLS」。若仍是表主，会有 error「不符合 RLS 基线」和一条飞书告警（未配置飞书时告警发送失败，error 日志仍在），进程不退出。

nginx 反代 `/api/` 时设置了 `X-Forwarded-For`。API 的 `trust proxy` 是 `['loopback', 'uniquelocal']`：只信任回环和私网地址，也就是本机和旁边这一跳反代。公网客户端直连时伪造的 `X-Forwarded-For` 不采用。

## 回滚到旧账号

1. 把 API 的 `DATABASE_URL` 改回 `postgresql://liquor:${POSTGRES_PASSWORD}@postgres:5432/liquor`（或删掉 `liquor_app` 这一行，让它重新指向表主）。
2. `docker compose up -d api`。迁移仍用 `MIGRATE_DATABASE_URL`，可以不动。
3. 确认进程起来后，再决定要不要 `DROP ROLE liquor_app`。先 `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM liquor_app`，并撤销 default privileges，再 `DROP ROLE`。
4. 若还要撤掉 RLS 本身，用 PR 描述里的 `NO FORCE` / `DISABLE` / `DROP POLICY` 脚本，并删掉 `_prisma_migrations` 中的 `20261025000000_enable_rls`。

切回表主之后，RLS 和 `AuditLog` 的 REVOKE 又会被超级用户绕过。这只作为紧急回退。
