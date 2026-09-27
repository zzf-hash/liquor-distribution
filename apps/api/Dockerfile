# api 镜像 — apps/api 由后续开发补上后此文件生效
# (Claude做完NestJS后如目录结构不同, 微调COPY行即可)
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --filter api --frozen-lockfile || pnpm install --filter api
COPY apps/api apps/api
RUN cd apps/api && pnpm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/apps/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
