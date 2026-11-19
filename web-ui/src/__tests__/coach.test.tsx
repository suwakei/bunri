/**
 * 差分コーチ（第3層の土台）のテスト: 指摘の文と、パネルの表示。
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

class MockGainNode {
    gain = { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    connect() { return this; }
    disconnect() {}
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return { pan: { value: 0 }, connect() { return this; }, disconnect() {} } as unknown as StereoPannerNode; }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const {
    coachHighlight, explainChartContext, explainRequestOf, hasVelocityDiff, issueText, noteName, requestDiff, resolveCoachPair,
    velocityFindingText, velocityNotesOf, velocitySummaryText,
} = await import('../lib/coach');
type ExplanationResponse = import('../lib/coach').ExplanationResponse;
type ChatCard = import('../lib/assistant-cards').ChatCard;
type DawContextType = import('../lib/store').DawContextType;
type AssistantDeps = import('../lib/assistant').AssistantDeps;
const { explanationCardOf } = await import('../lib/assistant-cards');
const { CardView } = await import('../components/AssistantCards');
const { assistantSession } = await import('../lib/assistant');
type DiffIssue = import('../lib/coach').DiffIssue;
type DiffResult = import('../lib/coach').DiffResult;
type VelocityDiff = import('../lib/coach').VelocityDiff;
type VelocityFinding = import('../lib/coach').VelocityFinding;
const { DawProvider, useDaw } = await import('../lib/store');
const { default: engine, MIDI_PART } = await import('../lib/engine');
const { referenceSourceOf } = await import('../lib/learn');
const CoachPanel = (await import('../components/CoachPanel')).default;

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });

/** アシスタントの入口（偽物）。このファイルの依頼は、ツールを呼ばない応答で終わる。 */
const fakeDeps: AssistantDeps = {
    env: {} as AssistantDeps['env'],
    beginEdit: () => () => false,
    topUndoId: () => null,
    suggestionFacts: () => ({
        trackCount: 0, imported: false, hasChart: false, separated: false, practiced: false,
        practiceOpen: false, selectedNotes: 0, openTrackHasNotes: false, jobRunning: false,
    }),
};

function issue(overrides: Partial<DiffIssue>): DiffIssue {
    return { kind: 'missing', bar: 2, beat: 3, expected: note('E', 4, 24), actual: null, offset_steps: null, length_diff: null, ...overrides };
}

let fetchMock: ReturnType<typeof vi.fn>;
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
    engine.init();
    engine.tracks.length = 0;
});

afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
});

describe('issueText', () => {
    it('ノートは E4 の形で呼ぶ', () => expect(noteName(note('F#', 3, 0))).toBe('F#3'));

    it('抜け', () => expect(issueText(issue({}))).toBe('2 小節 3 拍目: E4 が抜けています'));

    it('余分なノート', () => {
        expect(issueText(issue({ kind: 'extra', expected: null, actual: note('A', 3, 24) }))).toBe('2 小節 3 拍目: A3 はお手本にありません');
    });

    it('オクターブ違いと高さの違いは、打ち込んだノートとお手本を並べる', () => {
        expect(issueText(issue({ kind: 'octave', actual: note('E', 3, 24) }))).toBe('2 小節 3 拍目: E3 → お手本は E4（オクターブ違い）');
        expect(issueText(issue({ kind: 'pitch', actual: note('F', 4, 24) }))).toBe('2 小節 3 拍目: F4 → お手本は E4');
    });

    it('位置のずれは向きと量を言う', () => {
        expect(issueText(issue({ kind: 'timing', actual: note('E', 4, 25), offset_steps: 1 }))).toBe('2 小節 3 拍目: E4 が16 分音符 1 個ぶん遅い');
        expect(issueText(issue({ kind: 'timing', actual: note('E', 4, 22), offset_steps: -2 }))).toBe('2 小節 3 拍目: E4 が16 分音符 2 個ぶん早い');
    });

    it('長さの違いは、拍の倍数なら拍で言う', () => {
        expect(issueText(issue({ kind: 'length', actual: note('E', 4, 24, 8), length_diff: 4 }))).toBe('2 小節 3 拍目: E4 が1 拍ぶん長い');
        expect(issueText(issue({ kind: 'length', actual: note('E', 4, 24, 1), length_diff: -3 }))).toBe('2 小節 3 拍目: E4 が16 分音符 3 個ぶん短い');
    });

    it('三連・32 分のずれは、その音符の数で言う（「16 分音符 0.67 個」とは言わない）', () => {
        // お手本は三連の 2 つ目 (25.33)、打ち込みは 1 つ後ろの三連 (26.67)
        const late = issue({ kind: 'timing', expected: note('E', 4, 24 + 4 / 3, 4 / 3), actual: note('E', 4, 24 + 8 / 3, 4 / 3), offset_steps: 4 / 3 });
        expect(issueText(late)).toBe('2 小節 3 拍目: E4 が8 分の三連符 1 個ぶん遅い');
        expect(issueText(issue({ kind: 'timing', offset_steps: -2 / 3 }))).toBe('2 小節 3 拍目: E4 が16 分の三連符 1 個ぶん早い');
        expect(issueText(issue({ kind: 'timing', offset_steps: 0.5 }))).toBe('2 小節 3 拍目: E4 が32 分音符 1 個ぶん遅い');
        expect(issueText(issue({ kind: 'timing', offset_steps: -1.5 }))).toBe('2 小節 3 拍目: E4 が32 分音符 3 個ぶん早い');
        expect(issueText(issue({ kind: 'length', length_diff: -8 / 3 }))).toBe('2 小節 3 拍目: E4 が8 分の三連符 2 個ぶん短い');
        // API を通った小数 (1.3333333333333333) でも、4 桁に丸めた小数でも、同じ文になる
        expect(issueText(issue({ kind: 'timing', offset_steps: 1.3333 }))).toBe(issueText(late));
        // 三連 3 つぶんは、1 拍
        expect(issueText(issue({ kind: 'length', length_diff: 4 / 3 * 3 }))).toBe('2 小節 3 拍目: E4 が1 拍ぶん長い');
        // どの音符の倍数でもない幅 (人が弾いた MIDI のお手本) は、およその数で言う
        expect(issueText(issue({ kind: 'timing', offset_steps: 5 / 6 }))).toBe('2 小節 3 拍目: E4 が16 分音符でおよそ 0.8 個ぶん遅い');
        for (const steps of [4 / 3, 2 / 3, 0.5, 8 / 3]) expect(issueText(issue({ kind: 'timing', offset_steps: steps }))).not.toMatch(/\d\.\d/);
    });
});

describe('requestDiff', () => {
    it('お手本と打ち込みを JSON で送る', async () => {
        stubFetch(async () => Response.json({ summary: {}, bars: [], worst_bars: [] }));
        await requestDiff([note('C', 4, 0)], [note('C', 4, 0)], 12);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/coach/diff');
        expect(JSON.parse(init.body as string)).toEqual({ reference: [note('C', 4, 0)], attempt: [note('C', 4, 0)], steps_per_bar: 12 });
    });

    it('失敗の理由をそのまま伝える', async () => {
        stubFetch(async () => Response.json({ detail: 'お手本のノートがありません' }, { status: 400 }));
        await expect(requestDiff([], [])).rejects.toThrow('お手本のノートがありません');
    });

    it('お手本の出どころは、MIDI のときだけ送る (採譜のお手本では、以前と同じ本文)', async () => {
        stubFetch(async () => Response.json({ summary: {}, bars: [], worst_bars: [] }));
        await requestDiff([note('C', 4, 0)], [note('C', 4, 0)], 16, 'midi');
        await requestDiff([note('C', 4, 0)], [note('C', 4, 0)], 16, 'transcription');
        const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
        expect(bodies[0].reference_source).toBe('midi');
        expect(bodies[1]).toEqual({ reference: [note('C', 4, 0)], attempt: [note('C', 4, 0)], steps_per_bar: 16 });
    });

    it('比べ方は、ドラムのときだけ送る。位置の許容は送らない (比べ方に応じて、API の側が決める)', async () => {
        stubFetch(async () => Response.json({ summary: {}, bars: [], worst_bars: [] }));
        await requestDiff([note('C', 2, 0)], [note('C', 2, 0)], 16, 'transcription', 'drums');
        await requestDiff([note('C', 2, 0)], [note('C', 2, 0)], 16, 'transcription', undefined);
        const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
        expect(bodies[0]).toEqual({ reference: [note('C', 2, 0)], attempt: [note('C', 2, 0)], steps_per_bar: 16, mode: 'drums' });
        expect(bodies[1]).toEqual({ reference: [note('C', 2, 0)], attempt: [note('C', 2, 0)], steps_per_bar: 16 });
    });
});

const strong = (name: string, octave: number, step: number, velocity: number) => ({ ...note(name, octave, step), velocity });

/** 強さの違い (backend/coach_diff.py の velocity_diff の形)。1 小節目の 2 ノートが弱く、2 小節目の 1 ノートが強い。 */
function velocityDiff(findings: VelocityFinding[] = [], overrides: Partial<VelocityDiff> = {}): VelocityDiff {
    return {
        tolerance: 16, default_velocity: 96, compared: 8, weaker: 2, stronger: 1, attempt_unset: 0, median_diff: -4,
        reference: { min: 60, max: 120, median: 96 }, attempt: { min: 96, max: 96, median: 96 },
        findings,
        notes: [
            { bar: 1, beat: 1, expected: strong('C', 4, 0, 120), actual: strong('C', 4, 0, 96), diff: -24 },
            { bar: 1, beat: 2, expected: strong('E', 4, 4, 120), actual: strong('E', 4, 5, 96), diff: -24 },
            { bar: 2, beat: 1, expected: strong('C', 5, 16, 60), actual: strong('C', 5, 16, 96), diff: 36 },
        ],
        ...overrides,
    };
}

const finding = (overrides: Partial<VelocityFinding>): VelocityFinding => ({
    kind: 'section', direction: 'weaker', start_bar: 3, end_bar: 4, count: 6, compared: 8, median_diff: -30.5, notes: [0, 1], ...overrides,
});

describe('強さの違いの文', () => {
    it('全体に弱い・強い', () => {
        expect(velocityFindingText(finding({ kind: 'overall', start_bar: 1, end_bar: 8, count: 20, compared: 24 }), velocityDiff()))
            .toBe('全体に弱い: 合った 24 ノートのうち 20 ノートが、お手本より弱くなっています（強さの差は 31 ほど）');
        expect(velocityFindingText(finding({ kind: 'overall', direction: 'stronger', count: 7, compared: 8, median_diff: 26 }), velocityDiff()))
            .toBe('全体に強い: 合った 8 ノートのうち 7 ノートが、お手本より強くなっています（強さの差は 26 ほど）');
    });

    it('小節の範囲 (1 小節だけなら、その小節)', () => {
        expect(velocityFindingText(finding({}), velocityDiff()))
            .toBe('3〜4 小節が弱い: 8 ノートのうち 6 ノートが、お手本より弱くなっています（強さの差は 31 ほど）');
        expect(velocityFindingText(finding({ direction: 'stronger', start_bar: 5, end_bar: 5, count: 3, compared: 4, median_diff: 20 }), velocityDiff()))
            .toBe('5 小節が強い: 4 ノートのうち 3 ノートが、お手本より強くなっています（強さの差は 20 ほど）');
    });

    it('強弱が付いていない (打ち込みが全部同じ強さなら「一定」)', () => {
        const flat = finding({ kind: 'flat', direction: null });
        expect(velocityFindingText(flat, velocityDiff()))
            .toBe('強弱が付いていません: 打ち込みの強さは 96 で一定ですが、お手本は 60〜120 の幅があります');
        expect(velocityFindingText(flat, velocityDiff([], { attempt: { min: 88, max: 100, median: 96 } })))
            .toBe('強弱が付いていません: 打ち込みの強さは 88〜100 でほぼ一定ですが、お手本は 60〜120 の幅があります');
    });

    it('アクセントが付いていない', () => {
        expect(velocityFindingText(finding({ kind: 'accent', count: 3, compared: 4 }), velocityDiff()))
            .toBe('アクセントが付いていません: お手本で周りより強いノート 4 個のうち 3 個が、お手本より弱くなっています');
    });

    it('まとめの 1 行', () => {
        expect(velocitySummaryText(velocityDiff())).toBe('合った 8 ノートの強さを比べました（お手本より弱い 2 / 強い 1）');
        expect(velocitySummaryText(velocityDiff([], { weaker: 0 }))).toBe('合った 8 ノートの強さを比べました（お手本より強い 1）');
        expect(velocitySummaryText(velocityDiff([], { weaker: 0, stronger: 0 })))
            .toBe('合った 8 ノートの強さを比べました。どれも、お手本と合っています（差が 16 以内）');
    });

    it('強さの違いが在るか (比べていない結果では、無い)', () => {
        expect(hasVelocityDiff({ velocity: velocityDiff() })).toBe(true);
        expect(hasVelocityDiff({ velocity: velocityDiff([], { weaker: 0, stronger: 0, notes: [] }) })).toBe(false);
        expect(hasVelocityDiff({ velocity: null })).toBe(false);
        expect(hasVelocityDiff({})).toBe(false);
        expect(hasVelocityDiff(null)).toBe(false);
    });

    it('まとまりから、当たるノートの番号を引く (同じ形のノートが 2 つ在れば、1 つずつ)', () => {
        const velocity = velocityDiff();
        const attempt = [note('G', 4, 8), note('E', 4, 5), note('C', 4, 0), note('C', 4, 0)];
        const reference = [note('C', 4, 0), note('E', 4, 4)];
        expect(velocityNotesOf(finding({ notes: [0, 1] }), velocity, attempt, reference)).toEqual({ own: [2, 1], ghost: [0, 1] });
        // もう無いノート・番号の外は飛ばす
        expect(velocityNotesOf(finding({ notes: [2, 9] }), velocity, attempt)).toEqual({ own: [], ghost: [] });
    });
});

describe('お手本の出どころ', () => {
    it('MIDI ファイルからお手本として読み込んだトラックだけが midi。ほかは採譜と同じ扱い', () => {
        expect(referenceSourceOf({ role: 'part', part: MIDI_PART })).toBe('midi');
        expect(referenceSourceOf({ role: 'part', part: 'bass' })).toBe('transcription');
        // 以前の形式から開いた、出どころの分からないお手本
        expect(referenceSourceOf({})).toBe('transcription');
        expect(referenceSourceOf({ role: 'practice', part: MIDI_PART })).toBe('transcription');
        expect(referenceSourceOf(undefined)).toBe('transcription');
    });
});

const result: DiffResult = {
    summary: { reference_count: 4, attempt_count: 3, exact: 2, accuracy: 0.75, missing: 1, pitch: 0, octave: 0, extra: 0, timing: 1, length: 0 },
    bars: [
        { bar: 1, issues: [issue({ kind: 'timing', bar: 1, beat: 2, expected: note('E', 4, 4), actual: note('E', 4, 5), offset_steps: 1 })] },
        { bar: 2, issues: [issue({ kind: 'missing', bar: 2, beat: 1, expected: note('C', 5, 16) })] },
    ],
    worst_bars: [2, 1],
};

describe('CoachPanel', () => {
    it('お手本になるトラックが無ければ、作り方を案内する', () => {
        engine.addTrack('自分のトラック');
        render(<DawProvider><CoachPanel /></DawProvider>);
        expect(screen.getByText(/お手本になるトラックがまだありません/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'お手本と比べる' })).not.toBeInTheDocument();
    });

    it('お手本と打ち込みを送り、正確さと指摘を重い小節から表示する', async () => {
        const stem = engine.addTrack('ピアノ');
        stem.referenceNotes = [note('C', 4, 0), note('E', 4, 4), note('G', 4, 8), note('C', 5, 16)];
        stem.pianoNotes = [note('C', 4, 0), note('E', 4, 5), note('G', 4, 8)];
        stubFetch(async () => Response.json(result));
        render(<DawProvider><CoachPanel /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'お手本と比べる' }));

        await waitFor(() => expect(screen.getByText('75%')).toBeInTheDocument());
        const sent = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
        expect(sent.reference).toHaveLength(4);
        expect(sent.attempt).toHaveLength(3);
        expect(sent.steps_per_bar).toBe(16);

        expect(screen.getByText('抜け 1 / 位置のずれ 1')).toBeInTheDocument();
        expect(screen.getByText('まず見るとよい小節: 2 小節、1 小節')).toBeInTheDocument();
        // 指摘の一覧の行 (学習の記録の行は数えない)
        const items = within(screen.getByRole('list', { name: '指摘の一覧' })).getAllByRole('listitem').map((li) => li.textContent);
        expect(items).toEqual(['2 小節 1 拍目: C5 が抜けています', '1 小節 2 拍目: E4 が16 分音符 1 個ぶん遅い']);
    });

    it('別のトラックに打ち込んだものと比べられる', async () => {
        const stem = engine.addTrack('ピアノ');
        stem.referenceNotes = [note('C', 4, 0)];
        stem.pianoNotes = [note('C', 4, 0)];
        const mine = engine.addTrack('自分の打ち込み');
        mine.pianoNotes = [note('D', 4, 0), note('E', 4, 4)];
        stubFetch(async () => Response.json({ ...result, bars: [], worst_bars: [], summary: { ...result.summary, accuracy: 1, missing: 0, timing: 0 } }));
        render(<DawProvider><CoachPanel /></DawProvider>);
        fireEvent.change(screen.getByLabelText('比べる打ち込み'), { target: { value: String(mine.id) } });
        fireEvent.click(screen.getByRole('button', { name: 'お手本と比べる' }));
        await waitFor(() => expect(screen.getByText('お手本どおりです。')).toBeInTheDocument());
        const sent = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
        expect(sent.reference).toEqual([note('C', 4, 0)]);
        expect(sent.attempt).toEqual([note('D', 4, 0), note('E', 4, 4)]);
    });

    it('お手本を持たないトラックは、お手本の選択肢に出ない', () => {
        const stem = engine.addTrack('ピアノ');
        stem.referenceNotes = [note('C', 4, 0)];
        engine.addTrack('自分の打ち込み');
        render(<DawProvider><CoachPanel /></DawProvider>);
        const options = Array.from((screen.getByLabelText('お手本') as HTMLSelectElement).options).map((o) => o.textContent);
        expect(options).toEqual(['ピアノ（1 ノート）']);
        expect((screen.getByLabelText('比べる打ち込み') as HTMLSelectElement).options).toHaveLength(2);
    });

    it('比べられなかったら理由を出す', async () => {
        const stem = engine.addTrack('ピアノ');
        stem.referenceNotes = [note('C', 4, 0)];
        stubFetch(async () => Response.json({ detail: '打ち込みのノートの形式が正しくありません' }, { status: 400 }));
        render(<DawProvider><CoachPanel /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'お手本と比べる' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('打ち込みのノートの形式が正しくありません');
    });
});

describe('強さの違いの欄', () => {
    const flat = finding({ kind: 'flat', direction: null, start_bar: 1, end_bar: 2, count: 3, compared: 8, median_diff: 0, notes: [0, 1, 2] });
    const today = { date: '2026-11-13', calls: 0, cost_usd: 0, limit_calls: 20, limit_usd: null, blocked: null };

    /** お手本のトラックを用意して比べる。`midi` なら、MIDI ファイルからお手本として読み込んだトラックにする。 */
    async function compare(midi: boolean, diff: DiffResult) {
        const stem = engine.addTrack('Lead');
        if (midi) { stem.role = 'part'; stem.part = MIDI_PART; }
        stem.referenceNotes = [strong('C', 4, 0, 120), strong('E', 4, 4, 120), strong('G', 4, 8, 96), strong('C', 5, 16, 60)];
        stem.pianoNotes = [note('C', 4, 0), note('E', 4, 5), note('G', 4, 8)];
        stubFetch(async (url) => (url === '/api/coach/diff' ? Response.json(diff) : Response.json({ saved: false, today })));
        render(<DawProvider><CoachPanel /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'お手本と比べる' }));
        await waitFor(() => expect(screen.getByText('75%')).toBeInTheDocument());
        const sent = (url: string) => fetchMock.mock.calls.filter(([u]) => u === url)
            .map(([, init]) => JSON.parse((init as RequestInit).body as string));
        return { stem, sent };
    }

    it('MIDI のお手本では、出どころを送り、強さの違いをまとまりで出す', async () => {
        const { sent } = await compare(true, { ...result, velocity: velocityDiff([flat], { attempt_unset: 3 }) });
        expect(sent('/api/coach/diff')[0].reference_source).toBe('midi');
        // 強さは、ノートと一緒に送る (お手本は持ち、マウスで置いた打ち込みは持たない)
        expect(sent('/api/coach/diff')[0].reference[0].velocity).toBe(120);
        expect(sent('/api/coach/diff')[0].attempt[0].velocity).toBeUndefined();

        const section = screen.getByRole('region', { name: '強さの違い' });
        expect(section).toHaveTextContent('MIDI ファイルから読み込んだお手本なので、強さも比べています。合った 8 ノートの強さを比べました（お手本より弱い 2 / 強い 1）。');
        const items = within(section).getAllByRole('listitem').map((li) => li.textContent);
        expect(items).toEqual(['強弱が付いていません: 打ち込みの強さは 96 で一定ですが、お手本は 60〜120 の幅があります']);
        expect(section).toHaveTextContent('マウスで置いたノートは強さを持たないので、96 として比べています。');
        // 位置・高さ・長さの指摘の一覧と件数には、強さを混ぜない
        expect(screen.getByText('抜け 1 / 位置のずれ 1')).toBeInTheDocument();
        expect(within(screen.getByRole('list', { name: '指摘の一覧' })).getAllByRole('listitem')).toHaveLength(2);
        // パネルは、説明の API を呼ばない (説明はアシスタントが作る)
        expect(sent('/api/coach/explain/saved')).toHaveLength(0);
    });

    it('採譜のお手本では、出どころを送らず、強さの欄そのものを出さない', async () => {
        const { sent } = await compare(false, { ...result, velocity: null });
        expect(sent('/api/coach/diff')[0].reference_source).toBeUndefined();
        expect(screen.queryByRole('region', { name: '強さの違い' })).not.toBeInTheDocument();
        expect(document.getElementById('coach-panel')).not.toHaveTextContent('強さ');
    });

    it('以前の版が保存した結果 (強さの項目が無い) でも、強さの欄を出さない', async () => {
        await compare(false, result);
        expect(screen.queryByRole('region', { name: '強さの違い' })).not.toBeInTheDocument();
    });

    it('強さが合っていれば、合っている旨を 1 行だけ出す', async () => {
        await compare(true, { ...result, velocity: velocityDiff([], { weaker: 0, stronger: 0, notes: [] }) });
        const section = screen.getByRole('region', { name: '強さの違い' });
        expect(section).toHaveTextContent('どれも、お手本と合っています（差が 16 以内）');
        expect(within(section).queryByRole('list')).not.toBeInTheDocument();
    });

    it('まとまりにならない違いだけなら、数だけを出す', async () => {
        await compare(true, { ...result, velocity: velocityDiff() });
        const section = screen.getByRole('region', { name: '強さの違い' });
        expect(section).toHaveTextContent('まとまった違いはありません（1〜2 ノートだけの強さの違いは、挙げていません）。');
        expect(within(section).queryByRole('list')).not.toBeInTheDocument();
    });

    it('合ったノートが 1 つも無ければ、強さの欄を出さない', async () => {
        await compare(true, { ...result, velocity: velocityDiff([], { compared: 0, weaker: 0, stronger: 0, notes: [], reference: null, attempt: null, median_diff: null }) });
        expect(screen.queryByRole('region', { name: '強さの違い' })).not.toBeInTheDocument();
    });

    it('高さ・位置・長さが合っていて強さだけが違うときは、「お手本どおり」とは言い切らない', async () => {
        const matched = { ...result, bars: [], worst_bars: [], summary: { ...result.summary, accuracy: 0.75, missing: 0, timing: 0 } };
        await compare(true, { ...matched, velocity: velocityDiff([flat]) });
        expect(screen.getByText('高さ・位置・長さは、お手本どおりです。')).toBeInTheDocument();
        expect(screen.queryByText('お手本どおりです。')).not.toBeInTheDocument();
    });
});

describe('差分の説明（アシスタントに頼む入口と、チャットのカード）', () => {
    const explanation: ExplanationResponse = {
        explanation: {
            summary: '抜けと位置のずれが 1〜2 小節に出ています。',
            points: [
                { title: '2 小節目の抜け', observation: '2 小節目の頭が抜けています。', cause: '拍の頭を数え落としたのかもしれません。',
                    fix: 'お手本と見比べてください。', refs: [{ issue_id: 'i2', bar: 2, beat: 1, kind: 'missing' }, { issue_id: null, bar: 1, beat: null, kind: null }] },
            ],
            next_step: 'まず 2 小節目を開いてください。', next_step_bar: 2,
            dropped_refs: 0, dropped_points: 1, unverified_terms: ['Dm7'], replaced: [],
        },
        source: 'claude', reason: null, model: 'claude-opus-5-5',
        usage: { input_tokens: 20, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 400 },
        cost_usd: 0.12, cached: false, created_at: '2026-11-12T01:00:00+00:00',
        input: { issues: 2, issues_sent: 2, chart_context: 'none' },
    };

    /** ストアを外から読み、アシスタントの入口を置く（ドックのかわり）。 */
    function Harness({ expose, card }: { expose: (daw: DawContextType) => void; card?: ChatCard }) {
        const daw = useDaw();
        expose(daw);
        useEffect(() => assistantSession.attach(fakeDeps), []);
        return <><CoachPanel />{card && <CardView card={card} />}</>;
    }

    /** お手本のトラックを用意して、パネル（と、渡したカード）を出して比べる。 */
    async function setup(card?: (stemId: number) => ChatCard) {
        assistantSession.reset();
        const stem = engine.addTrack('ピアノ');
        stem.referenceNotes = [note('C', 4, 0), note('E', 4, 4), note('G', 4, 8), note('C', 5, 16)];
        stem.pianoNotes = [note('C', 4, 0), note('E', 4, 5), note('G', 4, 8)];
        stubFetch(async (url) => {
            if (url === '/api/coach/diff') return Response.json(result);
            if (url === '/api/assistant/step') return Response.json({ content: [{ type: 'text', text: 'どうぞ。' }], stop_reason: 'end_turn', model: 'claude-haiku-5-5' });
            throw new Error(`想定外: ${url}`);
        });
        const ref: { daw: DawContextType | null } = { daw: null };
        render(<DawProvider><Harness expose={(daw) => { ref.daw = daw; }} card={card?.(stem.id)} /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'お手本と比べる' }));
        await waitFor(() => expect(screen.getByText('75%')).toBeInTheDocument());
        return { stem, daw: () => ref.daw! };
    }

    const calls = (url: string) => fetchMock.mock.calls.filter(([u]) => u === url);

    it('比べたあとに「Claude に説明してもらう」を出す。押すとドックが開き、打ち込みの名前を入れた依頼が送られる。パネルは説明の API を呼ばない', async () => {
        const { daw } = await setup();
        expect(screen.getByText(/差分チェックの結果）を\s*Anthropic の Claude に送ります/)).toBeInTheDocument();
        // 設定の欄はドックにだけ在る
        expect(screen.queryByRole('button', { name: 'API キーと上限の設定' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Claude に説明してもらう' }));
        expect(daw().assistantOpen).toBe(true);
        await waitFor(() => expect(calls('/api/assistant/step')).toHaveLength(1));
        const body = JSON.parse((calls('/api/assistant/step')[0] as [string, RequestInit])[1].body as string);
        expect(body.messages[body.messages.length - 1].content[0].text).toBe('差分を説明して（ピアノ）');
        expect(calls('/api/coach/explain')).toHaveLength(0);
        expect(calls('/api/coach/explain/saved')).toHaveLength(0);
        await waitFor(() => expect(assistantSession.getState().running).toBe(false));
    });

    it('カード: 点・場所の札・事実に無い語の注意・使用量を出す。指摘の札を押すと、差分の段の一覧のその行を示す', async () => {
        await setup((stemId) => explanationCardOf(explanation, result, { referenceId: stemId, attemptId: stemId, trackName: 'ピアノ' }));
        const card = screen.getByRole('region', { name: '差分の説明（ピアノ）' });
        expect(within(card).getByText('2 小節目の抜け')).toBeInTheDocument();
        expect(card).toHaveTextContent('抜けと位置のずれが 1〜2 小節に出ています。');
        expect(within(card).getByRole('note')).toHaveTextContent('差分の結果に無い音名・コード名・小節番号が説明に含まれています: Dm7');
        expect(card).toHaveTextContent('結び付けられなかった点を 1 個省きました');
        expect(card).toHaveTextContent('この説明を作ったときの使用量: 入力 3,020 トークン、出力 400 トークン、概算 $0.12');
        expect(card).toHaveTextContent('作成: Opus');

        // 指摘を指す札を押すと、一覧のその行を示す (i2 = 2 つ目の小節の 1 つ目の指摘)
        fireEvent.click(within(card).getByRole('button', { name: '2 小節 1 拍目（抜け）' }));
        const row = screen.getByText('2 小節 1 拍目: C5 が抜けています').closest('li')!;
        await waitFor(() => expect(row).toHaveAttribute('aria-current', 'true'));
        expect(row).toHaveAttribute('data-issue-id', 'i2');
        // 小節だけの札は、一覧の行を示さない
        fireEvent.click(within(card).getByRole('button', { name: '1 小節' }));
        await waitFor(() => expect(row).not.toHaveAttribute('aria-current'));
        // 「最初にやること」の札もある
        expect(within(card).getByRole('button', { name: '2 小節へ' })).toBeInTheDocument();
        coachHighlight.set(null);
    });

    it('カード: Claude に頼むまでもないとき (決まった文) は、次にやることと理由だけを出し、費用は出さない', async () => {
        const rule: ExplanationResponse = {
            ...explanation, source: 'rule', reason: 'few_issues', model: null, usage: {}, cost_usd: 0,
            explanation: { ...explanation.explanation, summary: 'お手本 4 ノートのうち、75% が合っています。', points: [],
                next_step: '違いは 2 か所だけです。', next_step_bar: 2, unverified_terms: [], dropped_points: 0 },
        };
        await setup((stemId) => explanationCardOf(rule, result, { referenceId: stemId, attemptId: stemId, trackName: 'ピアノ' }));
        const card = screen.getByRole('region', { name: '差分の説明（ピアノ）' });
        expect(card).toHaveTextContent('違いは 2 か所だけです。');
        expect(card).not.toHaveTextContent('お手本 4 ノートのうち、75% が合っています。');
        expect(card).toHaveTextContent('違いが少なく一覧を読めば足りるので、Claude は呼んでいません');
        expect(card).not.toHaveTextContent('使用量');
        expect(within(card).getByRole('button', { name: '2 小節へ' })).toBeInTheDocument();
    });

    it('カード: 説明した打ち込みのトラックが無くなっていたら、移動できない理由を出す', async () => {
        const { daw } = await setup(() => explanationCardOf(explanation, result, { referenceId: 98, attemptId: 99, trackName: '消したトラック' }));
        fireEvent.click(within(screen.getByRole('region', { name: '差分の説明（消したトラック）' })).getByRole('button', { name: '2 小節へ' }));
        await waitFor(() => expect(daw().statusKind).toBe('hint'));
        expect(daw().status).toMatch(/消したトラック）が見つかりません/);
    });

    it('カード: 同じ番号のトラックでも名前が違えば（開き直して番号が振り直された）、別のトラックを開かずに理由を出す', async () => {
        const { daw } = await setup((stemId) => explanationCardOf(explanation, result, { referenceId: stemId, attemptId: stemId, trackName: '前のベース' }));
        fireEvent.click(within(screen.getByRole('region', { name: '差分の説明（前のベース）' })).getByRole('button', { name: '2 小節へ' }));
        await waitFor(() => expect(daw().statusKind).toBe('hint'));
        expect(daw().status).toMatch(/前のベース）が見つかりません.*番号が変わっています/);
    });
});

describe('説明の材料（lib/coach.ts）', () => {
    it('explainRequestOf: 比べたときのノートで組み立てる。MIDI のお手本のときだけ出どころを付け、カルテは在れば添える', () => {
        const compared = { reference: [note('C', 4, 0)], attempt: [note('D', 4, 0)], stepsPerBar: 12 };
        expect(explainRequestOf(compared, null)).toEqual({ reference: [note('C', 4, 0)], attempt: [note('D', 4, 0)], steps_per_bar: 12 });
        expect(explainRequestOf({ ...compared, referenceSource: 'midi' }, { chart_id: 'c1', bpm: 98, grid_offset_sec: 0.1 })).toEqual({
            reference: [note('C', 4, 0)], attempt: [note('D', 4, 0)], steps_per_bar: 12, reference_source: 'midi', chart_id: 'c1', bpm: 98, grid_offset_sec: 0.1,
        });
    });

    it('explainChartContext: いまのカルテのグリッドで採譜したパートのときだけ、カルテを添える', () => {
        const now = { chartId: 'c1', partsChartId: 'c1', bpm: 98, gridOffset: 0.1 };
        expect(explainChartContext({ role: 'part' }, now)).toEqual({ chart_id: 'c1', bpm: 98, grid_offset_sec: 0.1 });
        expect(explainChartContext({ role: 'part' }, { ...now, partsChartId: 'old' })).toBeNull();
        expect(explainChartContext({ role: 'practice' }, now)).toBeNull();
        expect(explainChartContext({ role: 'part' }, { ...now, chartId: null })).toBeNull();
    });

    it('resolveCoachPair: 選んでいる組。無ければ、お手本を持つ最初のトラックと、その練習のトラック（無ければ自分）', () => {
        const tracks = [
            { id: 1, name: '自由' }, { id: 2, role: 'part', referenceNotes: [note('C', 4, 0)] },
            { id: 3, role: 'practice', practiceOf: 2 }, { id: 4, role: 'part', referenceNotes: [note('C', 4, 0)] },
        ];
        expect(resolveCoachPair(tracks, { referenceId: null, attemptId: null })).toMatchObject({ reference: { id: 2 }, attempt: { id: 3 } });
        expect(resolveCoachPair(tracks, { referenceId: 4, attemptId: null })).toMatchObject({ reference: { id: 4 }, attempt: { id: 4 } });
        expect(resolveCoachPair(tracks, { referenceId: 4, attemptId: 1 })).toMatchObject({ reference: { id: 4 }, attempt: { id: 1 } });
        expect(resolveCoachPair([{ id: 1 }], { referenceId: null, attemptId: null })).toMatchObject({ reference: undefined, attempt: undefined });
    });
});
