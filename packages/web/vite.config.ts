import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * dev：vite 起静态（默认 :5173），/ws 走 WebSocket 代理到 game server（:8420）。
 * 生产：vite build 出 dist/，由 server 以 WEB_DIST 同端口托管（静态 + /ws 共端口）。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:8420',
        ws: true,
      },
    },
  },
});
