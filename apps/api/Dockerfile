# api 镜像: 入口 dist/main.js, 监听 PORT 环境变量 (deploy/docker-compose.yml 契约)
# 启动时先 prisma migrate deploy 再起服务
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
# shared 整包(含 tsconfig.json+src): build 步骤需要 tsc -p tsconfig.json
COPY packages/shared packages/shared
# @liquor/shared 为 api 的 workspace 依赖, --filter A... 递归拉取其依赖
RUN pnpm install --filter @liquor/api... --frozen-lockfile
# 先构建 shared(产出 dist+类型声明), 再构建 api(依赖其类型)
RUN pnpm --filter @liquor/shared build
COPY apps/api apps/api
RUN cd apps/api && pnpm exec prisma generate && pnpm run build

FROM node:22-alpine
WORKDIR /app/apps/api
ENV NODE_ENV=production
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/node_modules ./node_modules
# @liquor/shared 是 workspace 依赖: pnpm 在 node_modules 里放的是指向 ../packages/shared 的符号链接,
# COPY 后链接悬空(目标目录未拷)。删链, 直接把构建好的 shared(dist+package.json)拷进 node_modules。
RUN rm -f node_modules/@liquor/shared
COPY --from=build /app/packages/shared ./node_modules/@liquor/shared
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
# main.ts 直接 import { json, urlencoded } from 'express'(非直接依赖, pnpm 严格模式不提升):
# 从根 store 链一份到运行时 node_modules, 避免 MODULE_NOT_FOUND
RUN EXPRESS_DIR=$(ls -d /app/node_modules/.pnpm/express@*/node_modules/express | head -1) && \
    ln -sfn "$EXPRESS_DIR" /app/apps/api/node_modules/express
EXPOSE 3000
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/main.js"]
