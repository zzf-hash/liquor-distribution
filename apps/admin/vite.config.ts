import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 内勤后台构建配置：dev 5173 / preview 4173，host 打开以便局域网 1080p 真机演示
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
});
