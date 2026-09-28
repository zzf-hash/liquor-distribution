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
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
EXPOSE 3000
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/main.js"]
