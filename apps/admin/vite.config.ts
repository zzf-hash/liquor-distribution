import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 内勤后台构建配置：dev 5173 / preview 4173，host 打开以便局域网 1080p 真机演示
// dev 反代 /api → 本地 NestJS（PORT 3000），前端代码统一走相对 /api 前缀
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  preview: { port: 4173, host: true },
});
