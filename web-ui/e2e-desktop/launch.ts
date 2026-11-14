/**
 * テスト用のビルドのアプリを、利用者のデータから切り離して起動し、終わらせる。
 *
 * テスト (global-setup.ts) と、Claude Code が窓を覗くための起動 (inspect.ts) が使う。
 *
 * - データの置き場 (BUNRI_DATA_DIR) と、書き出したファイルの保存先は一時ディレクトリ。
 *   利用者の uploads/ results/ や ~/Downloads、アプリのデータ置き場には触れない
 * - Claude は偽のサーバ (e2e/fake-anthropic.mjs) を向かせ、API キーは偽の値を環境変数で渡す
 *   (キーチェーンは読まない。src-tauri/src/sidecar.rs の for_e2e)
 * - WebDriver サーバと偽の Claude サーバのポートは、空いている番号を OS に選ばせる
 * - 終わらせるときは、窓を閉じて (利用者が閉じたときと同じ終わり方) アプリを終わらせ、
 *   sidecar まで終わったことを確かめる。残っていたら止めて、問題として返す
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { WebDriverSession, waitForWebDriver } from './webdriver.ts';

const WEB_UI = resolve(import.meta.dirname, '..');
/** テスト用のビルドの置き場 (build.mjs と合わせる)。開発用の `tauri dev` のビルドとは分けてある。 */
export const APP_BINARY = resolve(WEB_UI, '..', 'src-tauri', 'target', 'e2e', 'debug', 'bunri');
/** アプリのログなどを残す場所。 */
export const RESULTS_DIR = join(WEB_UI, 'e2e-desktop-results');

/** 起動したアプリ。 */
export interface LaunchedApp {
    /** アプリの中の WebDriver サーバのポート (127.0.0.1)。 */
    webdriverPort: number;
    /** sidecar のデータ置き場 (BUNRI_DATA_DIR)。 */
    dataDir: string;
    /** 書き出したファイルの保存先。 */
    downloadDir: string;
    /** プロジェクトの保存・開くのダイアログの代わりに使う場所 (BUNRI_E2E_SAVE_PATH / BUNRI_E2E_OPEN_PATH)。 */
    projectPath: string;
    /** 偽の Claude サーバの URL。 */
    fakeLlmUrl: string;
    /** アプリの出力 (標準出力と標準エラー) のファイル。 */
    logFile: string;
    /** 終わらせる。問題 (窓を閉じても終わらなかった、sidecar が残った) の説明を返す。 */
    stop(options?: { keep?: boolean }): Promise<string[]>;
}

/** 空いているポートを OS に選ばせる。 */
function freePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(() => resolvePort(port));
        });
    });
}

/** そのポートで待ち受けているプロセスの番号 (無ければ空)。 */
function listeners(port: number): number[] {
    try {
        return execFileSync('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
            .split('\n').filter(Boolean).map(Number);
    } catch {
        return [];
    }
}

/** プロセスが終わるのを待つ。時間内に終われば true。 */
function waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolveExit) => {
        const timer = setTimeout(() => resolveExit(false), timeoutMs);
        child.once('exit', () => { clearTimeout(timer); resolveExit(true); });
    });
}

/** 偽の Claude サーバを起動し、準備ができるまで待つ。 */
async function startFakeLlm(port: number): Promise<ChildProcess> {
    const child = spawn(process.execPath, [join(WEB_UI, 'e2e', 'fake-anthropic.mjs'), '--port', String(port)], {
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((ready, reject) => {
        createInterface({ input: child.stdout! }).once('line', () => ready());
        child.once('exit', (code) => reject(new Error(`偽の Claude サーバが起動しませんでした (終了コード ${code})`)));
    });
    return child;
}

/** テスト用のビルドのアプリを起動し、WebDriver サーバが応答するまで待つ。 */
export async function launchApp(): Promise<LaunchedApp> {
    if (!existsSync(APP_BINARY)) {
        throw new Error(`テスト用のアプリが在りません: ${APP_BINARY}\n先に node e2e-desktop/build.mjs (make e2e-desktop) でビルドしてください`);
    }
    mkdirSync(RESULTS_DIR, { recursive: true });
    const workDir = mkdtempSync(join(tmpdir(), 'bunri-e2e-desktop-'));
    const dataDir = join(workDir, 'data');
    const downloadDir = join(workDir, 'downloads');
    mkdirSync(dataDir);
    mkdirSync(downloadDir);
    // ネイティブのダイアログは WebDriver で操作できないので、テスト用のビルドはこの場所が選ばれたことにする
    // (src-tauri/src/e2e.rs の SAVE_PATH_ENV)。利用者の ~/Documents には書かない
    const projectPath = join(workDir, 'projects', 'e2e-project.bunri');
    mkdirSync(dirname(projectPath));

    const children: ChildProcess[] = [];
    // 途中で止められても (Ctrl+C など)、起動したものを残さない
    const killAll = () => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); };
    process.once('exit', killAll);

    const fakeLlmPort = await freePort();
    const fakeLlm = await startFakeLlm(fakeLlmPort);
    children.push(fakeLlm);
    const fakeLlmUrl = `http://127.0.0.1:${fakeLlmPort}`;

    const webdriverPort = await freePort();
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        BUNRI_DATA_DIR: dataDir,
        BUNRI_E2E_DOWNLOAD_DIR: downloadDir,
        BUNRI_E2E_SAVE_PATH: projectPath,
        BUNRI_E2E_OPEN_PATH: projectPath,
        TAURI_WEBDRIVER_PORT: String(webdriverPort),
        // テストを回している機械のスピーカーから音を出さない (Rust の engine が、作った音に 0 を掛けてから
        // デバイスへ渡す。出力デバイスを開くところから位置を送るところまでは、配布物と同じに動く)
        BUNRI_E2E_AUDIO_SILENT: '1',
        ANTHROPIC_BASE_URL: fakeLlmUrl,
        ANTHROPIC_API_KEY: 'e2e-fake-key',
        PYTHONUNBUFFERED: '1',
    };
    // 手元の設定 (本物の API キーなど) を、sidecar に渡さない
    for (const name of ['BUNRI_TOKEN', 'BUNRI_ALLOWED_ORIGINS', 'CLAUDE_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'BUNRI_GUIDE_MODEL']) delete env[name];

    const logFile = join(RESULTS_DIR, 'app.log');
    const log = createWriteStream(logFile);
    const app = spawn(APP_BINARY, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(app);
    app.stdout!.pipe(log, { end: false });
    app.stderr!.pipe(log, { end: false });

    const cleanup = (keep: boolean) => {
        killAll();
        process.removeListener('exit', killAll);
        log.end();
        if (keep) process.stderr.write(`[e2e-desktop] 一時ディレクトリを残しました: ${workDir}\n`);
        else rmSync(workDir, { recursive: true, force: true });
    };

    try {
        await waitForWebDriver(webdriverPort, 60_000, () => app.exitCode === null);
    } catch (e) {
        cleanup(false);
        throw new Error(`${(e as Error).message}\nアプリの出力: ${logFile}`);
    }

    const stop = async ({ keep = false } = {}): Promise<string[]> => {
        const problems: string[] = [];
        // 窓を閉じる前に、sidecar のポートを聞いておく (閉じたあとに残っていないかを確かめるため)
        let sidecarPort: number | null = null;
        try {
            const session = await WebDriverSession.create(webdriverPort);
            // sidecar が止まったまま (テストが途中で失敗した) なら聞けないが、窓は閉じる
            sidecarPort = await session.run(async () => {
                const tauri = (window as unknown as { __TAURI__: { core: { invoke<T>(cmd: string): Promise<T> } } }).__TAURI__;
                return (await tauri.core.invoke<{ port: number }>('backend_info')).port;
            }).catch(() => null);
            // メインの窓を閉じる = 利用者が窓を閉じたときと同じ終わり方 (sidecar も一緒に止まるはず)
            await session.closeWindow();
        } catch (e) {
            problems.push(`窓を閉じられませんでした: ${(e as Error).message}`);
        }
        if (!(await waitExit(app, 10_000))) {
            problems.push('窓を閉じても、10 秒以内にアプリが終わりませんでした');
            app.kill('SIGTERM');
            if (!(await waitExit(app, 5_000))) app.kill('SIGKILL');
        }
        if (sidecarPort !== null) {
            // sidecar は、アプリが終わると自分も終わる約束 (docs/desktop-architecture.md「sidecar を孤児にしない」)
            const deadline = Date.now() + 5_000;
            while (listeners(sidecarPort).length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
            const left = listeners(sidecarPort);
            if (left.length > 0) {
                problems.push(`アプリが終わったあとも sidecar が残っていました (ポート ${sidecarPort}、pid ${left.join(', ')})。止めました`);
                for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* もう終わっている */ } }
            }
        }
        fakeLlm.kill('SIGTERM');
        await waitExit(fakeLlm, 3_000);
        cleanup(keep);
        return problems;
    };

    return { webdriverPort, dataDir, downloadDir, projectPath, fakeLlmUrl, logFile, stop };
}
