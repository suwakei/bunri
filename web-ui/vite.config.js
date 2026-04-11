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
      '/api': 'http://127.0.0.1:8000',
      '/download': 'http://127.0.0.1:8000',
    },
  },
  build: {
    outDir: '../web/static/dist',
    emptyOutDir: true,
  },
})
