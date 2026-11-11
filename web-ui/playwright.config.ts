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
import { FAKE_LLM_PORT, FAKE_LLM_URL } from './e2e/helpers';

/** 画面のポート。ほかの開発サーバとぶつからないよう、よく使われる番号を避けている。 */
const PORT = 5199;
const URL = `http://127.0.0.1:${PORT}`;

/*
 * 普段のテストでは、API サーバに本物の Claude ではなく、偽のサーバ (e2e/fake-anthropic.mjs) を呼ばせる。
 * 費用をかけないため。手元の .env に本物の API キーが在っても、環境変数のキーが優先されるので使われない。
 * BUNRI_E2E_LLM=1 のときだけ、偽のサーバを使わず本物を呼ぶ (e2e/guide.spec.ts)。
 */
const REAL_LLM = Boolean(process.env.BUNRI_E2E_LLM);

const serverOptions = {
    // すでに何かが居たら失敗させる (別のサーバを相手にテストしてしまわないように)
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
} as const;

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
    webServer: [
        ...(REAL_LLM ? [] : [{
            ...serverOptions,
            command: `node e2e/fake-anthropic.mjs --port ${FAKE_LLM_PORT}`,
            url: `${FAKE_LLM_URL}/__calls`,
            timeout: 20_000,
        }]),
        {
            ...serverOptions,
            command: `node ../scripts/dev-web.mjs --port ${PORT}`,
            url: URL,
            timeout: 120_000,
            // dev-web.mjs は、受け取った環境変数をそのまま API サーバに渡す
            env: REAL_LLM ? {} : { ANTHROPIC_BASE_URL: FAKE_LLM_URL, ANTHROPIC_API_KEY: 'e2e-fake-key' },
        },
    ],
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
});
