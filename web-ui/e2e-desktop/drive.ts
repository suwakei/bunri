#!/usr/bin/env node
/**
 * 本物の窓を、画面のことばで操作し、そのあと何が起きたかを動きの記録で確かめるコマンド (npm run desktop:drive)。
 *
 * Claude Code などのエージェントが、利用者に「こう操作して」と頼まれたときに使う。1 回の操作ごとに 1 回呼ぶ:
 *
 *   node e2e-desktop/drive.ts ui [絞り込む文]              いま押せるものの一覧と、ステータスバーの文
 *   node e2e-desktop/drive.ts click <名前> [--nth N]       押す
 *   node e2e-desktop/drive.ts set <名前> <値> [--nth N]    選択肢を選ぶ / チェックを オン・オフ / 入力欄に入れる
 *   node e2e-desktop/drive.ts key <キー>                   キーを押す (Space、Meta+z、Escape…)
 *   node e2e-desktop/drive.ts eval <JavaScript>            画面の中で実行する (式ならその値。文を並べるなら return で返す。await 可)
 *   node e2e-desktop/drive.ts shot [名前]                  窓の画像を保存して、場所を出す
 *   node e2e-desktop/drive.ts log [--tail N]               動きの記録の、前に読んだところから先 (--tail は末尾の N 行)
 *   node e2e-desktop/drive.ts wait-log <正規表現> [--timeout 秒] [--since-action]
 *                                                          記録に、当てはまる行が出るまで待つ (下の「待つとき」)
 *   node e2e-desktop/drive.ts wait-ready [--timeout 秒]    窓の起動 (npm run desktop:inspect) が終わるまで待つ
 *   node e2e-desktop/drive.ts status                       窓が動いているか、記録の場所
 *   node e2e-desktop/drive.ts stop                         窓を閉じて、アプリと sidecar を終わらせる
 *
 * 操作 (click / set / key) は、まず動きの記録に「アシスタント: いまから何をするか」の行を足し (利用者が見ている
 * 「記録」の一覧にも出る)、操作し、少し待ってから、そのあいだに記録に増えた行とステータスバーの文を出す。
 * つまり 1 回の呼び出しで「何をしたか → 何が起きたか」が読める。待つ長さは --settle ミリ秒 (既定 500)。
 * 操作できなかったとき (名前が見つからない、など) は、その旨の行も足す (「押す」とだけ残って、押したように見えないように)。
 *
 * 待つとき: wait-log は、前に読んだところから先を見る。まだ一度も読んでいない記録では、いまより後に出た行だけを見る
 * (前に起きたことに当たって、すぐ返らないように)。操作 (click など) は、そのあと増えた行を読んだことにするので、
 * 「操作の結果として出る行」を待つときは --since-action を付ける (直前の操作の行から先を見る)。
 *
 * 相手は、npm run desktop:inspect で起動した窓 (テスト用のビルド。利用者のデータから切り離してある)。
 * 利用者が自分で動かしているアプリ (make desktop) は操作できないが、その動きの記録は読める:
 *
 *   node e2e-desktop/drive.ts log --dev                    リポジトリの logs/activity.log を読む
 *   node e2e-desktop/drive.ts wait-log <正規表現> --dev
 *
 * 動きの記録の中身と置き場は src-tauri/src/activity.rs。使い方の全体は docs/ui-testing.md と .claude/skills/drive。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { announce, clickControl, pressKey, setControl, snapshot, type Snapshot } from './controls.ts';
import { RESULTS_DIR, SESSION_FILE } from './launch.ts';
import { asScript, endOf, headOf, readLines, resume, type Position } from './reader.ts';
import { WebDriverSession } from './webdriver.ts';

/** 利用者が自分で動かしている開発用のアプリ (make desktop) の、動きの記録。 */
const DEV_ACTIVITY_LOG = resolve(import.meta.dirname, '..', '..', 'logs', 'activity.log');
/** 記録を、どこまで読んだか (ファイルごとの位置と、直前の操作を始めた位置)。 */
const POSITIONS_FILE = join(RESULTS_DIR, 'drive-positions.json');
/** 初めて読むファイルで、さかのぼって出す行数。 */
const FIRST_READ_LINES = 100;

/** inspect.ts が書く、動いている窓の情報。 */
interface SessionInfo {
    webdriver_port: number;
    session_id: string;
    pid: number;
    log: string;
    activity_log: string;
    data_dir: string;
    download_dir: string;
}

/** 窓の情報は在るのに、窓が応答しないときの説明。 */
const GONE = '窓が応答しません (閉じられたか、アプリが終わっています)。`node e2e-desktop/drive.ts stop` で片付けてから、起動し直してください';

/** 使い方の間違いなど、説明だけ出して終わる失敗。 */
class Problem extends Error {}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** プロセスが動いているか。 */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** そのプロセスが、窓を起動した側 (inspect.ts) か。番号が別のプロセスに使い回されていないかを確かめる。 */
function isInspect(pid: number): boolean {
    try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes('inspect.ts');
    } catch {
        return false;
    }
}

/** 動いている窓の情報を読む。無ければ (または、起動した側がもう居なければ) null。 */
function readSession(): SessionInfo | null {
    let info: SessionInfo;
    try {
        info = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as SessionInfo;
    } catch {
        // まだ無い、または読めない
        return null;
    }
    if (!alive(info.pid) || !isInspect(info.pid)) {
        // 起動した側が、後片付けをせずに終わっている
        rmSync(SESSION_FILE, { force: true });
        return null;
    }
    return info;
}

/** 動いている窓につなぐ。無ければ、始め方を説明して終わる。 */
function connect(): { info: SessionInfo; session: WebDriverSession } {
    const info = readSession();
    if (!info) {
        throw new Problem('操作できる窓が動いていません。先に、裏で `cd web-ui && npm run desktop:inspect` を起動し、`node e2e-desktop/drive.ts wait-ready` で待ってください');
    }
    return { info, session: WebDriverSession.attach(info.webdriver_port, info.session_id) };
}

/** 引数から `--名前 値` を取り出す (取り出したぶんは、引数から消す)。 */
function option(args: string[], name: string): string | null {
    const index = args.indexOf(`--${name}`);
    if (index < 0) return null;
    const value = args[index + 1];
    if (value === undefined) throw new Problem(`--${name} には値が要ります`);
    args.splice(index, 2);
    return value;
}

/** 引数から `--名前` (値なし) を取り出す。 */
function flag(args: string[], name: string): boolean {
    const index = args.indexOf(`--${name}`);
    if (index < 0) return false;
    args.splice(index, 1);
    return true;
}

/** 数の引数を読む。 */
function numberOption(args: string[], name: string, fallback: number): number {
    const raw = option(args, name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Problem(`--${name} は 0 以上の数にしてください: ${raw}`);
    return value;
}

/** 覚えている位置。`read`: どこまで読んだか。`action`: 直前の操作を始めた位置。どちらもファイルごと。 */
interface Positions {
    read: Record<string, Position>;
    action: Record<string, Position>;
}

function loadPositions(): Positions {
    try {
        const saved = JSON.parse(readFileSync(POSITIONS_FILE, 'utf8')) as Partial<Positions>;
        return { read: saved.read ?? {}, action: saved.action ?? {} };
    } catch {
        return { read: {}, action: {} };
    }
}

function savePosition(kind: keyof Positions, file: string, position: Position): void {
    const positions = loadPositions();
    positions[kind][file] = position;
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

/**
 * 記録の、前に読んだところから先を読んで、読んだ位置を進める。
 *
 * 初めて読むファイル (覚えていない、または同じ名前で別の中身に替わった) は、末尾の決まった行数だけを出す。
 *
 * @param options.skipExisting - 初めて読むファイルでは、いま在る行を読んだことにして、何も返さない (これから出る行を待つとき)
 */
function readNew(file: string, options?: { skipExisting?: boolean }): string[] {
    const { from, fresh } = resume(file, loadPositions().read[file]);
    if (fresh && options?.skipExisting) {
        savePosition('read', file, endOf(file));
        return [];
    }
    const { lines, next } = readLines(file, from);
    savePosition('read', file, { offset: next, head: headOf(file) });
    if (fresh && lines.length > FIRST_READ_LINES) {
        return [`（初めて読む記録なので、末尾の ${FIRST_READ_LINES} 行だけ出します。全部は ${file}）`, ...lines.slice(-FIRST_READ_LINES)];
    }
    return lines;
}

/** 読む記録のファイルを決める (--dev なら、利用者が自分で動かしているアプリのもの)。 */
function activityFile(args: string[]): string {
    if (flag(args, 'dev')) {
        if (!existsSync(DEV_ACTIVITY_LOG)) {
            throw new Problem(`まだ記録がありません: ${DEV_ACTIVITY_LOG}\n利用者のターミナルで make desktop を起動してもらうと、ここに書かれます`);
        }
        return DEV_ACTIVITY_LOG;
    }
    const info = readSession();
    if (info) return info.activity_log;
    // 窓を終わらせたあとは、残しておいた写しを読む (launch.ts)
    const kept = join(RESULTS_DIR, 'activity.log');
    if (existsSync(kept)) return kept;
    throw new Problem('操作できる窓が動いておらず、残した記録もありません。利用者が自分で動かしているアプリの記録を読むなら --dev を付けてください');
}

function printLines(lines: string[], empty: string): void {
    console.log(lines.length > 0 ? lines.join('\n') : empty);
}

function printSnapshot(shot: Snapshot): void {
    console.log(`窓の題名: ${shot.title}`);
    console.log(`ステータスバー: ${shot.status ?? '（DAW の画面ではありません）'}`);
    console.log(`押せるもの (${shot.controls.length} 個):`);
    for (const c of shot.controls) console.log(`  ${c.kind}「${c.name}」${c.state ? `（${c.state}）` : ''}`);
}

/**
 * 操作を 1 つ行い、そのあいだに動きの記録に増えた行と、ステータスバーの文を出す。
 *
 * @param intent - 記録に足す「いまから何をするか」(パスワードの欄に入れる値など、秘密になりうるものは入れない)
 * @param act - 操作。行ったことの説明を返す
 * @param noteDone - 行ったことの説明も、記録に足すか (`intent` だけでは、何になったかが分からない操作)
 */
async function perform(settle: number, intent: string, act: (session: WebDriverSession) => Promise<string>, noteDone = false): Promise<void> {
    const { info, session } = connect();
    // ここまでの記録は読んだことにして、この操作で増えたぶんだけを出す。wait-log --since-action は、ここから先を見る
    const start = endOf(info.activity_log);
    savePosition('read', info.activity_log, start);
    savePosition('action', info.activity_log, start);
    await announce(session, intent);
    let done: string;
    try {
        done = await act(session);
    } catch (e) {
        // 利用者が見ている「記録」に「押す」とだけ残ると、押したように見える。できなかったことも残す
        const reason = String((e as Error)?.message ?? e).split('\n')[0].replace(/^画面の中で失敗しました: /, '');
        await announce(session, `できませんでした: ${reason.slice(0, 120)}`).catch(() => undefined);
        throw e;
    }
    if (noteDone) await announce(session, done);
    await sleep(settle);
    console.log(`行ったこと: ${done}`);
    console.log('そのあと記録に増えた行:');
    printLines(readNew(info.activity_log).map((l) => `  ${l}`), '  （増えていません）');
    const status = await session.run(() => document.querySelector('#status-text')?.textContent ?? null);
    console.log(`ステータスバー: ${status ?? '（DAW の画面ではありません）'}`);
}

/** 操作のコマンドに共通の引数 (`--nth N`、`--settle ミリ秒`) を取り出す。残りが、名前や値。 */
function actionOptions(args: string[]): { nth: number | null; settle: number } {
    const nth = option(args, 'nth');
    if (nth !== null && !(Number.isInteger(Number(nth)) && Number(nth) >= 1)) throw new Problem(`--nth は 1 以上の整数にしてください: ${nth}`);
    return { nth: nth === null ? null : Number(nth), settle: numberOption(args, 'settle', 500) };
}

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
    async ui(args) {
        const { session } = connect();
        printSnapshot(await snapshot(session, args[0] ?? null));
    },

    async click(args) {
        const { nth, settle } = actionOptions(args);
        const [label] = args;
        if (!label) throw new Problem('押すものの名前を指定してください: click <名前>');
        await perform(settle, `「${label}」を押す`, (session) => clickControl(session, label, nth).then((what) => `${what} を押した`));
    },

    async set(args) {
        const { nth, settle } = actionOptions(args);
        const [label, value] = args;
        if (!label || value === undefined) throw new Problem('名前と値を指定してください: set <名前> <値>');
        // 入れる値は、「いまから何をするか」には載せない (パスワードの欄かもしれない)。選択肢やチェックは、行ったことの説明に出る
        await perform(settle, `「${label}」の値を変える`, (session) => setControl(session, label, value, nth), true);
    },

    async key(args) {
        const { settle } = actionOptions(args);
        const [combo] = args;
        if (!combo) throw new Problem('キーを指定してください: key <キー> (Space、Meta+z など)');
        await perform(settle, `キー ${combo} を押す`, (session) => pressKey(session, combo).then((keys) => `キー ${keys} を押した`));
    },

    async eval(args) {
        const [body] = args;
        if (!body) throw new Problem('実行する JavaScript を指定してください: eval <JavaScript>');
        const { session } = connect();
        console.log(JSON.stringify(await session.execute<unknown>(asScript(body)), null, 2));
    },

    async shot(args) {
        const { session } = connect();
        const name = (args[0] ?? `shot-${new Date().toISOString().slice(11, 19).replaceAll(':', '')}`).replace(/[^\w.-]/g, '_');
        const file = join(RESULTS_DIR, name.endsWith('.png') ? name : `${name}.png`);
        writeFileSync(file, await session.screenshot());
        console.log(file);
    },

    async log(args) {
        const tail = option(args, 'tail');
        const file = activityFile(args);
        if (tail !== null) {
            const { lines } = readLines(file, 0);
            printLines(lines.slice(-Math.max(1, Number(tail) || 1)), '（記録は空です）');
            return;
        }
        printLines(readNew(file), '（前に読んだところから、増えていません）');
    },

    async 'wait-log'(args) {
        const timeout = numberOption(args, 'timeout', 30);
        const sinceAction = flag(args, 'since-action');
        const file = activityFile(args);
        const [pattern] = args;
        if (!pattern) throw new Problem('待つ行の正規表現を指定してください: wait-log <正規表現>');
        const wanted = new RegExp(pattern);
        if (sinceAction) {
            // 直前の操作を始めたところから見直す (操作のコマンドが、もう読んだことにした行も含める)
            const action = loadPositions().action[file];
            if (!action || resume(file, action).fresh) throw new Problem('--since-action: この記録には、直前の操作がありません');
            savePosition('read', file, action);
        }
        const deadline = Date.now() + timeout * 1000;
        for (;;) {
            // まだ読んだことのない記録では、これから出る行だけを待つ (前に起きたことに当たって、すぐ返らないように)
            const lines = readNew(file, { skipExisting: true });
            if (lines.length > 0) console.log(lines.join('\n'));
            if (lines.some((l) => wanted.test(l))) return;
            if (Date.now() > deadline) throw new Problem(`${timeout} 秒待ちましたが、/${pattern}/ に当てはまる行は記録に出ませんでした`);
            await sleep(250);
        }
    },

    async 'wait-ready'(args) {
        const timeout = numberOption(args, 'timeout', 600);
        const deadline = Date.now() + timeout * 1000;
        let unreachable = 0;
        // 初回はテスト用のビルドに数分かかる。窓の情報が書かれ、DAW の画面が出るまで待つ
        for (;;) {
            const info = readSession();
            if (info) {
                const session = WebDriverSession.attach(info.webdriver_port, info.session_id);
                const ready = await session.run(() => document.querySelector('#status-text') !== null).catch(() => null);
                if (ready) {
                    console.log(`窓の準備ができました。動きの記録: ${info.activity_log}`);
                    return;
                }
                // 窓の情報は在るのに応答しない = 窓が閉じられた (起動した側だけが残っている)
                unreachable = ready === null ? unreachable + 1 : 0;
                if (unreachable >= 15) throw new Problem(GONE);
            }
            if (Date.now() > deadline) throw new Problem(`${timeout} 秒待ちましたが、窓の準備が終わりませんでした。npm run desktop:inspect の出力を確かめてください`);
            await sleep(1000);
        }
    },

    async status() {
        const info = readSession();
        if (!info) {
            console.log('操作できる窓は動いていません');
        } else {
            console.log(`操作できる窓が動いています (起動した側の pid ${info.pid})`);
            console.log(`動きの記録: ${info.activity_log}`);
            console.log(`アプリの出力: ${info.log}`);
            console.log(`データの置き場 (一時): ${info.data_dir}`);
        }
        console.log(`利用者が自分で動かしているアプリの記録: ${DEV_ACTIVITY_LOG}${existsSync(DEV_ACTIVITY_LOG) ? '' : '（まだ無い）'}`);
    },

    async stop() {
        const info = readSession();
        if (!info) {
            console.log('操作できる窓は動いていません');
            return;
        }
        // 起動した側 (inspect.ts) に、Ctrl+C と同じ合図を送る。窓を閉じ、sidecar まで終わったことを確かめてから終わる
        process.kill(info.pid, 'SIGINT');
        const deadline = Date.now() + 40_000;
        while (alive(info.pid)) {
            if (Date.now() > deadline) throw new Problem(`40 秒待ちましたが、起動した側 (pid ${info.pid}) が終わりません`);
            await sleep(250);
        }
        console.log(`終わらせました。動きの記録の写し: ${join(RESULTS_DIR, 'activity.log')}`);
    },
};

const [command, ...rest] = process.argv.slice(2);
const run = command ? COMMANDS[command] : undefined;
if (!run) {
    console.error(`使い方: node e2e-desktop/drive.ts <${Object.keys(COMMANDS).join(' | ')}> …\n詳しくは、このファイルの頭の説明`);
    process.exit(2);
}
try {
    await run(rest);
} catch (e) {
    // 画面の中で起きた失敗 (見つからない、2 つ以上ある) は、説明の文をそのまま出す
    const message = e instanceof Problem ? e.message : String((e as Error)?.message ?? e);
    console.error(/fetch failed|ECONNREFUSED/.test(message) ? GONE : message);
    process.exit(1);
}
