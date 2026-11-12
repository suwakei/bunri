/**
 * プロジェクトの文書 (lib/project-file.ts)、学習の記録 (lib/learn-history.ts)、保存していない変更 (ストアの isDirty)。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import type * as PF from '../lib/project-file';

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
});

describe('文書を作る (buildDocument)', () => {
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
