#!/bin/sh
# 表主跑迁移和授权, 然后用容器环境里的 DATABASE_URL(liquor_app) 启动 API。
# LIQUOR_APP_PASSWORD 只来自环境变量, 不写进镜像或仓库。
set -eu
if [ -z "${MIGRATE_DATABASE_URL:-}" ]; then
  echo "MIGRATE_DATABASE_URL is required" >&2
  exit 1
fi
if [ -z "${LIQUOR_APP_PASSWORD:-}" ]; then
  echo "LIQUOR_APP_PASSWORD is required" >&2
  exit 1
fi
# 只允许字母数字且至少 32 位。错误信息只打印规则, 不打印口令。
case "$LIQUOR_APP_PASSWORD" in
  *[!A-Za-z0-9]*)
    echo "LIQUOR_APP_PASSWORD 不符合 ^[A-Za-z0-9]{32,}, 拒绝启动" >&2
    exit 1
    ;;
esac
if [ "${#LIQUOR_APP_PASSWORD}" -lt 32 ]; then
  echo "LIQUOR_APP_PASSWORD 不符合 ^[A-Za-z0-9]{32,}, 拒绝启动" >&2
  exit 1
fi
DATABASE_URL="$MIGRATE_DATABASE_URL" ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
DATABASE_URL="$MIGRATE_DATABASE_URL" ./node_modules/.bin/prisma db execute --schema prisma/schema.prisma --file prisma/grant-liquor-app.sql
# 已有口令时 deploy.sh 不会重新生成; 这里把角色口令同步成 .env 里的那一个。
# SET LOCAL 只活在当前事务, 必须和 ALTER 同一个 BEGIN/COMMIT, 否则口令会进语句日志。
DATABASE_URL="$MIGRATE_DATABASE_URL" ./node_modules/.bin/prisma db execute --schema prisma/schema.prisma --stdin <<EOF
BEGIN;
SET LOCAL log_statement = 'none';
ALTER ROLE liquor_app WITH LOGIN PASSWORD '${LIQUOR_APP_PASSWORD}';
COMMIT;
EOF
# 应用代码不读这两个变量。丢掉它们, 避免超级用户连接串和口令留在 node 进程里。
# compose 仍把 liquor_app 口令嵌进 DATABASE_URL, 那是业务连接本身。
exec env -u MIGRATE_DATABASE_URL -u LIQUOR_APP_PASSWORD node dist/main.js
