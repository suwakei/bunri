/**
 * 本物の窓 (Tauri の WKWebView) で、アプリが起動して使える状態になることを確かめる (make e2e-desktop)。
 *
 * ブラウザのテスト (e2e/) では確かめられないものだけを見る:
 * 同梱した画面が tauri://localhost で出ること、CSP、同梱したフォント、sidecar の起動とトークン、
 * WKWebView での音声の読み込み・再生・書き出し、sidecar から (偽の) Claude までの通し。
 *
 * 画面の構造に深く依存しない (タブの並びなどは変わりうる)。要素は役割と、画面のことば (docs/ui-terms.md) で引く。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeWav, readWav } from '../e2e/helpers.ts';
import { WebDriverSession } from './webdriver.ts';

/** テスト用のビルドが画面に入れる記録 (src-tauri/src/e2e.rs)。 */
interface E2ERecord {
    csp: { directive: string; blocked: string; source: string; line: number }[];
    errors: string[];
}

/** 「CSP が効いているか」を確かめるときに、わざと読み込ませて止めさせる先 (ポート 9 は使われない番号)。 */
const PROBE_ORIGIN = 'http://127.0.0.1:9';

let app: WebDriverSession;

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
