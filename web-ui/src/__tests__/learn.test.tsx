/**
 * 学ぶ流れ（lib/learn.ts）と、「曲とパート」の段のテスト
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

class MockGainNode {
    gain = { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
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
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { default: engine, MIDI_PART } = await import('../lib/engine');
const { progressFacts, stepStates, referenceTrackFor, useLearnActions, isDecomposeResult, CHART_RESULT_INVALID } = await import('../lib/learn');
const { jobTracker } = await import('../lib/jobs');
const { DawProvider, useDaw } = await import('../lib/store');
const LearnPanel = (await import('../components/LearnPanel')).default;
const ProgressSteps = (await import('../components/ProgressSteps')).default;

const note = (n: string, octave: number, step: number, length = 4) => ({ note: n, octave, step, length });

/** パートのトラック (お手本つき、打ち込みは空) を作る。 */
function addPart(name: string, part: string, reference = [note('C', 3, 0), note('E', 3, 4), note('G', 3, 8)]) {
    const t = engine.addTrack(name);
    t.role = 'part'; t.part = part; t.referenceNotes = reference; t.pianoNotes = [];
    return t;
}

/** ピアノロールの代わり。呼ばれた操作を記録する。 */
function fakePianoRoll() {
    const calls: string[] = [];
    let active: number | null = null;
    return {
        calls,
        switchToTrack: (id: number | null) => { active = id; calls.push(`switch:${id}`); },
        getActiveTrackId: () => active,
        setGhostNotes: (notes: unknown[]) => calls.push(`ghost:${notes.length}`),
        scrollToPitch: (n: string, o: number) => calls.push(`pitch:${n}${o}`),
        scrollToStep: (s: number) => calls.push(`step:${s}`),
        _saveToEngine: () => {},
    };
}

beforeEach(() => {
    cleanup();
    engine.tracks = [];
    localStorage.clear();
});

describe('進み具合の段階', () => {
    it('何もしていなければ、① がいまの段階で、残りはまだ', () => {
        expect(stepStates(progressFacts(false, false, false))).toEqual({
            import: 'current', chart: 'todo', separate: 'todo', practice: 'todo', diff: 'todo',
        });
    });

    it('実際の状態から決まる (原曲・カルテ・パート・練習のノート・差分)', () => {
        const song = engine.addTrack('原曲'); song.role = 'song';
        expect(stepStates(progressFacts(true, false, false))).toMatchObject({ import: 'done', chart: 'done', separate: 'current' });
        const part = addPart('ベース', 'bass');
        expect(stepStates(progressFacts(true, false, false))).toMatchObject({ separate: 'done', practice: 'current' });
        // 練習のトラックが空のうちは ④ が済んでいない
        const practice = engine.addTrack('ベースの練習'); practice.role = 'practice'; practice.practiceOf = part.id;
        expect(stepStates(progressFacts(true, false, false)).practice).toBe('current');
        practice.pianoNotes = [note('C', 3, 0)];
        expect(stepStates(progressFacts(true, false, false))).toMatchObject({ practice: 'done', diff: 'current' });
        expect(stepStates(progressFacts(true, false, true)).diff).toBe('done');
    });

    it('ドラムのパートのノート (採譜したリズム) は、打ち込みとして数えない', () => {
        const drum = engine.addTrack('ドラム'); drum.role = 'part'; drum.part = 'drums';
        drum.pianoNotes = [note('C', 2, 0, 1)];
        expect(progressFacts(true, true, false).practiced).toBe(false);
    });

    it('練習のトラックで重ねるお手本は、そのパートのお手本', () => {
        const part = addPart('ベース', 'bass');
        const practice = engine.addTrack('ベースの練習'); practice.role = 'practice'; practice.practiceOf = part.id;
        expect(referenceTrackFor(practice)).toBe(part);
        expect(referenceTrackFor(part)).toBe(part);
        expect(referenceTrackFor(engine.addTrack('自由'))).toBeUndefined();
    });
});

describe('曲とパート', () => {
    /** ピアノロールの代わりを入れ、状態を読めるようにして描く。 */
    function renderLearn() {
        const pr = fakePianoRoll();
        const seen: { pair?: unknown; ghost?: unknown } = {};
        function Probe() {
            const { pianoRollRef, coachPair, ghostChoice } = useDaw();
            useEffect(() => {
                pianoRollRef.current = pr;
                seen.pair = coachPair; seen.ghost = ghostChoice;
            });
            return null;
        }
        render(<DawProvider><Probe /><ProgressSteps /><LearnPanel /></DawProvider>);
        return { pr, seen };
    }

    it('既定の段は「曲とパート」。曲を取り込む前は、パートに分けられない', () => {
        renderLearn();
        expect(screen.getByRole('tab', { name: '曲とパート' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('button', { name: '曲を取り込む' })).toBeEnabled();
        expect(screen.getByRole('button', { name: /パートに分けて採譜する/ })).toBeDisabled();
        expect(screen.getByText('先に曲を取り込んでください。')).toBeInTheDocument();
    });

    it('「このパートを練習する」で、練習のトラックを作って開き、お手本を重ね、差分の組を決め、パートを鳴らす', () => {
        const part = addPart('ベース', 'bass');
        engine.toggleMute(part.id);
        const { pr, seen } = renderLearn();
        fireEvent.click(screen.getByRole('button', { name: '「ベース」を練習する' }));

        const practice = engine.tracks.find(t => t.role === 'practice')!;
        expect(practice.name).toBe('ベースの練習');
        expect(practice.practiceOf).toBe(part.id);
        expect(practice.pianoNotes).toEqual([]);
        // パートのトラックの隣に並ぶ
        expect(engine.tracks.map(t => t.name)).toEqual(['ベース', 'ベースの練習']);
        // パートの音が鳴るようになる
        expect(part.mute).toBe(false);
        expect(seen.pair).toEqual({ referenceId: part.id, attemptId: practice.id });
        expect(seen.ghost).toBe('auto');
        // 練習のトラックを開き、お手本を重ね、お手本の高さ (真ん中の E3) と最初の小節へ動かす
        expect(pr.calls).toEqual([`switch:${practice.id}`, 'ghost:3', 'pitch:E3', 'step:0']);

        // もう一度押しても、練習のトラックは増えない
        fireEvent.click(screen.getByRole('button', { name: '「ベース」を練習する' }));
        expect(engine.tracks.filter(t => t.role === 'practice')).toHaveLength(1);
        // 進み具合: ③ は済み。④ は練習のトラックにノートが入るまで済まない
        expect(screen.getByRole('button', { name: '③ パートに分ける（済み）' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '④ 打ち込む（まだ）' })).toBeInTheDocument();
        // 済んでいない最初の段階 (① 曲を取り込む) が、いまの段階
        expect(screen.getByRole('button', { name: '① 曲を取り込む（いまの段階）' })).toHaveAttribute('aria-current', 'step');
    });

    it('「お手本をノートとして取り込む」は、確かめてから写す', () => {
        const part = addPart('ベース', 'bass');
        renderLearn();
        fireEvent.click(screen.getByRole('button', { name: '「ベース」のお手本をノートとして取り込む' }));
        expect(screen.getByText(/差分チェックは 100% から始まります/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
        expect(part.pianoNotes).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: '「ベース」のお手本をノートとして取り込む' }));
        fireEvent.click(screen.getByRole('button', { name: '写す' }));
        expect(part.pianoNotes).toEqual(part.referenceNotes);
        expect(part.pianoNotes).not.toBe(part.referenceNotes);
    });

    it('ドラムのパートには練習のボタンを出さず、差分チェックの対象外と書く', () => {
        const drum = engine.addTrack('ドラム'); drum.role = 'part'; drum.part = 'drums';
        drum.pianoNotes = [note('C', 2, 0, 1)];
        renderLearn();
        expect(screen.getByText('ドラム（差分チェックの対象外）')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: '「ドラム」を練習する' })).not.toBeInTheDocument();
    });
});

describe('進み具合の段', () => {
    it('段階を押すと、その場所 (「学ぶ」タブの段) を開く。畳んだことを覚える', () => {
        function Probe() {
            const { learnTab, leftTab } = useDaw();
            return <span data-testid="where">{leftTab}/{learnTab}</span>;
        }
        render(<DawProvider><Probe /><ProgressSteps /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: '② カルテを見る（まだ）' }));
        expect(screen.getByTestId('where')).toHaveTextContent('learn/chart');
        fireEvent.click(screen.getByRole('button', { name: '⑤ 差分で直す（まだ）' }));
        expect(screen.getByTestId('where')).toHaveTextContent('learn/coach');

        fireEvent.click(screen.getByRole('button', { name: /進み具合/ }));
        expect(localStorage.getItem('bunri-progress-collapsed')).toBe('1');
        expect(screen.getByRole('button', { name: 'いま: ① 曲を取り込む' })).toBeInTheDocument();
        cleanup();
        render(<DawProvider><ProgressSteps /></DawProvider>);
        expect(screen.queryByRole('button', { name: /② カルテを見る/ })).not.toBeInTheDocument();
    });
});

describe('ジョブの結果の形が違うとき', () => {
    type Actions = ReturnType<typeof useLearnActions>;
    type Daw = ReturnType<typeof useDaw>;
    const latest: { actions?: Actions; daw?: Daw } = {};
    function Harness() {
        const actions = useLearnActions();
        const daw = useDaw();
        useEffect(() => { latest.actions = actions; latest.daw = daw; });
        return null;
    }
    /** ジョブの API を差し替える。カルテの作成は「終わった」と、`result` を返す。 */
    function stubJobApi(result: unknown) {
        const job = (state: string, extra: object = {}) => ({
            id: 'j1', kind: 'chart', title: '楽曲カルテの作成', filename: 'song.wav', state, cancel_requested: false,
            stage: null, stage_key: null, stage_index: null, stage_count: 1, progress: null, elapsed_sec: 0, error: null,
            result: null, ...extra,
        });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url.startsWith('/api/chart?async=1')) return Response.json(job('running'), { status: 202 });
            if (url === '/api/jobs/j1') return Response.json(job('done', { result }));
            // 原曲の音声の変換 (この環境ではデコードできないので呼ばれる)。置けなかったことにする
            return Response.json({ detail: 'テストでは変換しない' }, { status: 500 });
        }));
    }

    beforeEach(() => {
        jobTracker.resetForTest();
        jobTracker.configure({ poll: 5, hiddenPoll: 5, discover: 5, hiddenDiscover: 5 });
    });
    afterEach(() => {
        jobTracker.resetForTest();
        vi.unstubAllGlobals();
    });

    it('カルテの作成が「終わった」のに結果にカルテが無ければ、例外にせず失敗として知らせ、グリッドも変えない', async () => {
        // e2e の遅いジョブ (backend/web/e2e_routes.py) は、本物の形ではない結果で終わる。
        // 以前は gridFromChart で「chart.grid」を読めずに例外になり、取り込みが途中で止まっていた
        stubJobApi({ ok: true, kind: 'chart', filename: 'song.wav' });
        render(<DawProvider><Harness /></DawProvider>);
        const before = latest.daw!.bpm;
        await act(async () => {
            await latest.actions!.importSong(new File([new Uint8Array(16)], 'song.wav', { type: 'audio/wav' }));
        });
        expect(latest.daw!.status).toBe(CHART_RESULT_INVALID);
        expect(latest.daw!.statusKind).toBe('error');
        expect(latest.daw!.chart).toBeNull();
        expect(latest.daw!.bpm).toBe(before);
    });

    it('つなぎ直したジョブの結果も同じ。finishChart は当てなかったら false を返す', () => {
        render(<DawProvider><Harness /></DawProvider>);
        let applied = true;
        act(() => { applied = latest.actions!.finishChart({ ok: true }); });
        expect(applied).toBe(false);
        expect(latest.daw!.status).toBe(CHART_RESULT_INVALID);
    });

    it('パート分離の結果にパートの表が無ければ、トラックを変えずに知らせる', async () => {
        const song = engine.addTrack('原曲'); song.role = 'song';
        render(<DawProvider><Harness /></DawProvider>);
        expect(isDecomposeResult({ ok: true })).toBe(false);
        expect(isDecomposeResult({ bpm: 120, stems: {} })).toBe(true);
        await act(async () => { await latest.actions!.applyParts({ ok: true, kind: 'decompose' }); });
        expect(engine.tracks.map(t => t.name)).toEqual(['原曲']);
        expect(latest.daw!.statusKind).toBe('error');
        expect(latest.daw!.status).toContain('結果にパートが入っていませんでした');
    });

    it('パートを分け直しても、MIDI ファイルから読み込んだお手本と、その練習のトラックは残る', async () => {
        const note = { note: 'C', octave: 4, step: 0, length: 4 };
        const song = engine.addTrack('原曲'); song.role = 'song';
        // 前に分けたパートと、その練習のトラック (入れ替わる)
        const oldPart = engine.addTrack('ベース'); oldPart.role = 'part'; oldPart.part = 'bass'; oldPart.referenceNotes = [note];
        const oldPractice = engine.addTrack('ベースの練習'); oldPractice.role = 'practice'; oldPractice.practiceOf = oldPart.id;
        // MIDI から読み込んだお手本と、その練習のトラック (残る)
        const midiPart = engine.addTrack('Lead'); midiPart.role = 'part'; midiPart.part = MIDI_PART; midiPart.referenceNotes = [note];
        const midiPractice = engine.addTrack('Lead の練習'); midiPractice.role = 'practice'; midiPractice.practiceOf = midiPart.id;
        midiPractice.pianoNotes = [note];
        render(<DawProvider><Harness /></DawProvider>);

        const stem = { gm_program: null, mix: { volume_db: 0, pan: 0, reverb_wet: 0 }, notes: [note], drum_events: [] };
        await act(async () => { await latest.actions!.applyParts({ bpm: 120, stems: { vocals: stem } }); });

        expect(engine.tracks.map(t => t.name)).toEqual(['原曲', 'Lead', 'Lead の練習', 'ボーカル']);
        expect(engine.getTrack(midiPractice.id)?.practiceOf).toBe(midiPart.id);
        expect(engine.getTrack(midiPractice.id)?.pianoNotes).toEqual([note]);
    });
});
