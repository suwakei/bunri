/**
 * 本物の窓 (Tauri の WKWebView) を操作するテストの設定 (make e2e-desktop)。
 *
 * テストの書き方は vitest、窓の操作は WebDriver (アプリの中の tauri-plugin-wdio-webdriver)。
 * アプリは 1 つだけ起動して全部のテストで使う (起動に十数秒かかるため)。順番に、1 つずつ走らせる。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        root: import.meta.dirname,
        include: ['*.test.ts'],
        environment: 'node',
        globalSetup: ['./global-setup.ts'],
        fileParallelism: false,
        sequence: { concurrent: false },
        testTimeout: 90_000,
        hookTimeout: 120_000,
        teardownTimeout: 30_000,
        reporters: ['verbose'],
    },
});
