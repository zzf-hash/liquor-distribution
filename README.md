# liquor-distribution

酒类分销订货商城 —— TypeScript Monorepo（计划书§4.1）。

- apps/admin   内勤后台 Web（React + Ant Design Pro 组件集）—— P0-01b（task 7bb5e0eb, frontend 32c4186f）
- apps/api     服务端 NestJS + Prisma —— P0-01（backend, 进行中）
- apps/miniapp 移动端 Taro（预留）—— 待 P0-01 落地后开工
- packages/shared 共享类型/校验规则（预留）

## 状态
apps/admin 骨架由 feat/admin-skeleton 分支先行交付（空仓期避免与 backend 的 main 根文件提交互撞）；
backend P0-01 根脚手架落 main 后，本分支合并即完成 monorepo 汇合（根文件取并集即可）。
