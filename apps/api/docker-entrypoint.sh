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
DATABASE_URL="$MIGRATE_DATABASE_URL" ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
DATABASE_URL="$MIGRATE_DATABASE_URL" ./node_modules/.bin/prisma db execute --schema prisma/schema.prisma --file prisma/grant-liquor-app.sql
# 已有口令时 deploy.sh 不会重新生成; 这里把角色口令同步成 .env 里的那一个。
DATABASE_URL="$MIGRATE_DATABASE_URL" ./node_modules/.bin/prisma db execute --schema prisma/schema.prisma --stdin <<EOF
ALTER ROLE liquor_app WITH LOGIN PASSWORD '${LIQUOR_APP_PASSWORD}';
EOF
exec node dist/main.js
