# api 镜像: 入口 dist/main.js, 监听 PORT 环境变量 (deploy/docker-compose.yml 契约)
# 启动时先 prisma migrate deploy 再起服务
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN node -e "const f='package.json';const p=require('./'+f);p.pnpm={onlyBuiltDependencies:['@nestjs/core','@prisma/client','@prisma/engines','prisma','esbuild','@swc/core','unrs-resolver']};require('fs').writeFileSync(f,JSON.stringify(p,null,2))" && (pnpm install --filter @liquor/api --frozen-lockfile || pnpm install --filter @liquor/api)
COPY apps/api apps/api
RUN cd apps/api && pnpm exec prisma generate && pnpm run build

FROM node:22-alpine
WORKDIR /app/apps/api
ENV NODE_ENV=production
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/apps/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
EXPOSE 3000
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/main.js"]
