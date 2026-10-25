import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 内勤后台构建配置：dev 5173 / preview 4173，host 打开以便局域网 1080p 真机演示
// dev 反代 /api → 本地 NestJS（PORT 3000），前端代码统一走相对 /api 前缀
export default defineConfig({
  plugins: [react()],
  // shared 是 CJS，pnpm 把它解析到 packages/shared/dist，不在 node_modules 里。
  // Vite 默认只对 node_modules 做 CJS 互操作，否则具名导出会被当成不存在。
  build: {
    commonjsOptions: {
      include: [/node_modules/, /packages\/shared\/dist/],
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  preview: { port: 4173, host: true },
});
