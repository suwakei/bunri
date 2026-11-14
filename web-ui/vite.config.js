import { randomBytes } from 'node:crypto'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { CSP_REPORT_PATH, CSP_REPORTS_PATH, devCsp } from '../scripts/desktop-csp.mjs'

/**
 * 開発用のブラウザ起動 (scripts/dev-web.mjs) で、デスクトップアプリと同じ CSP を掛ける。
 *
 * 正本は src-tauri/tauri.conf.json。開発サーバの事情で足すもの (nonce、自動再読み込みの接続、
 * 違反の知らせ先) は scripts/desktop-csp.mjs に書いてある。違反はブラウザから CSP_REPORT_PATH に届き、
 * 標準エラーに出し、CSP_REPORTS_PATH で一覧を返す (ブラウザのテストが最後に確かめる: e2e/csp-check.ts)。
 *
 * 環境変数 BUNRI_DEV_CSP=1 のときだけ有効 (dev-web.mjs が付ける)。`tauri dev` が使う開発サーバには掛けない。
 */
function desktopCspPlugin() {
  const nonce = randomBytes(16).toString('base64')
  const reports = []
  return {
    name: 'bunri-desktop-csp',
    apply: 'serve',
    config: () => ({ html: { cspNonce: nonce } }),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (req.method === 'POST' && path === CSP_REPORT_PATH) {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body)
              // report-uri の形 ({"csp-report": {...}}) と、Reporting API の形 ([{body: {...}}]) の両方を読む
              const items = Array.isArray(parsed) ? parsed.map((r) => r.body ?? r) : [parsed['csp-report'] ?? parsed]
              for (const item of items) {
                reports.push(item)
                process.stderr.write(`[csp] 違反: ${JSON.stringify(item)}\n`)
              }
            } catch {
              process.stderr.write(`[csp] 読めない知らせ: ${body.slice(0, 200)}\n`)
            }
            res.statusCode = 204
            res.end()
          })
          return
        }
        if (req.method === 'GET' && path === CSP_REPORTS_PATH) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(reports))
          return
        }
        res.setHeader('Content-Security-Policy', devCsp({
          nonce,
          wsOrigin: `ws://${req.headers.host}`,
          reportUri: CSP_REPORT_PATH,
        }))
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), ...(process.env.BUNRI_DEV_CSP === '1' ? [desktopCspPlugin()] : [])],
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
    // テストの出力 (Playwright の trace が書く .html など) を見張らない。見張ると、テストの途中で画面が
    // 再読み込みされ (自動再読み込みの仕組みが blob の worker を作り、CSP の違反にもなる)、テストが壊れる
    // (trace は e2e-results/.playwright-artifacts-*/ のような「.」で始まるフォルダに書くので、glob ではなく正規表現で外す)
    watch: { ignored: [/[\\/](e2e-results|e2e-desktop-results|playwright-report)[\\/]/] },
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
