# web 镜像: admin 静态文件 + nginx 反代 api
# 构建上下文是仓库根(见 deploy.sh), 源码在 apps/admin
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/admin/package.json apps/admin/
RUN pnpm install --filter admin --frozen-lockfile || pnpm install --filter admin
COPY apps/admin apps/admin
RUN cd apps/admin && pnpm run build

FROM nginx:alpine
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
