#!/usr/bin/env node
/**
 * 本物の窓を、その場で操作して確かめるための起動 (開発用。npm run desktop:inspect)。
 *
 * テスト用のビルドのアプリを、テストと同じく利用者のデータから切り離して起動し (launch.ts)、
 * WebDriver のセッションを 1 つ作って、その URL を 1 行の JSON で知らせる:
 *
 *   {"event": "ready", "session": "http://127.0.0.1:<port>/session/<id>", ...}
 *
 * 同じ内容を `e2e-desktop-results/session.json` にも書く。操作のコマンド (drive.ts。npm run desktop:drive) は
 * これを読んで窓につなぐので、Claude Code などのエージェントは URL を持ち回らなくてよい:
 *
 *   node e2e-desktop/drive.ts ui                 # いま押せるものの一覧
 *   node e2e-desktop/drive.ts click "MIDI 入力"   # 押して、そのあと動きの記録に増えた行を出す
 *   node e2e-desktop/drive.ts stop               # 終わらせる (Ctrl+C と同じ)
 *
 * W3C WebDriver の API を直接送ることもできる:
 *
 *   curl -s <session>/screenshot | jq -r .value | base64 -d > window.png      # 窓の画像
 *
 * Ctrl+C (または drive.ts stop) で、アプリ・sidecar・偽の Claude サーバをまとめて止める。
 * 先に node e2e-desktop/build.mjs でテスト用のビルドを作っておく。
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { launchApp, SESSION_FILE } from './launch.ts';
import { WebDriverSession } from './webdriver.ts';

const app = await launchApp();
const session = await WebDriverSession.create(app.webdriverPort);
const info = {
    event: 'ready',
    session: `http://127.0.0.1:${app.webdriverPort}/session/${session.id}`,
    webdriver_port: app.webdriverPort,
    session_id: session.id,
    pid: process.pid,
    data_dir: app.dataDir,
    download_dir: app.downloadDir,
    log: app.logFile,
    activity_log: app.activityLog,
};
// 書きかけを読まれないよう、別の名前で書いてから置き換える
writeFileSync(`${SESSION_FILE}.tmp`, JSON.stringify(info, null, 2));
renameSync(`${SESSION_FILE}.tmp`, SESSION_FILE);
console.log(JSON.stringify(info));

let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    const problems = await app.stop();
    rmSync(SESSION_FILE, { force: true });
    for (const problem of problems) process.stderr.write(`[inspect] ${problem}\n`);
    process.exit(problems.length > 0 ? 1 : 0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
