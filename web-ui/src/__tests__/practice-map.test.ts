/**
 * 練習の地図の集計 (lib/practice-map.ts): 小節ごとに、いちばん新しい記録を採る。区間の値は中の小節の合計。
 * 一部だけ比べた区間、お手本のノートが無い区間、以前の記録 (小節ごとの結果が無い)、構成が無いときの区切り。
 */
import { describe, it, expect } from 'vitest';
import type { PianoNote } from '../lib/engine';
import type { SongChart } from '../lib/chart';
import type { BarStat, LearnAttempt } from '../lib/learn-history';
import {
    barResults, barsText, cellLabel, cellProgress, cellStateText, cellText, hasAttempts, lastReferenceBar, levelOf, mapRow, mapSections,
    ratePercent, referenceBarCounts, sectionLoop, sectionName, type MapSection,
} from '../lib/practice-map';
import { MAX_LOOP_BARS, secondsToBars, secondsToLoop } from '../lib/practice';

const n = (step: number, note = 'C', octave = 2): PianoNote => ({ note, octave, step, length: 2 });
const PER = 16;
const grid = { bpm: 120, beatsPerBar: 4, offsetSec: 0.75 };
/** 1 小節 = 2 秒。構成は、小節の番号で作る。 */
const sec = (bar: number) => 0.75 + (bar - 1) * 2;
const chartSection = (id: string, label: string | null, start: number, end: number, extra: Partial<SongChart['sections'][number]> = {}) => ({
    id, label, suggested_label: null, suggested_confidence: 0, start_bar: start, end_bar: end, start_sec: sec(start), end_sec: sec(end + 1),
    repeat_group: 'A', features: { rms_db: -12, onset_density: 2 }, ...extra,
});
const section = (startBar: number, endBar: number, name = 'サビ', fromChart = true): MapSection => ({ id: `s${startBar}`, name, startBar, endBar, fromChart });

/** お手本: 1〜4 小節に 2 ノートずつ、6 小節に 4 ノート (5 小節は空)。 */
const REFERENCE = [n(0), n(8), n(16), n(24), n(32), n(40), n(48), n(56), n(80), n(84), n(88), n(92)];

let seq = 0;
/** 記録を作る。`stats` を渡さなければ、以前の記録 (小節ごとの結果が無い)。 */
function attempt(over: Partial<LearnAttempt> & { stats?: [number, number, number][] } = {}): LearnAttempt {
    const { stats, ...rest } = over;
    const barStats: BarStat[] | null = stats ? stats.map(([bar, referenceCount, matched]) => ({ bar, referenceCount, matched })) : null;
    const referenceCount = barStats ? barStats.reduce((s, b) => s + b.referenceCount, 0) : 0;
    const matched = barStats ? barStats.reduce((s, b) => s + b.matched, 0) : 0;
    return {
        id: ++seq, recordedAt: '2026-11-18T00:00:00Z', referenceId: 1, attemptId: 2, part: 'bass',
        startBar: barStats?.[0]?.bar ?? 1, endBar: barStats?.[barStats.length - 1]?.bar ?? 1,
        referenceCount, matched, matchRate: referenceCount ? Math.round((matched / referenceCount) * 1e4) / 1e4 : 0,
        counts: { missing: 0, pitch: 0, octave: 0, extra: 0, timing: 0, length: 0 }, explanationId: null, barStats, ...rest,
    };
}
const PAIR = { referenceId: 1, attemptId: 2 };
const counts = referenceBarCounts(REFERENCE, PER);

describe('お手本を小節ごとに数える', () => {
    it('ノートが始まる小節で数える。ステップが小数でも、小節は整数', () => {
        expect([...counts]).toEqual([[1, 2], [2, 2], [3, 2], [4, 2], [6, 4]]);
        expect(lastReferenceBar(counts)).toBe(6);
        expect([...referenceBarCounts([n(15.75), n(16), n(31.5), n(47.9)], PER)]).toEqual([[1, 1], [2, 2], [3, 1]]);
        // 小節は、刻みの数 (1/60 ステップの整数) で数える (差分チェックの側と同じ)。三連の位置も、足し算の誤差の付いた値も、取り違えない
        expect([...referenceBarCounts([n(44 / 3), n(12 * (4 / 3)), n(16 + 8 / 3), n(31.9999999999)], PER)]).toEqual([[1, 1], [2, 2], [3, 1]]);
        // 1/60 ステップにそろえると小節の頭になる値 (47.999) は、その小節 (4 小節目) に数える
        expect([...referenceBarCounts([n(47.999)], PER)]).toEqual([[4, 1]]);
        // 3 拍子 (1 小節 12 ステップ)
        expect([...referenceBarCounts([n(11), n(12), n(30)], 12)]).toEqual([[1, 1], [2, 1], [3, 1]]);
        expect(lastReferenceBar(referenceBarCounts([], PER))).toBe(0);
    });
});

describe('小節ごとに、いちばん新しい記録を採る', () => {
    it('同じ小節を 2 回比べたら、新しいほう。新しい記録が掛かっていない小節は、古い記録のまま', () => {
        const history = [
            attempt({ stats: [[1, 2, 0], [2, 2, 1], [3, 2, 2]] }),
            attempt({ stats: [[2, 2, 2], [3, 2, 0]] }),
        ];
        const results = barResults(history, PAIR, counts);
        expect([...results.values()].map((r) => [r.bar, r.matched, r.attempt]))
            .toEqual(expect.arrayContaining([[1, 0, history[0].id], [2, 2, history[1].id], [3, 0, history[1].id]]));
        expect(results.size).toBe(3);
        expect([...results.values()].every((r) => !r.estimated)).toBe(true);
    });

    it('お手本と打ち込みのトラックの両方が合う記録だけを数える (消したトラック・別の組の記録は数えない)', () => {
        const history = [
            attempt({ stats: [[1, 2, 2]], referenceId: 9 }),         // 別のお手本 (分け直す前のパート)
            attempt({ stats: [[1, 2, 2]], attemptId: 1 }),           // お手本のトラック自身と比べた
            attempt({ stats: [[1, 2, 2]], referenceId: null }),      // お手本のトラックを消した
            attempt({ stats: [[1, 2, 2]], attemptId: null }),        // 練習のトラックを消した
        ];
        expect(barResults(history, PAIR, counts).size).toBe(0);
        expect(hasAttempts(history, [PAIR])).toBe(false);
        expect(hasAttempts(history, [{ referenceId: 1, attemptId: null }])).toBe(false);
        expect(hasAttempts([...history, attempt({ stats: [[1, 2, 0]] })], [{ referenceId: 5, attemptId: 6 }, PAIR])).toBe(true);
    });

    it('記録のお手本のノートの数が、いまのお手本と違う小節は使わない (お手本かグリッドが変わる前の記録で、嘘の値を出さない)', () => {
        const history = [
            attempt({ stats: [[1, 2, 1], [2, 2, 1]] }),
            attempt({ stats: [[1, 3, 3], [2, 2, 2], [5, 1, 1]] }),   // 1 小節は数が違う。5 小節は、いまは空
        ];
        const results = barResults(history, PAIR, counts);
        // 1 小節は、数の合う古い記録に戻る。2 小節は新しい記録。5 小節は入らない
        expect([...results.keys()].sort()).toEqual([1, 2]);
        expect(results.get(1)).toMatchObject({ matched: 1, attempt: history[0].id });
        expect(results.get(2)).toMatchObject({ matched: 2, attempt: history[1].id });
    });
});

describe('区間の集計', () => {
    const history = [
        attempt({ stats: [[1, 2, 2], [2, 2, 1], [3, 2, 0]] }),
        attempt({ stats: [[3, 2, 1]] }),
    ];
    const results = barResults(history, PAIR, counts);

    it('区間の値は、中の小節の合計 (合っていた数 ÷ お手本のノートの数)', () => {
        const cell = cellProgress(section(1, 2), counts, results);
        expect(cell).toMatchObject({ state: 'done', percent: 75, level: 'mid', bars: 2, comparedBars: 2, referenceCount: 4, matched: 3, estimated: false });
        expect(cellText(cell)).toBe('75%');
        expect(cellStateText(cell)).toBe('一致 75%');
    });

    it('一部の小節だけ比べた区間は「途中」。値は、比べた小節の一致率', () => {
        // 3〜4 小節のうち、比べたのは 3 小節だけ (新しい記録の 1/2)
        const cell = cellProgress(section(3, 4), counts, results);
        expect(cell).toMatchObject({ state: 'partial', percent: 50, level: 'mid', bars: 2, comparedBars: 1, referenceCount: 2, matched: 1 });
        expect(cellStateText(cell)).toBe('一致 50%（お手本のノートが在る 2 小節のうち、1 小節を比べました）');
        expect(cellLabel('ベース', section(3, 4), cell)).toBe('ベース・サビ（3〜4 小節）: 一致 50%（お手本のノートが在る 2 小節のうち、1 小節を比べました）');
    });

    it('お手本のノートは在るが、どの記録も掛かっていない区間は「まだ比べていません」', () => {
        const cell = cellProgress(section(6, 8), counts, results);
        expect(cell).toMatchObject({ state: 'untouched', percent: null, level: null, bars: 1, comparedBars: 0 });
        expect(cellText(cell)).toBe('');
        expect(cellLabel('ベース', section(6, 8, 'アウトロ'), cell)).toBe('ベース・アウトロ（6〜8 小節）: まだ比べていません');
    });

    it('お手本のノートが無い区間は「お手本のノートがありません」。空の小節は、区間の小節の数に入れない', () => {
        const cell = cellProgress(section(5, 5), counts, results);
        expect(cell).toMatchObject({ state: 'empty', percent: null, bars: 0, comparedBars: 0 });
        expect(cellText(cell)).toBe('–');
        expect(cellLabel('ベース', section(5, 5), cell)).toBe('ベース・サビ（5 小節）: お手本のノートがありません');
        // 4〜5 小節: ノートが在るのは 4 小節だけ。そこを比べていれば、全部比べたことになる
        const withGap = cellProgress(section(4, 5), counts, barResults([attempt({ stats: [[4, 2, 2]] })], PAIR, counts));
        expect(withGap).toMatchObject({ state: 'done', percent: 100, level: 'high', bars: 1, comparedBars: 1 });
    });

    it('段階は 80% から高い、50% から中くらい', () => {
        expect([100, 80, 79, 50, 49, 0].map(levelOf)).toEqual(['high', 'high', 'mid', 'mid', 'low', 'low']);
        expect(ratePercent(1, 8)).toBe(13);
        expect(ratePercent(2, 3)).toBe(67);
        expect(ratePercent(0, 0)).toBe(0);
    });

    it('行をまとめて集計する。練習のトラックがまだ無ければ、どの升も「まだ比べていません」か「ノートがありません」', () => {
        const sections = [section(1, 2), section(3, 4), section(5, 5), section(6, 8)];
        expect(mapRow(history, PAIR, REFERENCE, PER, sections).map((c) => [c.state, c.percent]))
            .toEqual([['done', 75], ['partial', 50], ['empty', null], ['untouched', null]]);
        expect(mapRow(history, { referenceId: 1, attemptId: null }, REFERENCE, PER, sections).map((c) => c.state))
            .toEqual(['untouched', 'untouched', 'empty', 'untouched']);
    });

    it('練習画面で区間を比べた直後の値は、見出しの「一致」と同じ (区間 = 構成の区間のとき)', () => {
        // 1〜2 小節の 4 ノートのうち 1 つ: 見出しは Math.round(0.25 * 100) = 25%
        const cell = cellProgress(section(1, 2), counts, barResults([attempt({ stats: [[1, 2, 1], [2, 2, 0]] })], PAIR, counts));
        expect(cell.percent).toBe(25);
    });
});

describe('以前の記録 (小節ごとの結果が無い)', () => {
    const old = (over: Partial<LearnAttempt>) => attempt({ barStats: null, ...over });

    it('範囲全体の一致率を、範囲の中の小節に一様に当てはめる。区間の値は、その一致率になる', () => {
        // 1〜4 小節 (8 ノート) を 75% で比べた記録
        const history = [old({ startBar: 1, endBar: 4, referenceCount: 8, matched: 6, matchRate: 0.75 })];
        const results = barResults(history, PAIR, counts);
        expect([...results.keys()].sort()).toEqual([1, 2, 3, 4]);
        expect(results.get(2)).toMatchObject({ referenceCount: 2, matched: 1.5, estimated: true });
        const cell = cellProgress(section(1, 2), counts, results);
        expect(cell).toMatchObject({ state: 'done', percent: 75, estimated: true });
        expect(cellStateText(cell)).toBe('一致 75%。以前の記録なので、小節ごとの内訳はありません（比べた範囲全体の一致率です）');
        // 範囲の外は、まだ比べていない
        expect(cellProgress(section(6, 6), counts, results).state).toBe('untouched');
    });

    it('barStats の項目そのものが無い記録も、以前の記録として扱う', () => {
        const bare = old({ startBar: 1, endBar: 2, referenceCount: 4, matched: 2, matchRate: 0.5 });
        delete bare.barStats;
        expect(cellProgress(section(1, 2), counts, barResults([bare], PAIR, counts))).toMatchObject({ percent: 50, estimated: true });
    });

    it('範囲の中のいまのお手本のノートの数が、記録の数と違えば使わない', () => {
        const history = [old({ startBar: 1, endBar: 4, referenceCount: 9, matched: 9, matchRate: 1 })];
        expect(barResults(history, PAIR, counts).size).toBe(0);
        // 範囲の中にノートが無い・範囲や一致率がおかしい記録も使わない
        expect(barResults([old({ startBar: 5, endBar: 5, referenceCount: 0, matchRate: 0 })], PAIR, counts).size).toBe(0);
        expect(barResults([old({ startBar: 4, endBar: 1, referenceCount: 8, matchRate: 0.5 })], PAIR, counts).size).toBe(0);
        expect(barResults([old({ startBar: 1, endBar: 4, referenceCount: 8, matchRate: Number.NaN })], PAIR, counts).size).toBe(0);
    });

    it('新しい記録 (小節ごとの結果つき) が在る小節は、そちらを採る。混じった区間は、以前の記録が入っていると分かる', () => {
        const history = [
            old({ startBar: 1, endBar: 4, referenceCount: 8, matched: 4, matchRate: 0.5 }),
            attempt({ stats: [[1, 2, 2]] }),
        ];
        const results = barResults(history, PAIR, counts);
        expect(results.get(1)).toMatchObject({ matched: 2, estimated: false });
        expect(results.get(2)).toMatchObject({ matched: 1, estimated: true });
        // 1〜2 小節: (2 + 1) / 4 = 75%
        expect(cellProgress(section(1, 2), counts, results)).toMatchObject({ state: 'done', percent: 75, estimated: true });
        // 以前の記録のほうが新しければ、その範囲は以前の記録の値になる
        const reversed = barResults([history[1], history[0]], PAIR, counts);
        expect(reversed.get(1)).toMatchObject({ matched: 1, estimated: true });
    });
});

describe('地図の列', () => {
    it('カルテの構成の区間を、秒からプロジェクトの小節に換える (練習画面の「構成」の段と同じ換え方)', () => {
        const chart = { sections: [
            chartSection('S1', null, 1, 2, { suggested_label: 'verse' }),
            chartSection('S2', 'サビ', 3, 4),
            chartSection('S3', null, 5, 6, { repeat_group: 'C' }),
        ] } as Pick<SongChart, 'sections'>;
        const sections = mapSections(chart, grid, 99);
        expect(sections).toEqual([
            { id: 'S1', name: 'Aメロ？', startBar: 1, endBar: 2, fromChart: true },
            { id: 'S2', name: 'サビ', startBar: 3, endBar: 4, fromChart: true },
            { id: 'S3', name: 'C', startBar: 5, endBar: 6, fromChart: true },
        ]);
        for (const [i, s] of chart.sections.entries()) {
            const loop = secondsToLoop(s.start_sec, s.end_sec, grid);
            expect([sections[i].startBar, sections[i].endBar]).toEqual([loop.startBar, loop.endBar]);
        }
        expect(sectionName(chart.sections[0])).toBe('Aメロ？');
    });

    it('カルテのグリッドとプロジェクトのグリッドが違えば、プロジェクトの小節になる (カルテの小節番号は使わない)', () => {
        // カルテでは 3〜4 小節 (4.75〜8.75 秒)。プロジェクトは 60 BPM・1 拍目が 0 秒なので、1 小節 = 4 秒
        const chart = { sections: [chartSection('S2', 'サビ', 3, 4)] } as Pick<SongChart, 'sections'>;
        const slow = { bpm: 60, beatsPerBar: 4, offsetSec: 0 };
        expect(mapSections(chart, slow, 0)[0]).toMatchObject({ startBar: 2, endBar: 3 });
        expect(secondsToBars(4.75, 8.75, slow)).toEqual({ startBar: 2, endBar: 3 });
    });

    it('構成が無ければ、お手本の最後の小節までを 4 小節ごとに区切る', () => {
        const blocks = mapSections(null, grid, 6);
        expect(blocks).toEqual([
            { id: 'bars-1', name: '1〜4', startBar: 1, endBar: 4, fromChart: false },
            { id: 'bars-5', name: '5〜8', startBar: 5, endBar: 8, fromChart: false },
        ]);
        expect(mapSections({ sections: [] }, grid, 4)).toHaveLength(1);
        expect(mapSections(null, grid, 0)).toEqual([]);
        // 区切りの名前は小節の範囲そのものなので、2 回言わない
        const cell = cellProgress(blocks[1], counts, new Map());
        expect(cellLabel('MIDI', blocks[1], cell)).toBe('MIDI・5〜8 小節: まだ比べていません');
        expect(barsText(blocks[0])).toBe('1〜4 小節');
    });

    it('升を押したときの区間ループは、その区間。上限より長い区間は、はじめのぶんだけ', () => {
        expect(sectionLoop(section(3, 4))).toEqual({ loop: { startBar: 3, endBar: 4, enabled: true }, clamped: false });
        const long = sectionLoop(section(5, 5 + MAX_LOOP_BARS + 7));
        expect(long).toEqual({ loop: { startBar: 5, endBar: 5 + MAX_LOOP_BARS - 1, enabled: true }, clamped: true });
    });
});
