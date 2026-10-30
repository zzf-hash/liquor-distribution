import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** antd 的入口会连带所有组件的样式副作用。源码里的具名导入改成组件路径，登录页就不会带上表格和图表组件。 */
function antdNamedToDeep(): Plugin {
  return {
    name: 'antd-named-to-deep',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/apps/admin/src/') || !/\.[tj]sx?$/.test(id)) return null;
      if (!code.includes("from 'antd'") && !code.includes('from "antd"')) return null;
      let changed = false;
      const next = code.replace(
        /import\s+(type\s+)?\{([^}]+)\}\s+from\s+(['"])antd\3/g,
        (full, typeKw: string | undefined, body: string) => {
          if (typeKw) {
            changed = true;
            return '';
          }
          const lines: string[] = [];
          for (const part of body.split(',')) {
            const spec = part.trim();
            if (!spec || spec.startsWith('type ')) continue;
            const match = spec.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
            if (!match) return full;
            const imported = match[1];
            const local = match[2] ?? imported;
            const folder = imported
              .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
              .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
              .toLowerCase();
            lines.push(`import ${local} from 'antd/es/${folder}';`);
          }
          changed = true;
          return lines.join('\n');
        },
      );
      return changed ? next : null;
    },
  };
}

// 内勤后台构建配置：dev 5173 / preview 4173，host 打开以便局域网 1080p 真机演示
// dev 反代 /api → 本地 NestJS（PORT 3000），前端代码统一走相对 /api 前缀
export default defineConfig({
  plugins: [
    react(),
    antdNamedToDeep(),
  ],
  // shared 是 CJS，pnpm 把它解析到 packages/shared/dist，不在 node_modules 里。
  // Vite 默认只对 node_modules 做 CJS 互操作，否则具名导出会被当成不存在。
  build: {
    sourcemap: false,
    commonjsOptions: {
      include: [/node_modules/, /packages\/shared\/dist/],
    },
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/[name]-[hash].js',
        // react 单独长期缓存。antd 和 pro 不手工并包：
        // 并包会把各页组件都塞进首屏，pnpm 嵌套目录还会把公共小工具误归进 pro 包。
        manualChunks(id) {
          const parts = id.split(/node_modules[\\/]/);
          if (parts.length < 2) return undefined;
          const rel = parts[parts.length - 1];
          if (/^(react|react-dom|react-router|react-router-dom|scheduler|react-is)[\\/]/.test(rel)) {
            return 'react-vendor';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
