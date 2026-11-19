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
const { progressFacts, stepStates, referenceTrackFor, useLearnActions, isDecomposeResult, CHART_RESULT_INVALID, alignSnapToReference } = await import('../lib/learn');
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

    it('お手本を持つドラムのパートは、ほかのパートと同じく練習できる', () => {
        addPart('ドラム', 'drums', [note('C', 2, 0, 1), note('D', 2, 4, 1), note('F#', 2, 0, 1)]);
        renderLearn();
        expect(screen.getByText('お手本 3 ノート')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '「ドラム」を練習する' }));
        expect(engine.tracks.map(t => t.name)).toEqual(['ドラム', 'ドラムの練習']);
        expect(engine.tracks[1]).toMatchObject({ role: 'practice', part: 'drums', practiceOf: engine.tracks[0].id, pianoNotes: [] });
    });

    it('お手本が三連の曲なら、練習を始めるときに刻みを 8 分の三連に合わせる（そのパートで 1 回だけ。利用者が変えたら従う）', () => {
        // シャッフルのベース: 拍の頭と、三連の 3 つ目
        const shuffle = [0, 8 / 3, 4, 20 / 3, 8, 32 / 3].map((step) => note('C', 2, step, 4 / 3));
        const part = addPart('ベース', 'bass', shuffle);
        let snap = '1/4';
        const set: [string, unknown][] = [];
        const pr = { snapId: () => snap, setSnapId: (id: string, options?: { remember?: boolean }) => { set.push([id, options]); snap = id; return true; } };

        // 合わせて、その旨の文を返す。利用者が覚えさせた刻みは書き換えない (remember: false)
        expect(alignSnapToReference(pr, part)).toBe('お手本が三連の曲なので、刻みを「8 分の三連」に合わせました（ピアノロールの上の「刻み」で変えられます）');
        expect(set).toEqual([['1/8T', { remember: false }]]);
        // 利用者が刻みを変えたあとに入り直しても、戻さない
        snap = '1/16';
        expect(alignSnapToReference(pr, part)).toBe('');
        expect(snap).toBe('1/16');
        expect(set).toHaveLength(1);

        // すでに三連の刻みなら、変えない (16 分の三連を選んでいる人を、8 分の三連に戻さない)
        snap = '1/16T';
        expect(alignSnapToReference(pr, addPart('ギター', 'guitar', shuffle))).toBe('');
        expect(snap).toBe('1/16T');
        // ストレートのお手本では、何もしない (三連を選んだままでも、戻さない)
        expect(alignSnapToReference(pr, addPart('ピアノ', 'piano'))).toBe('');
        expect(set).toHaveLength(1);
        // 刻みを持たないピアノロール (まだ用意できていない) でも落ちない
        expect(alignSnapToReference(null, addPart('その他', 'other', shuffle))).toBe('');
    });

    it('三連のお手本の「このパートを練習する」: 練習のトラックを開いてから、刻みを合わせる', () => {
        addPart('ベース', 'bass', [0, 8 / 3, 4, 20 / 3].map((step) => note('E', 2, step, 4 / 3)));
        const { pr } = renderLearn();
        const snaps: string[] = [];
        Object.assign(pr, { snapId: () => '1/4', setSnapId: (id: string) => { snaps.push(id); pr.calls.push(`snap:${id}`); return true; } });
        fireEvent.click(screen.getByRole('button', { name: '「ベース」を練習する' }));
        const practice = engine.tracks.find(t => t.role === 'practice')!;
        expect(pr.calls).toEqual([`switch:${practice.id}`, 'ghost:4', 'pitch:E2', 'step:0', 'snap:1/8T']);
        // もう一度押しても、合わせ直さない
        fireEvent.click(screen.getByRole('button', { name: '「ベース」を練習する' }));
        expect(snaps).toEqual(['1/8T']);
    });

    it('以前の分け方のドラム（お手本なし）は、練習のボタンを押せない。理由と、分け直すと使えることを出す', () => {
        const drum = engine.addTrack('ドラム'); drum.role = 'part'; drum.part = 'drums';
        drum.pianoNotes = [note('C', 2, 0, 1)];
        renderLearn();
        expect(screen.getByText('以前の分け方のドラム（お手本なし・1 ノート）')).toBeInTheDocument();
        const button = screen.getByRole('button', { name: '「ドラム」を練習する' });
        expect(button).toBeDisabled();
        // 押せない理由 (押すと、知らせとして出る)
        expect(button.getAttribute('data-blocked')).toContain('もう一度「パートに分ける」を押すと');
        expect(screen.getByText('パートを分け直すと、ドラムも練習と差分チェックが使えます。')).toBeInTheDocument();
        // 打ち込みに置いてあるノートは、そのまま (開けて、鳴らせる)
        expect(drum.pianoNotes).toEqual([note('C', 2, 0, 1)]);
        expect(engine.tracks).toHaveLength(1);
    });

    it('分け方は SubRoformer が既定で、新旧5モデルの準備と分離を頼む', async () => {
        const posted: FormData[] = [];
        const checkedModels: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            const path = String(url);
            if (path.includes('/api/models/')) {
                checkedModels.push(path);
                return new Response(JSON.stringify({ cached: true }));
            }
            if (path.includes('/api/decompose')) {
                posted.push(init!.body as FormData);
                return new Response(JSON.stringify({ detail: 'テストでは始めません' }), { status: 400 });
            }
            return new Response('{}', { status: 404 });
        }));
        function WithSong() {
            const { setSongFile } = useDaw();
            useEffect(() => { setSongFile(new File(['x'], 'song.wav')); }, [setSongFile]);
            return <LearnPanel />;
        }
        try {
            render(<DawProvider><WithSong /></DawProvider>);
            const choice = screen.getByRole('combobox', { name: '分け方' });
            expect(choice).toHaveValue('subroformer');
            expect(document.getElementById('learn-separation-model-note')).toHaveTextContent('約 207 MB');
            expect(document.getElementById('learn-separation-model-note')).toHaveTextContent('CPUだけの環境では時間がかかります');
            for (const model of ['subroformer', 'scnet', 'htdemucs_ft', 'htdemucs', 'htdemucs_6s']) {
                fireEvent.change(choice, { target: { value: model } });
                if (model === 'scnet') expect(document.getElementById('learn-separation-model-note')).toHaveTextContent('約 13 MB');
                await act(async () => { fireEvent.click(screen.getByRole('button', { name: /パートに分けて採譜する/ })); });
                await vi.waitFor(() => expect(posted.at(-1)?.get('model')).toBe(model));
                expect(checkedModels).toContain(`/api/models/${model}/status`);
            }
            expect(document.getElementById('learn-separation-model-note')).toHaveTextContent('混入や音の欠け');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('「ドラムを種類ごとに分ける」は、追加のモデルが手元に在るときだけ最初から選ばれ、選択を分離に渡す', async () => {
        let cached = false;
        const posted: FormData[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            if (String(url).includes('/api/models/drumsep/status')) return new Response(JSON.stringify({ model: 'drumsep', cached, missing: cached ? 0 : 1 }));
            if (String(url).includes('/api/models/')) return new Response(JSON.stringify({ cached: true }));
            if (String(url).includes('/api/decompose')) { posted.push(init!.body as FormData); return new Response(JSON.stringify({ detail: 'テストでは始めません' }), { status: 400 }); }
            return new Response('{}', { status: 404 });
        }));
        function WithSong() {
            const { setSongFile } = useDaw();
            useEffect(() => { setSongFile(new File(['x'], 'song.wav')); }, [setSongFile]);
            return <LearnPanel />;
        }
        const view = render(<DawProvider><WithSong /></DawProvider>);
        const box = screen.getByRole('checkbox', { name: /ドラムを種類ごとに分ける/ }) as HTMLInputElement;
        // モデルが手元に無い: 選ばれていない (勝手に 160 MB を落とさない)。選ぶとダウンロードが入る、と書く
        await act(async () => { await Promise.resolve(); });
        expect(box.checked).toBe(false);
        expect(document.getElementById('learn-split-drums-note')!.textContent).toContain('チェックを入れると、初回のみ、追加のモデル（約 160 MB）をダウンロードします');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /パートに分けて採譜する/ })); });
        await vi.waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0].get('split_drums')).toBe('false');

        // 利用者が選ぶと、分ける (ダウンロードが入る旨を出す)
        fireEvent.click(box);
        expect(document.getElementById('learn-split-drums-note')!.textContent).toContain('初回のみ、追加のモデル（約 160 MB）をダウンロードします。ダウンロードできなければ、分けずに採譜します');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /パートに分けて採譜する/ })); });
        await vi.waitFor(() => expect(posted).toHaveLength(2));
        expect(posted[1].get('split_drums')).toBe('true');
        view.unmount();

        // モデルが手元に在る: 最初から選ばれている
        cached = true;
        render(<DawProvider><WithSong /></DawProvider>);
        await vi.waitFor(() => expect((screen.getByRole('checkbox', { name: /ドラムを種類ごとに分ける/ }) as HTMLInputElement).checked).toBe(true));
        expect(document.getElementById('learn-split-drums-note')!.textContent).toContain('追加のモデルは、ダウンロード済みです');
        vi.unstubAllGlobals();
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

    it('テンポを自動で取るときは拍子も自動 (0) で頼み、いまの BPM で取るときは、いまの拍子を送る', async () => {
        stubJobApi({ ok: true, kind: 'chart', filename: 'song.wav' });
        render(<DawProvider><Harness /></DawProvider>);
        act(() => { latest.daw!.setBeatsPerBar('3'); });
        const sent = () => {
            const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
            const [, init] = calls.filter(([url]) => url.startsWith('/api/chart?async=1')).slice(-1)[0];
            const body = init.body as FormData;
            return { bpm: body.get('bpm'), beats: body.get('beats_per_bar') };
        };
        const file = () => new File([new Uint8Array(16)], 'song.wav', { type: 'audio/wav' });

        await act(async () => { await latest.actions!.importSong(file()); });
        expect(sent()).toEqual({ bpm: '0', beats: '0' });

        await act(async () => { await latest.actions!.importSong(file(), { autoBpm: false }); });
        expect(sent()).toEqual({ bpm: String(latest.daw!.bpm), beats: '3' });
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

    it.each(['subroformer', 'scnet'])('新モデル %s の分離音量と左右差も、再生時に二重適用しない', async (model) => {
        const song = engine.addTrack('原曲'); song.role = 'song';
        render(<DawProvider><Harness /></DawProvider>);
        await act(async () => { await latest.actions!.applyParts({ bpm: 120, model, stems: {
            bass: { gm_program: null, mix: { volume_db: -48.8, pan: 0.7, reverb_wet: 0.2 }, notes: [], drum_events: [] },
        } }); });
        const part = engine.tracks.find(track => track.part === 'bass')!;
        expect(part.gain).toBe(0);
        expect(part.pan).toBe(0);
        // 通常再生では原曲と重ねない設定は維持する。
        expect(part.mute).toBe(true);
    });

    it.each([
        ['subroformer', 'error'], ['subroformer', 'cancelled'], ['scnet', 'error'], ['scnet', 'cancelled'],
    ] as const)('新モデル %s が %s で終わっても以前のパートと練習を保持する', async (model, state) => {
        const oldPart = addPart('ベース', 'bass');
        const practice = engine.addTrack('ベースの練習');
        practice.role = 'practice'; practice.practiceOf = oldPart.id;
        practice.pianoNotes = [note('C', 2, 0)];
        const before = engine.tracks.map(track => track.id);
        const job = (status: string) => ({
            id: 'parts', kind: 'decompose', title: 'パート分離と採譜', filename: 'song.wav', state: status,
            cancel_requested: status === 'cancelled', stage: null, stage_key: null, stage_index: null, stage_count: 1,
            progress: null, elapsed_sec: 0, result: null,
            error: status === 'error' ? { status: 503, detail: 'モデルをダウンロードできませんでした' } : null,
        });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (String(url).includes('/api/models/')) return Response.json({ cached: true });
            if (String(url).includes('/api/decompose')) return Response.json(job('running'), { status: 202 });
            if (String(url).includes('/api/jobs/parts')) return Response.json(job(state));
            return Response.json({}, { status: 404 });
        }));
        render(<DawProvider><Harness /></DawProvider>);
        act(() => { latest.daw!.setSongFile(new File(['song'], 'song.wav')); });
        await act(async () => { await latest.actions!.separateParts(0.5, undefined, { model }); });
        expect(engine.tracks.map(track => track.id)).toEqual(before);
        expect(engine.getTrack(practice.id)?.pianoNotes).toEqual([note('C', 2, 0)]);
        expect(latest.daw!.status).toContain(state === 'cancelled' ? 'パート分離を中止しました' : 'モデルをダウンロードできませんでした');
    });

    const drumStem = (events: { type: string; step: number; velocity: number }[], source: 'stems' | 'spectral') =>
        ({ gm_program: null, mix: { volume_db: 0, pan: 0, reverb_wet: 0 }, notes: [], drum_events: events, drum_source: source });

    it('ドラムの打音は、種類ごとに決まった高さのお手本になる（打ち込みは空のまま）', async () => {
        render(<DawProvider><Harness /></DawProvider>);
        const events = [
            { type: 'kick', step: 0, velocity: 100 }, { type: 'cymbals', step: 0, velocity: 80 },
            { type: 'snare', step: 4, velocity: 96 }, { type: 'toms', step: 14, velocity: 90 },
            // 知らない種類は置かない
            { type: 'cowbell', step: 2, velocity: 90 },
        ];
        await act(async () => {
            await latest.actions!.applyParts({ bpm: 120, drum_source: 'stems', drum_fallback: null, stems: { drums: drumStem(events, 'stems') } });
        });
        const drums = engine.tracks.find(t => t.part === 'drums')!;
        expect(drums.role).toBe('part');
        expect(drums.pianoNotes).toEqual([]);
        expect(drums.referenceNotes).toEqual([
            { note: 'C', octave: 2, step: 0, length: 1, velocity: 100 },
            { note: 'F#', octave: 2, step: 0, length: 1, velocity: 80 },
            { note: 'D', octave: 2, step: 4, length: 1, velocity: 96 },
            { note: 'A', octave: 2, step: 14, length: 1, velocity: 90 },
        ]);
        expect(latest.daw!.status).toContain('お手本 1 パート');
        expect(latest.daw!.status).toContain('ドラムは、種類ごとに分けて採譜しました');
        expect(latest.daw!.statusKind).toBe('info');
    });

    it('ドラムを分けずに採譜した結果（kick / snare / hihat）も、お手本になる。分けるよう頼んでいたら、分けられなかった理由を知らせる', async () => {
        render(<DawProvider><Harness /></DawProvider>);
        const events = [{ type: 'kick', step: 0, velocity: 100 }, { type: 'hihat', step: 2, velocity: 60 }, { type: 'snare', step: 4, velocity: 96 }];
        await act(async () => {
            await latest.actions!.applyParts({
                bpm: 120, drum_source: 'spectral', drum_fallback: '分離用の追加モデルをダウンロードできませんでした。ネットワークの接続を確かめてください。',
                stems: { drums: drumStem(events, 'spectral') },
            });
        });
        const drums = engine.tracks.find(t => t.part === 'drums')!;
        expect(drums.pianoNotes).toEqual([]);
        expect(drums.referenceNotes!.map(n => `${n.note}${n.octave}@${n.step}`)).toEqual(['C2@0', 'F#2@2', 'D2@4']);
        expect(latest.daw!.statusKind).toBe('hint');
        expect(latest.daw!.status).toContain('ドラムは、種類ごとに分けずに採譜しました（分離用の追加モデルをダウンロードできませんでした。ネットワークの接続を確かめてください）');
        expect(latest.daw!.status).toContain('同時に鳴った種類は、1 つにまとまっています');
    });

    it('以前の版の結果（ドラムの作り方の項目が無い）も、そのまま当てられる', async () => {
        render(<DawProvider><Harness /></DawProvider>);
        const stem = { gm_program: null, mix: { volume_db: 0, pan: 0, reverb_wet: 0 }, notes: [], drum_events: [{ type: 'kick', step: 8, velocity: 90 }] };
        await act(async () => { await latest.actions!.applyParts({ bpm: 120, stems: { drums: stem } }); });
        expect(engine.tracks.find(t => t.part === 'drums')!.referenceNotes).toEqual([{ note: 'C', octave: 2, step: 8, length: 1, velocity: 90 }]);
        expect(latest.daw!.statusKind).toBe('info');
        expect(latest.daw!.status).not.toContain('ドラムは');
    });
});
