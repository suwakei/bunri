#!/usr/bin/env node
/**
 * 開発用のブラウザ起動 — 画面をブラウザで開けるようにする。
 *
 * 製品の形 (デスクトップアプリ) ではない。画面をブラウザで開いて直すときと、
 * ブラウザを自動操作してテストするとき (Playwright、Claude Code の Playwright MCP) に使う。
 * Playwright が操作できるのはブラウザで、Tauri アプリの窓には接続できないため。
 *
 * やること:
 * 1. API サーバ (backend/run_web.py) を、空きポートで、トークン無しで起動する
 * 2. Vite の開発サーバを起動し、/api をそのポートへ中継させる。画面にはデスクトップアプリと同じ CSP を掛ける
 *    (src-tauri/tauri.conf.json から読む。scripts/desktop-csp.mjs)
 * 3. 準備ができたら、標準出力に 1 行の JSON で URL を知らせる:
 *    {"event": "ready", "url": "http://127.0.0.1:5199", "api_port": 54321, "data_dir": "..."}
 *
 * 使い方:
 *   node scripts/dev-web.mjs [--port <画面のポート>] [--data-dir <データ置き場>]
 *
 * - 画面のポートは既定で 5199 (ほかの開発サーバとぶつからないよう、よく使われる番号を避けている)。
 *   使われていたら失敗する (別の番号に逃げない)
 * - データ置き場は既定で一時ディレクトリ。手元の uploads/ results/ projects/ を汚さない
 * - Ctrl+C か、このプロセスの終了で、両方のサーバを止める。API サーバは、このプロセスが
 *   強制終了されても自分で終わる (標準入力のパイプを見張っている)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 引数 `--name value` を読む。無ければ既定値。 */
function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const webPort = Number(option('port', '5199'));
const dataDir = resolve(option('data-dir', mkdtempSync(join(tmpdir(), 'bunri-dev-web-'))));

const children = [];
let stopping = false;

/** 両方のサーバを止めて終了する。 */
function shutdown(code) {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
        // API サーバは標準入力を閉じれば自分で終わる。Vite には終了の合図を送る
        child.stdin?.end();
        child.kill('SIGTERM');
    }
    setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** 子プロセスの出力を、名前を付けて標準エラーに流す (標準出力は JSON の知らせ専用)。 */
function forward(stream, name) {
    createInterface({ input: stream }).on('line', (line) => process.stderr.write(`[${name}] ${line}\n`));
}

/** API サーバを起動し、待ち受けを始めたポートを返す。 */
function startBackend() {
    return new Promise((resolvePort, reject) => {
        // --sidecar: 空きポートで待ち受け、ポートを JSON で知らせ、親 (このプロセス) が居なくなったら終わる。
        // BUNRI_TOKEN を渡さないので、API に鍵はかからない
        const env = { ...process.env, BUNRI_DATA_DIR: dataDir, PYTHONUNBUFFERED: '1' };
        delete env.BUNRI_TOKEN;
        delete env.BUNRI_ALLOWED_ORIGINS;
        const child = spawn('uv', ['run', '--frozen', 'python', 'backend/run_web.py', '--sidecar'], {
            cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.push(child);
        forward(child.stderr, 'backend');
        let announced = false;
        createInterface({ input: child.stdout }).on('line', (line) => {
            if (!announced) {
                try {
                    const message = JSON.parse(line);
                    if (message.event === 'listening' && message.port) {
                        announced = true;
                        resolvePort(message.port);
                        return;
                    }
                } catch {
                    // 知らせではない行。下でログとして流す
                }
            }
            process.stderr.write(`[backend] ${line}\n`);
        });
        child.on('error', (e) => reject(new Error(`API サーバを起動できません (uv が見つからない?): ${e.message}`)));
        child.on('exit', (code) => {
            if (!announced) reject(new Error(`API サーバが待ち受けを始める前に終了しました (終了コード ${code})`));
            else if (!stopping) { process.stderr.write('[dev-web] API サーバが終了しました\n'); shutdown(1); }
        });
    });
}

/** Vite の開発サーバを起動し、画面の URL を返す。 */
function startVite(apiPort) {
    return new Promise((resolveUrl, reject) => {
        const child = spawn('npx', ['vite', '--port', String(webPort), '--strictPort', '--host', '127.0.0.1'], {
            cwd: join(ROOT, 'web-ui'),
            // BUNRI_DEV_CSP: デスクトップアプリと同じ CSP を掛ける (web-ui/vite.config.js)
            env: { ...process.env, BUNRI_API_PORT: String(apiPort), BUNRI_DEV_CSP: '1', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(child);
        forward(child.stderr, 'vite');
        let ready = false;
        createInterface({ input: child.stdout }).on('line', (line) => {
            // Vite は色付きで出すことがあるので、制御文字を落としてから読む
            const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
            if (plain.trim()) process.stderr.write(`[vite] ${plain}\n`);
            const match = plain.match(/Local:\s+(http:\/\/[^\s/]+)/);
            if (match && !ready) { ready = true; resolveUrl(match[1]); }
        });
        child.on('error', (e) => reject(new Error(`Vite を起動できません: ${e.message}`)));
        child.on('exit', (code) => {
            if (!ready) reject(new Error(`Vite が起動しませんでした (終了コード ${code})。ポート ${webPort} が使われていないか確認してください`));
            else if (!stopping) { process.stderr.write('[dev-web] Vite が終了しました\n'); shutdown(1); }
        });
    });
}

try {
    const apiPort = await startBackend();
    const url = await startVite(apiPort);
    console.log(JSON.stringify({ event: 'ready', url, api_port: apiPort, data_dir: dataDir }));
} catch (e) {
    process.stderr.write(`[dev-web] ${e.message}\n`);
    shutdown(1);
}
