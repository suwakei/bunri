/**
 * bunri DAW — ブラウザを自動操作するテスト (Playwright) の設定。
 *
 * 画面をブラウザで開く経路 (scripts/dev-web.mjs = Vite の開発サーバ + API サーバ) に対して走らせる。
 * 製品の形はデスクトップアプリだが、Playwright が操作できるのはブラウザなので、この経路を使う。
 * ネイティブ側 (Rust) の機能 — キーチェーン、MIDI のネイティブ入力、別窓、初回セットアップ — は
 * ここでは確かめられない (それらは src-tauri のテストで見る)。
 *
 * ブラウザは 2 つ。Chromium と、デスクトップアプリの WebView に近い WebKit。
 */
import { defineConfig, devices } from '@playwright/test';

/** 画面のポート。ほかの開発サーバとぶつからないよう、よく使われる番号を避けている。 */
const PORT = 5199;
const URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: './e2e',
    outputDir: './e2e-results',
    timeout: 90_000,
    expect: { timeout: 10_000 },
    // API サーバは 1 つで、アップロード先などの状態を共有するので、並列にしない
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: {
        baseURL: URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    webServer: {
        command: `node ../scripts/dev-web.mjs --port ${PORT}`,
        url: URL,
        // すでに何かが居たら失敗させる (別のサーバを相手にテストしてしまわないように)
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
        gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
});
