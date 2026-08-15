import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// GitHub Pages 部署时按仓库名设置 base，例如仓库为 zongyi/work-dashboard 时：
//   base: '/work-dashboard/'
// 本地开发 / 自定义域名时可改为 '/'
export default defineConfig({
    plugins: [react()],
    base: process.env.VITE_BASE || '/',
    build: {
        outDir: 'dist',
    },
});
