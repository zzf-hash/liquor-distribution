# liquor-distribution

酒类分销订货商城 —— TypeScript Monorepo（计划书§4.1）。

- apps/api     服务端 NestJS + Prisma + PostgreSQL —— **P0 已落**：P0-T02 认证 RBAC(五角色)/租户注入、P0-T03 审计哈希链/状态机、P0-T10~T13 主数据+Excel 导入、P0-T20~T25 订单主线、P0-T30/31 应收/收款销账。安全评审 B1~B5 阻断项全部落地（见 `apps/api/src/prisma/prisma.service.ts` 与迁移 SQL 末尾）。
- apps/admin   内勤后台 Web（React + AntD Pro 组件集）—— P0-01b 骨架 + P0 页面接真接口（订单池/主数据/应收），统一 `/api` 前缀，`VITE_USE_MOCK=false` 切真实后端。
- apps/miniapp 移动端 Taro（Taro 4.2.1 + React + TS + Vite compiler）—— P0-01b同链 骨架已落（四端复用+三入口壳）。
- packages/shared 共享类型/校验规则（预留）

## 本地开发

```bash
pnpm install
# api: 先起 PostgreSQL, 配 apps/api/.env (参考 .env.example)
cd apps/api && pnpm exec prisma migrate deploy && pnpm seed && pnpm run dev
# admin:
cd apps/admin && pnpm dev   # vite 已配 /api -> localhost:3000 代理
# 小程序（客户和员工同一个包，不必设角色变量）:
pnpm --filter @liquor/miniapp build:weapp   # dist/
pnpm --filter @liquor/miniapp build:h5      # dist-h5/
pnpm check:bundle
```

演示账号（seed）：owner/clerk/rep1/warehouse，密码 `demo1234`。

## 部署

`./deploy/deploy.sh`（构建 api+web 镜像 → liquor-sg 起 compose）。API 用 `liquor_app` 连库，迁移和授权用表主账号 `MIGRATE_DATABASE_URL`。步骤、验证 SQL 和切回旧账号的回滚见 `deploy/README.md`。

## 状态

- P0 后端与 admin 前端主链路完成（任务书 WS-0/WS-1/WS-2/WS-3 对应 T02/T03/T10~T13/T20~T25/T30~T31）
- 待办：T03 抹零/坏账审批细分、T32 电子单据归档、T40 四问看板、T50/51 客户小程序页面
