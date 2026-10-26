# web 镜像: admin 静态文件 + nginx 反代 api
# 构建上下文是仓库根(见 deploy.sh), 源码在 apps/admin
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
# admin 依赖 workspace 包 @liquor/shared, 用 ... 递归装上 shared(含其 devDeps 的 tsc)
RUN pnpm install --filter @liquor/admin... --frozen-lockfile || pnpm install --filter @liquor/admin...
# 先产出 shared 的 dist+类型声明, admin 的 tsc/vite 才能解析 @liquor/shared (同 api Dockerfile)
COPY packages/shared packages/shared
RUN pnpm --filter @liquor/shared build
COPY apps/admin apps/admin
RUN cd apps/admin && pnpm run build

FROM nginx:alpine
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
