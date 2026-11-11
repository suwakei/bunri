/**
 * 差分コーチ（第3層の土台）のテスト: 指摘の文と、パネルの表示。
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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

const { issueText, noteName, requestDiff } = await import('../lib/coach');
type DiffIssue = import('../lib/coach').DiffIssue;
type DiffResult = import('../lib/coach').DiffResult;
const { DawProvider } = await import('../lib/store');
const engine = (await import('../lib/engine')).default;
const CoachPanel = (await import('../components/CoachPanel')).default;

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });

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

    it('余分な音', () => {
        expect(issueText(issue({ kind: 'extra', expected: null, actual: note('A', 3, 24) }))).toBe('2 小節 3 拍目: A3 はお手本にありません');
    });

    it('オクターブ違いと音の間違いは、打ち込んだ音とお手本を並べる', () => {
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
        const items = screen.getAllByRole('listitem').map((li) => li.textContent);
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
        expect(options).toEqual(['ピアノ（1 音）']);
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
