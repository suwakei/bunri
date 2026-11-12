/**
 * 練習画面の計算のテスト: 区間・指摘とノートの色・一致・区間ループの時刻・速度 (音の高さを変えずに伸ばす)。
 */
import { describe, it, expect } from 'vitest';
import type { DiffIssue, DiffResult, IssueKind } from '../lib/coach';
import type { PianoNote } from '../lib/engine';
import type { SongChart } from '../lib/chart';
import {
    clampLoop, defaultLoop, issuesInOrder, listenTrackIds, loopSeconds, loopSteps, markNotes, matchRate, noteMarkLabel,
    notesInRange, notesOfIssue, secondsToLoop, shiftLoop, speedLabel, MAX_LOOP_BARS,
    practiceFromSection, practiceToSection, samePracticeSettings, type PracticeState,
} from '../lib/practice';
import { beatsInSegment, clampToLoop, clipInSegment, loopPosition, loopSegment, noteInSegment } from '../lib/loop';
import { extractRegion, stretchedLength, wsolaStretch } from '../lib/stretch';

const n = (note: string, octave: number, step: number, length = 4): PianoNote => ({ note, octave, step, length });
const grid = { bpm: 120, beatsPerBar: 4, offsetSec: 0.75 };

function issue(kind: IssueKind, expected: PianoNote | null, actual: PianoNote | null, extra: Partial<DiffIssue> = {}): DiffIssue {
    const anchor = expected ?? actual!;
    return {
        kind, bar: Math.floor(anchor.step / 16) + 1, beat: Math.floor((anchor.step % 16) / 4) + 1, expected, actual,
        offset_steps: expected && actual ? actual.step - expected.step : null,
        length_diff: expected && actual ? actual.length - expected.length : null, ...extra,
    };
}

function result(issues: DiffIssue[], accuracy: number, referenceCount: number): DiffResult {
    const counts = { missing: 0, pitch: 0, octave: 0, extra: 0, timing: 0, length: 0 } as Record<IssueKind, number>;
    for (const i of issues) counts[i.kind] += 1;
    const bars = [...new Set(issues.map((i) => i.bar))].sort((a, b) => a - b).map((bar) => ({ bar, issues: issues.filter((i) => i.bar === bar) }));
    return { summary: { reference_count: referenceCount, attempt_count: 0, exact: 0, accuracy, ...counts }, bars, worst_bars: [] };
}

describe('区間', () => {
    it('小節の区間をステップと秒にする (1 小節目は gridOffset)', () => {
        const loop = { startBar: 2, endBar: 3, enabled: true };
        expect(loopSteps(loop, grid)).toEqual({ start: 16, end: 48 });
        expect(loopSeconds(loop, grid)).toEqual({ start: 2.75, end: 6.75 });
    });
    it('収まる形に直し、ずらしても長さは変わらない', () => {
        expect(clampLoop({ startBar: 0, endBar: -3, enabled: true })).toEqual({ startBar: 1, endBar: 1, enabled: true });
        expect(clampLoop({ startBar: 5, endBar: 500, enabled: true }).endBar).toBe(5 + MAX_LOOP_BARS - 1);
        expect(shiftLoop({ startBar: 5, endBar: 8, enabled: true }, 1)).toEqual({ startBar: 6, endBar: 9, enabled: true });
        expect(shiftLoop({ startBar: 1, endBar: 4, enabled: false }, -1)).toEqual({ startBar: 1, endBar: 4, enabled: false });
    });
    it('秒の範囲を、それを覆う小節にする', () => {
        expect(secondsToLoop(0.75, 4.75, grid)).toMatchObject({ startBar: 1, endBar: 2 });
        expect(secondsToLoop(4.75, 8.75, grid)).toMatchObject({ startBar: 3, endBar: 4 });
    });
    it('最初の区間は、お手本の最初のノートが在る構成の区間 (無ければ 4 小節)', () => {
        const chart = { sections: [
            { start_sec: 0.75, end_sec: 4.75 }, { start_sec: 4.75, end_sec: 40.75 },
        ] } as unknown as SongChart;
        expect(defaultLoop([n('C', 2, 40)], grid, chart)).toEqual({ startBar: 3, endBar: 10, enabled: true });
        expect(defaultLoop([n('C', 2, 0)], grid, chart)).toEqual({ startBar: 1, endBar: 2, enabled: true });
        expect(defaultLoop([n('C', 2, 70)], grid, null)).toEqual({ startBar: 5, endBar: 8, enabled: true });
    });
    it('範囲の中で始まるノートだけ', () => {
        const notes = [n('C', 2, 0), n('D', 2, 15), n('E', 2, 16)];
        expect(notesInRange(notes, { start: 0, end: 16 })).toEqual(notes.slice(0, 2));
        expect(notesInRange(notes, null)).toHaveLength(3);
    });
    it('聴く: パート / 自分 / 両方', () => {
        expect(listenTrackIds({ partId: 1, trackId: 2, listen: 'part' })).toEqual([1]);
        expect(listenTrackIds({ partId: 1, trackId: 2, listen: 'self' })).toEqual([2]);
        expect(listenTrackIds({ partId: 1, trackId: 2, listen: 'both' })).toEqual([1, 2]);
        expect(speedLabel(0.75)).toBe('75%');
    });
});

describe('プロジェクトへの保存 (状態の節 practice)', () => {
    const tracks = [
        { id: 11, referenceNotes: undefined },
        { id: 12, referenceNotes: [n('C', 2, 0)] },
        { id: 13, referenceNotes: undefined },
    ];
    const state: PracticeState = {
        partId: 12, trackId: 13, loop: { startBar: 5, endBar: 8, enabled: false }, speed: 0.75, listen: 'part', showGhost: false, input: 'midi-step',
    };

    it('トラックは並びの番号で持ち、開いたトラックの ID に戻す', () => {
        const saved = practiceToSection(state, tracks);
        expect(saved).toEqual({ part: 1, track: 2, loop: { startBar: 5, endBar: 8, enabled: false }, speed: 0.75, listen: 'part', showGhost: false, input: 'midi-step' });
        // 開き直すと ID は変わる
        const reopened = [{ id: 21, referenceNotes: undefined }, { id: 22, referenceNotes: [n('C', 2, 0)] }, { id: 23, referenceNotes: undefined }];
        expect(practiceFromSection(JSON.parse(JSON.stringify({ ...saved, version: 1 })), reopened)).toEqual({ ...state, partId: 22, trackId: 23 });
    });

    it('パートか練習のトラックが無くなっていたら、保存しない', () => {
        expect(practiceToSection({ ...state, trackId: 99 }, tracks)).toBeNull();
        expect(practiceToSection({ ...state, partId: 99 }, tracks)).toBeNull();
    });

    it('トラックの番号が範囲の外・お手本の無いトラック・節が無いときは、状態を持たない', () => {
        const base = practiceToSection(state, tracks)!;
        expect(practiceFromSection({ ...base, track: 3 }, tracks)).toBeNull();
        expect(practiceFromSection({ ...base, track: -1 }, tracks)).toBeNull();
        expect(practiceFromSection({ ...base, part: 1.5 }, tracks)).toBeNull();
        expect(practiceFromSection({ ...base, part: 0 }, tracks)).toBeNull();
        expect(practiceFromSection({ ...base, part: null }, tracks)).toBeNull();
        expect(practiceFromSection(null, tracks)).toBeNull();
        expect(practiceFromSection('practice', tracks)).toBeNull();
    });

    it('おかしな値は既定に直す (区間は収める。速度・聴く・入力は知らない値なら 100% / 両方 / マウス)', () => {
        const got = practiceFromSection({ part: 1, track: 2, loop: { startBar: 0, endBar: 999 }, speed: 0.33, listen: 'all', showGhost: 'yes', input: 'keyboard' }, tracks);
        expect(got).toEqual({
            partId: 12, trackId: 13, loop: { startBar: 1, endBar: MAX_LOOP_BARS, enabled: true }, speed: 1, listen: 'both', showGhost: true, input: 'mouse',
        });
        expect(practiceFromSection({ part: 1, track: 2 }, tracks)?.loop).toEqual({ startBar: 1, endBar: 4, enabled: true });
    });

    it('保存に使う設定が同じか', () => {
        expect(samePracticeSettings(state, { ...state, loop: { ...state.loop } })).toBe(true);
        expect(samePracticeSettings(state, { ...state, loop: { ...state.loop, enabled: true } })).toBe(false);
        expect(samePracticeSettings(state, { ...state, speed: 1 })).toBe(false);
        expect(samePracticeSettings(state, { ...state, input: 'mouse' })).toBe(false);
    });
});

describe('指摘とノートの色 (markNotes)', () => {
    const reference = [n('C', 2, 0), n('E', 2, 4), n('G', 2, 8), n('C', 3, 12), n('A', 2, 16)];
    const attempt = [n('C', 2, 0), n('F', 2, 4), n('G', 2, 9, 3), n('B', 4, 20), n('A', 2, 40)];
    const issues = [
        issue('pitch', reference[1], attempt[1]),
        issue('timing', reference[2], attempt[2]),
        issue('length', reference[2], attempt[2]),
        issue('missing', reference[3], null),
        issue('missing', reference[4], null),
        issue('extra', null, attempt[3]),
    ];
    const diff = result(issues, 0.4, 5);

    it('打ち込み: 合っている / 高さが違う / 位置か長さ / 余分。範囲の外には付けない', () => {
        const { own } = markNotes(diff, attempt, reference, { start: 0, end: 32 });
        expect(own.map((m) => m?.kind ?? null)).toEqual(['ok', 'pitch', 'rhythm', 'extra', null]);
        // 位置のずれと長さの違いは、同じノートに 2 件まとまる
        expect(own[2]!.issues.map((i) => i.kind)).toEqual(['timing', 'length']);
    });
    it('お手本: 合っている (位置だけのずれも) / 抜け。高さが違う組の相手には指摘を結ぶだけ', () => {
        const { ghost } = markNotes(diff, attempt, reference, { start: 0, end: 32 });
        expect(ghost.map((m) => m?.kind ?? null)).toEqual(['ok', 'pitch', 'ok', 'missing', 'missing']);
    });
    it('同じ形のノートが 2 つ在っても、別々に印を付ける', () => {
        const twice = [n('C', 2, 0), n('C', 2, 0)];
        const { own } = markNotes(result([issue('extra', null, twice[1])], 1, 1), twice, [n('C', 2, 0)]);
        expect(own.map((m) => m?.kind)).toEqual(['extra', 'ok']);
    });
    it('指摘から、結び付くノートを引ける。読み上げの名前に指摘の文が入る', () => {
        const marks = markNotes(diff, attempt, reference);
        expect(notesOfIssue(issues[0], marks)).toEqual({ own: [1], ghost: [1] });
        expect(notesOfIssue(issues[3], marks)).toEqual({ own: [], ghost: [3] });
        expect(noteMarkLabel(attempt[1], marks.own[1]!)).toBe('F2: 高さが違う。1 小節 2 拍目: F2 → お手本は E2');
        expect(noteMarkLabel(reference[3], marks.ghost[3]!, true)).toBe('お手本 C3: お手本の抜け。1 小節 4 拍目: C3 が抜けています');
    });
    it('一致は、お手本のうち高さと位置が合っていた割合 (差分の accuracy)。指摘は時間の順', () => {
        expect(matchRate(diff)).toBe(40);
        expect(matchRate(null)).toBeNull();
        expect(issuesInOrder(diff).map((i) => i.kind)).toEqual(['pitch', 'timing', 'length', 'missing', 'missing', 'extra']);
    });
});

describe('区間ループの時刻 (lib/loop.ts)', () => {
    const loop = { start: 2, end: 6 };
    it('1 周目は始めた位置から、2 周目からは区間の頭から。周の開始は式で出す', () => {
        expect(clampToLoop(1, loop)).toBe(2);
        expect(clampToLoop(3, loop)).toBe(3);
        expect(loopSegment(loop, 3, 10, 1, 0)).toEqual({ index: 0, from: 3, to: 6, when: 10, duration: 3 });
        expect(loopSegment(loop, 3, 10, 1, 1)).toEqual({ index: 1, from: 2, to: 6, when: 13, duration: 4 });
        expect(loopSegment(loop, 3, 10, 1, 1000).when).toBe(10 + 3 + 999 * 4);
    });
    it('速度 0.5 なら、周の長さは 2 倍', () => {
        expect(loopSegment(loop, 2, 0, 0.5, 1)).toMatchObject({ when: 8, duration: 8 });
    });
    it('再生位置は区間の終わりで頭に戻る (何周目かも分かる)', () => {
        expect(loopPosition(loop, 3, 1, 2.5)).toEqual({ position: 5.5, pass: 0 });
        expect(loopPosition(loop, 3, 1, 3.5)).toEqual({ position: 2.5, pass: 1 });
        expect(loopPosition(loop, 3, 1, 7.5)).toEqual({ position: 2.5, pass: 2 });
        expect(loopPosition(loop, 2, 0.5, 9)).toEqual({ position: 2.5, pass: 1 });
        expect(loopPosition(null, 3, 1, 10)).toEqual({ position: 13, pass: 0 });
    });
    it('ノート: 周の中で鳴るところ。周をまたぐノートは周の終わりで切る。前の周から続くノートは 1 周目だけ', () => {
        const first = loopSegment(loop, 3, 0, 1, 0), second = loopSegment(loop, 3, 0, 1, 1);
        expect(noteInSegment(first, 1, 4, 1)).toEqual({ when: 1, duration: 1, partial: false });
        expect(noteInSegment(first, 1, 5.5, 2)).toEqual({ when: 2.5, duration: 0.5, partial: false });
        expect(noteInSegment(first, 1, 2.5, 1)).toEqual({ when: 0, duration: 0.5, partial: true });
        expect(noteInSegment(second, 1, 1.5, 1)).toBeNull();
        expect(noteInSegment(second, 0.5, 3, 1)).toEqual({ when: 3 + 2, duration: 2, partial: false });
    });
    it('クリップ: 周と重なるところを読む (区間の途中から始まるクリップも)', () => {
        const second = loopSegment(loop, 2, 0, 1, 1);
        expect(clipInSegment(second, 0, 10)).toEqual({ when: 4, offset: 2, duration: 4 });
        expect(clipInSegment(second, 3, 1)).toEqual({ when: 5, offset: 0, duration: 1 });
        expect(clipInSegment(second, 7, 1)).toBeNull();
    });
    it('メトロノームの拍 (1 小節目の位置から)', () => {
        const seg = loopSegment({ start: 0.75, end: 2.75 }, 0.75, 0, 1, 0);
        expect(beatsInSegment(seg, 0.75, 0.5, 4)).toEqual([
            { at: 0.75, downbeat: true }, { at: 1.25, downbeat: false }, { at: 1.75, downbeat: false }, { at: 2.25, downbeat: false },
        ]);
    });
});

describe('速度: 音の高さを変えずに伸ばす (lib/stretch.ts)', () => {
    const sr = 22050;
    const sine = (freq: number, sec: number) => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => Math.sin((2 * Math.PI * freq * i) / sr));
    const zeroCrossFreq = (x: Float32Array, from: number, to: number) => {
        let count = 0;
        for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) count++;
        return count / ((to - from) / sr);
    };
    const rms = (x: Float32Array, from: number, to: number) => Math.sqrt(x.subarray(from, to).reduce((s, v) => s + v * v, 0) / (to - from));

    it.each([0.5, 0.75, 0.9])('速度 %s: 長さは 1/速度 倍、高さ (周波数) と大きさは変わらない', (rate) => {
        const input = sine(220, 2);
        const [out] = wsolaStretch([input], rate, sr);
        expect(out.length).toBe(stretchedLength(input.length, rate));
        const from = Math.round(sr * 0.3), to = out.length - Math.round(sr * 0.3);
        expect(Math.abs(zeroCrossFreq(out, from, to) - 220)).toBeLessThan(3);
        // 重ね方がずれると、山と谷が打ち消し合って小さくなる (うなる)
        expect(Math.abs(rms(out, from, to) - Math.SQRT1_2)).toBeLessThan(0.08);
    });
    it('速度 1 はそのまま写す。チャンネルは同じだけずらす', () => {
        const input = sine(110, 0.5);
        expect(wsolaStretch([input], 1, sr)[0]).toEqual(input);
        const out = wsolaStretch([input, input.map((v) => -v)], 0.5, sr);
        expect(out).toHaveLength(2);
        for (let i = 0; i < out[0].length; i += 997) expect(out[1][i]).toBeCloseTo(-out[0][i], 5);
    });
    it('区間をクリップから切り出す (クリップの位置・モノラル・重なり)', () => {
        const buf = (data: Float32Array) => ({ numberOfChannels: 1, sampleRate: 10, length: data.length, getChannelData: () => data as Float32Array<ArrayBuffer> });
        const a = Float32Array.from({ length: 20 }, (_, i) => i);
        const region = extractRegion([{ offset: 1, buffer: buf(a) }, { offset: 2, buffer: buf(new Float32Array(20).fill(100)) }], 1.5, 2.5)!;
        expect(region.sampleRate).toBe(10);
        expect(Array.from(region.channels[0])).toEqual([5, 6, 7, 8, 9, 110, 111, 112, 113, 114]);
        expect(extractRegion([], 0, 1)).toBeNull();
    });
});
