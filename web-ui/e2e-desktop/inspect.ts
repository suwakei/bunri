#!/usr/bin/env node
/**
 * 本物の窓を、その場で覗いて確かめるための起動 (開発用。npm run desktop:inspect)。
 *
 * テスト用のビルドのアプリを、テストと同じく利用者のデータから切り離して起動し (launch.ts)、
 * WebDriver のセッションを 1 つ作って、その URL を 1 行の JSON で知らせる:
 *
 *   {"event": "ready", "session": "http://127.0.0.1:<port>/session/<id>", ...}
 *
 * Claude Code (や curl) は、この URL に W3C WebDriver の API を送って窓を操作できる:
 *
 *   curl -s <session>/screenshot | jq -r .value | base64 -d > window.png      # 窓の画像
 *   curl -s -X POST <session>/execute/sync -H 'Content-Type: application/json' \
 *        -d '{"script": "return document.title", "args": []}'                  # 画面の中で JS を実行
 *
 * Ctrl+C で、アプリ・sidecar・偽の Claude サーバをまとめて止める。
 * 先に node e2e-desktop/build.mjs でテスト用のビルドを作っておく。
 */
import { launchApp } from './launch.ts';
import { WebDriverSession } from './webdriver.ts';

const app = await launchApp();
const session = await WebDriverSession.create(app.webdriverPort);
console.log(JSON.stringify({
    event: 'ready',
    session: `http://127.0.0.1:${app.webdriverPort}/session/${session.id}`,
    data_dir: app.dataDir,
    download_dir: app.downloadDir,
    log: app.logFile,
}));

let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    const problems = await app.stop();
    for (const problem of problems) process.stderr.write(`[inspect] ${problem}\n`);
    process.exit(problems.length > 0 ? 1 : 0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
