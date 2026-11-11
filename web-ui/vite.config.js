import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './test-setup.ts',
    include: ['./src/__tests__/*.test.ts', './src/__tests__/*.test.tsx'],
    server: {
      deps: {
        fallbackCJS: true,
      },
    },
  },
  resolve: {
    alias: process.env.VITEST ? {} : undefined,
  },
  server: {
    port: 3000,
    proxy: {
      // 開発用: 画面をブラウザで開いたとき、API をバックエンドへ中継する。
      // 中継先のポートは BUNRI_API_PORT で変えられる（既定は backend/run_web.py と同じ 8000）
      '/api': `http://127.0.0.1:${process.env.BUNRI_API_PORT || 8000}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
