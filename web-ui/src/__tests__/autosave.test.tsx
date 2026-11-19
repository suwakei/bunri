/**
 * 自動保存と、落ちたときの復旧 (lib/autosave.ts、lib/project-actions.ts、components/ProjectDialogs.tsx)。
 *
 * - 間隔: 最後の変更から落ち着くのを待って書く。変更が続いても、長くても決めた時間で書く
 * - 再生中などは次の機会に回す。利用者の保存とは重ならない (途中の自動保存はやめて、保存を先に通す)
 * - 自動保存しても、保存していない変更の印・開いているプロジェクトの情報・元に戻す履歴は変わらない
 * - 保存できた・元に戻して保存したときと同じになったら、復旧用の写しを消す
 * - 起動したとき: 前回の続きが残っていれば窓で尋ねる。続きを開くと、名前と場所が戻り、保存していない変更になる
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode, useEffect } from 'react';
import { render, cleanup, act, screen, fireEvent, waitFor } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';
import type { AutosaveBusy, AutosaveHost, RecoveryInfo } from '../lib/autosave';
import type { SavedBaseline } from '../lib/store';

expect.extend(matchers);

class MockGainNode {
    gain = { value: 1 };
    connect() { return this; }
}
class MockStereoPannerNode {
    pan = { value: 0 };
    connect() { return this; }
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return new MockStereoPannerNode() as unknown as StereoPannerNode; }
    createBuffer(_ch: number, length: number, rate: number) {
        return { duration: length / rate, sampleRate: rate, numberOfChannels: 1, length, getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer;
    }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { default: engine } = await import('../lib/engine');
const {
    autosave, PRESERVING_REASON, AUTOSAVE_SETTING_KEY, AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_WAIT_MS, AUTOSAVE_PLAYING_MAX_WAIT_MS, AUTOSAVE_RECORDING_MAX_WAIT_MS,
} = await import('../lib/autosave');
const { DawProvider, useDaw, EMPTY_PROJECT } = await import('../lib/store');
const { useProjectActions, useProjectWiring } = await import('../lib/project-actions');
const { default: ProjectDialogs } = await import('../components/ProjectDialogs');
const { jobTracker } = await import('../lib/jobs');
const { health } = await import('../lib/health');
const { noteMidiMessage } = await import('../lib/useMidiInput');
const pf = await import('../lib/project-file');
const { resetPromptsForTest } = await import('../lib/project-prompts');
type Daw = ReturnType<typeof useDaw>;
type Actions = ReturnType<typeof useProjectActions>;

// ---- 偽の API ----

interface Call { method: string; path: string; body: Record<string, unknown> | null }

let calls: Call[];
/** 置き場に在る復旧用の写しの目印 (偽の API が持つ) */
let stored: RecoveryInfo | null;
/** 捨てたときの目印 (偽の API が持つ。これより前の世代の自動保存は断る) */
let fence: { session: string; generation: number } | null;
/** 応答を差し替える口 (返せば、それを応答にする) */
let intercept: (call: Call) => Promise<Response | undefined> | Response | undefined;
let tokens: number;

const token = (n: number) => n.toString(16).padStart(24, '0');
const seen = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });

/** 開いたときに返す、プロジェクトの文書 (トラック 1 本とノート 1 つ)。 */
function openedDocument(tokenName: string) {
    return {
        version: 1, meta: { name: '文書の中の名前', createdAt: '2026-11-18T00:00:00Z', uuid: 'u-1' },
        grid: { bpm: 96, beatsPerBar: 3, gridOffset: 0 },
        tracks: [{
            name: 'Lead', role: null, part: null, practiceOf: null, gain: 0, pan: 0, mute: false, solo: false,
            notes: [note('C', 4, 0)], referenceNotes: null, clips: [],
        }],
        chart: null, state: {}, history: [], token: tokenName, audioBase: `/api/project/${tokenName}/audio/`,
    };
}

beforeEach(() => {
    calls = [];
    stored = null;
    fence = null;
    tokens = 0;
    intercept = () => undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const call: Call = {
            method: (init?.method ?? 'GET').toUpperCase(), path: url,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        };
        calls.push(call);
        const replaced = await intercept(call);
        if (replaced) return replaced;
        const { method, path, body } = call;
        if (path === '/api/project/recovery') {
            if (method === 'GET') return Response.json({ recovery: stored });
            // 捨てたときの目印 (backend/project_store.py の recovery_clear / recovery_put と同じ): 同じ画面の古い世代は断る
            const writer = body?.writer as { session: string; generation: number } | undefined;
            if (method === 'DELETE') {
                if (writer) fence = writer;
                const removed = stored !== null; stored = null; return Response.json({ removed });
            }
            if (writer && fence && writer.session === fence.session && writer.generation < fence.generation) {
                return Response.json({ detail: '保存しないと決めたあとの自動保存なので、残しませんでした' }, { status: 409 });
            }
            stored = { name: (body?.name ?? null) as string | null, path: (body?.path ?? null) as string | null, file: (body?.file ?? null) as string | null, saved_at: 1_800_000_000, size_bytes: 10 };
            return Response.json(stored);
        }
        if (path === '/api/project/recovery/open') {
            if (!stored) return Response.json({ detail: '復旧できる変更は残っていません' }, { status: 404 });
            return Response.json({ token: token(0xabc), name: stored.name, path: stored.path, file: stored.file });
        }
        if (path.startsWith('/api/project/open/')) return Response.json(openedDocument(path.split('/').pop()!));
        if (path === '/api/project/audio/missing') return Response.json({ missing: [] });
        if (path === '/api/project/document') return Response.json({ token: token(++tokens), size_bytes: 10 });
        if (path === '/api/project/library/save') return Response.json({ file: body?.file ?? `${String(body?.name)}.bunri`, name: String(body?.file ?? body?.name).replace(/\.bunri$/, '') });
        return Response.json({});
    }));
    localStorage.clear();
    resetPromptsForTest();
    autosave.resetForTest();
    jobTracker.resetForTest();
    health.resetForTest();
    engine.init();
    engine.stop();
    engine.tracks = [];
    engine.bpm = 120; engine.beatsPerBar = 4; engine.gridOffset = 0;
});

afterEach(() => {
    cleanup();
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    autosave.resetForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// ---- 自動保存そのもの (画面は偽物) ----

/** 控え。`version` が同じなら、中身も同じと見なされる。 */
const HISTORY: never[] = [];
const GRID = { bpm: 120, beatsPerBar: 4, offsetSec: 0 };
const baseline = (version: number): SavedBaseline => ({ snapshot: { tracks: [], grid: GRID }, chartId: null, history: HISTORY, touch: version });

function fakeHost() {
    const state = {
        dirty: true, busy: null as AutosaveBusy | null, version: 1, writes: 0, failing: [] as string[],
        write: (async () => ({ token: token(++tokens), name: '曲', path: null, file: '曲.bunri' })) as AutosaveHost['writeCopy'],
    };
    const host: AutosaveHost = {
        isDirty: () => state.dirty,
        busy: () => state.busy,
        capture: () => baseline(state.version),
        writeCopy: (cancelled) => { state.writes += 1; return state.write(cancelled); },
        onFailing: (reason) => { state.failing.push(reason); },
    };
    /** 中身を変えて、変わったことを知らせる。 */
    const change = () => { state.version += 1; autosave.touched(); };
    return { state, host, change };
}

/** 起動したときの確かめを済ませて (前回の続きは無い)、偽の画面をつなぐ。 */
async function started() {
    const h = fakeHost();
    autosave.attach(h.host);
    expect(await autosave.checkStartup()).toBeNull();
    return h;
}

describe('自動保存の間隔', () => {
    beforeEach(() => { vi.useFakeTimers(); });

    it('既定は、最後の変更から 30 秒、長くても 2 分', () => {
        expect(AUTOSAVE_IDLE_MS).toBe(30_000);
        expect(AUTOSAVE_MAX_WAIT_MS).toBe(120_000);
    });

    it('最後の変更から落ち着くのを待って、1 回だけ書く。中身が変わらなければ、もう書かない', async () => {
        const { state, change } = await started();
        change();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS - 1);
        expect(state.writes).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(state.writes).toBe(1);
        expect(seen('POST', '/api/project/recovery')).toHaveLength(1);
        expect(seen('POST', '/api/project/recovery')[0].body).toEqual({ token: token(1), name: '曲', path: null, file: '曲.bunri', writer: { session: expect.any(String), generation: expect.any(Number) } });

        // 中身は同じまま、変わったかもしれないと知らされた (再生しただけ、など)
        autosave.touched();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS);
        expect(state.writes).toBe(1);
        // 変われば、また落ち着くのを待って書く
        change();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
        expect(state.writes).toBe(2);
    });

    it('変更が続いているあいだは待つが、最初の変更から 2 分経てば書く', async () => {
        const { state, change } = await started();
        // 20 秒おきに変え続ける (30 秒の落ち着きは、いつまでも来ない)
        for (let t = 0; t < AUTOSAVE_MAX_WAIT_MS; t += 20_000) {
            change();
            expect(state.writes).toBe(0);
            await vi.advanceTimersByTimeAsync(20_000);
        }
        expect(state.writes).toBe(1);
        // 書いたあとの変更は、またそこから数え直す
        change();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS - 1);
        expect(state.writes).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(state.writes).toBe(2);
    });

    it('保存していない変更が無くなっていたら、書かない', async () => {
        const { state, change } = await started();
        change();
        state.dirty = false;
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS);
        expect(state.writes).toBe(0);
    });

    it('再生中などは書かずに、少し後でもう一度試す', async () => {
        autosave.configure({ idle: 1000, maxWait: 5000, retry: 200 });
        const { state, change } = await started();
        state.busy = 'playing';
        change();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.writes).toBe(0);
        state.busy = null;
        await vi.advanceTimersByTimeAsync(200);
        expect(state.writes).toBe(1);
    });

    it('再生し続けていても (区間ループを回しながらの打ち込み)、最初の変更から 5 分経てば書く。そのあとも 5 分ごと', async () => {
        expect(AUTOSAVE_PLAYING_MAX_WAIT_MS).toBe(300_000);
        const { state, change } = await started();
        state.busy = 'playing';
        // 10 秒おきに打ち込み続ける
        for (let t = 0; t < AUTOSAVE_PLAYING_MAX_WAIT_MS; t += 10_000) {
            change();
            expect(state.writes).toBe(0);
            await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(state.writes).toBe(1);
        // 書いたあとの変更から、また 5 分
        change();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_PLAYING_MAX_WAIT_MS - 5_000);
        expect(state.writes).toBe(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(state.writes).toBe(2);
        // 再生を止めれば、いつもどおり 30 秒で書く
        state.busy = null;
        change();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
        expect(state.writes).toBe(3);
    });

    it('リアルタイム録音で弾いている最中は 5 分を過ぎても待ち、弾く手が止まった合間に書く。弾き続けていても 10 分で書く', async () => {
        expect(AUTOSAVE_RECORDING_MAX_WAIT_MS).toBe(600_000);
        const { state, change } = await started();
        state.busy = 'recording';
        change();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_PLAYING_MAX_WAIT_MS + 30_000);
        expect(state.writes).toBe(0);
        // 手が止まった (再生は続いている): 5 分はもう過ぎているので、次の機会に書く
        state.busy = 'playing';
        await vi.advanceTimersByTimeAsync(5_000);
        expect(state.writes).toBe(1);

        // 弾き続けている: 10 分で書く
        state.busy = 'recording';
        change();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_RECORDING_MAX_WAIT_MS - 5_000);
        expect(state.writes).toBe(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(state.writes).toBe(2);
    });

    it('ドラッグの途中・時間のかかる処理の最中・届かないあいだは、どれだけ経っても書かない', async () => {
        const { state, change } = await started();
        state.busy = 'blocked';
        change();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_RECORDING_MAX_WAIT_MS * 2);
        expect(state.writes).toBe(0);
        state.busy = null;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(state.writes).toBe(1);
    });

    it('テスト用の設定: 保存領域の値で、間隔を変える・自動保存をしない', async () => {
        const { state, change } = await started();
        localStorage.setItem(AUTOSAVE_SETTING_KEY, JSON.stringify({ idleMs: 50, maxWaitMs: 400 }));
        change();
        await vi.advanceTimersByTimeAsync(50);
        expect(state.writes).toBe(1);
        localStorage.setItem(AUTOSAVE_SETTING_KEY, 'off');
        change();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS);
        expect(state.writes).toBe(1);
        // 読めない値は、無いものとして扱う
        localStorage.setItem(AUTOSAVE_SETTING_KEY, '{ こわれた');
        change();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
        expect(state.writes).toBe(2);
    });
});

describe('利用者の保存と重ならない', () => {
    beforeEach(() => { vi.useFakeTimers(); autosave.configure({ idle: 1000, maxWait: 5000, retry: 200 }); });

    it('止めているあいだは書かず、止めるのをやめると書く', async () => {
        const { state, change } = await started();
        const resume = await autosave.hold();
        change();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.writes).toBe(0);
        resume();
        resume(); // 2 回呼んでも、止めた数は狂わない
        await vi.advanceTimersByTimeAsync(200);
        expect(state.writes).toBe(1);
    });

    it('書いている途中に保存が始まったら、自動保存はやめて、止まってから保存を通す', async () => {
        const { state, change } = await started();
        let finish!: () => void;
        let sawCancel: boolean | null = null;
        state.write = async (cancelled) => {
            await new Promise<void>((resolve) => { finish = resolve; });
            sawCancel = cancelled();
            return cancelled() ? null : { token: token(++tokens), name: '曲', path: null, file: null };
        };
        change();
        await vi.advanceTimersByTimeAsync(1000);
        expect(state.writes).toBe(1);

        let held = false;
        const holding = autosave.hold().then((resume) => { held = true; return resume; });
        await vi.advanceTimersByTimeAsync(0);
        expect(held).toBe(false); // 途中の自動保存が止まるまで、保存は待つ
        finish();
        const resume = await holding;
        expect(sawCancel).toBe(true);
        expect(seen('POST', '/api/project/recovery')).toHaveLength(0);
        // 保存が終わるまでは書かない。終わっても変更が残っていれば (保存に失敗した、など)、書き直す
        state.write = async () => ({ token: token(++tokens), name: '曲', path: null, file: null });
        await vi.advanceTimersByTimeAsync(1000);
        expect(state.writes).toBe(1);
        resume();
        await vi.advanceTimersByTimeAsync(200);
        expect(state.writes).toBe(2);
        expect(seen('POST', '/api/project/recovery')).toHaveLength(1);
    });

    it('自動保存で送った音声を送り直さないよう、保存は最後の復旧用の写しを元にする', async () => {
        const { change } = await started();
        expect(autosave.baseFor('開いている写し')).toBe('開いている写し');
        change();
        await vi.advanceTimersByTimeAsync(1000);
        expect(autosave.baseFor('開いている写し')).toBe(token(1));
        await autosave.discard();
        expect(autosave.baseFor('開いている写し')).toBe('開いている写し');
    });
});

describe('復旧用の写しを消す・失敗を知らせる', () => {
    beforeEach(() => { vi.useFakeTimers(); autosave.configure({ idle: 1000, maxWait: 5000, retry: 200 }); });

    it('書いたものが在るときだけ消す。変更が無くなったときも消す', async () => {
        const { change } = await started();
        await autosave.discard();
        expect(seen('DELETE', '/api/project/recovery')).toHaveLength(0);
        change();
        await vi.advanceTimersByTimeAsync(1000);
        expect(stored).not.toBeNull();
        await autosave.discard();
        await autosave.discard();
        expect(seen('DELETE', '/api/project/recovery')).toHaveLength(1);
        expect(stored).toBeNull();

        change();
        await vi.advanceTimersByTimeAsync(1000);
        expect(stored).not.toBeNull();
        await autosave.settled();
        expect(stored).toBeNull();
    });

    it('失敗が 3 回続いたら、1 度だけ知らせる。書けるようになれば、数え直す', async () => {
        const { state, change } = await started();
        let failing = true;
        intercept = (c) => (failing && c.method === 'POST' && c.path === '/api/project/recovery'
            ? Response.json({ detail: '置き場に書けません' }, { status: 500 }) : undefined);
        change();
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(state.writes).toBe(2);
        expect(state.failing).toEqual([]);
        await vi.advanceTimersByTimeAsync(1000);
        expect(state.failing).toHaveLength(1);
        expect(state.failing[0]).toContain('置き場に書けません');
        await vi.advanceTimersByTimeAsync(3000);
        expect(state.writes).toBeGreaterThanOrEqual(5);
        expect(state.failing).toHaveLength(1);

        failing = false;
        await vi.advanceTimersByTimeAsync(1000);
        expect(stored).not.toBeNull();
        failing = true;
        change();
        await vi.advanceTimersByTimeAsync(3000);
        expect(state.failing).toHaveLength(2);
    });
});

describe('起動したときの確かめ', () => {
    beforeEach(() => { vi.useFakeTimers(); autosave.configure({ idle: 1000, maxWait: 5000, retry: 200, startupRetry: 100 }); });

    it('前回の続きが在るあいだは、答えが出るまで書かない・消さない。問いは 1 回だけ', async () => {
        stored = { name: '前回の曲', path: '/Users/me/曲.bunri', file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        const { state, host, change } = fakeHost();
        autosave.attach(host);
        expect(await autosave.checkStartup()).toMatchObject({ name: '前回の曲', path: '/Users/me/曲.bunri' });
        expect(await autosave.checkStartup()).toMatchObject({ name: '前回の曲' });
        expect(seen('GET', '/api/project/recovery')).toHaveLength(1);
        expect(autosave.claimOffer()).toBe(true);
        expect(autosave.claimOffer()).toBe(false);

        change();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.writes).toBe(0);
        await autosave.discard();
        expect(stored).not.toBeNull();
        expect(seen('DELETE', '/api/project/recovery')).toHaveLength(0);

        // 捨てると決めたら消して、そこから自動保存を始める
        await autosave.startupAnswered(false);
        expect(stored).toBeNull();
        await vi.advanceTimersByTimeAsync(200);
        expect(state.writes).toBe(1);
    });

    it('続きを開いたら、復旧用の写しは残したまま、自動保存を始める', async () => {
        stored = { name: null, path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        const { state, host, change } = fakeHost();
        autosave.attach(host);
        await autosave.checkStartup();
        await autosave.startupAnswered(true);
        expect(stored).not.toBeNull();
        change();
        await vi.advanceTimersByTimeAsync(1000);
        expect(state.writes).toBe(1);
        // 保存できたら消す (続きを開いただけで、まだ自動保存していなくても)
        autosave.resetForTest();
        stored = { name: null, path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        await autosave.checkStartup();
        await autosave.startupAnswered(true);
        await autosave.discard();
        expect(stored).toBeNull();
    });

    it('処理を担当する部分に届かないあいだは待ち、届くようになってから確かめる', async () => {
        stored = { name: '前回の曲', path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        let reachable = false;
        intercept = () => { if (!reachable) throw new TypeError('Failed to fetch'); return undefined; };
        let found: RecoveryInfo | null | undefined;
        void autosave.checkStartup().then((r) => { found = r; });
        await vi.advanceTimersByTimeAsync(1000);
        expect(found).toBeUndefined();
        expect(seen('GET', '/api/project/recovery').length).toBeGreaterThanOrEqual(2);
        reachable = true;
        await vi.advanceTimersByTimeAsync(1000);
        expect(found).toMatchObject({ name: '前回の曲' });
    });

    it('失敗の応答が続いて確かめられなかったら、前回の写しを上書きしない (この回は書かず、1 度だけ知らせる。消しもしない)', async () => {
        stored = { name: '前回の曲', path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        intercept = (c) => (c.method === 'GET' && c.path === '/api/project/recovery'
            ? Response.json({ detail: '読めません' }, { status: 500 }) : undefined);
        const { state, host, change } = fakeHost();
        autosave.attach(host);
        let found: RecoveryInfo | null | undefined;
        void autosave.checkStartup().then((r) => { found = r; });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(found).toBeNull();
        change();
        await vi.advanceTimersByTimeAsync(10_000);
        change();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.writes).toBe(0);
        expect(seen('POST', '/api/project/recovery')).toHaveLength(0);
        expect(state.failing).toEqual([PRESERVING_REASON]);
        // 保存しても (捨てても)、尋ねていない前回の写しは消さない
        await autosave.discard();
        expect(seen('DELETE', '/api/project/recovery')).toHaveLength(0);
        expect(stored).toMatchObject({ name: '前回の曲' });
    });
});

// ---- 画面とつないで ----

let daw: Daw;
let actions: Actions;

function Probe() {
    const d = useDaw();
    const a = useProjectActions();
    useProjectWiring(a);
    useEffect(() => { daw = d; actions = a; });
    return <ProjectDialogs />;
}

/** 画面を出して、起動したときの確かめが済むのを待つ。 */
async function mount() {
    render(<DawProvider><Probe /></DawProvider>);
    await waitFor(() => expect(seen('GET', '/api/project/recovery')).toHaveLength(1));
}

/** トラックを足す (元に戻せる操作として)。 */
function addTrack(name: string) {
    act(() => { daw.record(`「${name}」を追加`, () => { engine.addTrack(name); }); });
}

describe('画面の自動保存', () => {
    beforeEach(() => { autosave.configure({ idle: 20, maxWait: 200, retry: 10 }); });

    it('変更が落ち着くと、文書を送って復旧用の写しにする。保存していない変更の印も、プロジェクトの情報も、元に戻す履歴も変わらない', async () => {
        await mount();
        act(() => daw.setProject({ ...EMPTY_PROJECT, name: '曲', file: '曲.bunri', token: token(0xf00) }));
        addTrack('Lead');
        expect(daw.isDirty).toBe(true);
        const status = daw.status;
        const undoLabel = daw.undoLabel;

        await waitFor(() => expect(seen('POST', '/api/project/recovery')).toHaveLength(1));
        // 送る順: 音声の確かめ → 文書 → 復旧用の写しにする。音声は、開いている写しを元にする
        expect(calls.filter((c) => c.method !== 'GET').map((c) => c.path)).toEqual([
            '/api/project/audio/missing', '/api/project/document', '/api/project/recovery',
        ]);
        expect(seen('POST', '/api/project/audio/missing')[0].body).toMatchObject({ base: token(0xf00) });
        expect(seen('POST', '/api/project/document')[0].body).toMatchObject({ base: token(0xf00) });
        expect((seen('POST', '/api/project/document')[0].body!.document as { tracks: { name: string }[] }).tracks.map((t) => t.name)).toEqual(['Lead']);
        expect(seen('POST', '/api/project/recovery')[0].body).toEqual({ token: token(1), name: '曲', path: null, file: '曲.bunri', writer: { session: expect.any(String), generation: expect.any(Number) } });

        expect(daw.isDirty).toBe(true);
        expect(document.title).toBe('曲 ● — bunri');
        expect(daw.project).toMatchObject({ name: '曲', file: '曲.bunri', token: token(0xf00) });
        expect(daw.undoLabel).toBe(undoLabel);
        expect(daw.canRedo).toBe(false);
        expect(daw.status).toBe(status);

        // 次の自動保存は、前の復旧用の写しを元にする (音声を送り直さない)
        addTrack('Bass');
        await waitFor(() => expect(seen('POST', '/api/project/recovery')).toHaveLength(2));
        expect(seen('POST', '/api/project/document')[1].body).toMatchObject({ base: token(1) });
    });

    it('再生し続けていても、決めた時間が過ぎたら書く。リアルタイム録音で弾いている最中は、さらに待つ', async () => {
        autosave.configure({ idle: 20, maxWait: 200, retry: 10, playingMaxWait: 150, recordingMaxWait: 600 });
        await mount();
        engine.isPlaying = true;
        addTrack('Lead');
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(seen('POST', '/api/project/document')).toHaveLength(0);
        await waitFor(() => expect(seen('POST', '/api/project/recovery')).toHaveLength(1));
        expect(engine.isPlaying).toBe(true);
        expect(daw.isDirty).toBe(true);

        // 鍵盤をつないでリアルタイム録音を選び、弾いている: 再生中の上限を過ぎても書かない
        daw.midiRef.current = { connected: true, mode: 'realtime' } as never;
        const playing = setInterval(noteMidiMessage, 20);
        addTrack('Bass');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(seen('POST', '/api/project/recovery')).toHaveLength(1);
        // 弾き続けていても、録音中の上限で書く
        await waitFor(() => expect(seen('POST', '/api/project/recovery')).toHaveLength(2), { timeout: 2000 });
        clearInterval(playing);
        daw.midiRef.current = null;
        engine.isPlaying = false;
    });

    it('文書を作り直しても、音声の書き出しとハッシュの計算は、音声ごとに 1 度だけ (再生中に書いても、長く塞がない)', async () => {
        await mount();
        const samples = new Float32Array(800);
        let reads = 0;
        const buffer = {
            duration: 0.1, sampleRate: 8000, numberOfChannels: 1, length: samples.length,
            getChannelData: () => { reads += 1; return samples; },
        } as unknown as AudioBuffer;
        const track = engine.addTrack('Audio');
        track.clips = [{ buffer, offset: 0, name: 'made.wav', duration: 0.1 }];
        const digest = vi.spyOn(crypto.subtle, 'digest');
        const input = {
            name: '曲', chart: null, chartId: null, chartPeaks: null, songFile: null, ghostChoice: 'auto' as const,
            coachPair: { referenceId: null, attemptId: null }, coachResult: null, learnHistory: [],
            leftTab: 'learn' as const, learnTab: 'coach' as const, openTrackId: null, partsUseChart: false,
        };
        const first = await pf.buildDocument(input);
        const second = await pf.buildDocument(input);
        const third = await pf.buildDocument(input);
        expect(first.doc.tracks[0].clips[0].audio).toMatch(/^[0-9a-f]{64}$/);
        expect(third.doc.tracks[0].clips[0].audio).toBe(first.doc.tracks[0].clips[0].audio);
        // 元のバイト列の無い音声を WAV に書き出すのも、ハッシュを計算するのも、1 度だけ。送る Blob も同じもの
        expect(reads).toBe(1);
        expect(digest).toHaveBeenCalledTimes(1);
        expect([...second.audio.values()][0].blob).toBe([...first.audio.values()][0].blob);
        digest.mockRestore();
    });

    it('再生中は書かず、止めてから書く', async () => {
        await mount();
        addTrack('Lead');
        engine.isPlaying = true;
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(seen('POST', '/api/project/document')).toHaveLength(0);
        engine.isPlaying = false;
        await waitFor(() => expect(seen('POST', '/api/project/recovery')).toHaveLength(1));
    });

    it('元に戻して保存したときと同じになったら、復旧用の写しを消す', async () => {
        await mount();
        addTrack('Lead');
        await waitFor(() => expect(stored).not.toBeNull());
        act(() => daw.undo());
        expect(daw.isDirty).toBe(false);
        await waitFor(() => expect(stored).toBeNull());
    });

    it('保存すると、復旧用の写しを消す。保存は、自動保存の写しを元にして音声を送り直さない', async () => {
        await mount();
        act(() => daw.setProject({ ...EMPTY_PROJECT, name: '曲', file: '曲.bunri', token: token(0xf00) }));
        addTrack('Lead');
        await waitFor(() => expect(stored).not.toBeNull());

        let saved = false;
        await act(async () => { saved = await actions.save(); });
        expect(saved).toBe(true);
        expect(seen('POST', '/api/project/document')[1].body).toMatchObject({ base: token(1) });
        expect(seen('POST', '/api/project/library/save')[0].body).toEqual({ token: token(2), file: '曲.bunri' });
        expect(stored).toBeNull();
        expect(daw.isDirty).toBe(false);
        expect(daw.project.token).toBe(token(2));
        // 保存のあとは、変えるまで何も書かない
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(seen('POST', '/api/project/recovery')).toHaveLength(1);
    });

    it('自動保存の途中で保存したら、利用者の保存を先に通す (途中の自動保存は、復旧用の写しにしない)', async () => {
        await mount();
        act(() => daw.setProject({ ...EMPTY_PROJECT, name: '曲', file: '曲.bunri', token: token(0xf00) }));
        let release!: () => void;
        let first = true;
        intercept = async (c) => {
            if (first && c.path === '/api/project/audio/missing') {
                first = false;
                await new Promise<void>((resolve) => { release = resolve; });
            }
            return undefined;
        };
        addTrack('Lead');
        await waitFor(() => expect(seen('POST', '/api/project/audio/missing')).toHaveLength(1));

        let saved: boolean | null = null;
        let saving!: Promise<void>;
        act(() => { saving = actions.save().then((ok) => { saved = ok; }); });
        await new Promise((resolve) => setTimeout(resolve, 30));
        // 自動保存が止まるまで、保存は文書を送らない (同じ音声の預かりを取り合わない)
        expect(seen('POST', '/api/project/document')).toHaveLength(0);
        release();
        await act(async () => { await saving; });
        expect(saved).toBe(true);
        expect(seen('POST', '/api/project/document')).toHaveLength(1);
        expect(seen('POST', '/api/project/recovery')).toHaveLength(0);
        expect(seen('POST', '/api/project/library/save')).toHaveLength(1);
        expect(daw.isDirty).toBe(false);
        expect(stored).toBeNull();
    });

    it('自動保存をしない設定なら、何も送らない', async () => {
        localStorage.setItem(AUTOSAVE_SETTING_KEY, 'off');
        await mount();
        addTrack('Lead');
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });
});

describe('起動したときの、前回の続きの窓', () => {
    const TITLE = '前回、保存していない変更が残っています';
    beforeEach(() => { autosave.configure({ idle: 20, maxWait: 200, retry: 10 }); });

    it('前回の続きが無ければ、何も尋ねない', async () => {
        await mount();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('開発時の StrictMode (副作用が 2 回走る) でも、確かめるのも尋ねるのも 1 回だけ。自動保存も動く', async () => {
        stored = { name: '前回の曲', path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        render(<StrictMode><DawProvider><Probe /></DawProvider></StrictMode>);
        await screen.findByRole('alertdialog', { name: TITLE });
        expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
        expect(seen('GET', '/api/project/recovery')).toHaveLength(1);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '捨てる' })); });
        await waitFor(() => expect(stored).toBeNull());
        addTrack('Lead');
        await waitFor(() => expect(seen('POST', '/api/project/recovery')).toHaveLength(1));
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('名前と書いた時刻を出して尋ねる。「続きを開く」で、名前と場所が戻り、保存していない変更になる。保存すると元のファイルに入る', async () => {
        stored = { name: '前回の曲', path: null, file: '前回の曲.bunri', saved_at: 1_800_000_000, size_bytes: 10 };
        await mount();
        const dialog = await screen.findByRole('alertdialog', { name: TITLE });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveTextContent('前回の曲');
        const time = new Date(1_800_000_000 * 1000).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        expect(dialog).toHaveTextContent(`${time} の時点`);
        // Esc では閉じない (どちらかを選ぶまで)
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '続きを開く' })); });
        await waitFor(() => expect(daw.project.name).toBe('前回の曲'));
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(seen('POST', '/api/project/recovery/open')).toHaveLength(1);
        expect(seen('POST', `/api/project/open/${token(0xabc)}`)).toHaveLength(1);
        expect(daw.project).toMatchObject({ name: '前回の曲', path: null, file: '前回の曲.bunri', token: token(0xabc), legacy: false });
        expect(engine.tracks.map((t) => t.name)).toEqual(['Lead']);
        expect(engine.tracks[0].pianoNotes).toEqual([note('C', 4, 0)]);
        expect(daw.bpm).toBe(96);
        await waitFor(() => expect(daw.isDirty).toBe(true));
        expect(document.title).toBe('前回の曲 ● — bunri');
        expect(daw.canUndo).toBe(false);
        expect(daw.status).toContain('前回の続き（「前回の曲」）を開きました');
        // 開いただけでは、復旧用の写しは消さない (まだ保存していない)
        expect(stored).not.toBeNull();

        // 保存すると、名前を尋ねずに元のファイルへ入り、復旧用の写しが消える
        let saved = false;
        await act(async () => { saved = await actions.save(); });
        expect(saved).toBe(true);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(seen('POST', '/api/project/library/save')[0].body).toMatchObject({ file: '前回の曲.bunri' });
        expect(daw.isDirty).toBe(false);
        expect(stored).toBeNull();
    });

    it('まだ名前の無かったプロジェクトは、名前の無いまま戻る', async () => {
        stored = { name: null, path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        await mount();
        const dialog = await screen.findByRole('alertdialog', { name: TITLE });
        expect(dialog).toHaveTextContent('無題のプロジェクト');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '続きを開く' })); });
        await waitFor(() => expect(engine.tracks).toHaveLength(1));
        await waitFor(() => expect(daw.isDirty).toBe(true));
        expect(daw.project).toMatchObject({ name: null, path: null, file: null });
        expect(document.title).toBe('無題のプロジェクト ● — bunri');
    });

    it('「捨てる」で、復旧用の写しを消して、何も開かない', async () => {
        stored = { name: '前回の曲', path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        await mount();
        await screen.findByRole('alertdialog', { name: TITLE });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '捨てる' })); });
        await waitFor(() => expect(stored).toBeNull());
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(seen('POST', '/api/project/recovery/open')).toHaveLength(0);
        expect(engine.tracks).toHaveLength(0);
        expect(daw.isDirty).toBe(false);
        expect(daw.status).toBe('前回の、保存していない変更を捨てました');
    });

    it('答えるまでは、自動保存が前回の続きを上書きしない', async () => {
        stored = { name: '前回の曲', path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        await mount();
        await screen.findByRole('alertdialog', { name: TITLE });
        addTrack('Lead');
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(seen('POST', '/api/project/document')).toHaveLength(0);
        expect(stored).toMatchObject({ name: '前回の曲' });
    });

    it('尋ねる前にもう何か変えていたら、続きを開くと消えることを伝える', async () => {
        stored = { name: '前回の曲', path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        let answer!: () => void;
        intercept = async (c) => {
            if (c.method === 'GET' && c.path === '/api/project/recovery') await new Promise<void>((resolve) => { answer = resolve; });
            return undefined;
        };
        await mount();
        addTrack('Lead');
        answer();
        const dialog = await screen.findByRole('alertdialog', { name: TITLE });
        expect(dialog).toHaveTextContent('続きを開くと、いまの画面の変更は消えます');
    });

    it('続きを開けなかったら、復旧用の写しを残したまま、もう一度尋ねる', async () => {
        stored = { name: '前回の曲', path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        let broken = true;
        intercept = (c) => (broken && c.path.startsWith('/api/project/open/')
            ? Response.json({ detail: 'ファイルが壊れています' }, { status: 400 }) : undefined);
        await mount();
        await screen.findByRole('alertdialog', { name: TITLE });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '続きを開く' })); });
        await waitFor(() => expect(daw.status).toContain('前回の続きを開けませんでした'));
        expect(await screen.findByRole('alertdialog', { name: TITLE })).toBeInTheDocument();
        expect(stored).not.toBeNull();
        broken = false;
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '続きを開く' })); });
        await waitFor(() => expect(engine.tracks).toHaveLength(1));
    });
});

describe('デスクトップ版', () => {
    const TITLE = '前回、保存していない変更が残っています';
    const PATH = '/Users/me/Documents/bunri/前回の曲.bunri';
    /** Rust のコマンドの呼び出し (名前と引数) */
    let invoked: { cmd: string; args?: Record<string, unknown> }[];
    /** 最近使ったプロジェクトに在る場所 (Rust が、書き込みを許す場所) */
    let recent: string[];
    /** 窓を閉じようとしたときに、Rust が画面に送るイベントの受け手 */
    let closeRequested: ((e: { payload: { quit?: boolean } }) => void) | null;

    beforeEach(() => {
        autosave.configure({ idle: 20, maxWait: 200, retry: 10 });
        invoked = [];
        recent = [PATH];
        closeRequested = null;
        (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
            core: {
                invoke: async (cmd: string, args?: Record<string, unknown>) => {
                    invoked.push({ cmd, args });
                    if (cmd === 'recent_projects') return recent.map((path) => ({ path, name: '前回の曲', exists: true, opened_at: 1 }));
                    if (cmd === 'project_commit') return { path: args!.path, name: '前回の曲' };
                    return null;
                },
            },
            event: {
                listen: async (event: string, handler: (e: { payload: { quit?: boolean } }) => void) => {
                    if (event === 'close-requested') closeRequested = handler;
                    return () => { closeRequested = null; };
                },
            },
        };
    });

    it('続きを開くと、元のファイルの場所が戻り、保存すると (ダイアログを出さずに) そこへ入る', async () => {
        stored = { name: '前回の曲', path: PATH, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        await mount();
        await screen.findByRole('alertdialog', { name: TITLE });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '続きを開く' })); });
        await waitFor(() => expect(daw.project.path).toBe(PATH));
        await waitFor(() => expect(daw.isDirty).toBe(true));

        let saved = false;
        await act(async () => { saved = await actions.save(); });
        expect(saved).toBe(true);
        expect(invoked.some((i) => i.cmd === 'project_pick_save')).toBe(false);
        expect(invoked.find((i) => i.cmd === 'project_commit')?.args).toMatchObject({ path: PATH });
        expect(stored).toBeNull();
        expect(daw.isDirty).toBe(false);
    });

    it('元の場所が最近使ったプロジェクトから外れていたら、場所は戻さない (保存のときに、保存先を尋ねる)', async () => {
        stored = { name: '前回の曲', path: PATH, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        recent = [];
        await mount();
        await screen.findByRole('alertdialog', { name: TITLE });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '続きを開く' })); });
        await waitFor(() => expect(daw.project.name).toBe('前回の曲'));
        expect(daw.project.path).toBeNull();
    });

    it('窓を閉じる前に「保存しない」を選んだら、復旧用の写しを消してから閉じる (次の起動で尋ねない)', async () => {
        await mount();
        await waitFor(() => expect(closeRequested).not.toBeNull());
        addTrack('Lead');
        await waitFor(() => expect(stored).not.toBeNull());

        act(() => { closeRequested!({ payload: { quit: false } }); });
        const guard = await screen.findByRole('alertdialog', { name: '保存していない変更があります' });
        expect(guard).toHaveTextContent('窓を閉じる前に');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存しない' })); });
        await waitFor(() => expect(invoked.some((i) => i.cmd === 'close_confirmed')).toBe(true));
        expect(stored).toBeNull();
        // 消してから閉じる
        const order = calls.map((c) => `${c.method} ${c.path}`);
        expect(order[order.length - 1]).toBe('DELETE /api/project/recovery');
    });

    it('起動したときの問いが出ているあいだに窓を閉じようとしたら、確かめを先に出す。キャンセルすると、問いがもう一度出て、答えると自動保存が始まる', async () => {
        stored = { name: '前回の曲', path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        await mount();
        await waitFor(() => expect(closeRequested).not.toBeNull(), { timeout: 3000 });
        await screen.findByRole('alertdialog', { name: TITLE }, { timeout: 3000 });
        addTrack('Lead');

        act(() => { closeRequested!({ payload: { quit: false } }); });
        await screen.findByRole('alertdialog', { name: '保存していない変更があります' }, { timeout: 3000 });
        expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'キャンセル' })); });
        // 取り下げられていない。もう一度出る
        await screen.findByRole('alertdialog', { name: TITLE }, { timeout: 3000 });
        expect(invoked.some((i) => i.cmd === 'close_confirmed')).toBe(false);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '捨てる' })); });
        await waitFor(() => expect(seen('DELETE', '/api/project/recovery')).toHaveLength(1), { timeout: 3000 });
        // 答えが出たので、自動保存が始まる (いまの画面の変更が、前回の写しに替わって残る)
        addTrack('Bass');
        await waitFor(() => expect(seen('POST', '/api/project/recovery').length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
        await waitFor(() => expect(stored).toMatchObject({ name: null }), { timeout: 3000 });
    });

    it('起動したときの問いが出ているあいだに「保存しない」で閉じたら、前回の写しは消さずに閉じる (次の起動でまた尋ねる)', async () => {
        stored = { name: '前回の曲', path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        await mount();
        await waitFor(() => expect(closeRequested).not.toBeNull(), { timeout: 3000 });
        await screen.findByRole('alertdialog', { name: TITLE }, { timeout: 3000 });
        addTrack('Lead');
        act(() => { closeRequested!({ payload: { quit: true } }); });
        await screen.findByRole('alertdialog', { name: '保存していない変更があります' }, { timeout: 3000 });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存しない' })); });
        await waitFor(() => expect(invoked.some((i) => i.cmd === 'close_confirmed')).toBe(true), { timeout: 3000 });
        expect(seen('DELETE', '/api/project/recovery')).toHaveLength(0);
        expect(stored).toMatchObject({ name: '前回の曲' });
    });

    it('開く一覧が出ているあいだに起動したときの確かめが済んでも、一覧を置き換えない。一覧に答えてから、続きを尋ねる', async () => {
        stored = { name: '前回の曲', path: null, file: null, saved_at: 1_800_000_000, size_bytes: 10 };
        let answer!: () => void;
        intercept = async (c) => {
            if (c.method === 'GET' && c.path === '/api/project/recovery') await new Promise<void>((resolve) => { answer = resolve; });
            if (c.path === '/api/project/library') return Response.json({ projects: [] });
            return undefined;
        };
        await mount();
        let opened = false;
        act(() => { void actions.open().then(() => { opened = true; }); });
        await screen.findByRole('dialog', { name: 'プロジェクトを開く' }, { timeout: 3000 });
        answer();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(screen.getByRole('dialog', { name: 'プロジェクトを開く' })).toBeInTheDocument();
        expect(screen.queryByRole('alertdialog', { name: TITLE })).not.toBeInTheDocument();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'キャンセル' })); });
        await waitFor(() => expect(opened).toBe(true), { timeout: 3000 });
        await screen.findByRole('alertdialog', { name: TITLE }, { timeout: 3000 });
    });

    it('自動保存が送っている途中に「保存しない」で閉じても、待たずにすぐ消して閉じる。送り終えた自動保存は、写しを置き直さない', async () => {
        await mount();
        await waitFor(() => expect(closeRequested).not.toBeNull(), { timeout: 3000 });
        addTrack('Lead');
        await waitFor(() => expect(stored).not.toBeNull(), { timeout: 3000 });

        // 2 回目の自動保存は、文書を送っている途中で止まる (大きな音声を送っている途中の代わり)
        let release!: () => void;
        const sending = new Promise<void>((resolve) => { release = resolve; });
        intercept = async (c) => { if (c.method === 'POST' && c.path === '/api/project/document') await sending; return undefined; };
        addTrack('Bass');
        await waitFor(() => expect(seen('POST', '/api/project/document')).toHaveLength(2), { timeout: 3000 });

        act(() => { closeRequested!({ payload: { quit: false } }); });
        await screen.findByRole('alertdialog', { name: '保存していない変更があります' }, { timeout: 3000 });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存しない' })); });
        await waitFor(() => expect(invoked.some((i) => i.cmd === 'close_confirmed')).toBe(true), { timeout: 2000 });
        expect(seen('DELETE', '/api/project/recovery')).toHaveLength(1);
        expect(stored).toBeNull();

        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(seen('POST', '/api/project/recovery')).toHaveLength(1);
        expect(stored).toBeNull();
    });

    it('置く要求を送ったあとに捨てても、その要求が消したあとに届けば、古い世代として断られ、写しは残らない', async () => {
        await mount();
        await waitFor(() => expect(closeRequested).not.toBeNull(), { timeout: 3000 });
        // 置く要求が、処理を担当する部分に届くのが遅れる (消す要求に追い越される)
        let release!: () => void;
        const late = new Promise<void>((resolve) => { release = resolve; });
        intercept = async (c) => { if (c.method === 'POST' && c.path === '/api/project/recovery') await late; return undefined; };
        addTrack('Lead');
        await waitFor(() => expect(seen('POST', '/api/project/recovery')).toHaveLength(1), { timeout: 3000 });

        act(() => { closeRequested!({ payload: { quit: false } }); });
        await screen.findByRole('alertdialog', { name: '保存していない変更があります' }, { timeout: 3000 });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存しない' })); });
        await waitFor(() => expect(invoked.some((i) => i.cmd === 'close_confirmed')).toBe(true), { timeout: 2000 });
        expect(seen('DELETE', '/api/project/recovery')).toHaveLength(1);

        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(stored).toBeNull();
    });
});
