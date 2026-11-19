/**
 * アシスタントの会話と繰り返し（lib/assistant.ts）、依頼ごとの記録（元に戻す）、ドックの部品（components/AssistantPanel.tsx）。
 * 処理を担当する部分の呼び出し（/api/assistant/step）は、偽物の fetch に差し替える。Claude は呼ばない。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

class MockGainNode {
    gain = { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    connect() { return this; }
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return { pan: { value: 0 }, connect() { return this; } } as unknown as StereoPannerNode; }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { default: engine } = await import('../lib/engine');
const { DawProvider, useDaw } = await import('../lib/store');
const { AssistantSession, MAX_STEPS, assistantSession, readJsonLines, requestHead } = await import('../lib/assistant');
const { toolLabel } = await import('../lib/assistant-tools');
const {
    COMPACT_CHARS, COMPACT_MESSAGES, DIGEST_CHARS, MAX_ARCHIVED, MAX_SAVED_ITEMS, archiveFromSection, archiveTitle, conversationDigest, itemsFromSection, itemsToSaved, needsCompaction,
} = await import('../lib/assistant-history');
const { SUGGESTION_COUNT, suggestionsFor } = await import('../lib/assistant-suggestions');
const { activityEntries, recordActivity, resetActivityForTest } = await import('../lib/activity');
const { AssistantPanel, AssistantToggle } = await import('../components/AssistantPanel');
const { useAssistantDeps } = await import('../lib/assistant-env');
type AssistantDeps = import('../lib/assistant').AssistantDeps;
type ApiMessage = import('../lib/assistant').ApiMessage;
type ChatItem = import('../lib/assistant').ChatItem;
type SuggestionFacts = import('../lib/assistant-suggestions').SuggestionFacts;
type ContentBlock = import('../lib/assistant').ContentBlock;
type Session = InstanceType<typeof AssistantSession>;
type ToolEnv = import('../lib/assistant-tools').ToolEnv;
type DawContextType = import('../lib/store').DawContextType;
type PianoNote = import('../lib/engine').PianoNote;

// ---- 偽の応答 ----

const TODAY = { date: '2026-11-18', calls: 3, cost_usd: 0.12, limit_calls: 20, limit_usd: null, blocked: null };

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const use = (id: string, name: string, input: unknown = {}): ContentBlock => ({ type: 'tool_use', id, name, input });
/** 思考のブロック（署名つき）。変えずに送り返されることを確かめるのに使う */
const thinking: ContentBlock = { type: 'thinking', thinking: '', signature: 'sig-abc' };

const step = (content: ContentBlock[], stop_reason = 'end_turn', cost: number | null = 0.01) =>
    ({ content, stop_reason, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: cost, today: TODAY });

type Reply = ReturnType<typeof step> | { status: number; detail: unknown } | 'hang' | 'network' | (() => Response);

/** 送られた `/api/assistant/step` の本文（送った時点の写し）。 */
let sent: { messages: ApiMessage[]; turn_id: string; step: number; stream?: boolean }[] = [];

/**
 * 偽の fetch を仕掛ける。`/api/assistant/step` には、渡した応答を順に返す（足りなくなったら最後のものを繰り返す）。
 * 'hang' は、中止されるまで返らない。'network' は、届かなかったことにする。関数は、その場で作った応答を返す
 * （少しずつ届く応答。下の `flow` / `flowing`）。
 */
function stubSteps(replies: Reply[]) {
    sent = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        if (url === '/api/settings/guide') return Response.json({ settings: {}, today: TODAY });
        if (url !== '/api/assistant/step') return Response.json({ detail: 'not found' }, { status: 404 });
        sent.push(JSON.parse(String(init?.body)));
        const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
        if (reply === 'network') throw new TypeError('Failed to fetch');
        if (reply === 'hang') {
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
            });
        }
        if (typeof reply === 'function') return reply();
        if ('status' in reply) return Response.json({ detail: reply.detail }, { status: reply.status });
        return Response.json(reply);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

// ---- 少しずつ届く偽の応答 (application/x-ndjson) ----

const encoder = new TextEncoder();
/** 1 行ぶん（JSON 1 つ + 改行）。 */
const line = (value: unknown) => JSON.stringify(value) + '\n';
const delta = (value: string) => ({ type: 'text', text: value });
const toolStart = (name: string) => ({ type: 'tool', name });
const doneLine = (content: ContentBlock[], stop_reason = 'end_turn', cost: number | null = 0.01) => ({ type: 'done', ...step(content, stop_reason, cost) });

/** 渡したかたまりを、その切れ目のまま順に流して終わる本文。 */
function bodyOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
            controller.close();
        },
    });
}

const ndjson = (body: ReadableStream<Uint8Array>) => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });

/** 渡した行を、1 行ずつ流して終わる応答。 */
const flow = (...lines: unknown[]) => () => ndjson(bodyOf(lines.map(line)));

/**
 * テストの側から、手で流す応答。`push` で行を流し、`close` で本文を終える。
 * 中止の合図（fetch の signal）とはつないでいない（読む側が、自分で読み取りを止めることを確かめるため）。
 * `closed()` は、読む側が本文の読み取りを閉じたか。
 */
function flowing() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { cancelled = true; } });
    return {
        body,
        reply: () => ndjson(body),
        push: (...lines: unknown[]) => controller.enqueue(encoder.encode(lines.map(line).join(''))),
        close: () => controller.close(),
        closed: () => cancelled,
    };
}

/** 本文を最後まで読んで、行の並びにする。 */
async function collect(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<unknown[]> {
    const lines: unknown[] = [];
    for await (const value of readJsonLines(body, signal)) lines.push(value);
    return lines;
}

// ---- 偽の入口 ----

/** 再生エンジンのトラックを直接書き換える入口。`record` を渡すと、元に戻す履歴に載る。 */
function engineEnv(record: <T>(label: string, fn: () => T) => T = (_label, fn) => fn(), hooks: { onAddTrack?: () => void } = {}): ToolEnv {
    return {
        grid: () => engine.grid,
        tracks: () => engine.tracks,
        activeTrackId: () => null,
        maxSteps: () => 16 * 999,
        playing: () => false,
        positionSec: () => 0,
        durationSec: () => engine.getTotalDuration(),
        chart: () => null,
        practice: () => ({ open: false, partId: null, trackId: null }),
        // 練習画面・選んでいるノート・学ぶ流れ・場所を示すものは、このファイルのテストでは使わない (lib/assistant-tools の単体テストで見る)
        practiceSettings: () => null,
        updatePractice: () => {},
        selection: () => null,
        flashNotes: () => {},
        metronome: () => false,
        setMetronome: () => {},
        chartId: () => null,
        learn: () => ({ imported: false, hasChart: false, separated: false, practiced: false, diffed: false }),
        referenceSource: () => 'transcription',
        requestDiff: async () => { throw new Error('このテストでは、差分を取りません'); },
        practiceCompare: async () => null,
        savedGuide: async () => { throw new Error('このテストでは、再現ガイドを読みません'); },
        requestGuide: async () => { throw new Error('このテストでは、再現ガイドを作りません'); },
        coachPair: () => null,
        coachDiff: () => null,
        explainChart: () => null,
        requestExplanation: async () => { throw new Error('このテストでは、差分の説明を作りません'); },
        linkExplanation: () => {},
        pointAt: async () => ({ shown: false }),
        // 時間のかかる処理・書き出し・保存・クリップ・エフェクトも、ここでは使わない
        job: () => null,
        cancelJob: async () => {},
        hasSongFile: () => false,
        startSeparation: async () => ({ started: false, reason: 'このテストでは、パート分離を始めません' }),
        exportWav: async () => ({ ok: false, message: 'このテストでは、書き出しません' }),
        exportMidi: () => ({ ok: false, message: 'このテストでは、書き出しません' }),
        project: () => ({ name: null, dirty: false }),
        saveProject: async () => false,
        moveClip: () => {},
        deleteClip: () => {},
        duplicateClip: () => {},
        trimClip: () => {},
        splitClip: () => {},
        fadeClip: () => {},
        applyEffect: async () => {},
        play: () => {},
        stop: () => {},
        seekStep: () => {},
        setBpm: (bpm) => record('テンポを変更', () => { engine.bpm = bpm; }),
        setBeatsPerBar: (beats) => record('拍子を変更', () => { engine.beatsPerBar = beats; }),
        addTrack: (name) => {
            const track = record('トラックを追加', () => engine.addTrack(name));
            recordActivity('status', `「${track.name}」を追加しました`);
            hooks.onAddTrack?.();
            return { id: track.id, name: track.name };
        },
        renameTrack: (id, name) => record('名前を変更', () => { engine.getTrack(id)!.name = name; }),
        deleteTrack: (id) => record('削除', () => engine.removeTrack(id)),
        selectTrack: () => {},
        setMute: (id, on) => record('ミュート', () => { engine.getTrack(id)!.mute = on; }),
        setSolo: (id, on) => record('ソロ', () => { engine.getTrack(id)!.solo = on; }),
        setGain: (id, db) => record('音量', () => engine.updateTrackGain(id, db)),
        setPan: (id, pan) => record('パン', () => engine.updateTrackPan(id, pan)),
        setTrackNotes: (id, notes: PianoNote[], label) => record(label, () => { engine.getTrack(id)!.pianoNotes = notes; }),
        openPractice: () => {},
        closePractice: () => {},
        midi: () => null,
    };
}

/** 記録の開け閉めを控える、偽の入口。 */
function fakeDeps(env: ToolEnv = engineEnv()) {
    const log: string[] = [];
    let changed = false;
    const deps: AssistantDeps = {
        env,
        beginEdit: (label) => {
            log.push(`begin ${label}`);
            const before = JSON.stringify(engine.tracks.map((t) => [t.id, t.name, t.pianoNotes])) + engine.bpm;
            return (options) => {
                // 捨てる: 記録を作らずに閉じる (依頼の途中で、プロジェクトが入れ替わった)
                if (options?.discard) { log.push('discard'); return false; }
                changed = JSON.stringify(engine.tracks.map((t) => [t.id, t.name, t.pianoNotes])) + engine.bpm !== before;
                log.push(`commit ${changed}`);
                return changed;
            };
        },
        topUndoId: () => 7,
        suggestionFacts: () => ({
            trackCount: engine.tracks.length, imported: false, hasChart: false, separated: false, practiced: false,
            practiceOpen: false, selectedNotes: 0, openTrackHasNotes: false, jobRunning: false,
        }),
    };
    return { deps, log };
}

/** 画面に出す行を、種類と文の並びにする。 */
const rows = (session: Session) => session.getState().items.map((item) => {
    if (item.kind === 'tool') return `tool/${item.state}: ${item.text}`;
    if (item.kind === 'turn') return `turn: ${item.calls} 回${item.changed ? '・変えた' : ''}`;
    if (item.kind === 'notice') return `notice/${item.tone}: ${item.text}`;
    if (item.kind === 'card') return `card/${item.card}`;
    return `${item.kind}: ${item.text}`;
});

/** 並びの、後ろから n 番目（1 が最後）。 */
function last<T>(list: readonly T[], n = 1): T {
    return list[list.length - n];
}

const NOTES = [{ pitch: 'C2', step: 0, length: 4 }, { pitch: 'Eb2', step: 4, length: 4 }];

beforeEach(() => {
    resetActivityForTest();
    engine.init();
    engine.tracks = [];
    engine.nextTrackId = 1;
    engine.bpm = 120; engine.beatsPerBar = 4; engine.gridOffset = 0;
    localStorage.setItem('bunri-guide-seen', '1');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('繰り返し（AssistantSession.send）', () => {
    it('tool_use → 全部の結果を 1 つの user のメッセージにまとめて送り返す → end_turn で終わる', async () => {
        engine.addTrack();
        const first = [thinking, text('まず様子を見て、トラックを足します。'), use('tu_1', 'get_project'), use('tu_2', 'add_track', { name: 'Bass' })];
        stubSteps([step(first, 'tool_use'), step([text('「Bass」を足しました。')])]);
        const session = new AssistantSession();
        const { deps } = fakeDeps();
        expect(await session.send('  ベース用のトラックを足して  ', deps)).toBe(true);

        expect(sent).toHaveLength(2);
        // 1 回目: 利用者の文だけ。step は 0 から
        expect(sent[0].messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'ベース用のトラックを足して' }] }]);
        expect(sent[0].step).toBe(0);
        expect(sent[1].step).toBe(1);
        // 同じ依頼の呼び出しは、同じ turn_id (英数字とハイフン、64 文字まで)
        expect(sent[0].turn_id).toMatch(/^[A-Za-z0-9-]{1,64}$/);
        expect(sent[1].turn_id).toBe(sent[0].turn_id);
        // 2 回目: 応答の content を (思考のブロックも) そのまま送り返し、結果は 1 つの user のメッセージ
        expect(sent[1].messages).toHaveLength(3);
        expect(sent[1].messages[0]).toEqual(sent[0].messages[0]);
        expect(sent[1].messages[1]).toEqual({ role: 'assistant', content: first });
        const results = sent[1].messages[2];
        expect(results.role).toBe('user');
        expect(results.content.map((b) => [b.type, b.tool_use_id, b.is_error])).toEqual([
            ['tool_result', 'tu_1', undefined], ['tool_result', 'tu_2', undefined],
        ]);
        // 成功の結果は、JSON の文字列 ({ok, summary, …})
        const added = JSON.parse(results.content[1].content as string);
        expect(added).toMatchObject({ ok: true, summary: '「Bass」を追加しました', name: 'Bass' });
        expect(JSON.parse(results.content[0].content as string).steps_per_bar).toBe(16);

        expect(engine.tracks.map((t) => t.name)).toEqual(['Track 1', 'Bass']);
        expect(rows(session)).toEqual([
            'user: ベース用のトラックを足して',
            'assistant: まず様子を見て、トラックを足します。',
            'tool/ok: プロジェクトの様子を見ました（トラック 1 本、120 BPM、4/4）',
            'tool/ok: 「Bass」を追加しました',
            'assistant: 「Bass」を足しました。',
            'turn: 2 回・変えた',
        ]);
        expect(session.getState()).toMatchObject({ running: false, waiting: null, today: TODAY });
        // 会話は、最後の応答まで足してある (次の依頼は、この続きになる)
        expect(session.conversation()).toHaveLength(4);
        expect(session.conversation()[3]).toEqual({ role: 'assistant', content: [text('「Bass」を足しました。')] });
    });

    it('前のメッセージは書き換えず、次の依頼は続きに足す', async () => {
        stubSteps([step([text('はい。')]), step([text('どういたしまして。')])]);
        const session = new AssistantSession();
        const { deps } = fakeDeps();
        await session.send('こんにちは', deps);
        const before = JSON.stringify(session.conversation());
        await session.send('ありがとう', deps);
        expect(JSON.stringify(session.conversation().slice(0, 2))).toBe(before);
        expect(sent[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        // 依頼ごとに、turn_id は変わり、step は 0 に戻る
        expect(sent[1].step).toBe(0);
        expect(sent[1].turn_id).not.toBe(sent[0].turn_id);
    });

    it('ツールの失敗は is_error の結果にして返し、Claude が続けられる', async () => {
        engine.addTrack();
        stubSteps([step([use('tu_1', 'add_notes', { track_id: 99, notes: NOTES })], 'tool_use'), step([text('すみません、そのトラックはありませんでした。')])]);
        const session = new AssistantSession();
        await session.send('ノートを置いて', fakeDeps().deps);
        const result = sent[1].messages[2].content[0];
        expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1', is_error: true });
        expect(result.content).toMatch(/track_id 99 のトラックはありません/);
        // 操作ログには、利用者向けの文を出す (ツールや引数の名前は、Claude に返す文にだけ入れる)
        expect(rows(session)[1]).toBe('tool/error: ノートを置く: そのトラックが見つかりませんでした');
        expect(last(rows(session))).toBe('turn: 2 回');
    });

    it(`${MAX_STEPS} 回に達したら、そこで止めて知らせる。会話は tool_result で閉じている`, async () => {
        const fetchMock = stubSteps([step([use('tu', 'get_project')], 'tool_use')]);
        const session = new AssistantSession();
        await session.send('ずっと見ていて', fakeDeps().deps);
        expect(fetchMock).toHaveBeenCalledTimes(MAX_STEPS);
        expect(sent.map((s) => s.step)).toEqual(Array.from({ length: MAX_STEPS }, (_, i) => i));
        expect(last(rows(session), 2)).toMatch(/^notice\/info: Claude を 12 回呼んだので、ここで止めました/);
        expect(last(rows(session))).toBe('turn: 12 回');
        const closing = last(session.conversation());
        expect(closing.role).toBe('user');
        expect(closing.content[0].type).toBe('tool_result');
        expect(session.getState().running).toBe(false);
    });

    it('max_tokens は、途中で切れたと知らせて終える。切れた応答の中のツールは実行しない', async () => {
        engine.addTrack();
        stubSteps([step([text('長い説明…'), use('tu_1', 'add_track', { name: 'X' })], 'max_tokens')]);
        const session = new AssistantSession();
        const { deps, log } = fakeDeps();
        await session.send('たくさん説明して', deps);
        expect(sent).toHaveLength(1);
        expect(engine.tracks).toHaveLength(1);
        expect(log).toEqual([]);
        expect(rows(session)).toEqual([
            'user: たくさん説明して',
            'assistant: 長い説明…',
            'tool/cancelled: トラックを追加する: 応答が途中で切れたので、実行していません',
            'notice/error: 応答が長すぎて、途中で切れました。頼むことを小さく分けて、もう一度試してください',
            'turn: 1 回',
        ]);
        // tool_use には、実行しなかったことの結果を入れて、形を閉じてある
        expect(last(session.conversation())).toEqual({
            role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '応答が途中で切れたので、実行していません', is_error: true }],
        });
    });

    it('待っているあいだに中止すると、呼び出しを止めて知らせる。次の依頼は通る形のまま', async () => {
        stubSteps(['hang', step([text('はい。')])]);
        const session = new AssistantSession();
        const { deps } = fakeDeps();
        const running = session.send('考えて', deps);
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(session.getState()).toMatchObject({ running: true, waiting: '考えています…' });
        // 動いているあいだは、次の依頼も、新しい会話も受けない
        expect(await session.send('もう 1 つ', deps)).toBe(false);
        expect(session.reset()).toBe(false);
        session.cancel();
        await running;
        expect(rows(session)).toEqual(['user: 考えて', 'notice/info: 中止しました']);
        expect(session.getState().running).toBe(false);
        await session.send('続けて', deps);
        expect(sent[1].messages.map((m) => m.role)).toEqual(['user', 'user']);
        expect(last(rows(session), 2)).toBe('assistant: はい。');
    });

    it('ツールの途中で中止すると、次のツールを始めず、残りに「中止しました」の結果を入れて tool_use を閉じる', async () => {
        const session = new AssistantSession();
        // 1 つ目のツール (トラックの追加) の中で、利用者が「中止」を押したことにする
        const { deps, log } = fakeDeps(engineEnv(undefined, { onAddTrack: () => session.cancel() }));
        const fetchMock = stubSteps([step([use('tu_1', 'add_track', { name: 'A' }), use('tu_2', 'add_track', { name: 'B' }), use('tu_3', 'get_project')], 'tool_use')]);
        await session.send('2 本足して', deps);
        // 次の呼び出しは始めない
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // すでに行った操作は残る
        expect(engine.tracks.map((t) => t.name)).toEqual(['A']);
        expect(rows(session)).toEqual([
            'user: 2 本足して',
            'tool/ok: 「A」を追加しました',
            'tool/cancelled: トラックを追加する: 中止したので、実行していません',
            'tool/cancelled: プロジェクトの様子を見る: 中止したので、実行していません',
            'notice/info: 中止しました。ここまでに行った操作は残っています（「元に戻す」で戻せます）',
            'turn: 1 回・変えた',
        ]);
        const closing = last(session.conversation());
        expect(closing.role).toBe('user');
        expect(closing.content.map((b: ContentBlock) => [b.tool_use_id, b.is_error, b.content === '中止しました'])).toEqual([
            ['tu_1', undefined, false], ['tu_2', true, true], ['tu_3', true, true],
        ]);
        // 記録は、中止でも必ず閉じる
        expect(log).toEqual(['begin アシスタント: 2 本足して', 'commit true']);
    });

    it('失敗の code を読む: no_key / auth は API キーの欄を出し、daily_limit は文をそのまま出す', async () => {
        const session = new AssistantSession();
        const { deps } = fakeDeps();
        stubSteps([{ status: 401, detail: { message: 'Claude の API キーが設定されていません', code: 'no_key' } }]);
        await session.send('やあ', deps);
        expect(rows(session)).toEqual(['user: やあ', 'notice/error: Claude の API キーが設定されていません']);
        expect(session.getState().needsKey).toBe(true);

        stubSteps([{ status: 429, detail: { message: '今日の上限（20 回）に達しました。明日また試すか、上限を変えてください', code: 'daily_limit' } }]);
        session.setNeedsKey(false);
        await session.send('もう一度', deps);
        expect(last(rows(session))).toBe('notice/error: 今日の上限（20 回）に達しました。明日また試すか、上限を変えてください');
        expect(session.getState().needsKey).toBe(false);

        stubSteps([{ status: 401, detail: { message: 'API キーが正しくありません', code: 'auth' } }]);
        await session.send('3 回目', deps);
        expect(session.getState().needsKey).toBe(true);
        // うまくいったら、キーの欄はしまう
        stubSteps([step([text('はい。')])]);
        await session.send('4 回目', deps);
        expect(session.getState().needsKey).toBe(false);
    });

    it('届かなかったとき・理由の無い失敗は、次にどうすればよいかの文にする', async () => {
        const session = new AssistantSession();
        stubSteps(['network']);
        await session.send('やあ', fakeDeps().deps);
        expect(last(rows(session))).toMatch(/^notice\/error: アシスタントを呼べませんでした。アプリの処理部分に接続できませんでした/);
        stubSteps([{ status: 500, detail: undefined }]);
        await session.send('やあ', fakeDeps().deps);
        expect(last(rows(session))).toMatch(/^notice\/error: アシスタントを呼べませんでした。処理の途中で問題が起きました/);
        expect(session.getState().running).toBe(false);
    });

    it('途中の呼び出しが失敗しても、記録を閉じ、行った操作は残る', async () => {
        stubSteps([step([use('tu_1', 'add_track', { name: 'A' })], 'tool_use'), { status: 529, detail: { message: 'Claude が混み合っています', code: 'api' } }]);
        const session = new AssistantSession();
        const { deps, log } = fakeDeps();
        await session.send('足して', deps);
        expect(log).toEqual(['begin アシスタント: 足して', 'commit true']);
        expect(rows(session).slice(-2)).toEqual(['notice/error: Claude が混み合っています', 'turn: 1 回・変えた']);
        expect(last(session.conversation()).content[0].type).toBe('tool_result');
    });

    it('空の文は送らない。「新しい会話」で、会話と操作ログが空になる', async () => {
        const fetchMock = stubSteps([step([text('はい。')])]);
        const session = new AssistantSession();
        expect(await session.send('   \n ', fakeDeps().deps)).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        await session.send('やあ', fakeDeps().deps);
        expect(session.reset()).toBe(true);
        expect(session.getState().items).toEqual([]);
        expect(session.conversation()).toEqual([]);
        // 今日の使用量は残す
        expect(session.getState().today).toEqual(TODAY);
    });

    it('概算の費用は足し合わせる。単価の分からない呼び出しが在れば、出さない', async () => {
        stubSteps([step([use('tu', 'get_project')], 'tool_use', 0.02), step([text('はい。')], 'end_turn', 0.03)]);
        const session = new AssistantSession();
        await session.send('見て', fakeDeps().deps);
        expect(last(session.getState().items)).toMatchObject({ kind: 'turn', calls: 2, changed: false, undoEntryId: null });
        expect((last(session.getState().items) as { costUsd: number }).costUsd).toBeCloseTo(0.05);
        stubSteps([step([text('はい。')], 'end_turn', null)]);
        await session.send('もう一度', fakeDeps().deps);
        expect(last(session.getState().items)).toMatchObject({ kind: 'turn', calls: 1, costUsd: null });
    });
});

describe('行の読み取り（readJsonLines）', () => {
    const A = { type: 'text', text: 'こんにちは' };
    const B = { type: 'tool', name: 'add_track' };
    const C = { type: 'done', content: [], stop_reason: 'end_turn' };

    it('1 行ずつ届く・複数の行がまとめて届く・行の途中で切れて届く、のどれでも同じ行になる', async () => {
        const whole = line(A) + line(B) + line(C);
        expect(await collect(bodyOf([line(A), line(B), line(C)]))).toEqual([A, B, C]);
        expect(await collect(bodyOf([whole]))).toEqual([A, B, C]);
        // 行の途中 (改行の前後も) で切れて届く
        for (const at of [1, 9, line(A).length - 1, line(A).length, line(A).length + 1, whole.length - 1]) {
            expect(await collect(bodyOf([whole.slice(0, at), whole.slice(at)]))).toEqual([A, B, C]);
        }
        // 1 文字ずつ
        expect(await collect(bodyOf([...whole]))).toEqual([A, B, C]);
    });

    it('文字の途中（バイトの途中）で切れて届いても、文字が壊れない', async () => {
        const bytes = encoder.encode(line(A) + line(C));
        for (let at = 1; at < bytes.length; at++) {
            expect(await collect(bodyOf([bytes.slice(0, at), bytes.slice(at)]))).toEqual([A, C]);
        }
    });

    it('最後の行に改行が無くても読む。空の行と \\r\\n も扱う', async () => {
        expect(await collect(bodyOf([line(A), JSON.stringify(C)]))).toEqual([A, C]);
        expect(await collect(bodyOf([`${JSON.stringify(A)}\r\n\r\n\n${JSON.stringify(C)}\r\n`]))).toEqual([A, C]);
        expect(await collect(bodyOf([]))).toEqual([]);
        expect(await collect(bodyOf(['\n\n']))).toEqual([]);
    });

    it('JSON のオブジェクトとして読めない行は飛ばす', async () => {
        expect(await collect(bodyOf([line(A), '{"type":"text","te\n', '"文字列"\n', '[1,2]\n', 'null\n', line(C)]))).toEqual([A, C]);
    });

    it('中止すると、待っている読み取りを止めて AbortError を投げ、本文の読み取りを閉じる', async () => {
        const stream = flowing();
        const controller = new AbortController();
        const lines = readJsonLines(stream.body, controller.signal);
        stream.push(A);
        expect((await lines.next()).value).toEqual(A);
        // 次の行を待っているあいだに中止する (本文は、終わっていない)
        const waiting = lines.next();
        controller.abort();
        await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
        expect(stream.closed()).toBe(true);
        // 始める前から中止されていれば、1 行も渡さない
        await expect(collect(bodyOf([line(A)]), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('同じまとまりで届いた行の途中で中止されたら、残りの行は渡さない', async () => {
        const controller = new AbortController();
        const got: unknown[] = [];
        const reading = (async () => {
            for await (const value of readJsonLines(bodyOf([line(A) + line(B) + line(C)]), controller.signal)) {
                got.push(value);
                controller.abort();
            }
        })();
        await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
        expect(got).toEqual([A]);
    });

    it('途中で読むのをやめると、本文の読み取りを閉じる（接続を残さない）', async () => {
        const stream = flowing();
        stream.push(A, B);
        for await (const value of readJsonLines(stream.body)) {
            expect(value).toEqual(A);
            break;
        }
        expect(stream.closed()).toBe(true);
    });
});

describe('少しずつ届く応答（ストリーミング）', () => {
    /** 流れている途中の吹き出し。 */
    const flowingItems = (session: Session) => session.getState().items.filter((item) => item.kind === 'assistant' && item.streaming);

    it('"stream": true を付けて送る。差分は 1 つの吹き出しに足されていき、done の content で確定する', async () => {
        const stream = flowing();
        stubSteps([stream.reply]);
        const session = new AssistantSession();
        const running = session.send('様子を教えて', fakeDeps().deps);
        await waitFor(() => expect(sent).toHaveLength(1));
        // ほかの項目は、今までどおり
        expect(sent[0]).toMatchObject({ stream: true, step: 0, messages: [{ role: 'user', content: [text('様子を教えて')] }] });
        expect(rows(session)).toEqual(['user: 様子を教えて']);

        // 頭の空白や改行だけのあいだは、吹き出しを出さない
        stream.push(delta('\n'));
        stream.push(delta('トラックは'));
        await waitFor(() => expect(rows(session)).toEqual(['user: 様子を教えて', 'assistant: トラックは']));
        expect(flowingItems(session)).toHaveLength(1);
        const bubbleId = flowingItems(session)[0].id;
        stream.push(delta(' 2 本'), delta('あります。'));
        await waitFor(() => expect(last(rows(session))).toBe('assistant: トラックは 2 本あります。'));
        // 足されるのは、同じ吹き出し
        expect(flowingItems(session).map((item) => item.id)).toEqual([bubbleId]);
        expect(session.getState()).toMatchObject({ running: true, waiting: '考えています…' });
        // 流れているあいだは、会話に足していない
        expect(session.conversation()).toHaveLength(1);

        // 確定する文は、差分をつないだものではなく、done の content から作る
        const content = [thinking, text('トラックは 2 本あります（確定）。')];
        stream.push(doneLine(content));
        await running;
        expect(rows(session)).toEqual(['user: 様子を教えて', 'assistant: トラックは 2 本あります（確定）。', 'turn: 1 回']);
        expect(flowingItems(session)).toEqual([]);
        // 吹き出しの番号は変わらない (画面の同じ要素のまま確定する)
        expect(session.getState().items[1]).toEqual({ kind: 'assistant', id: bubbleId, text: 'トラックは 2 本あります（確定）。' });
        // 会話には、done の content を変えずに足す (思考のブロックも。行の `type` などは入れない)
        expect(session.conversation()[1]).toEqual({ role: 'assistant', content });
        expect(session.getState()).toMatchObject({ running: false, waiting: null, today: TODAY });
        expect(last(session.getState().items)).toMatchObject({ kind: 'turn', calls: 1, costUsd: 0.01 });
        // 最後の行まで読んだら、本文の読み取りを閉じる
        expect(stream.closed()).toBe(true);
    });

    it('tool の行が来たら、待っているあいだの 1 行を「〜する準備をしています…」にする。ツールの後の応答も、少しずつ届く', async () => {
        engine.addTrack();
        const first = flowing();
        const second = flowing();
        const content = [thinking, text('トラックを足します。'), use('tu_1', 'add_track', { name: 'Bass' })];
        stubSteps([first.reply, second.reply]);
        const session = new AssistantSession();
        const running = session.send('ベース用のトラックを足して', fakeDeps().deps);
        await waitFor(() => expect(sent).toHaveLength(1));
        first.push(delta('トラックを足します。'));
        first.push(toolStart('add_track'));
        await waitFor(() => expect(session.getState().waiting).toBe(`${toolLabel('add_track')}準備をしています…`));
        expect(last(rows(session))).toBe('assistant: トラックを足します。');
        first.push(doneLine(content, 'tool_use'));

        // ツールを実行して、結果を送り返す (会話の形は、今までどおり)
        await waitFor(() => expect(sent).toHaveLength(2));
        expect(engine.tracks.map((t) => t.name)).toEqual(['Track 1', 'Bass']);
        expect(sent[1]).toMatchObject({ stream: true, step: 1 });
        expect(sent[1].messages[1]).toEqual({ role: 'assistant', content });
        expect(sent[1].messages[2].content.map((b) => [b.type, b.tool_use_id])).toEqual([['tool_result', 'tu_1']]);
        // 次の呼び出しを待つあいだは、「考えています…」に戻る
        expect(session.getState().waiting).toBe('考えています…');

        second.push(delta('「Bass」を'));
        await waitFor(() => expect(last(rows(session))).toBe('assistant: 「Bass」を'));
        second.push(delta('足しました。'), doneLine([text('「Bass」を足しました。')]));
        await running;
        expect(rows(session)).toEqual([
            'user: ベース用のトラックを足して',
            'assistant: トラックを足します。',
            'tool/ok: 「Bass」を追加しました',
            'assistant: 「Bass」を足しました。',
            'turn: 2 回・変えた',
        ]);
    });

    it('done の content に文が無ければ、流れていた吹き出しを消す。文が流れてこなくても、done の文は出す', async () => {
        engine.addTrack();
        stubSteps([
            flow(delta('見てみます'), toolStart('get_project'), doneLine([use('tu_1', 'get_project')], 'tool_use')),
            flow(doneLine([text('1 本あります。')])),
        ]);
        const session = new AssistantSession();
        await session.send('様子を教えて', fakeDeps().deps);
        expect(rows(session)).toEqual([
            'user: 様子を教えて',
            'tool/ok: プロジェクトの様子を見ました（トラック 1 本、120 BPM、4/4）',
            'assistant: 1 本あります。',
            'turn: 2 回',
        ]);
        expect(session.conversation().map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });

    it('error の行（途中の失敗）: 文と種類を読み、確定していない吹き出しを消す。会話には足さない', async () => {
        const session = new AssistantSession();
        const { deps } = fakeDeps();
        const later = { ...TODAY, calls: 4 };
        stubSteps([flow(delta('ええと、'), { type: 'error', detail: { message: 'Claude が混み合っています。少し待ってから、もう一度試してください', code: 'rate_limit' }, today: later })]);
        await session.send('やあ', deps);
        expect(rows(session)).toEqual(['user: やあ', 'notice/error: Claude が混み合っています。少し待ってから、もう一度試してください']);
        expect(session.conversation().map((m) => m.role)).toEqual(['user']);
        expect(session.getState()).toMatchObject({ running: false, waiting: null, needsKey: false, today: later });

        // API キーを入れれば直る種類なら、キーの欄を出す
        stubSteps([flow({ type: 'error', detail: { message: 'API キーが正しくありません', code: 'auth' } })]);
        await session.send('もう一度', deps);
        expect(last(rows(session))).toBe('notice/error: API キーが正しくありません');
        expect(session.getState().needsKey).toBe(true);
    });

    it('done も error も来ないまま本文が終わったら、途中で切れたと知らせて、吹き出しを消す', async () => {
        const session = new AssistantSession();
        const { deps } = fakeDeps();
        stubSteps([flow(delta('途中まで書いた文'), toolStart('add_track'))]);
        await session.send('足して', deps);
        expect(rows(session)).toEqual(['user: 足して', 'notice/error: 応答が途中で切れました。もう一度試してください']);
        expect(session.conversation().map((m) => m.role)).toEqual(['user']);
        expect(engine.tracks).toHaveLength(0);
        expect(session.getState()).toMatchObject({ running: false, waiting: null });
        // 空の本文も同じ
        stubSteps([flow()]);
        await session.send('もう一度', deps);
        expect(last(rows(session))).toBe('notice/error: 応答が途中で切れました。もう一度試してください');
        // 次の依頼は通る
        stubSteps([flow(delta('は'), delta('い。'), doneLine([text('はい。')]))]);
        await session.send('3 回目', deps);
        expect(rows(session).slice(-2)).toEqual(['assistant: はい。', 'turn: 1 回']);
    });

    it('流れている途中で中止すると、読み取りを止め、確定していない吹き出しを消す。次の依頼は通る形のまま', async () => {
        const stream = flowing();
        stubSteps([stream.reply, flow(delta('はい。'), doneLine([text('はい。')]))]);
        const session = new AssistantSession();
        const { deps } = fakeDeps();
        const running = session.send('長く話して', deps);
        stream.push(delta('むかしむかし、'));
        await waitFor(() => expect(last(rows(session))).toBe('assistant: むかしむかし、'));
        session.cancel();
        expect(session.getState().waiting).toBe('中止しています…');
        await running;
        expect(rows(session)).toEqual(['user: 長く話して', 'notice/info: 中止しました']);
        expect(session.getState()).toMatchObject({ running: false, waiting: null });
        expect(stream.closed()).toBe(true);
        // 会話に入っていない文は、次の依頼にも送らない
        await session.send('続けて', deps);
        expect(sent[1].messages).toEqual([
            { role: 'user', content: [text('長く話して')] }, { role: 'user', content: [text('続けて')] },
        ]);
        expect(rows(session).slice(-2)).toEqual(['assistant: はい。', 'turn: 1 回']);
    });

    it('JSON 1 つの応答（古い形）でも、今までどおり読む', async () => {
        const content = [thinking, text('はい。')];
        stubSteps([step(content)]);
        const session = new AssistantSession();
        await session.send('やあ', fakeDeps().deps);
        expect(sent[0].stream).toBe(true);
        expect(rows(session)).toEqual(['user: やあ', 'assistant: はい。', 'turn: 1 回']);
        expect(session.getState().items[1]).not.toHaveProperty('streaming');
        expect(session.conversation()[1]).toEqual({ role: 'assistant', content });
    });

    it('知らない種類の行と、done の後ろの行は読み飛ばす', async () => {
        stubSteps([flow({ type: 'ping' }, delta('は'), { type: 'text' }, doneLine([text('はい。')]), delta('おまけ'), { type: 'error', detail: { message: '遅れて来た失敗', code: 'api' } })]);
        const session = new AssistantSession();
        await session.send('やあ', fakeDeps().deps);
        expect(rows(session)).toEqual(['user: やあ', 'assistant: はい。', 'turn: 1 回']);
    });

    it('流れてきた文は、動きの記録に残さない', async () => {
        stubSteps([flow(delta('ひみつの答えを書きました'), doneLine([text('ひみつの答えを書きました')]))]);
        const session = new AssistantSession();
        await session.send('やあ', fakeDeps().deps);
        const lines = activityEntries().map((e) => `${e.tag}: ${e.message}`);
        expect(lines.join('\n')).not.toContain('ひみつ');
        expect(lines.filter((l) => l.startsWith('api: '))).toEqual([expect.stringMatching(/^api: POST \/api\/assistant\/step → 200/)]);
    });
});

describe('依頼ごとの記録と、動きの記録', () => {
    it('「変える」ツールの前に 1 回だけ記録を開き、終わりに閉じる。読むだけの依頼では開かない', async () => {
        const session = new AssistantSession();
        const { deps, log } = fakeDeps();
        stubSteps([step([use('a', 'get_project')], 'tool_use'), step([text('2 本あります。')])]);
        await session.send('様子を教えて', deps);
        expect(log).toEqual([]);
        expect(last(session.getState().items)).toMatchObject({ kind: 'turn', changed: false, undoEntryId: null });

        stubSteps([
            step([use('a', 'get_project'), use('b', 'add_track', { name: 'Bass' })], 'tool_use'),
            step([use('c', 'add_notes', { track_id: 1, notes: NOTES }), use('d', 'set_tempo', { bpm: 96 })], 'tool_use'),
            step([text('できました。')]),
        ]);
        await session.send('ベースのトラックを作って、最初の 1 小節にルートを置き、テンポも落としてください', deps);
        // 記録の名前は「アシスタント: <依頼の頭 20 文字>」
        expect(log).toEqual(['begin アシスタント: ベースのトラックを作って、最初の 1 小…', 'commit true']);
        expect(last(session.getState().items)).toMatchObject({ kind: 'turn', calls: 3, changed: true, undoEntryId: 7 });
        expect(engine.tracks[0].pianoNotes).toEqual([{ note: 'C', octave: 2, step: 0, length: 4 }, { note: 'D#', octave: 2, step: 4, length: 4 }]);
        expect(engine.bpm).toBe(96);
    });

    it('再生だけのように、何も変わらなかった依頼は、記録を作らない（「元に戻す」を出さない）', async () => {
        const session = new AssistantSession();
        const { deps, log } = fakeDeps();
        stubSteps([step([use('a', 'play', { from_bar: 2 })], 'tool_use'), step([text('再生しました。')])]);
        await session.send('2 小節目から再生して', deps);
        expect(log).toEqual(['begin アシスタント: 2 小節目から再生して', 'commit false']);
        expect(last(session.getState().items)).toMatchObject({ kind: 'turn', changed: false, undoEntryId: null });
    });

    it('requestHead: 頭の 20 文字。改行は空白にする', () => {
        expect(requestHead('テンポを 96 にして')).toBe('テンポを 96 にして');
        expect(requestHead('a'.repeat(20))).toBe('a'.repeat(20));
        expect(requestHead('a'.repeat(21))).toBe('a'.repeat(20) + '…');
        expect(requestHead('1 行目\n\n2 行目')).toBe('1 行目 2 行目');
    });

    it('動きの記録には、ツールの結果の 1 行だけを残す。利用者が打った文は残さない', async () => {
        const secret = 'ひみつの依頼の文をここに書きました';
        stubSteps([
            step([use('a', 'add_track', { name: 'Bass' }), use('b', 'add_notes', { track_id: 99, notes: NOTES })], 'tool_use'),
            step([text('できました。')]),
        ]);
        const session = new AssistantSession();
        await session.send(secret, fakeDeps().deps);
        const lines = activityEntries().map((e) => `${e.tag}: ${e.message}`);
        expect(lines.filter((l) => l.startsWith('agent: '))).toEqual([
            'agent: 「Bass」を追加しました',
            'agent: できませんでした（ノートを置く）: そのトラックが見つかりませんでした',
        ]);
        expect(lines.join('\n')).not.toContain('ひみつ');
        // API の呼び出しは、呼び出し先と結果の番号だけが残る
        expect(lines.filter((l) => l.startsWith('api: '))).toEqual([
            expect.stringMatching(/^api: POST \/api\/assistant\/step → 200/), expect.stringMatching(/^api: POST \/api\/assistant\/step → 200/),
        ]);
    });

    it('操作ログの行は、その操作のあいだに動きの記録に増えた行を持つ', async () => {
        stubSteps([step([use('a', 'add_track', { name: 'Bass' }), use('b', 'get_project')], 'tool_use'), step([text('できました。')])]);
        const session = new AssistantSession();
        await session.send('足して', fakeDeps().deps);
        const tools = session.getState().items.filter((item) => item.kind === 'tool');
        // 偽の入口は、トラックを足したときにステータスバーの文を記録する
        expect(tools[0].activity.map((e) => `${e.tag}: ${e.message}`)).toEqual(['status: 「Bass」を追加しました']);
        // 自分の結果の行 (agent) は、自分の中には入れない。次の操作にも持ち越さない
        expect(tools[1].activity).toEqual([]);
    });
});

// ---- 本物のストアと、ドックの部品 ----

/** 本物のストアにつないだ入口と、ドックを描く。ストアは `daw` で読める。 */
function Harness({ session, expose, toggle }: { session: Session; expose: (daw: DawContextType) => void; toggle?: boolean }) {
    const daw = useDaw();
    expose(daw);
    // 記録の開け閉めは本物 (lib/assistant-env.ts)。ツールの入口だけ、タイムラインとピアノロールの要らない偽物にする
    const real = useAssistantDeps();
    const deps: AssistantDeps = {
        env: engineEnv((label, fn) => daw.record(label, fn)),
        beginEdit: real.beginEdit,
        topUndoId: real.topUndoId,
        // 頼み方の例の材料も本物 (読むだけの入口。タイムラインとピアノロールが無くても読める)
        suggestionFacts: real.suggestionFacts,
    };
    return <>{toggle && <AssistantToggle />}{(!toggle || daw.assistantOpen) && <AssistantPanel deps={deps} session={session} />}</>;
}

function renderPanel(session: Session, options: { toggle?: boolean } = {}) {
    const ref: { daw: DawContextType | null } = { daw: null };
    render(<DawProvider><Harness session={session} expose={(daw) => { ref.daw = daw; }} toggle={options.toggle} /></DawProvider>);
    return { daw: () => ref.daw! };
}

const input = () => screen.getByRole('textbox', { name: 'アシスタントに頼むこと' }) as HTMLTextAreaElement;
const log = () => screen.getByRole('log', { name: '会話と操作ログ' });

/** 入力欄に打って Enter で送り、終わるまで待つ。 */
async function ask(request: string) {
    fireEvent.change(input(), { target: { value: request } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: '新しい会話' })).toBeEnabled());
}

describe('依頼ごとの記録（本物の元に戻す履歴）', () => {
    it('1 回の依頼で変えたことは、1 つの記録にまとまり、1 回の「元に戻す」で全部戻る', async () => {
        engine.addTrack();
        stubSteps([
            step([use('a', 'add_track', { name: 'Bass' })], 'tool_use'),
            step([use('b', 'add_notes', { track_id: 2, notes: NOTES }), use('c', 'set_track_mix', { track_id: 1, mute: true }), use('d', 'set_tempo', { bpm: 90 })], 'tool_use'),
            step([text('できました。')]),
        ]);
        const session = new AssistantSession();
        const { daw } = renderPanel(session);
        await ask('ベースを足して');
        expect(engine.tracks.map((t) => [t.name, t.pianoNotes.length, t.mute])).toEqual([['Track 1', 0, true], ['Bass', 2, false]]);
        expect(engine.bpm).toBe(90);
        // 元に戻す履歴には、この依頼の 1 つだけ
        expect(daw().undoLabel).toBe('アシスタント: ベースを足して');
        const turn = last(session.getState().items);
        expect(turn).toMatchObject({ kind: 'turn', changed: true, undoEntryId: daw().undoEntryId });

        const undo = within(log()).getByRole('button', { name: 'この依頼の変更を元に戻す' });
        expect(undo).toBeEnabled();
        expect(undo).toHaveTextContent('元に戻す');
        fireEvent.click(undo);
        await waitFor(() => expect(engine.tracks.map((t) => [t.name, t.pianoNotes.length, t.mute])).toEqual([['Track 1', 0, false]]));
        expect(engine.bpm).toBe(120);
        expect(daw().canUndo).toBe(false);
        // 画面には、依頼の頭の文字が入った名前で出す。動きの記録には、利用者が打った文を残さない
        expect(daw().status).toBe('元に戻しました（アシスタント: ベースを足して）');
        const noted = () => activityEntries().map((e) => `${e.tag}: ${e.message}`);
        expect(noted()).toContain('status: 元に戻しました（アシスタントの依頼）');
        expect(noted().join('\n')).not.toContain('ベースを足して');
        // 戻した後は押せない。やり直すと、また押せる
        expect(undo).toBeDisabled();
        act(() => daw().redo());
        expect(undo).toBeEnabled();
        expect(daw().status).toBe('やり直しました（アシスタント: ベースを足して）');
        expect(noted()).toContain('status: やり直しました（アシスタントの依頼）');
        expect(noted().join('\n')).not.toContain('ベースを足して');
    });

    it('その後に別の操作をしたら、チャットの「元に戻す」は押せない（別の操作が先に戻ってしまうため）', async () => {
        stubSteps([step([use('a', 'add_track', { name: 'Bass' })], 'tool_use'), step([text('できました。')])]);
        const session = new AssistantSession();
        const { daw } = renderPanel(session);
        await ask('足して');
        const undo = within(log()).getByRole('button', { name: 'この依頼の変更を元に戻す' });
        expect(undo).toBeEnabled();
        act(() => { daw().record('トラックを追加', () => engine.addTrack('Lead')); });
        expect(undo).toBeDisabled();
        act(() => daw().undo());
        expect(undo).toBeEnabled();
    });

    it('アシスタントが動いているあいだ（記録が開いているあいだ）は、利用者の「元に戻す」は効かない', async () => {
        engine.addTrack();
        stubSteps([step([use('a', 'add_track', { name: 'Bass' })], 'tool_use'), 'hang']);
        const session = new AssistantSession();
        const { daw } = renderPanel(session);
        fireEvent.change(input(), { target: { value: '足して' } });
        fireEvent.keyDown(input(), { key: 'Enter' });
        await waitFor(() => expect(sent).toHaveLength(2));
        expect(engine.tracks).toHaveLength(2);
        act(() => daw().undo());
        expect(engine.tracks).toHaveLength(2);
        // 中止すると記録が閉じ、そこまでの操作を「元に戻す」で戻せる
        fireEvent.click(screen.getByRole('button', { name: '中止' }));
        const undo = await within(log()).findByRole('button', { name: 'この依頼の変更を元に戻す' });
        expect(log()).toHaveTextContent('中止しました。ここまでに行った操作は残っています');
        fireEvent.click(undo);
        await waitFor(() => expect(engine.tracks).toHaveLength(1));
    });
});

describe('ドック（AssistantPanel）', () => {
    it('操作ログの行: 成功は ✓ と summary、失敗は ✕ と理由。開くと、その操作のあいだの動きの記録が出る', async () => {
        stubSteps([
            step([text('足します。'), use('a', 'add_track', { name: 'Bass' }), use('b', 'add_notes', { track_id: 99, notes: NOTES }), use('c', 'get_project')], 'tool_use'),
            step([text('トラックは足せましたが、ノートは置けませんでした。')]),
        ]);
        const session = new AssistantSession();
        renderPanel(session);
        await ask('ベースを足して');

        const tools = [...log().querySelectorAll('.assistant-tool')] as HTMLElement[];
        expect(tools.map((el) => el.textContent)).toEqual([
            expect.stringMatching(/^✓成功: 「Bass」を追加しました/),
            expect.stringMatching(/^✕失敗: ノートを置く: そのトラックが見つかりませんでした/),
            expect.stringMatching(/^✓成功: プロジェクトの様子を見ました（トラック 1 本、120 BPM、4\/4）/),
        ]);
        expect(tools.map((el) => [el.tagName, el.className, el.dataset.tool])).toEqual([
            ['DETAILS', 'assistant-tool ok', 'add_track'], ['DETAILS', 'assistant-tool error', 'add_notes'], ['DETAILS', 'assistant-tool ok', 'get_project'],
        ]);
        // 行の中: その操作のあいだに増えた、動きの記録の行 (時刻・呼び名・文)
        const during = within(tools[0]).getByRole('list', { name: 'この操作のあいだに起きたこと' });
        expect(within(during).getAllByRole('listitem')).toHaveLength(1);
        expect(during.textContent).toMatch(/^\d\d:\d\d:\d\d\.\d{3}状態「Bass」を追加しました$/);
        // 何も起きなかった操作
        expect(tools[2]).toHaveTextContent('この操作のあいだに、ほかに起きたことはありません');
        // 行を開いて読む操作は、動きの記録に残さない
        expect(tools[0]).toHaveAttribute('data-activity-ignore');

        // 利用者の文、アシスタントの文、依頼の終わり
        expect(log().querySelector('.assistant-msg.user')).toHaveTextContent('あなた: ベースを足して');
        expect([...log().querySelectorAll('.assistant-msg.assistant')].map((el) => el.textContent)).toEqual([
            'アシスタント: 足します。', 'アシスタント: トラックは足せましたが、ノートは置けませんでした。',
        ]);
        expect(log().querySelector('.assistant-turn')).toHaveTextContent('Claude を 2 回呼びました（概算 $0.02）');
        // 今日の使用量
        expect(screen.getByText('今日 3 回・$0.12')).toBeInTheDocument();
    });

    it('Enter で送る。Shift+Enter と、日本語の変換中の Enter では送らない。空の文は送れない', async () => {
        const fetchMock = stubSteps([step([text('はい。')])]);
        const session = new AssistantSession();
        renderPanel(session);
        const calls = () => fetchMock.mock.calls.filter((call) => call[0] === '/api/assistant/step').length;
        const send = screen.getByRole('button', { name: '送る' });
        // 空と、空白だけ
        expect(send).toBeDisabled();
        fireEvent.keyDown(input(), { key: 'Enter' });
        fireEvent.change(input(), { target: { value: '   ' } });
        expect(send).toBeDisabled();
        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(calls()).toBe(0);

        fireEvent.change(input(), { target: { value: 'てんぽを' } });
        expect(send).toBeEnabled();
        // 変換中の Enter (変換を確定する操作)
        fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
        // 変換を確定した Enter が、isComposing なしで届くブラウザ (WebKit) は keyCode 229 で見分ける
        fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
        // 改行
        fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
        expect(calls()).toBe(0);
        expect(input().value).toBe('てんぽを');

        fireEvent.keyDown(input(), { key: 'Enter' });
        await waitFor(() => expect(calls()).toBe(1));
        // 送ったら、入力欄は空になる
        expect(input().value).toBe('');
        await waitFor(() => expect(log()).toHaveTextContent('アシスタント: はい。'));
    });

    it('待っているあいだは「考えています…」と「中止」を出し、送れない', async () => {
        stubSteps(['hang']);
        const session = new AssistantSession();
        renderPanel(session);
        fireEvent.change(input(), { target: { value: '考えて' } });
        fireEvent.click(screen.getByRole('button', { name: '送る' }));
        expect(await screen.findByRole('status')).toHaveTextContent('考えています…');
        // 動いているあいだは、打てても送れない
        fireEvent.change(input(), { target: { value: '次の依頼' } });
        expect(screen.getByRole('button', { name: '送る' })).toBeDisabled();
        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(sent).toHaveLength(1);
        expect(screen.getByRole('button', { name: '新しい会話' })).toBeDisabled();

        fireEvent.click(screen.getByRole('button', { name: '中止' }));
        await waitFor(() => expect(log()).toHaveTextContent('中止しました'));
        expect(screen.queryByRole('button', { name: '中止' })).toBeNull();
        expect(screen.getByRole('button', { name: '送る' })).toBeEnabled();
        // 打ちかけの文は残る
        expect(input().value).toBe('次の依頼');
    });

    it('流れている文は、1 つの吹き出しに足されていく。流れているあいだは aria-busy で読み上げを待ち、確定したら外す', async () => {
        const stream = flowing();
        stubSteps([stream.reply]);
        const session = new AssistantSession();
        renderPanel(session);
        fireEvent.change(input(), { target: { value: '様子を教えて' } });
        fireEvent.keyDown(input(), { key: 'Enter' });
        await waitFor(() => expect(sent).toHaveLength(1));
        const bubbles = () => [...log().querySelectorAll('.assistant-msg.assistant')] as HTMLElement[];
        expect(bubbles()).toHaveLength(0);

        await act(async () => { stream.push(delta('トラックは')); });
        await waitFor(() => expect(bubbles().map((el) => el.textContent)).toEqual(['アシスタント: トラックは']));
        const bubble = bubbles()[0];
        expect(bubble).toHaveAttribute('aria-busy', 'true');
        expect(bubble).toHaveClass('streaming');
        await act(async () => { stream.push(delta(' 2 本あります。')); });
        await waitFor(() => expect(bubble).toHaveTextContent('アシスタント: トラックは 2 本あります。'));
        expect(bubbles()).toHaveLength(1);
        // 待っているあいだの 1 行と「中止」は、流れているあいだも出ている
        expect(screen.getByRole('status')).toHaveTextContent('考えています…');
        await act(async () => { stream.push(toolStart('add_track')); });
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`${toolLabel('add_track')}準備をしています…`));
        expect(screen.getByRole('button', { name: '中止' })).toBeEnabled();

        await act(async () => { stream.push(doneLine([text('トラックは 2 本あります。')])); });
        await waitFor(() => expect(screen.getByRole('button', { name: '新しい会話' })).toBeEnabled());
        // 同じ要素のまま確定する (読み上げは、ここで全文を 1 回)
        expect(bubbles()).toEqual([bubble]);
        expect(bubble).not.toHaveAttribute('aria-busy');
        expect(bubble).not.toHaveClass('streaming');
        expect(bubble).toHaveTextContent('アシスタント: トラックは 2 本あります。');
    });

    it('流れている途中で「中止」を押すと、確定していない吹き出しは消える', async () => {
        const stream = flowing();
        stubSteps([stream.reply]);
        const session = new AssistantSession();
        renderPanel(session);
        fireEvent.change(input(), { target: { value: '長く話して' } });
        fireEvent.keyDown(input(), { key: 'Enter' });
        await waitFor(() => expect(sent).toHaveLength(1));
        await act(async () => { stream.push(delta('むかしむかし、')); });
        await waitFor(() => expect(log()).toHaveTextContent('アシスタント: むかしむかし、'));
        fireEvent.click(screen.getByRole('button', { name: '中止' }));
        await waitFor(() => expect(log()).toHaveTextContent('中止しました'));
        expect(log().querySelectorAll('.assistant-msg.assistant')).toHaveLength(0);
        expect(log()).not.toHaveTextContent('むかしむかし');
        expect(screen.getByRole('button', { name: '送る' })).toBeDisabled();
        expect(screen.queryByRole('button', { name: '中止' })).toBeNull();
    });

    it('API キーが無いときは、理由と API キーの欄を出す。設定すると欄をしまう', async () => {
        const fetchMock = stubSteps([{ status: 401, detail: { message: 'Claude の API キーが設定されていません', code: 'no_key' } }]);
        const session = new AssistantSession();
        renderPanel(session);
        expect(screen.queryByLabelText('Claude の API キー')).toBeNull();
        await ask('やあ');
        expect(within(log()).getByRole('alert')).toHaveTextContent('Claude の API キーが設定されていません');
        const key = screen.getByLabelText('Claude の API キー');
        expect(key).toHaveAttribute('type', 'password');
        // 何を Claude に送るかも出している
        expect(screen.getByText(/音声は送りません/)).toBeInTheDocument();

        fetchMock.mockImplementation(async () => Response.json({ has_key: true, key_source: 'settings', model: 'claude-opus-5-5' }));
        fireEvent.change(key, { target: { value: 'sk-ant-test' } });
        fireEvent.click(screen.getByRole('button', { name: '設定する' }));
        await waitFor(() => expect(screen.queryByLabelText('Claude の API キー')).toBeNull());
        expect(screen.getByText('API キーを設定しました')).toBeInTheDocument();
        expect(session.getState().needsKey).toBe(false);
    });

    it('何も無いときは頼み方の例を出し、押すと入力欄に入る（送るのは自分で）。「新しい会話」で空に戻る', async () => {
        const fetchMock = stubSteps([step([text('はい。')])]);
        const session = new AssistantSession();
        renderPanel(session);
        const examples = within(log()).getAllByRole('button');
        expect(examples).toHaveLength(3);
        expect(screen.getByRole('button', { name: '新しい会話' })).toBeDisabled();
        fireEvent.click(examples[2]);
        expect(input().value).toBe(examples[2].textContent);
        expect(fetchMock.mock.calls.filter((call) => call[0] === '/api/assistant/step')).toHaveLength(0);

        await ask(input().value);
        expect(within(log()).queryAllByRole('button', { name: /教えて|置いて|再生して/ })).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: '新しい会話' }));
        expect(log().querySelectorAll('.assistant-msg')).toHaveLength(0);
        expect(within(log()).getAllByRole('button')).toHaveLength(3);
        expect(session.conversation()).toEqual([]);
    });

    it('ヘッダのボタンで開閉でき、閉じて開き直しても会話と操作ログが残る', async () => {
        stubSteps([step([use('a', 'add_track', { name: 'Bass' })], 'tool_use'), step([text('足しました。')])]);
        const session = new AssistantSession();
        renderPanel(session, { toggle: true });
        const toggle = screen.getByRole('button', { name: 'アシスタント' });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('complementary', { name: 'アシスタント' })).toBeNull();
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('complementary', { name: 'アシスタント' })).toBeInTheDocument();
        // 開いたら、すぐ打てる
        expect(input()).toHaveFocus();
        await ask('足して');

        fireEvent.click(screen.getByRole('button', { name: 'アシスタントを閉じる' }));
        expect(screen.queryByRole('complementary', { name: 'アシスタント' })).toBeNull();
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(toggle);
        expect(log()).toHaveTextContent('「Bass」を追加しました');
        expect(log()).toHaveTextContent('アシスタント: 足しました。');
        expect(within(log()).getByRole('button', { name: 'この依頼の変更を元に戻す' })).toBeEnabled();
    });
});

describe('会話の保存と、長くなったときのまとめ（lib/assistant-history.ts）', () => {
    const items: ChatItem[] = [
        { kind: 'user', id: 1, text: 'ベースを置いて' },
        { kind: 'tool', id: 2, name: 'add_notes', state: 'ok', text: 'ノートを 8 個置きました（Track 1、1〜2 小節）', activity: [{ id: 9, at: 0, tag: 'status', message: '8 ノートを追加' }] },
        { kind: 'tool', id: 3, name: 'add_notes', state: 'error', text: 'ノートを置く: そのトラックが見つかりませんでした', activity: [] },
        { kind: 'tool', id: 4, name: 'play', state: 'running', text: '再生しています…', activity: [] },
        { kind: 'assistant', id: 5, text: '1〜2 小節に\nベースを置きました。' },
        { kind: 'assistant', id: 6, text: '流れている途中', streaming: true },
        { kind: 'notice', id: 7, tone: 'info', text: '中止しました' },
        { kind: 'turn', id: 8, calls: 2, costUsd: 0.03, changed: true, undoEntryId: 4, model: 'claude-sonnet-5-5', reason: 'ベースを考えるので' },
    ];

    it('itemsToSaved: 文だけを残す（番号・操作のあいだの動きの記録・流れている文・実行中の行は入れない）', () => {
        expect(itemsToSaved(items)).toEqual([
            { kind: 'user', text: 'ベースを置いて' },
            { kind: 'tool', name: 'add_notes', state: 'ok', text: 'ノートを 8 個置きました（Track 1、1〜2 小節）' },
            { kind: 'tool', name: 'add_notes', state: 'error', text: 'ノートを置く: そのトラックが見つかりませんでした' },
            { kind: 'assistant', text: '1〜2 小節に\nベースを置きました。' },
            { kind: 'notice', tone: 'info', text: '中止しました' },
            { kind: 'turn', calls: 2, costUsd: 0.03, model: 'claude-sonnet-5-5', reason: 'ベースを考えるので' },
        ]);
        // 新しいほうから、上限まで。長い文は切る
        const many: ChatItem[] = Array.from({ length: MAX_SAVED_ITEMS + 5 }, (_v, i) => ({ kind: 'user', id: i + 1, text: `依頼 ${i}` }));
        const saved = itemsToSaved(many);
        expect(saved).toHaveLength(MAX_SAVED_ITEMS);
        expect(saved[0]).toEqual({ kind: 'user', text: '依頼 5' });
        expect((itemsToSaved([{ kind: 'user', id: 1, text: 'あ'.repeat(5000) }])[0] as { text: string }).text).toHaveLength(4001);
    });

    it('itemsFromSection: 保存した形をそのまま読み戻す。おかしな値は読み飛ばす', () => {
        const saved = itemsToSaved(items);
        expect(itemsFromSection({ version: 1, items: saved })).toEqual(saved);
        expect(itemsFromSection(null)).toEqual([]);
        expect(itemsFromSection({ items: 'x' })).toEqual([]);
        expect(itemsFromSection({ items: [null, 3, { kind: 'user' }, { kind: 'user', text: '  ' }, { kind: 'tool', name: 'play', state: 'running', text: 'x' },
            { kind: 'spell', text: 'x' }, { kind: 'notice', tone: 'loud', text: '知らせ' }, { kind: 'turn', calls: 'many', costUsd: 'x' }, { kind: 'assistant', text: 'はい' }] }))
            .toEqual([{ kind: 'notice', tone: 'info', text: '知らせ' }, { kind: 'turn', calls: 0, costUsd: null }, { kind: 'assistant', text: 'はい' }]);
    });

    it('conversationDigest: 利用者の文・アシスタントの文・操作ログの行を、古い順に並べる。ツールの結果の中身は入れない', () => {
        expect(conversationDigest(items)).toBe([
            '<earlier_conversation>',
            'Record of the earlier conversation in this project, written by the app. Oldest first. Tool results are left out.',
            'User: ベースを置いて',
            'Tool ok: ノートを 8 個置きました（Track 1、1〜2 小節）',
            'Tool failed: ノートを置く: そのトラックが見つかりませんでした',
            'Assistant: 1〜2 小節に ベースを置きました。',
            '</earlier_conversation>',
        ].join('\n'));
        expect(conversationDigest([])).toBeNull();
        expect(conversationDigest([{ kind: 'notice', id: 1, tone: 'info', text: '中止しました' }])).toBeNull();
    });

    it('conversationDigest: 上限を超えるぶんは、古いほうから省き、省いた数を書く', () => {
        const long: ChatItem[] = Array.from({ length: 40 }, (_v, i) => ({ kind: 'user', id: i + 1, text: `依頼 ${i} ` + 'あ'.repeat(500) }));
        const digest = conversationDigest(long)!;
        expect(digest.length).toBeLessThan(DIGEST_CHARS + 300);
        expect(digest).toMatch(/\(\d+ earlier entries omitted\)/);
        expect(digest).toContain('依頼 39 ');
        expect(digest).not.toContain('依頼 0 ');
        // どれだけ長くても、いちばん新しい 1 つは入れる
        expect(conversationDigest([{ kind: 'user', id: 1, text: 'い'.repeat(550) }], 10)).toContain('い'.repeat(550));
    });

    it('needsCompaction: 件数か大きさが上限を超えたら、まとめる', () => {
        const message = (value: string): ApiMessage => ({ role: 'user', content: [text(value)] });
        expect(needsCompaction([message('短い')])).toBe(false);
        expect(needsCompaction(Array.from({ length: COMPACT_MESSAGES + 1 }, () => message('短い')))).toBe(true);
        expect(needsCompaction([message('あ'.repeat(COMPACT_CHARS))])).toBe(true);
    });
});

describe('会話を戻す・まとめる（AssistantSession）', () => {
    const SAVED = [
        { kind: 'user', text: 'ベースを置いて' } as const,
        { kind: 'tool', name: 'add_notes', state: 'ok', text: 'ノートを 8 個置きました（Track 1、1〜2 小節）' } as const,
        { kind: 'assistant', text: '置きました。' } as const,
        { kind: 'turn', calls: 2, costUsd: 0.03 } as const,
    ];

    it('restore: 保存してあった並びを画面に戻す。次の依頼は、その記録から始める（前の会話のメッセージは送らない）', async () => {
        stubSteps([step([text('続けます。')])]);
        const session = new AssistantSession();
        expect(session.restore(SAVED)).toBe(true);
        expect(rows(session)).toEqual(['user: ベースを置いて', 'tool/ok: ノートを 8 個置きました（Track 1、1〜2 小節）', 'assistant: 置きました。', 'turn: 2 回']);
        expect(session.getState().restored).toBe(4);
        expect(session.conversation()).toEqual([]);
        // 開き直したら、元に戻す履歴は無いので、「元に戻す」は出さない
        expect(last(session.getState().items)).toMatchObject({ kind: 'turn', changed: false, undoEntryId: null });

        await session.send('続きをお願い', fakeDeps().deps);
        expect(sent[0].messages).toHaveLength(2);
        const digest = String(sent[0].messages[0].content[0].text);
        expect(sent[0].messages[0].role).toBe('user');
        expect(digest).toMatch(/^<earlier_conversation>\n/);
        expect(digest).toContain('User: ベースを置いて');
        expect(digest).toContain('Tool ok: ノートを 8 個置きました');
        expect(sent[0].messages[1]).toEqual({ role: 'user', content: [text('続きをお願い')] });
        // その次の依頼には、記録を付け直さない (会話は、足すだけ)
        await session.send('もう 1 つ', fakeDeps().deps);
        expect(sent[1].messages).toHaveLength(4);
        expect(sent[1].messages.slice(0, 2)).toEqual(sent[0].messages);
        // 保存する形には、戻したぶんも、その後のぶんも入る
        expect(session.saved().filter((item) => item.kind === 'user').map((item) => (item as { text: string }).text)).toEqual(['ベースを置いて', '続きをお願い', 'もう 1 つ']);
    });

    it('restore: 空の並びなら、空にする。「新しい会話」の後は、記録を付けない', async () => {
        stubSteps([step([text('はい。')])]);
        const session = new AssistantSession();
        session.restore(SAVED);
        session.restore([]);
        expect(session.getState()).toMatchObject({ items: [], restored: 0 });
        session.restore(SAVED);
        session.reset();
        expect(session.getState().restored).toBe(0);
        await session.send('こんにちは', fakeDeps().deps);
        expect(sent[0].messages).toEqual([{ role: 'user', content: [text('こんにちは')] }]);
    });

    it('restore: 動いているあいだに呼ばれたら（依頼の途中でプロジェクトを開いた）、中止して、依頼が終わったところで戻す', async () => {
        engine.addTrack();
        // 1 回目でトラックを足し (依頼ごとの記録が開く)、2 回目の呼び出しを待っているあいだに、プロジェクトが入れ替わる
        stubSteps([step([use('a', 'add_track', { name: 'Bass' })], 'tool_use'), 'hang']);
        const session = new AssistantSession();
        const { deps, log } = fakeDeps();
        const running = session.send('トラックを足して', deps);
        await waitFor(() => expect(sent).toHaveLength(2));
        expect(session.restore(SAVED)).toBe(false);
        await running;
        // 前のプロジェクトの会話は残さず、開いたプロジェクトの会話に置き換わる (保存で、別のプロジェクトに入れない)
        expect(rows(session)).toEqual(['user: ベースを置いて', 'tool/ok: ノートを 8 個置きました（Track 1、1〜2 小節）', 'assistant: 置きました。', 'turn: 2 回']);
        expect(session.getState()).toMatchObject({ running: false, restored: 4 });
        expect(session.conversation()).toEqual([]);
        // 依頼ごとの記録は、作らずに閉じる (前と後で、別のプロジェクトになる)
        expect(log).toEqual(['begin アシスタント: トラックを足して', 'discard']);
        // 空の並びで呼ばれたら (新しいプロジェクト)、空になる
        stubSteps(['hang']);
        const again = session.send('待って', fakeDeps().deps);
        await waitFor(() => expect(session.getState().running).toBe(true));
        session.restore([]);
        await again;
        expect(session.getState()).toMatchObject({ items: [], restored: 0, running: false });
    });

    it('会話が長くなったら、次の依頼の前に、送る会話を丸ごと記録に置き換える（画面の並びは残る）', async () => {
        // ツールの結果が大きい依頼 (読むだけ) を 1 つ。get_notes の結果を、上限を超える大きさにする
        const track = engine.addTrack();
        track.pianoNotes = Array.from({ length: 400 }, (_v, i) => ({ note: 'C', octave: 4, step: i, length: 1 }));
        const big = [thinking, text('読みます。'), ...Array.from({ length: 12 }, (_v, i) => use(`tu_${i}`, 'get_notes', { track_id: track.id }))];
        stubSteps([step(big, 'tool_use'), step([text('読みました。')]), step([text('続けます。')])]);
        const session = new AssistantSession();
        await session.send('ノートを全部読んで', fakeDeps().deps);
        expect(JSON.stringify(session.conversation()).length).toBeGreaterThan(COMPACT_CHARS);
        const shown = rows(session).length;

        await session.send('ありがとう', fakeDeps().deps);
        // 3 回目の呼び出し: 記録 + 新しい依頼だけ。前の会話のメッセージ (思考のブロックも) は送らない
        expect(sent[2].messages).toHaveLength(2);
        expect(JSON.stringify(sent[2].messages)).not.toContain('sig-abc');
        const digest = String(sent[2].messages[0].content[0].text);
        expect(digest).toContain('User: ノートを全部読んで');
        expect(digest).toContain('Assistant: 読みました。');
        expect(sent[2].messages[1]).toEqual({ role: 'user', content: [text('ありがとう')] });
        expect(sent[2].step).toBe(0);
        // 画面には、前の並びが残り、まとめた知らせが 1 行入る
        expect(rows(session).slice(0, shown)).toEqual(expect.arrayContaining(['user: ノートを全部読んで', 'assistant: 読みました。']));
        expect(rows(session)[shown]).toMatch(/^notice\/info: 会話が長くなったので、ここまでを短い記録にまとめて/);
        expect(rows(session)[shown + 1]).toBe('user: ありがとう');
    });
});

describe('頼み方の例（lib/assistant-suggestions.ts）', () => {
    const base: SuggestionFacts = {
        trackCount: 0, imported: false, hasChart: false, separated: false, practiced: false,
        practiceOpen: false, selectedNotes: 0, openTrackHasNotes: false, jobRunning: false,
    };

    it('いつも 3 つで、重なりが無い', () => {
        const all: SuggestionFacts[] = [
            base, { ...base, trackCount: 1 }, { ...base, imported: true, trackCount: 1 }, { ...base, imported: true, hasChart: true, trackCount: 1 },
            { ...base, imported: true, hasChart: true, separated: true, trackCount: 7 },
            { ...base, imported: true, separated: true, practiced: true, practiceOpen: true, selectedNotes: 3, openTrackHasNotes: true, jobRunning: true, trackCount: 8 },
        ];
        for (const facts of all) {
            const picked = suggestionsFor(facts);
            expect(picked).toHaveLength(SUGGESTION_COUNT);
            expect(new Set(picked).size).toBe(SUGGESTION_COUNT);
        }
    });

    it('状況に合わせて選ぶ: 何も無い → 取り込み、カルテ → パート分離、練習画面 → 比べる・くり返す、選んでいる → 変形', () => {
        expect(suggestionsFor(base)[0]).toBe('曲を取り込むのは、どこから？');
        expect(suggestionsFor({ ...base, imported: true, hasChart: true, trackCount: 1 }).slice(0, 2)).toEqual(['この曲のキーとコード進行を教えて', 'パートに分けて採譜して']);
        expect(suggestionsFor({ ...base, imported: true, separated: true, trackCount: 7 })[0]).toBe('ベースの練習画面を開いて');
        expect(suggestionsFor({ ...base, imported: true, separated: true, practiced: true, practiceOpen: true, trackCount: 8 }).slice(0, 2))
            .toEqual(['お手本と比べて、どこが違うか教えて', 'この区間を 75% の速さでくり返し再生して']);
        expect(suggestionsFor({ ...base, trackCount: 1, selectedNotes: 2, openTrackHasNotes: true }).slice(0, 2)).toEqual(['選んだノートを 1 オクターブ上げて', '選んだノートを、だんだん強くして']);
        expect(suggestionsFor({ ...base, trackCount: 1, jobRunning: true })[0]).toBe('いま動いている処理は、どこまで進んだ？');
        expect(suggestionsFor({ ...base, trackCount: 1 })).toEqual([
            'いまのプロジェクトの様子を教えて', 'トラックを 1 本追加して、1〜2 小節に C メジャーのベースラインを置いて', 'テンポを 96 にして、1 小節目から再生して',
        ]);
    });
});

describe('前の会話（履歴）', () => {
    const FIRST = [
        { kind: 'user', text: 'ベースを置いて' } as const,
        { kind: 'assistant', text: '置きました。' } as const,
    ];

    it('「新しい会話」で、それまでの会話は消えずに履歴の頭へ移る。空の会話は移さない。上限を超えたら古いほうから消える', () => {
        const session = new AssistantSession();
        session.reset();
        expect(session.getState().archive).toEqual([]);
        session.restore(FIRST);
        session.reset();
        expect(session.getState().items).toEqual([]);
        expect(session.getState().archive).toHaveLength(1);
        expect(session.getState().archive[0]).toMatchObject({ title: 'ベースを置いて', items: FIRST });
        for (let i = 0; i < MAX_ARCHIVED + 3; i++) {
            session.restore([{ kind: 'user', text: `依頼 ${i}` }], session.archived());
            session.reset();
        }
        const titles = session.getState().archive.map((entry) => entry.title);
        expect(titles).toHaveLength(MAX_ARCHIVED);
        expect(titles[0]).toBe(`依頼 ${MAX_ARCHIVED + 2}`);
        expect(titles).not.toContain('ベースを置いて');
    });

    it('履歴から開き直すと、いまの会話は履歴に残り、次の依頼は開き直した会話の記録から始まる', async () => {
        stubSteps([step([text('続けます。')])]);
        const session = new AssistantSession();
        session.restore(FIRST);
        session.reset();
        session.restore([{ kind: 'user', text: 'テンポを 120 に' }], session.archived());
        const id = session.getState().archive[0].id;
        expect(session.openArchived(id)).toBe(true);
        expect(rows(session)).toEqual(['user: ベースを置いて', 'assistant: 置きました。']);
        expect(session.getState()).toMatchObject({ restored: 2, restoredFrom: 'history' });
        expect(session.getState().archive.map((entry) => entry.title)).toEqual(['テンポを 120 に']);
        expect(session.openArchived(9999)).toBe(false);

        await session.send('続きをお願い', fakeDeps().deps);
        const digest = String(sent[0].messages[0].content[0].text);
        expect(digest).toMatch(/^<earlier_conversation>\n/);
        expect(digest).toContain('User: ベースを置いて');
        expect(digest).not.toContain('テンポを 120 に');
    });

    it('動いているあいだは、開き直さない。履歴の会話は消せる', async () => {
        stubSteps(['hang']);
        const session = new AssistantSession();
        session.restore(FIRST);
        session.reset();
        const id = session.getState().archive[0].id;
        const running = session.send('こんにちは', fakeDeps().deps);
        await waitFor(() => expect(session.getState().running).toBe(true));
        expect(session.openArchived(id)).toBe(false);
        session.cancel();
        await running;
        expect(session.deleteArchived(id)).toBe(true);
        expect(session.getState().archive).toEqual([]);
        expect(session.deleteArchived(id)).toBe(false);
    });

    it('archiveFromSection / archiveTitle: 保存した形を読む。おかしな会話は読み飛ばし、名前が無ければ最初の依頼から作る', () => {
        let n = 0;
        const next = () => ++n;
        expect(archiveFromSection(null, next)).toEqual([]);
        expect(archiveFromSection({ version: 1, items: FIRST }, next)).toEqual([]);
        const read = archiveFromSection({
            archive: [
                { title: 'ベース', archivedAt: '2026-11-19T05:00:00.000Z', items: FIRST },
                { title: 'x', items: [] },
                null,
                { archivedAt: 'いつか', items: [{ kind: 'assistant', text: 'こんにちは' }] },
            ],
        }, next);
        expect(read).toEqual([
            { id: 1, title: 'ベース', archivedAt: '2026-11-19T05:00:00.000Z', items: FIRST },
            { id: 2, title: 'こんにちは', archivedAt: null, items: [{ kind: 'assistant', text: 'こんにちは' }] },
        ]);
        expect(archiveTitle([{ kind: 'turn', calls: 1, costUsd: null }])).toBe('（依頼の無い会話）');
        expect(archiveTitle([{ kind: 'user', text: 'あ'.repeat(40) }])).toBe('あ'.repeat(30) + '…');
    });
});

describe('ドック: 前の会話（履歴）', () => {
    it('「新しい会話」の後、「履歴」から前の会話を開き直せる。区切りは履歴の言い方。消すと一覧から外れる', async () => {
        const session = new AssistantSession();
        session.restore([{ kind: 'user', text: 'ベースを置いて' }, { kind: 'assistant', text: '置きました。' }]);
        renderPanel(session);
        const history = screen.getByRole('button', { name: /^履歴/ });
        expect(history).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: '新しい会話' }));
        expect(within(log()).queryByText('置きました。')).toBeNull();
        expect(history).toBeEnabled();
        expect(history).toHaveTextContent('履歴 1');

        fireEvent.click(history);
        const list = screen.getByRole('region', { name: '前の会話' });
        expect(within(list).getByText('ベースを置いて')).toBeInTheDocument();
        fireEvent.click(within(list).getByRole('button', { name: '「ベースを置いて」の会話を開く' }));
        expect(screen.queryByRole('region', { name: '前の会話' })).toBeNull();
        expect(within(log()).getByText('置きました。')).toBeInTheDocument();
        expect(within(log()).getByRole('separator')).toHaveTextContent('ここまでは、履歴から開き直した会話です');

        // 開き直した会話を、もう一度履歴に移して、消す
        fireEvent.click(screen.getByRole('button', { name: '新しい会話' }));
        fireEvent.click(screen.getByRole('button', { name: /^履歴/ }));
        fireEvent.click(screen.getByRole('button', { name: '「ベースを置いて」の会話を消す' }));
        // 最後の 1 つを消したら、一覧を閉じて会話に戻る
        expect(screen.queryByRole('region', { name: '前の会話' })).toBeNull();
        expect(screen.getByRole('button', { name: /^履歴/ })).toBeDisabled();
    });
});

describe('ドック: 保存してあった会話', () => {
    it('戻した会話の後ろに、区切りを出す。新しい会話にすると、区切りも消える', async () => {
        stubSteps([step([text('続けます。')])]);
        const session = new AssistantSession();
        session.restore([{ kind: 'user', text: 'ベースを置いて' }, { kind: 'assistant', text: '置きました。' }]);
        renderPanel(session);
        const separator = within(log()).getByRole('separator');
        expect(separator).toHaveTextContent('ここまでは、プロジェクトに保存してあった会話です');
        // 区切りは、戻した並びのすぐ後ろ (その後の依頼は、区切りの後ろに並ぶ)
        expect(separator.previousElementSibling).toHaveTextContent('置きました。');
        await ask('続きをお願い');
        expect(separator.nextElementSibling).toHaveTextContent('続きをお願い');
        fireEvent.click(screen.getByRole('button', { name: '新しい会話' }));
        expect(within(log()).queryByRole('separator')).toBeNull();
    });
});

describe('ドック: 1 日の上限に達したとき', () => {
    const BLOCKED = { ...TODAY, calls: 20, limit_calls: 20, blocked: '今日は再現ガイドを 20 回作りました。1 日の上限（20 回）に達したので、Claude を呼びません。' };

    it('入力欄の上に、アシスタントの言い方の知らせを 1 つ出す（処理を担当する部分の、再現ガイドの言い方の文は出さない）', () => {
        stubSteps([step([text('はい。')])]);
        const session = new AssistantSession();
        session.setToday(BLOCKED);
        renderPanel(session);
        const alerts = screen.getAllByRole('alert');
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toHaveTextContent('今日は Claude を 20 回使いました。1 日の上限（20 回）に達したので、いまは頼めません（再現ガイド・差分の説明・アシスタントの合計です）');
        expect(document.body.textContent).not.toContain('再現ガイドを 20 回作りました');
    });

    it('上限で断られたら、会話に理由を 1 つ出し、入力欄の上の知らせは重ねない。今日の使用量を読み直す', async () => {
        const fetchMock = stubSteps([{ status: 429, detail: { message: '今日は Claude を 20 回使いました。1 日の上限（20 回）に達したので、アシスタントは Claude を呼びません。', code: 'daily_limit' } }]);
        const session = new AssistantSession();
        session.setToday(BLOCKED);
        renderPanel(session);
        fireEvent.change(input(), { target: { value: 'トラックを足して' } });
        fireEvent.keyDown(input(), { key: 'Enter' });
        await waitFor(() => expect(session.getState().running).toBe(false));
        await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
        expect(screen.getByRole('alert')).toHaveTextContent('アシスタントは Claude を呼びません');
        expect(last(session.getState().items)).toMatchObject({ kind: 'notice', tone: 'error', code: 'daily_limit' });
        // 今日の使用量を読み直している (Claude は呼ばない)
        await waitFor(() => expect(fetchMock.mock.calls.filter((call) => call[0] === '/api/settings/guide').length).toBeGreaterThanOrEqual(1));
    });
});

// ---- モデルの選び方（ルーター）・カード・パネルからの依頼 ----

const ROUTE = { model: 'claude-sonnet-5-5', tier: 'sonnet', reason: '8 小節のベースを考えるので', cost_usd: 0.001 };
const routeLine = (extra: Partial<typeof ROUTE> = {}) => ({ type: 'route', ...ROUTE, ...extra });

/** 再現ガイドの応答（偽物）。 */
const GUIDE_MADE = {
    chart_id: 'chart-1', focus: null, model: 'claude-sonnet-5-5', usage: { input_tokens: 20, output_tokens: 400 }, cost_usd: 0.02,
    created_at: '2026-11-19T10:00:00Z', cached: false,
    guide: {
        overview: '全体の流れ', cautions: ['キーの確信度が低め'], dropped_refs: 0, unverified_terms: ['Bm7'],
        steps: [
            { title: 'テンポを合わせる', topic: 'grid' as const, body: '120 に合わせます', refs: [{ section_id: null, bar: 3, beat: 2 }] },
            { title: '構成を並べる', topic: 'sections' as const, body: 'サビから', refs: [] },
        ],
    },
};
const CHART = {
    key: { tonic: 'C', mode: 'major', confidence: 0.9 }, grid: { bpm: 120, time_signature: [4, 4], downbeat_offset_sec: 0, beat_times_sec: [] },
    sections: [{ id: 's1', label: 'chorus', suggested_label: null, start_bar: 5, end_bar: 8, start_sec: 8, end_sec: 16, repeat_group: 'A' }], chords: [],
} as unknown as import('../lib/chart').SongChart;

/** 再現ガイドを作れる入口（作ったときのモデルを控える）。 */
function guideEnv(models: (string | null)[]): ToolEnv {
    return {
        ...engineEnv(),
        chart: () => CHART,
        chartId: () => 'chart-1',
        requestGuide: async (_chartId, _focus, _regenerate, model) => { models.push(model); return GUIDE_MADE; },
    };
}

describe('モデルの選び方（ルーター）', () => {
    it('step 0 はモデルを付けずに送り、route の行で選んだモデルを、その依頼の残りの呼び出しに付ける。終わりの行に、答えたモデルと理由', async () => {
        stubSteps([
            flow(routeLine(), doneLine([use('a', 'get_project')], 'tool_use', 0.01)),
            flow(doneLine([text('置きました。')], 'end_turn', 0.02)),
        ]);
        const session = new AssistantSession();
        const waits: (string | null)[] = [];
        session.subscribe(() => waits.push(session.getState().waiting));
        await session.send('8 小節のベースを置いて', fakeDeps().deps);
        expect(sent.map((body) => (body as { model?: string }).model)).toEqual([undefined, 'claude-sonnet-5-5']);
        // route が来たら、待っているあいだの 1 行に、モデルの名前を入れる
        expect(waits).toContain('Sonnet で考えています…');
        const turn = last(session.getState().items);
        expect(turn).toMatchObject({ kind: 'turn', calls: 2, model: 'claude-opus-5-5', reason: '8 小節のベースを考えるので' });
        // 費用の合計には、ルーターの費用も足す
        expect((turn as { costUsd: number }).costUsd).toBeCloseTo(0.031);
    });

    it('次の依頼では、また step 0 をモデルなしで送る（依頼ごとに選ぶ）。JSON 1 つの応答の route も読む', async () => {
        const withRoute = (reply: ReturnType<typeof step>, route: typeof ROUTE) => () => Response.json({ ...reply, route });
        stubSteps([withRoute(step([text('はい。')]), ROUTE), withRoute(step([text('いいえ。')]), { ...ROUTE, model: 'claude-haiku-5-5', tier: 'haiku', reason: '短い質問なので', cost_usd: 0 })]);
        const session = new AssistantSession();
        await session.send('一つ目', fakeDeps().deps);
        await session.send('二つ目', fakeDeps().deps);
        expect(sent.map((body) => (body as { model?: string }).model)).toEqual([undefined, undefined]);
        const turns = session.getState().items.filter((item) => item.kind === 'turn');
        expect(turns.map((t) => t.kind === 'turn' && t.reason)).toEqual(['8 小節のベースを考えるので', '短い質問なので']);
    });

    it('ルーターの費用が来なければ足さない。route が無い古い応答は、モデルなしのまま続ける', async () => {
        stubSteps([step([use('a', 'get_project')], 'tool_use', 0.01), step([text('はい。')], 'end_turn', 0.01)]);
        const session = new AssistantSession();
        await session.send('見て', fakeDeps().deps);
        expect(sent.map((body) => (body as { model?: string }).model)).toEqual([undefined, undefined]);
        expect(last(session.getState().items)).toMatchObject({ kind: 'turn', model: 'claude-opus-5-5', reason: null });
    });

    it('ドック: 待っているあいだの 1 行がモデルの名前になり、終わりの行にモデルの名前を出す。選んだ理由は説明の吹き出し', async () => {
        const stream = flowing();
        stubSteps([stream.reply]);
        const session = new AssistantSession();
        renderPanel(session);
        fireEvent.change(input(), { target: { value: 'ベースを考えて' } });
        fireEvent.keyDown(input(), { key: 'Enter' });
        await waitFor(() => expect(sent).toHaveLength(1));
        await act(async () => { stream.push(routeLine()); });
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sonnet で考えています…'));
        await act(async () => { stream.push({ ...doneLine([text('考えました。')]), model: 'claude-sonnet-5-5' }); stream.close(); });
        await waitFor(() => expect(session.getState().running).toBe(false));
        const model = log().querySelector('.assistant-turn-model') as HTMLElement;
        expect(model).toHaveTextContent('Sonnet');
        expect(model.dataset.tip).toBe('Sonnet で答えました。選んだ理由: 8 小節のベースを考えるので');
        expect(model).toHaveAttribute('tabindex', '0');
        expect(log().querySelector('.assistant-turn')).toHaveTextContent('SonnetClaude を 1 回呼びました（概算 $0.01）');
    });
});

describe('カード（再現ガイド・差分の説明）', () => {
    it('ツールが出したカードは、その行の後ろに並ぶ。ツールには選んだモデルを渡し、作った費用を依頼の合計に足す', async () => {
        stubSteps([
            flow(routeLine(), doneLine([use('g', 'make_guide')], 'tool_use', 0.01)),
            flow(doneLine([text('ガイドを出しました。')], 'end_turn', 0.01)),
        ]);
        const models: (string | null)[] = [];
        const session = new AssistantSession();
        await session.send('再現ガイドを作って', fakeDeps(guideEnv(models)).deps);
        expect(models).toEqual(['claude-sonnet-5-5']);
        expect(rows(session)).toEqual([
            'user: 再現ガイドを作って',
            'tool/ok: 再現ガイドを作りました（曲全体、手順 2 個）',
            'card/guide',
            'assistant: ガイドを出しました。',
            'turn: 2 回',
        ]);
        expect((last(session.getState().items) as { costUsd: number }).costUsd).toBeCloseTo(0.041);
        // Claude には中身を JSON で返す (カードを出したことも)
        const result = session.conversation()[2].content[0];
        expect(JSON.parse(String(result.content))).toMatchObject({ card_shown: true, overview: '全体の流れ' });
    });

    it('保存すると、カードも並びに入る（版 3）。読み戻せ、記録には 1 行だけ入る。版 1・2 の節も読める', async () => {
        stubSteps([step([use('g', 'make_guide')], 'tool_use'), step([text('どうぞ。')])]);
        const session = new AssistantSession();
        await session.send('ガイドを作って', fakeDeps(guideEnv([])).deps);
        const saved = session.saved();
        const card = saved.find((item) => item.kind === 'card');
        expect(card).toMatchObject({ kind: 'card', card: 'guide', chartId: 'chart-1', target: '曲全体', overview: '全体の流れ', unverifiedTerms: ['Bm7'] });
        expect(card).not.toHaveProperty('id');
        // JSON を通しても同じに読める
        expect(itemsFromSection(JSON.parse(JSON.stringify({ version: 3, items: saved })))).toEqual(saved);
        // おかしなカードは読み飛ばす
        expect(itemsFromSection({ items: [{ kind: 'card', card: 'guide' }, { kind: 'card', card: 'poem', text: 'x' }, { kind: 'user', text: 'はい' }] }))
            .toEqual([{ kind: 'user', text: 'はい' }]);
        // 版 2 の節 (カードもモデルも無い) は、そのまま読める
        expect(itemsFromSection({ version: 2, items: [{ kind: 'turn', calls: 1, costUsd: 0.01 }] })).toEqual([{ kind: 'turn', calls: 1, costUsd: 0.01 }]);

        // 開き直した後の記録には、カード 1 つを 1 行だけ入れる (中身は入れない)
        const restored = new AssistantSession();
        restored.restore(saved);
        stubSteps([step([text('はい。')])]);
        await restored.send('続き', fakeDeps().deps);
        const digest = String(restored.conversation()[0].content[0].text);
        expect(digest).toContain('Guide shown: 手順 2 個（曲全体）');
        expect(digest).not.toContain('120 に合わせます');
    });

    it('「新しい会話」で履歴に移した会話にも、カードが残る', async () => {
        stubSteps([step([use('g', 'make_guide')], 'tool_use'), step([text('どうぞ。')])]);
        const session = new AssistantSession();
        await session.send('ガイドを作って', fakeDeps(guideEnv([])).deps);
        session.reset();
        const entry = session.archived()[0];
        expect(entry.items.some((item) => item.kind === 'card' && item.card === 'guide')).toBe(true);
        session.openArchived(entry.id);
        expect(session.getState().items.some((item) => item.kind === 'card')).toBe(true);
    });

    it('ドック: ガイドのカードに、手順・注意・カルテに無い語の注意・作ったモデルを出す。場所を押すと、その小節へ移る', async () => {
        stubSteps([step([use('g', 'make_guide')], 'tool_use'), step([text('どうぞ。')])]);
        const session = new AssistantSession();
        const { daw } = renderPanel(session);
        act(() => daw().setChartResult({ chart: CHART, chart_id: 'chart-1' } as unknown as import('../lib/chart').ChartResponse));
        // ドックの入口のかわりに、カルテを持つ入口で送る
        await act(async () => { await session.send('ガイドを作って', fakeDeps(guideEnv([])).deps); });
        const card = screen.getByRole('region', { name: '再現ガイド（曲全体）' });
        expect(within(card).getAllByRole('listitem').map((li) => li.querySelector('.assistant-card-title')?.textContent)).toEqual([
            'テンポを合わせるテンポ・拍', '構成を並べる構成', undefined,
        ]);
        expect(card).toHaveTextContent('キーの確信度が低め');
        expect(within(card).getByRole('note')).toHaveTextContent('解析結果に無い音名・コード名が説明に含まれています: Bm7');
        expect(card).toHaveTextContent('作成: Sonnet');
        expect(card).toHaveTextContent('このガイドを作ったときの使用量: 入力 20 トークン、出力 400 トークン、概算 $0.02');
        fireEvent.click(within(card).getByRole('button', { name: '3 小節 2 拍目' }));
        await waitFor(() => expect(daw().status).toBe('3 小節 2 拍目 へ移動しました'));
        // カルテが別の曲に替わったら、移動できない理由を出す
        act(() => daw().setChartResult({ chart: CHART, chart_id: 'chart-2' } as unknown as import('../lib/chart').ChartResponse));
        fireEvent.click(within(card).getByRole('button', { name: '3 小節 2 拍目' }));
        await waitFor(() => expect(daw().statusKind).toBe('hint'));
        expect(daw().status).toMatch(/別の曲のものなので、移動できません/);
    });
});

describe('パネルからの依頼（ストアの askAssistant）', () => {
    function AskHarness({ expose, deps }: { expose: (daw: DawContextType) => void; deps: AssistantDeps }) {
        const daw = useDaw();
        expose(daw);
        // ドックと同じく、入口を置く
        useEffect(() => assistantSession.attach(deps), [deps]);
        return null;
    }

    it('ドックを開いて送る。前の依頼を処理しているあいだは送らず、理由を知らせる', async () => {
        stubSteps(['hang']);
        const ref: { daw: DawContextType | null } = { daw: null };
        const { deps } = fakeDeps();
        render(<DawProvider><AskHarness deps={deps} expose={(daw) => { ref.daw = daw; }} /></DawProvider>);
        let sentNow = false;
        act(() => { sentNow = ref.daw!.askAssistant('再現ガイドを作って'); });
        expect(sentNow).toBe(true);
        expect(ref.daw!.assistantOpen).toBe(true);
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(assistantSession.getState().items[0]).toMatchObject({ kind: 'user', text: '再現ガイドを作って' });

        act(() => { sentNow = ref.daw!.askAssistant('差分を説明して（Track 1）'); });
        expect(sentNow).toBe(false);
        expect(ref.daw!.statusKind).toBe('hint');
        expect(ref.daw!.status).toMatch(/前の依頼を処理しています/);
        expect(sent).toHaveLength(1);
        assistantSession.cancel();
        await waitFor(() => expect(assistantSession.getState().running).toBe(false));
        assistantSession.reset();
    });

    it('入口がまだ無ければ（ドックが無い）、送らずに理由を知らせる', () => {
        const session = new AssistantSession();
        expect(session.ask('再現ガイドを作って')).toBe('unavailable');
        expect(session.ask('  ')).toBe('empty');
    });
});
