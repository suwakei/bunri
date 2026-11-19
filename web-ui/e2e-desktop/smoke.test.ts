/**
 * 本物の窓 (Tauri の WKWebView) で、アプリが起動して使える状態になることを確かめる (make e2e-desktop)。
 *
 * ブラウザのテスト (e2e/) では確かめられないものだけを見る:
 * 同梱した画面が tauri://localhost で出ること、CSP、同梱したフォント、sidecar の起動とトークン、
 * WKWebView での音声の読み込み・再生・書き出し、sidecar から (偽の) Claude までの通し、
 * 動きの記録がファイルに残ること (ネイティブ側が書く)、名前での操作 (controls.ts。エージェントが窓を操作するときに使う)。
 * アシスタント (右側のドックのチャット) が、本物の窓で、sidecar と (偽の) Claude を通して操作を行えること。
 *
 * 画面の構造に深く依存しない (タブの並びなどは変わりうる)。要素は役割と、画面のことば (docs/ui-terms.md) で引く。
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeWav, readWav } from '../e2e/helpers.ts';
import { announce, clickControl, pressKey, setControl, snapshot } from './controls.ts';
import { WebDriverSession } from './webdriver.ts';

/** テスト用のビルドが画面に入れる記録 (src-tauri/src/e2e.rs)。 */
interface E2ERecord {
    csp: { directive: string; blocked: string; source: string; line: number }[];
    errors: string[];
}

/** 「CSP が効いているか」を確かめるときに、わざと読み込ませて止めさせる先 (ポート 9 は使われない番号)。 */
const PROBE_ORIGIN = 'http://127.0.0.1:9';

let app: WebDriverSession;
/** テストのあいだに使われた sidecar のトークン (起動し直すと変わる)。最後に、記録に残っていないことを確かめる。 */
const seenTokens = new Set<string>();

/** 画面の中の記録 (CSP の違反、捕まえられなかった例外)。わざと起こした違反は除く。 */
async function record(): Promise<E2ERecord> {
    const value = await app.run(() => (window as unknown as { __bunriE2E: E2ERecord }).__bunriE2E);
    return { ...value, csp: value.csp.filter((v) => !String(v.blocked).startsWith(PROBE_ORIGIN)) };
}

/** ステータスバーの文が、指定の文を含むまで待つ。 */
function waitStatus(text: string, timeoutMs?: number): Promise<void> {
    return app.waitFor(`ステータスバーに「${text}」`, (t: string) => {
        const el = document.querySelector('#status-text');
        return el?.textContent?.includes(t) ? true : `いまの文: ${el?.textContent}`;
    }, [text], timeoutMs);
}

/** sidecar の接続情報 (Rust の backend_info)。 */
function backendInfo(): Promise<{ port: number; token: string }> {
    return app.run(() => (window as unknown as {
        __TAURI__: { core: { invoke<T>(cmd: string): Promise<T> } };
    }).__TAURI__.core.invoke<{ port: number; token: string }>('backend_info'));
}

beforeAll(async () => {
    app = await WebDriverSession.create(inject('webdriverPort'));
    // 起動の表示 (BootMessage) が消えて、DAW の画面が出るまで待つ。初回は sidecar の起動を待つ
    await app.waitFor('DAW の画面が出る', () => document.querySelector('#status-text') !== null, [], 60_000);
});

afterAll(async () => {
    // 最後の画面を結果に残す (目で確かめられるように)
    if (app) {
        try {
            const dir = join(import.meta.dirname, '..', 'e2e-desktop-results');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'last-window.png'), await app.screenshot());
        } catch {
            // スクリーンショットが撮れなくても、テストの結果は変えない
        }
        await app.delete();
    }
});

describe('起動', () => {
    it('同梱した画面が tauri://localhost で出て、sidecar とつながる', async () => {
        const where = await app.run(() => ({ href: location.href, desktop: '__TAURI__' in window }));
        expect(where.href).toMatch(/^tauri:\/\/localhost(\/|$)/);
        expect(where.desktop).toBe(true);
        // 起動中の表示は消えている
        expect(await app.run(() => document.body.textContent?.includes('bunri を起動しています') ?? false)).toBe(false);
        // 起動の進み具合は「待ち受け中」
        const boot = await app.run(() => (window as unknown as {
            __TAURI__: { core: { invoke<T>(cmd: string): Promise<T> } };
        }).__TAURI__.core.invoke<{ phase: string }>('boot_status'));
        expect(boot.phase).toBe('ready');
    });

    it('データ置き場が空なら、初回の案内が出て、閉じられる', async () => {
        await app.waitFor('初回の案内', () => document.querySelector('[role="dialog"]') !== null, []);
        await app.click('//*[@role="dialog"]//button[normalize-space()="はじめる"]');
        await app.waitFor('案内が閉じる', () => document.querySelector('[role="dialog"]') === null, []);
        await waitStatus('準備完了');
    });

    it('music の曲をネイティブで一覧表示し、選択して原曲へ取り込む', async () => {
        const name = `bunri-desktop-music-${process.pid}-${Date.now()}.wav`;
        const musicDir = join(import.meta.dirname, '..', '..', 'music');
        const fixture = join(musicDir, name);
        const wav = makeWav(4, [261.63, 329.63, 392, 523.25]);
        mkdirSync(musicDir, { recursive: true });
        writeFileSync(fixture, wav, { flag: 'wx' });
        try {
            const result = await app.run(async (filename: string) => {
                const invoke = (window as unknown as {
                    __TAURI__: { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
                }).__TAURI__.core.invoke;
                const entries = await invoke<{ name: string }[]>('music_list');
                const bytes = await invoke<ArrayBuffer | number[]>('music_read', { name: filename });
                let rejected = false;
                try {
                    await invoke('music_read', { name: '../outside.wav' });
                } catch {
                    rejected = true;
                }
                return { listed: entries.some(entry => entry.name === filename), length: bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length, rejected };
            }, name);
            expect(result).toEqual({ listed: true, length: wav.length, rejected: true });

            await app.waitFor('music の一覧', () => document.querySelector('.music-library') !== null, []);
            await app.run(() => {
                Array.from(document.querySelectorAll<HTMLButtonElement>('.music-library button'))
                    .find(button => button.textContent?.trim() === '一覧を更新')?.click();
            });
            await app.waitFor('合成音源の曲ボタン', (filename: string) =>
                Array.from(document.querySelectorAll<HTMLButtonElement>('.music-library button'))
                    .some(button => button.textContent?.trim() === filename && !button.disabled), [name]);
            expect(await app.run(() => Array.from(document.querySelectorAll('button'))
                .some(button => button.textContent?.trim() === '曲を取り込んで始める'))).toBe(true);
            await app.run((filename: string) => {
                const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.music-library button'))
                    .find(button => button.textContent?.trim() === filename);
                if (!button) throw new Error('曲ボタンがありません');
                button.click();
            }, name);
            await app.waitFor('原曲に合成音源が入る', (filename: string) => {
                const current = document.querySelector('#song-current');
                return current?.textContent?.includes(filename) === true && document.querySelector('#empty-state') === null
                    && Array.from(document.querySelectorAll('#tracks-container .clip-name')).some(clip => clip.textContent === filename);
            }, [name], 60_000);
            await waitStatus('カルテを作りました', 60_000);
            const errors = await app.run(() => (window as unknown as {
                __bunriE2E: { csp: unknown[]; errors: string[] };
            }).__bunriE2E);
            expect(errors).toEqual({ csp: [], errors: [] });
        } finally {
            rmSync(fixture, { force: true });
            // 後続の smoke ケースが、取り込む前と同じ空のプロジェクトから始められるよう戻す。
            await app.click('//button[@aria-label="プロジェクトのメニュー"]');
            await app.click('//button[@role="menuitem"][normalize-space()="新しいプロジェクト"]');
            await app.waitFor('新規作成または保存の確認', () => document.querySelector('#status-text')?.textContent?.includes('新しいプロジェクトにしました')
                || Array.from(document.querySelectorAll('[role="alertdialog"] button'))
                    .some(button => button.textContent?.trim() === '保存しない'), []);
            if (await app.run(() => document.querySelector('[role="alertdialog"]') !== null)) {
                await app.click('//*[@role="alertdialog"]//button[normalize-space()="保存しない"]');
            }
            await waitStatus('新しいプロジェクトにしました');
            await app.waitFor('空のプロジェクト', () => document.querySelector('#empty-state') !== null
                && document.querySelectorAll('#tracks-container .clip').length === 0, []);
        }
    });

});

/** 動きの記録のファイル (テストの一時ディレクトリの中。利用者の記録には混ざらない)。 */
const activityLog = () => join(inject('dataDir'), 'logs', 'activity.log');

/** 記録のファイルに、指定の文を含む行が、この順に出るまで待つ。出た行を返す。 */
async function waitLines(...wanted: string[]): Promise<string[]> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const lines = existsSync(activityLog()) ? readFileSync(activityLog(), 'utf8').split('\n') : [];
        let from = 0;
        const found = wanted.map((text) => {
            const index = lines.findIndex((line, i) => i >= from && line.includes(text));
            if (index >= 0) from = index + 1;
            return index;
        });
        if (found.every((index) => index >= 0)) return found.map((index) => lines[index]);
        if (Date.now() > deadline) throw new Error(`記録に、この順では出ませんでした: ${wanted.join(' → ')}\n${lines.slice(-30).join('\n')}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

describe('動きの記録と、名前での操作', () => {
    it('押したボタンとその結果が、時刻つきでファイルに残る。エージェントが足した行も、同じ並びに入る', async () => {
        const [started] = await waitLines('[app] ==== ');
        expect(started).toMatch(/^\d\d:\d\d:\d\d\.\d{3} \[app\] ==== \d{4}-\d\d-\d\d bunri を起動しました \(版 [\d.]+\) ====$/);

        await announce(app, 'テスト: 「MIDI 書き出し」を押す');
        expect(await clickControl(app, 'MIDI 書き出し')).toBe('ボタン「MIDI 書き出し」');
        // 結果は、ステータスバーに出る (起動したときの「準備完了」から変わる)
        await app.waitFor('書き出しの結果が出る', () => {
            const text = document.querySelector('#status-text')?.textContent ?? '';
            return text !== '' && text !== '準備完了' ? true : `いまの文: ${text}`;
        }, []);
        const status = await app.run(() => document.querySelector('#status-text')?.textContent ?? '');
        const lines = await waitLines('[agent] テスト: 「MIDI 書き出し」を押す', '[click] ボタン「MIDI 書き出し」', status);
        for (const line of lines) expect(line).toMatch(/^\d\d:\d\d:\d\d\.\d{3} \[/);
        // 失敗の知らせは、記録でも失敗と分かる
        expect(lines[2]).toContain('[status] エラー: ');

        // sidecar のトークンが記録に残っていないことは、全部の操作のあとに確かめる (このファイルの最後)
        seenTokens.add((await backendInfo()).token);
    });

    it('つながっている MIDI のポートを、開かずに調べられる', async () => {
        const ports = await app.run(() => (window as unknown as {
            __TAURI__: { core: { invoke<T>(cmd: string): Promise<T> } };
        }).__TAURI__.core.invoke<string[]>('midi_ports'));
        expect(Array.isArray(ports)).toBe(true);
        // 中身は、つながっている機器で変わる (CI には無い)。コマンドが在って、名前の一覧を返すことだけを確かめる
        expect(ports.every((name) => typeof name === 'string' && name !== '')).toBe(true);
    });

    it('「記録」の一覧に、同じ内容と、ファイルの場所が出る', async () => {
        await clickControl(app, '記録');
        await app.waitFor('一覧に、押したボタンとエージェントの行が出る', () => {
            const rows = Array.from(document.querySelectorAll('#activity-panel li')).map((li) => li.textContent ?? '');
            const ok = rows.some((t) => t.includes('アシスタント') && t.includes('テスト: 「MIDI 書き出し」を押す'))
                && rows.some((t) => t.includes('操作') && t.includes('ボタン「MIDI 書き出し」'));
            return ok ? true : rows.join(' | ');
        }, []);
        const footer = await app.run(() => document.querySelector('#activity-panel footer')?.textContent ?? '');
        expect(footer).toContain(join('logs', 'activity.log'));
        await clickControl(app, '動きの記録を閉じる');
        await app.waitFor('一覧が閉じる', () => document.querySelector('#activity-panel') === null, []);
    });

    it('名前で操作できる: 一覧に出る、見つからなければ見えているものを教える、キーも押せる', async () => {
        const shot = await snapshot(app);
        expect(shot.status).not.toBeNull();
        expect(shot.controls).toContainEqual({ kind: 'ボタン', name: '記録', state: '' });
        expect((await snapshot(app, '記録')).controls.map((c) => c.name)).toEqual(['記録']);

        await expect(clickControl(app, 'このなまえのボタンはありません')).rejects.toThrow(/見つかりません。いま見えているもの/);
        await expect(setControl(app, '記録', 'x')).rejects.toThrow(/値を入れられません/);

        // キーは、画面の操作として記録に残る (アプリのショートカットと同じ経路)
        await pressKey(app, 'Shift+F9');
        await waitLines('[key] Shift+F9');
    });
});

/**
 * 仮想の MIDI ポート (鍵盤の代わり) を作る (virtual-midi.swift)。作れない環境 (swift が無い、OS の MIDI が
 * 使えない) では null。
 */
async function startVirtualKeyboard(name: string): Promise<{ play(pitch: number): Promise<void>; close(): void } | null> {
    const child = spawn('swift', [join(import.meta.dirname, 'virtual-midi.swift'), name], { stdio: ['pipe', 'pipe', 'ignore'] });
    const seen: string[] = [];
    let ended = false;
    createInterface({ input: child.stdout }).on('line', (text) => { seen.push(text); });
    child.on('error', () => { ended = true; });
    child.on('exit', () => { ended = true; });
    /** その行が出るまで待つ (出る前に終わった・時間が過ぎたら false)。 */
    const line = async (text: string, timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (!seen.includes(text)) {
            if (ended || Date.now() > deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return true;
    };
    // swift は、初回はスクリプトのコンパイルに数秒かかる
    if (!(await line('ready', 60_000))) {
        child.kill();
        return null;
    }
    return {
        async play(pitch) {
            child.stdin.write(`note ${pitch}\n`);
            if (!(await line(`sent ${pitch}`, 10_000))) throw new Error('仮想の鍵盤が、音を送れませんでした');
        },
        // 標準入力を閉じると、ポートを消して終わる
        close: () => { child.stdin.end(); },
    };
}

describe('MIDI 入力', () => {
    it('入力を開いたあとにつないだ鍵盤が「再検出」で見つかり、鍵盤 1 回は 1 回だけ届く', async (ctx) => {
        const port = `bunri-e2e-${process.pid}`;
        // 先に、鍵盤が無いうちに入力を開く (アプリが OS の MIDI を使い始める)
        await clickControl(app, 'MIDI 入力');
        await waitLines('[click] ボタン「MIDI 入力」', '[midi-in] 開いたポート: ');
        const keyboard = await startVirtualKeyboard(port);
        if (!keyboard) {
            await clickControl(app, 'MIDI 入力を止める');
            ctx.skip('仮想の MIDI ポートを作れない環境です');
            return;
        }
        try {
            // 「再検出」は、あとからつないだ鍵盤を見つける (mac では、最初の MIDI クライアントを run loop を回す
            // スレッドで作らないと、ポートの一覧が古いままになる。src-tauri/src/midi.rs の prime)
            const deadline = Date.now() + 20_000;
            for (;;) {
                await clickControl(app, '再検出');
                await new Promise((resolve) => setTimeout(resolve, 500));
                if (await app.run((name: string) => document.body.textContent?.includes(name) ?? false, port)) break;
                if (Date.now() > deadline) throw new Error('「再検出」を押しても、あとからつないだ鍵盤が出ませんでした');
            }
            // ネイティブ側の記録にも、開いたポートとして残る
            expect(readFileSync(activityLog(), 'utf8').split('\n').some((l) => l.includes('[midi-in] 開いたポート: ') && l.includes(port))).toBe(true);

            // 開き直したあとも、鍵盤 1 回は 1 回だけ届く (前の受け口が残っていると、2 回届いてノートが 2 個ずつ入る)
            await announce(app, 'テスト: 仮想の鍵盤で D4 を弾く');
            await keyboard.play(62);
            await waitLines('[agent] テスト: 仮想の鍵盤で D4 を弾く', `[midi-in] ${port}: note-on ch1 62(D4) vel 100`, '[midi] 離した D4');
            await new Promise((resolve) => setTimeout(resolve, 300));
            const lines = readFileSync(activityLog(), 'utf8').split('\n');
            const after = lines.slice(lines.findIndex((l) => l.includes('[agent] テスト: 仮想の鍵盤で D4 を弾く')));
            expect(after.filter((l) => l.includes('[midi] 押した D4'))).toHaveLength(1);
            expect(after.filter((l) => l.includes('[midi] 離した D4'))).toHaveLength(1);
        } finally {
            keyboard.close();
            await clickControl(app, 'MIDI 入力を止める');
        }
    });
});

describe('CSP とフォント', () => {
    it('起動から今まで、CSP の違反も捕まえられなかった例外も無い', async () => {
        const { csp, errors } = await record();
        expect(csp).toEqual([]);
        expect(errors).toEqual([]);
    });

    it('CSP は実際に効いている (許していない読み込みは止まる)', async () => {
        const directive = await app.run((origin: string) => new Promise<string>((resolve) => {
            document.addEventListener('securitypolicyviolation', (e) => resolve(e.effectiveDirective), { once: true });
            const script = document.createElement('script');
            script.src = `${origin}/bunri-csp-probe.js`;
            document.head.appendChild(script);
        }), PROBE_ORIGIN);
        expect(directive).toMatch(/^script-src/);
    });

    it('同梱したフォントが、すべて読み込める', async () => {
        const faces = await app.run(async () => {
            await document.fonts.ready;
            const all = [...document.fonts];
            // 使われている文字の範囲 (unicode-range) のぶんだけ読まれるので、全部を明示的に読ませる
            await Promise.allSettled(all.map((face) => face.load()));
            return all.map((face) => ({ family: face.family.replace(/"/g, ''), weight: face.weight, range: face.unicodeRange, status: face.status }));
        });
        const families = new Set(faces.map((f) => f.family));
        expect(families).toContain('Outfit Variable');
        expect(families).toContain('IBM Plex Mono');
        expect(faces.filter((f) => f.status !== 'loaded')).toEqual([]);
        const rendering = await app.run(() => ({
            body: getComputedStyle(document.body).fontFamily,
            outfit: document.fonts.check('16px "Outfit Variable"'),
            plex: document.fonts.check('16px "IBM Plex Mono"'),
        }));
        expect(rendering.body).toMatch(/^"?Outfit Variable/);
        expect(rendering.outfit).toBe(true);
        expect(rendering.plex).toBe(true);
        expect((await record()).csp).toEqual([]);
    });
});

describe('sidecar の鍵', () => {
    it('画面からの API 呼び出しには鍵が要り、鍵があれば tauri://localhost から呼べる', async () => {
        const { port, token } = await backendInfo();
        const results = await app.run(async (base: string, key: string) => {
            const without = await fetch(`${base}/api/gm-instruments`);
            const withHeader = await fetch(`${base}/api/gm-instruments`, { headers: { 'X-Bunri-Token': key } });
            const wrong = await fetch(`${base}/api/gm-instruments`, { headers: { 'X-Bunri-Token': 'wrong' } });
            return { without: without.status, withHeader: withHeader.status, wrong: wrong.status };
        }, `http://127.0.0.1:${port}`, token);
        expect(results).toEqual({ without: 401, withHeader: 200, wrong: 401 });
    });

    it('<audio src> は、クエリの鍵で sidecar の音声を読める (鍵が無ければ読めない)', async () => {
        const { port, token } = await backendInfo();
        // sidecar の結果の置き場に、1 秒の音を置く (API で作ると時間がかかるので、直接置く)
        const results = join(inject('dataDir'), 'results');
        mkdirSync(results, { recursive: true });
        writeFileSync(join(results, 'e2e-tone.wav'), makeWav(1));
        const outcome = await app.run((base: string, key: string) => {
            const load = (src: string) => new Promise<string>((resolve) => {
                const audio = new Audio();
                audio.onloadedmetadata = () => resolve(`loaded ${audio.duration.toFixed(2)}`);
                audio.onerror = () => resolve('error');
                audio.src = src;
            });
            return Promise.all([
                load(`${base}/api/download/e2e-tone.wav?token=${encodeURIComponent(key)}`),
                load(`${base}/api/download/e2e-tone.wav`),
            ]);
        }, `http://127.0.0.1:${port}`, token);
        expect(outcome).toEqual(['loaded 1.00', 'error']);
        expect((await record()).csp).toEqual([]);
    });
});

describe('音声', () => {
    it('WAV をタイムラインに置くと、クリップが出て、再生と停止ができる', async () => {
        // 起動したときはトラックが無い (空の状態の案内)。「自由に作る」で Track 1 を作る
        await app.click('//button[normalize-space()="自由に作る"]');
        await app.waitFor('トラックが出る', () => document.querySelector('#tracks-container .track-canvas-wrap') !== null, []);
        const wav = makeWav(2, [440, 660]).toString('base64');
        await app.run(async (data: string) => {
            const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
            const transfer = new DataTransfer();
            transfer.items.add(new File([bytes], 'desktop-e2e.wav', { type: 'audio/wav' }));
            const wrap = document.querySelector('#tracks-container .track-canvas-wrap')!;
            const box = wrap.getBoundingClientRect();
            wrap.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: box.left + 5, clientY: box.top + 10, bubbles: true, cancelable: true }));
        }, wav);
        await app.waitFor('クリップが出る', () => document.querySelectorAll('#tracks-container .clip').length === 1, []);
        await waitStatus('desktop-e2e.wav を「Track 1」に追加しました');

        await app.click('//button[@aria-label="再生"]');
        await waitStatus('再生中');
        // 再生位置が進む = WKWebView の Web Audio が実際に動いている
        const start = await app.run(() => document.querySelector('#time-display')?.textContent ?? '');
        await app.waitFor('再生位置が進む', (first: string) => {
            const now = document.querySelector('#time-display')?.textContent ?? '';
            return now !== first ? true : `止まったまま: ${now}`;
        }, [start], 5_000);
        await app.click('//button[@aria-label="停止"]');
        await waitStatus('停止');
        expect(await record()).toEqual({ csp: [], errors: [] });
    });

    it('WAV の書き出しで、ファイルが保存される (WKWebView の <a download>)', async () => {
        const target = join(inject('downloadDir'), 'bunri_mix.wav');
        await app.click('//button[normalize-space()="WAV 書き出し"]');
        await waitStatus('WAV ファイルを書き出しました', 30_000);
        // 保存は WebView が非同期に行う
        const deadline = Date.now() + 10_000;
        while (!existsSync(target) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        expect(existsSync(target), `${target} が保存されていない`).toBe(true);
        const wav = readWav(readFileSync(target));
        expect(wav.seconds).toBeGreaterThan(1.9);
        expect(wav.peak).toBeGreaterThan(0.1);
    });

    it('ノートを置いて再生すると、再生位置が進み、止めると止まる (Rust の engine でも、Web Audio に切り替わっていても)', async () => {
        // 再生位置の表示 (分:秒) を、秒で読む
        const seconds = () => app.run(() => {
            const match = /^(\d+):(\d+(?:\.\d+)?)$/.exec(document.querySelector('#time-display')?.textContent?.trim() ?? '');
            return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
        });
        // Track 1 を選んでピアノロールを開き、ノートを 1 つ置く (置いたときの試し聴きで、音の出力を開く)
        await app.click('(//*[@id="tracks-container"]//*[contains(@class,"track-name")])[1]');
        await app.waitFor('ピアノロールが Track 1 を開く', () => {
            const label = document.querySelector('#piano-roll-area .area-label')?.textContent ?? '';
            return label.includes('Track 1') ? true : `いまの見出し: ${label}`;
        }, []);
        const before = await app.run(() => document.querySelectorAll('#note-layer .note-block').length);
        await app.run(() => {
            const layer = document.querySelector<HTMLElement>('#note-layer')!;
            const box = layer.getBoundingClientRect();
            layer.dispatchEvent(new MouseEvent('dblclick', { clientX: box.left + 10, clientY: box.top + 200, bubbles: true, cancelable: true }));
        });
        await app.waitFor('ノートが入る', (count: number) => {
            const now = document.querySelectorAll('#note-layer .note-block').length;
            return now === count + 1 ? true : `ノートの数: ${now}`;
        }, [before]);

        // 音の出力を開けたか (開けない機械では、画面は Web Audio に切り替えて鳴らす。どちらでも下の確かめは同じ)
        const output = await app.run(() => (window as unknown as {
            __TAURI__: { core: { invoke<T>(cmd: string): Promise<T> } };
        }).__TAURI__.core.invoke<{ sampleRate: number }>('audio_init').then((info) => `Rust (${info.sampleRate} Hz)`, (e) => `Web Audio (${String(e)})`));
        console.log(`[e2e-desktop] 再生に使う音の出力: ${output}`);

        expect(await seconds()).toBe(0);
        await app.click('//button[@aria-label="再生"]');
        await waitStatus('再生中');
        // 再生位置が進み続ける (Rust の engine なら、位置の event が窓に届いている)
        await app.waitFor('再生位置が進む', () => {
            const text = document.querySelector('#time-display')?.textContent ?? '';
            return text !== '0:00.0' ? true : `止まったまま: ${text}`;
        }, [], 10_000);
        const first = await seconds();
        await app.waitFor('再生位置がさらに進む', (from: number) => {
            const match = /^(\d+):(\d+(?:\.\d+)?)$/.exec(document.querySelector('#time-display')?.textContent?.trim() ?? '');
            const now = match ? Number(match[1]) * 60 + Number(match[2]) : -1;
            return now >= from + 0.3 ? true : `進んでいない: ${from} → ${now}`;
        }, [first], 10_000);

        // 止めると先頭に戻り、そのまま動かない
        await app.click('//button[@aria-label="停止"]');
        await waitStatus('停止');
        await app.waitFor('再生位置が先頭に戻る', () => {
            const text = document.querySelector('#time-display')?.textContent ?? '';
            return text === '0:00.0' ? true : `戻っていない: ${text}`;
        }, []);
        await new Promise((r) => setTimeout(r, 700));
        expect(await seconds()).toBe(0);
        // 音の出力を開けた機械では、最後まで Rust の engine で鳴らし通せたこと (途中で Web Audio に切り替わっていないこと)。
        // 切り替わっても上の確かめは通るので、これが無いと、画面と Rust のつなぎの不具合を見逃す
        // (lib/native-audio.ts が、どちらで鳴らしているかを <html data-bunri-audio> に残す)
        const backend = await app.run(() => document.documentElement.dataset.bunriAudio ?? '');
        if (output.startsWith('Rust')) expect(backend).toBe('native');
        expect(await record()).toEqual({ csp: [], errors: [] });
    });
});

describe('アシスタント', () => {
    /** ドックの中の様子 (待ちの表示、知らせ、操作ログの行、アシスタントの文)。 */
    const dockState = () => app.run(() => {
        const panel = document.querySelector('#assistant-panel');
        const texts = (selector: string) => Array.from(panel?.querySelectorAll(selector) ?? []).map((el) => el.textContent ?? '');
        return {
            open: panel !== null,
            waiting: panel?.querySelector('.assistant-waiting')?.textContent ?? null,
            notices: texts('.assistant-notice'),
            turns: panel?.querySelectorAll('.assistant-turn').length ?? 0,
            rows: Array.from(panel?.querySelectorAll('.assistant-tool') ?? []).map((el) => ({
                tool: el.getAttribute('data-tool'), ok: el.classList.contains('ok'),
                text: el.querySelector('.assistant-tool-text')?.textContent ?? '',
            })),
            replies: texts('.assistant-msg.assistant'),
        };
    });

    /** 頼んで、答え終わるまで待つ (`turns` は、答え終わったあとの依頼の数)。 */
    async function ask(text: string, turns: number) {
        await setControl(app, 'アシスタントに頼むこと', text);
        await clickControl(app, '送る');
        await app.waitFor(`アシスタントが答え終わる: ${text}`, (wanted: number) => {
            const panel = document.querySelector('#assistant-panel');
            const waiting = panel?.querySelector('.assistant-waiting')?.textContent ?? null;
            const done = panel?.querySelectorAll('.assistant-turn').length ?? 0;
            if (waiting === null && done >= wanted) return true;
            const notices = Array.from(panel?.querySelectorAll('.assistant-notice') ?? []).map((el) => el.textContent).join(' | ');
            return `待ち: ${waiting} / 終わった依頼: ${done} / 知らせ: ${notices}`;
        }, [turns], 30_000);
    }

    const trackCount = () => app.run(() => document.querySelectorAll('#tracks-container .track-row').length);
    const noteCount = () => app.run(() => document.querySelectorAll('#note-layer .note-block').length);
    const activityText = () => readFileSync(join(inject('dataDir'), 'logs', 'activity.log'), 'utf8');

    it('頼むと、(偽の) Claude がツールを呼び、操作ログの行が出て、トラックとノートが増える。動きの記録に残り、1 回で元に戻る', async () => {
        const tracksBefore = await trackCount();
        await clickControl(app, 'アシスタント');
        await app.waitFor('ドックが開く', () => document.querySelector('#assistant-panel') !== null, []);

        // tauri://localhost の画面 → sidecar (トークン、CORS) → (偽の) Claude。応答は、少しずつ届く形で読む
        await ask('トラックを足して、ノートを置いて', 1);
        const state = await dockState();
        expect(state.notices, '失敗の知らせは出ていない').toEqual([]);
        expect(state.rows.map((r) => r.tool)).toEqual(['add_track', 'add_notes', 'set_track_mix']);
        expect(state.rows.every((r) => r.ok), JSON.stringify(state.rows)).toBe(true);
        expect(state.rows[0].text).toContain('「アシスタントのベース」を追加しました');
        expect(state.rows[1].text).toContain('ノートを 8 個置きました');
        // 少しずつ届いた文は、答え終わると 1 つの文になっている
        expect(state.replies[state.replies.length - 1]).toContain('トラックを足して、1〜2 小節にベースを置き、音量を下げました。');

        // プロジェクト: トラックが 1 本増え、ピアノロールにノートが 8 個
        expect(await trackCount()).toBe(tracksBefore + 1);
        expect(await noteCount()).toBe(8);

        // 動きの記録 (ファイル): 操作の結果が agent の行で残り、利用者が打った依頼の文は残らない
        const text = activityText();
        expect(text).toContain('[agent] 「アシスタントのベース」を追加しました');
        expect(text).toMatch(/\[agent\] ノートを 8 個置きました/);
        expect(text).toMatch(/\[api\] POST \/api\/assistant\/step → 200/);
        expect(text).not.toContain('トラックを足して、ノートを置いて');
        expect(await record()).toEqual({ csp: [], errors: [] });

        // チャットの「元に戻す」1 回で、この依頼の変更 (トラック・ノート・音量) が全部戻る
        await clickControl(app, 'この依頼の変更を元に戻す');
        await app.waitFor('トラックの数が戻る', (n: number) => document.querySelectorAll('#tracks-container .track-row').length === n, [tracksBefore]);
        expect(await noteCount()).toBe(0);
        // 元に戻したことは記録に残るが、依頼の文は残らない
        expect(activityText()).not.toContain('トラックを足して、ノートを置いて');
    });

    it('再生を頼むと、再生位置が進む (アシスタントから始めた再生が、WKWebView で実際に動く)', async () => {
        await ask('再生して', 2);
        const state = await dockState();
        expect(state.notices).toEqual([]);
        const last = state.rows[state.rows.length - 1];
        expect(last, JSON.stringify(state.rows)).toMatchObject({ tool: 'play', ok: true });

        const start = await app.run(() => document.querySelector('#time-display')?.textContent ?? '');
        await app.waitFor('再生位置が進む', (first: string) => {
            const now = document.querySelector('#time-display')?.textContent ?? '';
            return now !== first ? true : `止まったまま: ${now}`;
        }, [start], 5_000);
        await app.click('//button[@aria-label="停止"]');
        await waitStatus('停止');
        expect(await record()).toEqual({ csp: [], errors: [] });
    });

    it('WAV の書き出しを頼むと、ヘッダのボタンと同じ経路でファイルが保存される', async () => {
        // ヘッダのボタンのテストが保存したファイルを消してから頼む (同じ名前で保存される)
        const target = join(inject('downloadDir'), 'bunri_mix.wav');
        rmSync(target, { force: true });
        await ask('WAV に書き出して', 3);
        const state = await dockState();
        expect(state.notices).toEqual([]);
        const last = state.rows[state.rows.length - 1];
        expect(last, JSON.stringify(state.rows)).toMatchObject({ tool: 'export_wav', ok: true });
        expect(last.text).toContain('WAV ファイルを書き出しました（bunri_mix.wav');

        // 保存は WebView が非同期に行う (Rust の on_download。利用者の操作の外から始めた保存でも通ること)
        const deadline = Date.now() + 10_000;
        while (!existsSync(target) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        expect(existsSync(target), `${target} が保存されていない`).toBe(true);
        const wav = readWav(readFileSync(target));
        expect(wav.seconds).toBeGreaterThan(1.9);
        expect(wav.peak).toBeGreaterThan(0.1);

        await clickControl(app, 'アシスタントを閉じる');
        await app.waitFor('ドックが閉じる', () => document.querySelector('#assistant-panel') === null, []);
        expect(await record()).toEqual({ csp: [], errors: [] });
    });
});

describe('sidecar から Claude まで', () => {
    it('カルテを作って再現ガイドを頼むと、sidecar が (偽の) Claude を呼び、ガイドが返る', async () => {
        const fakeLlm = inject('fakeLlmUrl');
        const before = (await (await fetch(`${fakeLlm}/__calls`)).json()).messages as number;
        const { port, token } = await backendInfo();
        const wav = makeWav(16, [261.63, 196.0, 220.0, 174.61, 261.63, 196.0, 220.0, 174.61]).toString('base64');
        // 画面と同じ経路 (tauri://localhost から、鍵を付けて sidecar へ) で呼ぶ。CSP の connect-src もここで効く
        const guide = await app.run(async (base: string, key: string, data: string) => {
            const headers = { 'X-Bunri-Token': key };
            const form = new FormData();
            form.append('file', new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'desktop-guide.wav', { type: 'audio/wav' }));
            const chart = await fetch(`${base}/api/chart`, { method: 'POST', body: form, headers });
            if (!chart.ok) throw new Error(`カルテ: ${chart.status} ${await chart.text()}`);
            const { chart_id: chartId } = await chart.json();
            const response = await fetch(`${base}/api/chart/${encodeURIComponent(chartId)}/guide`, { method: 'POST', body: new FormData(), headers });
            if (!response.ok) throw new Error(`ガイド: ${response.status} ${await response.text()}`);
            return (await response.json()).guide as { steps: { title: string }[] };
        }, `http://127.0.0.1:${port}`, token, wav);
        expect(guide.steps.map((s) => s.title)).toEqual(['テンポを合わせる', '構成を並べる', '音量をそろえる']);
        const after = (await (await fetch(`${fakeLlm}/__calls`)).json()).messages as number;
        expect(after).toBe(before + 1);
        expect((await record()).csp).toEqual([]);
    });
});

/** そのポートで待ち受けているプロセスの番号 (無ければ空)。 */
function listenersOn(port: number): number[] {
    try {
        return execFileSync('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
            .split('\n').filter(Boolean).map(Number);
    } catch {
        return [];
    }
}

// 最後に置く (sidecar を止めて起動し直すので、ほかのテストの sidecar を入れ替えてしまわないように)
describe('sidecar が止まったとき', () => {
    it('止まったことを知らせ、「再起動」で新しいポートとトークンの sidecar に差し替わる', async () => {
        const before = await backendInfo();
        // 止める前は、知らせは出ていない (重い処理のあとでも、応答が遅いだけで知らせない)
        expect(await app.run(() => document.querySelector('#health-banner') === null)).toBe(true);
        // このテストが起動したアプリの sidecar だけを止める (backend_info が教えたポートで待ち受けているプロセス)
        const pids = listenersOn(before.port);
        expect(pids.length, `ポート ${before.port} で待ち受けている sidecar が見つからない`).toBeGreaterThan(0);
        for (const pid of pids) process.kill(pid, 'SIGKILL');

        // 数秒以内に、止まったことの知らせが出る (モーダルではない)
        await app.waitFor('止まったことの知らせ', () => {
            const banner = document.querySelector('#health-banner');
            return banner?.textContent?.includes('処理を担当する部分が止まりました') ? true : `いまの知らせ: ${banner?.textContent ?? '無し'}`;
        }, [], 20_000);
        // Rust も sidecar の終了に気づいている (画面の問い合わせが先に失敗して、知らせが先に出ることもある)
        await app.waitFor('boot_status が失敗になる', () => (window as unknown as {
            __TAURI__: { core: { invoke<T>(cmd: string): Promise<T> } };
        }).__TAURI__.core.invoke<{ phase: string }>('boot_status').then((s) => s.phase === 'failed' ? true : s.phase), [], 10_000);

        await app.click('//*[@id="health-banner"]//button[normalize-space()="再起動"]');
        await app.waitFor('知らせが消える', () => document.querySelector('#health-banner') === null, [], 60_000);

        const after = await backendInfo();
        expect(after.port).not.toBe(before.port);
        expect(after.token).not.toBe(before.token);
        // 画面は新しい接続先とトークンを使う (画面の apiFetch を通した呼び出しが通る)
        const status = await app.run(async (base: string, key: string) => {
            const response = await fetch(`${base}/api/health`, { headers: { 'X-Bunri-Token': key } });
            return response.status;
        }, `http://127.0.0.1:${after.port}`, after.token);
        expect(status).toBe(200);
        // 画面の見張りも新しい接続先で応答を確かめ続ける (古い接続先を使っていたら、次の回でまた知らせが出る)
        await new Promise((r) => setTimeout(r, 7_000));
        expect(await app.run(() => document.querySelector('#health-banner') === null)).toBe(true);
        // 画面の側に在るトラックとクリップは、そのまま残る
        expect(await app.run(() => document.querySelectorAll('#tracks-container .clip').length)).toBe(1);
        // 前の sidecar のポートは、もう誰も待ち受けていない
        expect(listenersOn(before.port)).toEqual([]);
        expect((await record())).toEqual({ csp: [], errors: [] });
    });
});

describe('プロジェクトのファイル', () => {
    /** 押せるボタンを、画面のことばで押す (メニューの項目も)。 */
    const press = (label: string) => app.click(`//button[normalize-space()="${label}"]`);

    it('保存すると、ダイアログで選んだ場所に .bunri ができ、題名に名前が出る。新しくしてから開くと、トラックと音声とテンポが戻る', async () => {
        const target = inject('projectPath');
        // テンポを変えて、保存していない変更にする (前のテストで置いたクリップも在る)
        await app.run(() => {
            const input = document.querySelector<HTMLInputElement>('#transport-bpm')!;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '96');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await app.waitFor('保存していない変更のしるし', () => document.querySelector('#project-title .unsaved-mark') !== null, []);

        // 保存 (テスト用のビルドでは、ダイアログの代わりに BUNRI_E2E_SAVE_PATH が選ばれる)
        await press('保存');
        await waitStatus('プロジェクト「e2e-project」を保存しました', 60_000);
        expect(existsSync(target)).toBe(true);
        // SQLite の .bunri (v2)。音声 (WKWebView でデコードした WAV の元のバイト列) も中に入っている
        expect(readFileSync(target).subarray(0, 15).toString()).toBe('SQLite format 3');
        await app.waitFor('題名', () => document.title === 'e2e-project — bunri' ? true : document.title, []);
        expect(await app.run(() => document.querySelector('#project-title .unsaved-mark') === null)).toBe(true);
        // 最近使ったプロジェクトは、データ置き場に書かれる (利用者のアプリのデータには書かない)
        const recent = JSON.parse(readFileSync(join(inject('dataDir'), 'recent-projects.json'), 'utf8'));
        // Rust は実体のパスで覚える (mac の一時ディレクトリは /var → /private/var)
        expect(recent.entries[0].path).toBe(realpathSync(target));

        // 新しいプロジェクト (保存したばかりなので確かめは出ない)
        await app.click('//button[@aria-label="プロジェクトのメニュー"]');
        await app.click('//button[@role="menuitem"][normalize-space()="新しいプロジェクト"]');
        await waitStatus('新しいプロジェクトにしました');
        // タイムラインは描き直しのあとで消える (知らせより少し遅れることがある)
        await app.waitFor('クリップが無くなる', () => document.querySelectorAll('#tracks-container .clip').length === 0, []);

        // 開く: 最近使ったプロジェクトから
        await press('開く');
        await app.waitFor('開く一覧に出る', () => [...document.querySelectorAll('[role="dialog"] .project-entry-name')]
            .some((el) => el.textContent === 'e2e-project') ? true : document.querySelector('[role="dialog"]')?.textContent ?? '一覧が無い', []);
        await app.click('//*[@role="dialog"]//button[contains(@class,"project-entry-open")][.//*[normalize-space()="e2e-project"]]');
        await waitStatus('プロジェクト「e2e-project」を開きました', 60_000);
        await app.waitFor('クリップが戻る', () => document.querySelectorAll('#tracks-container .clip').length === 1, []);
        expect(await app.run(() => document.querySelector<HTMLInputElement>('#transport-bpm')!.value)).toBe('96');

        // 開いた音声は再生できる
        await app.click('//button[@aria-label="再生"]');
        await waitStatus('再生中');
        await app.click('//button[@aria-label="停止"]');
        // ここで知らせの文を「停止」に変えておく。下の 2 回目の「開く」は、1 回目と同じ文で終わるので、
        // 文が残ったままだと、開き終わるのを待たずに先へ進んでしまう (遅れて終わった「開く」が、次のテストの
        // 操作を上書きして落ちたことがある)
        await waitStatus('停止');

        // 開く: 「ほかのファイルを選ぶ…」(テスト用のビルドでは BUNRI_E2E_OPEN_PATH が選ばれる)
        await press('開く');
        await app.waitFor('開く一覧', () => document.querySelector('[role="dialog"]') !== null, []);
        const pickedAt = Date.now();
        await press('ほかのファイルを選ぶ…');
        await waitStatus('プロジェクト「e2e-project」を開きました', 60_000);
        console.log(`[e2e-desktop] ファイルを選んで開くのにかかった時間: ${Date.now() - pickedAt} ms`);
        await app.waitFor('クリップが戻る', () => document.querySelectorAll('#tracks-container .clip').length === 1, []);
        // 開き直した音声も再生できる
        await app.click('//button[@aria-label="再生"]');
        await waitStatus('再生中');
        await app.click('//button[@aria-label="停止"]');
        await waitStatus('停止');
        expect(await record()).toEqual({ csp: [], errors: [] });
        writeFileSync(join(import.meta.dirname, '..', 'e2e-desktop-results', 'project-reopened.png'), await app.screenshot());
    });

    it('保存していない変更があるときに窓を閉じようとすると、閉じずに尋ねる。キャンセルすれば窓はそのまま', async () => {
        await app.run(() => {
            const input = document.querySelector<HTMLInputElement>('#transport-bpm')!;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '100');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await app.waitFor('保存していない変更のしるし', () => document.querySelector('#project-title .unsaved-mark') !== null, []);
        // Rust に、保存していない変更が在ることが届くまで少し待つ (題名と一緒に送っている)
        await app.waitFor('題名', () => document.title.includes('●') ? true : document.title, []);
        await app.closeWindow();
        await app.waitFor('確かめの窓', () => {
            const dialog = document.querySelector('[role="alertdialog"]');
            return dialog?.textContent?.includes('窓を閉じる前に') ? true : `いま: ${dialog?.textContent ?? '無し'}`;
        }, [], 10_000);
        await app.click('//*[@role="alertdialog"]//button[normalize-space()="キャンセル"]');
        await app.waitFor('確かめの窓が閉じる', () => document.querySelector('[role="alertdialog"]') === null, []);
        expect(await app.run(() => document.querySelector('#status-text') !== null)).toBe(true);
        // 後片付け (窓を閉じて終わる) で止まらないよう、保存しておく
        await press('保存');
        await waitStatus('を保存しました', 60_000);
    });
});

describe('動きの記録に残さないもの', () => {
    it('ここまでの操作 (音声の読み込み、書き出し、ガイド、sidecar の起動し直し、保存と開く) のあとも、sidecar のトークンが記録に無い', async () => {
        seenTokens.add((await backendInfo()).token);
        // 起動し直しのテストで、トークンは少なくとも 1 回変わっている
        expect(seenTokens.size).toBeGreaterThanOrEqual(2);
        const text = readFileSync(join(inject('dataDir'), 'logs', 'activity.log'), 'utf8');
        // 記録は、ここまでの操作を実際に含んでいる (空のファイルを見ているのではない)
        expect(text).toContain('[api] ');
        expect(text).toContain('[click] ボタン「保存」');
        for (const token of seenTokens) expect(text).not.toContain(token);
        // クエリの値は載せない (音声の名前)
        expect(text).not.toMatch(/\?name=[^…]/);
    });
});

describe('楽器の音源', () => {
    it('導入した SFZ を読み、鍵盤の試聴とデバイスを使わない WAV 書き出しに渡せる', async () => {
        // 実際のピアノは取得せず、識別できる高さの録音素材で IPC からサンプラーまでを通す。
        const version = '3382bf9496bba2486f5ab0de55a264d1dfc38404';
        const directory = join(inject('dataDir'), 'instruments', 'salamander', version);
        mkdirSync(join(directory, 'Samples'), { recursive: true });
        mkdirSync(join(directory, 'Data'), { recursive: true });
        writeFileSync(join(directory, 'LICENSE'), 'テスト用に生成した波形');
        writeFileSync(join(directory, 'Samples', 'test.wav'), makeWav(2, [659.255], 48000));
        writeFileSync(join(directory, 'Salamander Grand Piano V3.sfz'),
            '<region> sample=Samples/test.wav key=60 ampeg_release=0.12');
        writeFileSync(join(directory, '.installed.json'), JSON.stringify({
            version, sha256: '4f64bc2dadf2eb893e7fb824c2982c03962025e1c82ab9e593e2f7269c50a476',
        }));
        try {
            const result = await app.run(async () => {
                const invoke = (window as unknown as {
                    __TAURI__: { core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> } };
                }).__TAURI__.core.invoke;
                // 再生や準備より先に書き出しても、導入済みの録音を使う。
                const raw = await invoke<ArrayBuffer | number[]>('audio_render_song', { song: {
                    bpm: 120, offsetSec: 0, beatsPerBar: 4,
                    tracks: [{ id: 991, gainDb: 0, pan: 0, audible: true,
                        notes: [{ start: 0, length: 960, pitch: 60, velocity: 96 }], clips: [] }],
                } });
                const prepared = await invoke<{ installed: boolean }>('audio_prepare_piano');
                await invoke('audio_live_note', { pitch: 60, velocity: 96 });
                await invoke('audio_live_note', { pitch: 60, velocity: 0 });
                await invoke('audio_live_all_off');
                const bytes = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
                const context = new AudioContext();
                try {
                    const audio = await context.decodeAudioData(bytes);
                    const data = audio.getChannelData(0);
                    let crossings = 0, peak = 0;
                    const begin = Math.round(audio.sampleRate * 0.1), end = Math.round(audio.sampleRate * 0.4);
                    for (let i = begin; i < end; i++) {
                        peak = Math.max(peak, Math.abs(data[i]));
                        if (data[i - 1] <= 0 && data[i] > 0) crossings++;
                    }
                    return { installed: prepared.installed, frequency: crossings / 0.3, peak,
                        sampleRate: audio.sampleRate, duration: audio.duration };
                } finally { await context.close(); }
            });
            expect(result.installed).toBe(true);
            // C4 の三角波 (261.6Hz) ではなく、SFZ に割り当てた録音 (659.3Hz) が鳴る。
            expect(result.frequency).toBeGreaterThan(650);
            expect(result.frequency).toBeLessThan(670);
            expect(result.peak).toBeGreaterThan(0.001);
            expect(result.duration).toBeGreaterThan(0.5);
            expect(await record()).toEqual({ csp: [], errors: [] });
        } finally {
            rmSync(directory, { recursive: true, force: true });
            await app.run(() => (window as unknown as {
                __TAURI__: { core: { invoke(cmd: string): Promise<unknown> } };
            }).__TAURI__.core.invoke('audio_prepare_piano'));
        }
    });

    it('内蔵のゲーム音色を通信せず用意し、違う2音色を同時に書き出せる。素材不足は別音色に置き換えない', async () => {
        const result = await app.run(async () => {
            const invoke = (window as unknown as {
                __TAURI__: { core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> } };
            }).__TAURI__.core.invoke;
            const info = await invoke<{ port: number; token: string }>('backend_info');
            const origin = `http://127.0.0.1:${info.port}`;
            const response = await fetch(`${origin}/api/instruments/game-lead/install`, {
                method: 'POST', headers: { 'X-Bunri-Token': info.token },
            });
            if (!response.ok) throw new Error('内蔵音色を用意できませんでした');
            const prepared = await response.json() as { installed: boolean; downloadBytes: number };
            const library = await fetch(`${origin}/api/instruments`, { headers: { 'X-Bunri-Token': info.token } })
                .then((r) => r.json()) as { instruments: { id: string; installed: boolean }[] };
            const track = (id: number, instrumentId: string, pan = 0) => ({
                id, instrumentId, pan, gainDb: 0, audible: true,
                notes: [{ start: 0, length: 960, pitch: 60, velocity: 96 }], clips: [],
            });
            const song = (tracks: ReturnType<typeof track>[]) => ({ bpm: 120, offsetSec: 0, beatsPerBar: 4, tracks });
            const context = new AudioContext();
            try {
                await invoke('audio_prepare_instrument', { instrumentId: 'game-lead' });
                await invoke('audio_live_note', { pitch: 60, velocity: 96, instrumentId: 'game-lead' });
                await invoke('audio_prepare_instrument', { instrumentId: 'game-bell' });
                await invoke('audio_live_note', { pitch: 60, velocity: 96, instrumentId: 'game-bell' });
                await invoke('audio_live_note', { pitch: 60, velocity: 0, instrumentId: 'game-lead' });
                await invoke('audio_live_all_off');
                const raw = await invoke<ArrayBuffer | number[]>('audio_render_song', {
                    song: song([track(1, 'game-lead', -1), track(2, 'game-bell', 1)]),
                });
                const buffer = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
                const audio = await context.decodeAudioData(buffer);
                const left = audio.getChannelData(0), right = audio.getChannelData(1);
                let leftPeak = 0, rightPeak = 0, difference = 0, count = 0;
                for (let i = Math.round(audio.sampleRate * 0.05); i < Math.round(audio.sampleRate * 0.25); i++) {
                    leftPeak = Math.max(leftPeak, Math.abs(left[i]));
                    rightPeak = Math.max(rightPeak, Math.abs(right[i]));
                    difference += (left[i] - right[i]) ** 2;
                    count++;
                }
                let missing = '';
                try {
                    await invoke('audio_render_song', { song: song([track(3, 'violin')]) });
                } catch (error) { missing = String(error); }
                return { installed: prepared.installed, downloadBytes: prepared.downloadBytes,
                    readyGames: library.instruments.filter((i) => i.id.startsWith('game-') && i.installed).length,
                    leftPeak, rightPeak, difference: Math.sqrt(difference / count), missing };
            } finally {
                await context.close();
                await invoke('audio_live_all_off');
            }
        });
        expect(result.installed).toBe(true);
        expect(result.downloadBytes).toBe(0);
        expect(result.readyGames).toBe(15);
        expect(result.leftPeak).toBeGreaterThan(0.01);
        expect(result.rightPeak).toBeGreaterThan(0.01);
        expect(result.difference).toBeGreaterThan(0.01);
        expect(result.missing).toContain('BUNRI_INSTRUMENT_UNAVAILABLE:violin:');
        expect(await record()).toEqual({ csp: [], errors: [] });
    });
});
