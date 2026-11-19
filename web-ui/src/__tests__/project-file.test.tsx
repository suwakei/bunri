/**
 * プロジェクトの文書 (lib/project-file.ts)、学習の記録 (lib/learn-history.ts)、保存していない変更 (ストアの isDirty)。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import type * as PF from '../lib/project-file';
import type { SavedItem } from '../lib/assistant-history';

class MockGainNode {
    gain = { value: 1 };
    connect() { return this; }
}
class MockStereoPannerNode {
    pan = { value: 0 };
    connect() { return this; }
}
/** デコードすると、バイト数を長さ (秒) にした AudioBuffer もどきを返す。 */
function fakeBuffer(seconds: number, rate = 8000): AudioBuffer {
    const data = new Float32Array(Math.max(1, Math.round(seconds * rate)));
    return { duration: seconds, sampleRate: rate, numberOfChannels: 1, length: data.length, getChannelData: () => data } as unknown as AudioBuffer;
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return new MockStereoPannerNode() as unknown as StereoPannerNode; }
    createBuffer(_ch: number, length: number, rate: number) { return fakeBuffer(length / rate, rate); }
    async decodeAudioData(bytes: ArrayBuffer) { return fakeBuffer(bytes.byteLength / 100); }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { default: engine } = await import('../lib/engine');
const { rememberSource, sourceOf } = await import('../lib/audio-sources');
const pf = await import('../lib/project-file');
const lh = await import('../lib/learn-history');
const { rememberCompared, comparedOf } = await import('../lib/coach');
const { DawProvider, useDaw } = await import('../lib/store');
const { usePracticeProjectSection } = await import('../lib/practice-project');
const { useAssistantProjectSection } = await import('../lib/assistant-project');
const { assistantSession } = await import('../lib/assistant');
type DawContextType = ReturnType<typeof useDaw>;

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });
const blob = (text: string) => new Blob([text]);

function diff(accuracy: number, refCount: number, counts: Partial<Record<string, number>> = {}) {
    return {
        summary: { reference_count: refCount, attempt_count: 3, exact: 1, accuracy, missing: 0, pitch: 0, octave: 0, extra: 0, timing: 0, length: 0, ...counts },
        bars: [], worst_bars: [],
    } as never;
}

beforeEach(() => {
    cleanup();
    engine.init();
    engine.tracks = [];
    engine.bpm = 120; engine.beatsPerBar = 4; engine.gridOffset = 0;
});
afterEach(() => vi.unstubAllGlobals());

function baseInput(over: Partial<Parameters<typeof pf.buildDocument>[0]> = {}): Parameters<typeof pf.buildDocument>[0] {
    return {
        name: '曲', chart: null, chartId: null, chartPeaks: null, songFile: null, ghostChoice: 'auto',
        coachPair: { referenceId: null, attemptId: null }, coachResult: null, learnHistory: [],
        leftTab: 'learn', learnTab: 'coach', openTrackId: null, partsUseChart: false, ...over,
    };
}

describe('学習の記録', () => {
    it('一致率は差分チェックの accuracy と同じで、範囲はお手本のノートの最初から最後の小節', () => {
        const a = lh.attemptFromDiff(diff(0.75, 4, { missing: 1, timing: 1 }), {
            referenceId: 1, attemptId: 2, part: 'bass', reference: [note('C', 2, 4), note('E', 2, 40)], stepsPerBar: 16,
            now: new Date('2026-11-12T00:00:00Z'),
        });
        expect(a).toMatchObject({ matchRate: 0.75, matched: 3, referenceCount: 4, startBar: 1, endBar: 3, part: 'bass' });
        expect(a.counts).toEqual({ missing: 1, pitch: 0, octave: 0, extra: 0, timing: 1, length: 0 });
        expect(a.recordedAt).toBe('2026-11-12T00:00:00.000Z');
    });

    it('前回との差を出す。範囲を渡すと同じ範囲の記録だけと比べる', () => {
        const mk = (id: number, rate: number, startBar = 1, endBar = 4) => ({
            id, recordedAt: '', referenceId: 1, attemptId: 2, part: 'bass', startBar, endBar,
            referenceCount: 10, matched: rate * 10, matchRate: rate, counts: { missing: 0, pitch: 0, octave: 0, extra: 0, timing: 0, length: 0 }, explanationId: null,
        });
        const history = [mk(1, 0.5), mk(2, 0.9, 5, 8), mk(3, 0.64), mk(4, 0.72)];
        const all = lh.matchSummary(history, 2)!;
        expect(all).toMatchObject({ percent: 72, previousPercent: 64, deltaPercent: 8, bestPercent: 90, attempts: 4 });
        expect(lh.deltaText(all)).toBe('前回より +8%');
        const ranged = lh.matchSummary(history, 2, 1, { startBar: 5, endBar: 8 })!;
        expect(ranged).toMatchObject({ percent: 90, deltaPercent: null, attempts: 1 });
        expect(lh.deltaText(ranged)).toBe('はじめての記録');
        expect(lh.matchSummary(history, 99)).toBeNull();
        expect(lh.formatDelta(-3)).toBe('−3%');
        expect(lh.formatDelta(0)).toBe('±0%');
    });

    it('小節ごとの結果 (bar_stats) を記録に持たせる。合計は全体の数と食い違わない。無い結果からは、小節ごとの結果を持たない記録になる', () => {
        const result = {
            ...(diff(0.6667, 3) as object),
            bar_stats: [{ bar: 2, reference_count: 1, matched: 0 }, { bar: 1, reference_count: 2, matched: 2 }],
        } as never;
        const a = lh.attemptFromDiff(result, { referenceId: 1, attemptId: 2, part: 'bass', reference: [note('C', 2, 0)], stepsPerBar: 16 });
        // 小節順にそろえる
        expect(a.barStats).toEqual([{ bar: 1, referenceCount: 2, matched: 2 }, { bar: 2, referenceCount: 1, matched: 0 }]);
        expect(a.barStats!.reduce((sum, b) => sum + b.referenceCount, 0)).toBe(a.referenceCount);
        expect(a.barStats!.reduce((sum, b) => sum + b.matched, 0)).toBe(a.matched);
        expect(a).toMatchObject({ matched: 2, referenceCount: 3, matchRate: 0.6667 });

        // 以前の版の処理を担当する部分が返した結果 (bar_stats が無い): いままでどおりの値で、小節ごとの結果は持たない
        const old = lh.attemptFromDiff(diff(0.75, 4), { referenceId: 1, attemptId: 2, part: 'bass', reference: [note('C', 2, 0)], stepsPerBar: 16 });
        expect(old).toMatchObject({ matched: 3, referenceCount: 4, matchRate: 0.75, barStats: null });

        // 形の違う要素は落とす
        expect(lh.cleanBarStats([{ bar: 1, referenceCount: 2, matched: 3 }, { bar: 0, referenceCount: 1, matched: 0 },
            { bar: 2.5, referenceCount: 1, matched: 0 }, { bar: 3, referenceCount: 0, matched: 0 }, null, 'x',
            { bar: 4, referenceCount: 5, matched: 5 }])).toEqual([{ bar: 4, referenceCount: 5, matched: 5 }]);
        expect(lh.cleanBarStats(undefined)).toBeNull();
        expect(lh.cleanBarStats(null)).toBeNull();
        expect(lh.cleanBarStats('1:2:2')).toBeNull();
        expect(lh.cleanBarStats([])).toEqual([]);
    });

    it('練習の地図の % は、学習の記録の % と同じ丸め方', async () => {
        const { ratePercent } = await import('../lib/practice-map');
        for (const [matched, count] of [[1, 8], [2, 8], [1, 3], [2, 3], [5, 8], [199, 400], [0, 5], [5, 5]]) {
            // 差分チェックの accuracy は、小数 4 桁に丸めた値
            const accuracy = Math.round((matched / count) * 1e4) / 1e4;
            expect(ratePercent(matched, count)).toBe(lh.percentOf(accuracy));
        }
    });
});

describe('文書を作る (buildDocument)', () => {
    it('トラックごとの音色をextraへ保存し、未知のIDも読み直しと再保存で保持する', async () => {
        const piano = engine.addTrack('Piano'), voice = engine.addTrack('Voice'), game = engine.addTrack('Game');
        voice.instrumentId = 'choir-a'; game.instrumentId = 'future-game';
        const { doc } = await pf.buildDocument(baseInput());
        expect(doc.tracks[0]).not.toHaveProperty('extra');
        expect(doc.tracks[1].extra).toEqual({ instrumentId: 'choir-a' });
        expect(doc.tracks[2].extra).toEqual({ instrumentId: 'future-game' });
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
        await pf.applyDocument(JSON.parse(JSON.stringify(doc)), applyTarget());
        expect(engine.tracks.map((track) => track.instrumentId)).toEqual([undefined, 'choir-a', 'future-game']);
        const savedAgain = await pf.buildDocument(baseInput());
        expect(savedAgain.doc.tracks.map((track) => track.extra?.instrumentId)).toEqual([undefined, 'choir-a', 'future-game']);
        expect(piano.instrumentId).toBeUndefined();
    });

    it('トラックは控えから写し、相手のトラック・重ねるお手本・差分の組・記録は並びの番号で指す。同じ音声は 1 つだけ送る', async () => {
        const song = engine.addTrack('原曲'); song.role = 'song';
        const part = engine.addTrack('ベース'); part.role = 'part'; part.part = 'bass';
        part.referenceNotes = [note('C', 2, 0)];
        const practice = engine.addTrack('ベースの練習'); practice.role = 'practice'; practice.part = 'bass'; practice.practiceOf = part.id;
        practice.pianoNotes = [note('C', 2, 0)];
        const buf = fakeBuffer(2);
        rememberSource(buf, blob('original-mp3-bytes'), 'song.mp3');
        song.clips.push({ buffer: buf, offset: 0, name: 'song.mp3', duration: 2 });
        practice.clips.push({ buffer: buf, offset: 4, name: '同じ音', duration: 2 });
        // 元のバイト列が無い音声は、浮動小数の WAV にして覚える
        const rendered = fakeBuffer(1);
        part.clips.push({ buffer: rendered, offset: 0, name: 'bass', duration: 1 });

        const result = diff(0.5, 2);
        rememberCompared(result, { reference: [note('C', 2, 0)], attempt: [], stepsPerBar: 16 });
        const history = [{ ...lh.attemptFromDiff(result, { referenceId: part.id, attemptId: practice.id, part: 'bass', reference: [note('C', 2, 0)], stepsPerBar: 16 }), id: 1, explanationId: 'a'.repeat(40) }];
        const { doc, audio } = await pf.buildDocument(baseInput({
            ghostChoice: part.id,
            coachPair: { referenceId: part.id, attemptId: practice.id },
            coachResult: { referenceId: part.id, attemptId: practice.id, result },
            learnHistory: history, openTrackId: practice.id,
        }));
        expect(doc.tracks.map(t => t.name)).toEqual(['原曲', 'ベース', 'ベースの練習']);
        expect(doc.tracks[2].practiceOf).toBe(1);
        expect(doc.tracks[1].referenceNotes).toEqual([note('C', 2, 0)]);
        expect(doc.tracks[0].referenceNotes).toBeNull();
        expect(doc.tracks[0].clips[0].audio).toBe(doc.tracks[2].clips[0].audio);
        expect(audio.size).toBe(2);
        expect(sourceOf(rendered)?.name).toBe('bass.wav');
        const learn = doc.state.learn as unknown as PF.LearnState;
        expect(learn.ghostChoice).toEqual({ track: 1 });
        expect(learn.coachPair).toEqual({ reference: 1, attempt: 2 });
        expect(learn.coachResult?.compared?.reference).toEqual([note('C', 2, 0)]);
        expect(learn.openTrack).toBe(2);
        expect(doc.history[0]).toMatchObject({ referenceTrack: 1, attemptTrack: 2, matchRate: 0.5 });
        expect(doc.explanations).toEqual({ coach: ['a'.repeat(40)] });
    });

    it('学習の記録の小節ごとの結果は、保存と読み出しで往復する。以前の記録 (小節ごとの結果が無い) も開ける', async () => {
        const part = engine.addTrack('ベース'); part.role = 'part'; part.part = 'bass';
        part.referenceNotes = [note('C', 2, 0), note('E', 2, 4), note('G', 2, 16)];
        const practice = engine.addTrack('ベースの練習'); practice.role = 'practice'; practice.practiceOf = part.id;
        const counts = { missing: 0, pitch: 0, octave: 0, extra: 0, timing: 0, length: 0 };
        const base = { recordedAt: 't', referenceId: part.id, attemptId: practice.id, part: 'bass', startBar: 1, endBar: 2,
            referenceCount: 3, matched: 2, matchRate: 0.6667, counts, explanationId: null };
        const barStats = [{ bar: 1, referenceCount: 2, matched: 2 }, { bar: 2, referenceCount: 1, matched: 0 }];
        const { doc } = await pf.buildDocument(baseInput({ learnHistory: [{ ...base, id: 1 }, { ...base, id: 2, barStats }] }));
        expect(doc.history[0].barStats ?? null).toBeNull();
        expect(doc.history[1].barStats).toEqual(barStats);

        // sidecar を通ったあとの形 (JSON) から戻す。以前のファイルの記録は、barStats が null か、項目そのものが無い
        const saved = JSON.parse(JSON.stringify(doc)) as PF.ProjectDocument;
        saved.history.push({ ...saved.history[0], barStats: null });
        saved.history.push({ ...saved.history[1], barStats: [{ bar: 1, referenceCount: 2, matched: 9 }] as never });
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
        const target = applyTarget();
        await pf.applyDocument(saved, target);
        const restored = (target.setLearnHistory as ReturnType<typeof vi.fn>).mock.calls[0][0] as { barStats: unknown; referenceId: number; matchRate: number }[];
        expect(restored.map(a => a.barStats)).toEqual([null, barStats, null, []]);
        // 一致率などの既存の欄は、そのまま
        expect(restored.map(a => a.matchRate)).toEqual([0.6667, 0.6667, 0.6667, 0.6667]);
        expect(restored[1].referenceId).toBe(engine.tracks[0].id);
        pf.resetSections();
    });

    it('登録した状態の節は版つきで入り、開くと読み戻される。登録していない節は保存し直しても残る', async () => {
        const loaded: unknown[] = [];
        const off = pf.registerProjectSection('practice', {
            version: 2, save: () => ({ loop: { startBar: 3, endBar: 4 } }), load: (v) => loaded.push(v),
        });
        expect(() => pf.registerProjectSection('learn', { version: 1, save: () => null, load: () => {} })).toThrow();
        try {
            const { doc } = await pf.buildDocument(baseInput());
            expect(doc.state.practice).toEqual({ version: 2, loop: { startBar: 3, endBar: 4 } });

            vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
            doc.state.future = { version: 1, x: 1 };
            await pf.applyDocument(doc, applyTarget());
            expect(loaded).toEqual([{ version: 2, loop: { startBar: 3, endBar: 4 } }]);
            const again = await pf.buildDocument(baseInput());
            expect(again.doc.state.future).toEqual({ version: 1, x: 1 });
        } finally {
            off();
            pf.resetSections();
        }
    });
});

function applyTarget(over: Partial<PF.ApplyTarget> = {}): PF.ApplyTarget {
    return {
        setBpm: (v) => { engine.bpm = v; }, setBeatsPerBar: (v) => { engine.beatsPerBar = v; }, setGridOffset: (v) => { engine.gridOffset = v; },
        setChartResult: vi.fn(), clearChart: vi.fn(), setSongFile: vi.fn(), setGhostChoice: vi.fn(), setCoachPair: vi.fn(),
        setCoachResult: vi.fn(), setLearnHistory: vi.fn(), setLeftTab: vi.fn(), setLearnTab: vi.fn(), setChartIdOfParts: vi.fn(),
        pianoRoll: null, ...over,
    };
}

describe('文書を画面に戻す (applyDocument)', () => {
    it('トラック・音声・相手のトラック・学ぶ流れの状態・記録を戻す。音声の無いクリップは無音の置き場所にする', async () => {
        const hash = 'f'.repeat(64);
        const fetched: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            fetched.push(url);
            if (url.startsWith('/api/project/tok/audio/')) return new Response(new Uint8Array(300), { headers: { 'content-type': 'audio/wav' } });
            if (url.startsWith('/api/chart/')) return Response.json({ glossary: { key: { ja: 'キー' } } });
            return new Response('', { status: 404 });
        }));
        const result = diff(1, 1);
        const doc: PF.ProjectDocument = {
            version: 1, meta: { name: '曲' }, grid: { bpm: 96, beatsPerBar: 3, gridOffset: 0.5 },
            tracks: [
                { name: 'ベース', role: 'part', part: 'bass', practiceOf: null, gain: -3, pan: 0.5, mute: true, solo: false,
                  notes: [], referenceNotes: [note('C', 2, 0)], clips: [{ name: 'bass.wav', offset: 0, duration: 3, audio: hash }] },
                { name: 'ベースの練習', role: 'practice', part: 'bass', practiceOf: 0, gain: 0, pan: 0, mute: false, solo: true,
                  notes: [note('C', 2, 0)], referenceNotes: null, clips: [{ name: 'take.wav', offset: 1, duration: 2, audio: null }] },
            ],
            chart: { chartId: 'song', chart: { source: { filename: 'song.mp3' } } as never, audio: hash, audioName: 'song.mp3', peaks: null },
            state: { learn: { version: 1, ghostChoice: { track: 0 }, coachPair: { reference: 0, attempt: 1 },
                coachResult: { reference: 0, attempt: 1, result, compared: { reference: [note('C', 2, 0)], attempt: [note('C', 2, 0)], stepsPerBar: 12 } },
                partsUseChart: true, leftTab: 'learn', learnTab: 'coach', openTrack: null } },
            history: [{ recordedAt: 't', referenceTrack: 0, attemptTrack: 1, part: 'bass', startBar: 1, endBar: 1, referenceCount: 1, matched: 1,
                matchRate: 1, counts: { missing: 0, pitch: 0, octave: 0, extra: 0, timing: 0, length: 0 }, explanationId: null }],
            token: 'tok', audioBase: '/api/project/tok/audio/',
        };
        engine.addTrack('前のトラック');
        const target = applyTarget();
        const out = await pf.applyDocument(doc, target);
        expect(out).toEqual({ tracks: 2, missingClips: 1 });
        // 同じ音声 (クリップとカルテの原曲) は 1 回だけ取ってくる
        expect(fetched.filter(u => u.includes('/audio/'))).toHaveLength(1);
        expect(engine.tracks.map(t => t.name)).toEqual(['ベース', 'ベースの練習']);
        const [part, practice] = engine.tracks;
        expect(practice.practiceOf).toBe(part.id);
        expect(part.mute).toBe(true);
        expect(part.gain).toBe(-3);
        expect(practice.solo).toBe(true);
        expect(practice.referenceNotes).toBeUndefined();
        expect(part.clips[0].missing).toBeUndefined();
        expect(sourceOf(part.clips[0].buffer)?.hash).toBe(hash);
        expect(practice.clips[0]).toMatchObject({ missing: true, name: 'take.wav', offset: 1, duration: 2 });
        expect(engine.bpm).toBe(96);
        expect(engine.gridOffset).toBe(0.5);
        expect(pf.missingClips()).toHaveLength(1);
        expect(target.setChartResult).toHaveBeenCalledWith(expect.objectContaining({ chart_id: 'song', glossary: { key: { ja: 'キー' } } }));
        expect((target.setSongFile as ReturnType<typeof vi.fn>).mock.calls[0][0].name).toBe('song.wav');
        expect(target.setGhostChoice).toHaveBeenCalledWith(part.id);
        expect(target.setCoachPair).toHaveBeenCalledWith({ referenceId: part.id, attemptId: practice.id });
        const restored = (target.setCoachResult as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(restored).toMatchObject({ referenceId: part.id, attemptId: practice.id });
        expect(comparedOf(restored.result)?.stepsPerBar).toBe(12);
        expect(target.setChartIdOfParts).toHaveBeenCalledWith('song');
        expect((target.setLearnHistory as ReturnType<typeof vi.fn>).mock.calls[0][0][0]).toMatchObject({ referenceId: part.id, attemptId: practice.id });
    });
});

describe('小数のステップ（三連・32 分）とスウィング', () => {
    afterEach(() => { engine.swing = 0.5; });

    it('小数のノートとスウィングは、保存と読み出しで往復する。整数のノートは整数のまま', async () => {
        engine.swing = 2 / 3;
        const track = engine.addTrack('ベース');
        const notes = [note('C', 2, 0, 4 / 3), note('E', 2, 4 / 3, 4 / 3), note('G', 2, 4.5, 0.5), note('C', 3, 8, 4)];
        const reference = [note('C', 2, 8 / 3, 2 / 3), note('D', 2, 65 / 60, 55 / 60)];
        track.pianoNotes = notes.map(n => ({ ...n }));
        track.referenceNotes = reference.map(n => ({ ...n }));
        const { doc } = await pf.buildDocument(baseInput());
        expect(doc.grid).toEqual({ bpm: 120, beatsPerBar: 4, gridOffset: 0, swing: 2 / 3 });
        expect(doc.tracks[0].notes).toEqual(notes);

        // sidecar を通ったあとの形 (JSON の文字にして、読み直す) から戻す
        const saved = JSON.parse(JSON.stringify(doc)) as PF.ProjectDocument;
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
        engine.swing = 0.5;
        const setSwing = vi.fn((v: number) => { engine.swing = v; });
        await pf.applyDocument(saved, applyTarget({ setSwing }));
        expect(setSwing).toHaveBeenCalledWith(2 / 3);
        expect(engine.tracks[0].pianoNotes).toEqual(notes);
        expect(engine.tracks[0].referenceNotes).toEqual(reference);
        expect(Number.isInteger(engine.tracks[0].pianoNotes[3].step)).toBe(true);

        // もう一度保存しても、同じ値のまま (往復のたびに、位置がずれていかない)
        const again = await pf.buildDocument(baseInput());
        expect(again.doc.tracks[0].notes).toEqual(doc.tracks[0].notes);
        expect(again.doc.tracks[0].referenceNotes).toEqual(doc.tracks[0].referenceNotes);
        expect(again.doc.grid).toEqual(doc.grid);
        pf.resetSections();
    });

    it('スウィングが 50% なら文書に入れない。以前の文書 (swing が無い) は 50% として開き、端数の付いた値はそろえて読む', async () => {
        engine.addTrack('t');
        expect((await pf.buildDocument(baseInput())).doc.grid).toEqual({ bpm: 120, beatsPerBar: 4, gridOffset: 0 });

        const doc: PF.ProjectDocument = {
            version: 1, meta: { name: '曲' }, grid: { bpm: 120, beatsPerBar: 4, gridOffset: 0 },
            tracks: [{ name: 't', role: null, part: null, practiceOf: null, gain: 0, pan: 0, mute: false, solo: false,
                notes: [note('C', 4, 1.3333, 4.0000001)], referenceNotes: null, clips: [] }],
            chart: null, state: {}, history: [],
        };
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
        // スウィングの setter を渡さない呼び手では、再生エンジンの値を変える
        engine.swing = 0.62;
        await pf.applyDocument(doc, applyTarget());
        expect(engine.swing).toBe(0.5);
        expect(engine.tracks[0].pianoNotes).toEqual([note('C', 4, 4 / 3, 4)]);
        // 範囲の外は収め、数でない値は 50% にする
        await pf.applyDocument({ ...doc, grid: { ...doc.grid, swing: 0.9 } }, applyTarget());
        expect(engine.swing).toBe(0.75);
        await pf.applyDocument({ ...doc, grid: { ...doc.grid, swing: 'x' as never } }, applyTarget());
        expect(engine.swing).toBe(0.5);
        pf.resetSections();
    });

    it('スウィングを変えると、保存していない変更の印が付き、元の値に戻すと消える。記録した変更は、元に戻せる（テンポや拍子と同じ）', () => {
        let daw: DawContextType | null = null;
        function Probe() {
            const ctx = useDaw();
            useEffect(() => { daw = ctx; });
            return null;
        }
        render(<DawProvider><Probe /></DawProvider>);
        expect(daw!.swing).toBe(0.5);
        expect(daw!.isDirty).toBe(false);
        act(() => daw!.setSwing(0.67));
        // 67% は、ちょうど 2/3 (三連と同じ位置)
        expect(daw!.swing).toBe(2 / 3);
        expect(engine.swing).toBe(2 / 3);
        expect(daw!.isDirty).toBe(true);
        act(() => daw!.setSwing(0.5));
        expect(daw!.isDirty).toBe(false);
        // 範囲に収める
        act(() => daw!.setSwing(2));
        expect(daw!.swing).toBe(0.75);
        act(() => daw!.setSwing(0.5));
        // 操作として記録した変更 (アシスタントなど) は、元に戻すと戻り、やり直すと戻る
        act(() => { daw!.record('スウィングを変更', () => daw!.setSwing(0.58)); });
        expect(daw!.swing).toBe(0.58);
        act(() => daw!.undo());
        expect([daw!.swing, engine.swing]).toEqual([0.5, 0.5]);
        act(() => daw!.redo());
        expect([daw!.swing, engine.swing]).toEqual([0.58, 0.58]);
    });
});

describe('音声を送る (uploadAudio)', () => {
    it('sidecar が持っていないものだけを送る。開いたプロジェクトの音声で写しから消えていたら、手元のバイト列のハッシュで送り直す', async () => {
        const known = await pf.payloadForBlob(blob('aaa'), 'a.wav');
        const reopened = { hash: 'e'.repeat(64), blob: blob('wav-from-flac'), name: 'b.wav', verified: false };
        const doc = { tracks: [{ clips: [{ audio: known.hash }, { audio: reopened.hash }] }], chart: null } as unknown as PF.ProjectDocument;
        const calls: { url: string; method?: string }[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, method: init?.method });
            if (url === '/api/project/audio/missing') return Response.json({ missing: [reopened.hash] });
            return Response.json({ ok: true });
        }));
        await pf.uploadAudio(doc, new Map([[known.hash, known], [reopened.hash, reopened]]), 'base');
        const puts = calls.filter(c => c.method === 'PUT');
        expect(puts).toHaveLength(1);
        const real = (await pf.payloadForBlob(reopened.blob, 'b.wav')).hash;
        expect(puts[0].url).toBe(`/api/project/audio/${real}?name=b.wav`);
        expect(doc.tracks[0].clips[1].audio).toBe(real);
    });
});

describe('保存していない変更 (isDirty)', () => {
    it('トラックやノートを変えると付き、保存した状態にすると消え、元に戻して同じになっても消える', async () => {
        let daw: DawContextType | null = null;
        function Probe() {
            const ctx = useDaw();
            useEffect(() => { daw = ctx; });
            return null;
        }
        render(<DawProvider><Probe /></DawProvider>);
        expect(daw!.isDirty).toBe(false);
        act(() => { daw!.record('トラックを追加', () => engine.addTrack()); daw!.bumpTracks(); });
        expect(daw!.isDirty).toBe(true);
        act(() => daw!.markSaved());
        expect(daw!.isDirty).toBe(false);
        act(() => { daw!.record('ノートを追加', () => { engine.tracks[0].pianoNotes = [note('C', 4, 0)]; }); });
        expect(daw!.isDirty).toBe(true);
        act(() => daw!.undo());
        expect(daw!.isDirty).toBe(false);
        // 学習の記録が増えても付く
        act(() => { daw!.recordLearnAttempt({ ...lh.attemptFromDiff(diff(1, 1), { referenceId: 1, attemptId: 1, part: null, reference: [], stepsPerBar: 16 }) }); });
        expect(daw!.isDirty).toBe(true);
        act(() => daw!.markSaved());
        expect(daw!.isDirty).toBe(false);
        act(() => daw!.touchProject());
        expect(daw!.isDirty).toBe(true);
    });
});

describe('練習画面の状態 (状態の節 practice)', () => {
    let daw: DawContextType | null = null;
    function Probe() {
        const ctx = useDaw();
        usePracticeProjectSection();
        useEffect(() => { daw = ctx; });
        return null;
    }
    /** パートと練習のトラックを作る。 */
    function addPartAndPractice() {
        const part = engine.addTrack('ベース'); part.role = 'part'; part.part = 'bass'; part.referenceNotes = [note('C', 2, 0), note('E', 2, 20)];
        const practice = engine.addTrack('ベースの練習'); practice.role = 'practice'; practice.practiceOf = part.id;
        return { part, practice };
    }
    afterEach(() => pf.resetSections());

    it('保存すると並びの番号で入り、開くと設定だけ戻す (練習画面は開かない)。トラックが無ければ持たない', async () => {
        engine.addTrack('原曲');
        const { part, practice } = addPartAndPractice();
        render(<DawProvider><Probe /></DawProvider>);
        act(() => daw!.openPractice(part.id, practice.id));
        act(() => daw!.updatePractice({ loop: { startBar: 2, endBar: 3, enabled: true }, speed: 0.75, listen: 'self' }));
        const { doc } = await pf.buildDocument(baseInput());
        expect(doc.state.practice).toEqual({
            version: 1, part: 1, track: 2, loop: { startBar: 2, endBar: 3, enabled: true }, speed: 0.75, listen: 'self', showGhost: true, input: 'mouse',
        });

        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        await act(async () => { await pf.applyDocument(JSON.parse(JSON.stringify(doc)), applyTarget()); });
        const [, newPart, newPractice] = engine.tracks;
        expect(newPart.id).not.toBe(part.id);
        expect(daw!.practice).toMatchObject({ partId: newPart.id, trackId: newPractice.id, loop: { startBar: 2, endBar: 3, enabled: true }, speed: 0.75, listen: 'self' });
        expect(daw!.practiceOpen).toBe(false);

        // 練習のトラックの番号が範囲の外 (トラックを消して保存したファイルなど)
        const broken = JSON.parse(JSON.stringify(doc));
        broken.state.practice.track = 7;
        await act(async () => { await pf.applyDocument(broken, applyTarget()); });
        expect(daw!.practice).toBeNull();
    });

    it('新しいプロジェクトにすると、状態を消して練習画面を閉じる', () => {
        const { part, practice } = addPartAndPractice();
        render(<DawProvider><Probe /></DawProvider>);
        act(() => daw!.openPractice(part.id, practice.id));
        expect(daw!.practiceOpen).toBe(true);
        act(() => pf.resetSections());
        expect(daw!.practice).toBeNull();
        expect(daw!.practiceOpen).toBe(false);
    });

    it('設定を変えると保存していない変更の印が付く。開く・閉じる・同じ値・画面が自分で直したときは付けない', () => {
        const { part, practice } = addPartAndPractice();
        render(<DawProvider><Probe /></DawProvider>);
        act(() => daw!.markSaved());
        expect(daw!.isDirty).toBe(false);
        act(() => daw!.openPractice(part.id, practice.id));
        act(() => daw!.closePractice());
        expect(daw!.isDirty).toBe(false);
        act(() => daw!.updatePractice({ speed: daw!.practice!.speed }));
        expect(daw!.isDirty).toBe(false);
        act(() => daw!.updatePractice({ input: 'mouse' }, { touch: false }));
        act(() => daw!.updatePractice({ input: 'midi-step' }, { touch: false }));
        expect(daw!.isDirty).toBe(false);
        act(() => daw!.updatePractice({ loop: { startBar: 3, endBar: 4, enabled: true } }));
        expect(daw!.isDirty).toBe(true);
    });
});

describe('アシスタントの会話 (状態の節 assistant)', () => {
    function Probe() {
        useAssistantProjectSection();
        return null;
    }
    const SAVED: SavedItem[] = [
        { kind: 'user', text: 'ベースを置いて' } as const,
        { kind: 'tool', name: 'add_notes', state: 'ok', text: 'ノートを 8 個置きました（Track 1、1〜2 小節）' } as const,
        { kind: 'assistant', text: '置きました。' } as const,
        // 再現ガイドのカード (版 3 で足した)
        {
            kind: 'card', card: 'guide', chartId: 'chart-1', focus: null, target: '曲全体', overview: '全体の流れ',
            steps: [{ title: 'テンポ', topic: 'grid', body: '120 に合わせます', refs: [{ section_id: null, bar: 1, beat: 1, label: '1 小節 1 拍目' }] }],
            cautions: [], unverifiedTerms: [], model: 'claude-sonnet-5-5', createdAt: null, cached: false, costUsd: 0.02, usage: { input_tokens: 20, output_tokens: 400 },
        },
        { kind: 'turn', calls: 2, costUsd: 0.03, model: 'claude-sonnet-5-5', reason: 'ベースを考えるので' },
    ];
    /** 版 2 までの並び (カードとモデルが無い) */
    const SAVED_V2: SavedItem[] = [SAVED[0], SAVED[1], SAVED[2], { kind: 'turn', calls: 2, costUsd: 0.03 }];
    afterEach(() => { pf.resetSections(); assistantSession.restore([]); });

    it('保存すると、画面に並ぶ文と操作ログの行が入る。開くと戻り、新しいプロジェクトにすると空になる', async () => {
        render(<Probe />);
        // 会話が空なら、節を入れない
        expect((await pf.buildDocument(baseInput())).doc.state.assistant).toBeUndefined();

        act(() => { assistantSession.restore(SAVED); });
        const { doc } = await pf.buildDocument(baseInput());
        expect(doc.state.assistant).toEqual({ version: 3, items: SAVED });
        // Claude に送る会話 (思考のブロックやツールの結果) は、入れない
        expect(JSON.stringify(doc.state.assistant)).not.toMatch(/tool_use|tool_result|signature|thinking/);

        // 新しいプロジェクト: 空になる
        act(() => pf.resetSections());
        expect(assistantSession.getState()).toMatchObject({ items: [], restored: 0 });

        // 開く: 並びが戻る。送る会話は空 (次の依頼は、記録から始まる)
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        await act(async () => { await pf.applyDocument(JSON.parse(JSON.stringify(doc)), applyTarget()); });
        const state = assistantSession.getState();
        expect(state.restored).toBe(5);
        expect(state.items.map((item) => item.kind)).toEqual(['user', 'tool', 'assistant', 'card', 'turn']);
        expect(assistantSession.saved()).toEqual(SAVED);
        expect(assistantSession.conversation()).toEqual([]);

        // 会話の入っていないプロジェクトを開くと、空になる (会話は、プロジェクトごと)
        const without = JSON.parse(JSON.stringify(doc));
        delete without.state.assistant;
        await act(async () => { await pf.applyDocument(without, applyTarget()); });
        expect(assistantSession.getState().items).toEqual([]);
    });

    it('「新しい会話」の前の会話は（カードも）、履歴として一緒に入り、開くと戻る。版 1・版 2 の節も読める', async () => {
        render(<Probe />);
        act(() => { assistantSession.restore(SAVED); assistantSession.reset(); });
        // いまの会話が空でも、履歴が在れば節を入れる
        const { doc } = await pf.buildDocument(baseInput());
        const section = doc.state.assistant as { version: number; items: unknown[]; archive: { title: string; archivedAt: string; items: unknown[] }[] };
        expect(section.version).toBe(3);
        expect(section.items).toEqual([]);
        expect(section.archive).toHaveLength(1);
        expect(section.archive[0]).toMatchObject({ title: 'ベースを置いて', items: SAVED });
        expect(Number.isNaN(Date.parse(section.archive[0].archivedAt))).toBe(false);
        // 画面の中だけの番号は、入れない
        expect(section.archive[0]).not.toHaveProperty('id');

        act(() => pf.resetSections());
        expect(assistantSession.getState().archive).toEqual([]);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        await act(async () => { await pf.applyDocument(JSON.parse(JSON.stringify(doc)), applyTarget()); });
        expect(assistantSession.getState().archive.map((entry) => entry.title)).toEqual(['ベースを置いて']);
        expect(assistantSession.archived()[0].items).toEqual(SAVED);

        // 版 1 の節: いまの会話だけが戻り、履歴は空
        const v1 = JSON.parse(JSON.stringify(doc));
        v1.state.assistant = { version: 1, items: SAVED_V2 };
        await act(async () => { await pf.applyDocument(v1, applyTarget()); });
        expect(assistantSession.saved()).toEqual(SAVED_V2);
        expect(assistantSession.getState().archive).toEqual([]);
        // 版 2 の節: 履歴も戻る (カードとモデルは無いまま)
        const v2 = JSON.parse(JSON.stringify(doc));
        v2.state.assistant = { version: 2, items: SAVED_V2, archive: [{ title: '前の会話', archivedAt: null, items: SAVED_V2 }] };
        await act(async () => { await pf.applyDocument(v2, applyTarget()); });
        expect(assistantSession.saved()).toEqual(SAVED_V2);
        expect(assistantSession.archived().map((entry) => entry.items)).toEqual([SAVED_V2]);
    });

    it('壊れた節は、読めるものだけを戻す', async () => {
        render(<Probe />);
        const { doc } = await pf.buildDocument(baseInput());
        doc.state.assistant = { version: 1, items: [{ kind: 'user', text: 'こんにちは' }, { kind: 'tool', name: 'play' }, 'x', { kind: 'assistant', text: 'はい。' }] };
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        await act(async () => { await pf.applyDocument(doc, applyTarget()); });
        expect(assistantSession.saved()).toEqual([{ kind: 'user', text: 'こんにちは' }, { kind: 'assistant', text: 'はい。' }]);
    });
});
