/**
 * bunri DAW — 練習の地図（曲のどこを比べ終えていて、どこが手つかずか）の集計。
 *
 * 学習の記録（lib/learn-history.ts。「お手本と比べる」「比べる」のたびに 1 件）から、パートごと・構成の区間ごとの
 * 一致率を出す。ここは純粋な計算だけ（画面は components/PracticeMap.tsx と、練習画面の「構成」の段）。
 * 事実は信号処理の側が出した数（差分チェックの `bar_stats`）で、LLM は使わない。
 *
 * ## 集計の決まり（docs/coach-diff-design.md「練習の地図」）
 *
 * - **組**: 行は、お手本を持つパートのトラック。数える記録は「そのパートがお手本、その練習のトラックが打ち込み」の
 *   記録だけ（`referenceId` と `attemptId` の両方が合うもの）。トラックを消した・パートを分け直したあとの
 *   古い記録は、ID が合わないので数えない
 * - **小節**: 小節ごとに、その小節を含む、いちばん新しい記録の結果を採る（記録は古い順に並んでいる）。
 *   記録が持つその小節のお手本のノートの数が、いまのお手本と違えば、その記録は使わない
 *   （お手本かグリッドが変わったあとの古い記録で、嘘の値を出さない）
 * - **以前の記録**（小節ごとの結果を持たない）: 範囲全体の一致率を、範囲の中の小節に一様に当てはめる
 *   （小節の合っていた数 = 一致率 × その小節のお手本のノートの数。`estimated`）。範囲の中のいまのお手本のノートの数が、
 *   記録の数と違えば使わない
 * - **区間**: 中の小節の合計（合っていた数 ÷ お手本のノートの数）。比べていない小節は、合計に入れない
 *   （区間の一部だけを比べたときの値は、比べたところの一致率。練習画面の「一致」と同じ数になる）
 * - **状態**: `empty`（お手本のノートが無い）/ `untouched`（お手本のノートは在るが、どの記録も掛かっていない）/
 *   `partial`（お手本のノートが在る小節の一部だけを比べた）/ `done`（全部を比べた）
 * - **列**: カルテの構成の区間を、秒からプロジェクトの小節に換える（練習画面の「構成」の段と同じ `secondsToBars`）。
 *   構成が無ければ（自由に作った・カルテの無いお手本）、4 小節ごとに区切る
 *
 * ステップは小数になりうる。小節は、刻みの数（1/60 ステップの整数。lib/grid.ts の `toTicks`）で数えた
 * 「位置 ÷ 1 小節」の切り捨て + 1（差分チェックの側と同じ）。
 */
import { SECTION_LABEL_JA, type SongChart } from './chart';
import type { PianoNote } from './engine';
import { STEP_UNITS, toTicks, type ProjectGrid } from './grid';
import type { LearnAttempt } from './learn-history';
import { clampLoop, secondsToBars, type PracticeLoop } from './practice';

/** 構成が無いときの、区切りの長さ（小節）。 */
export const FALLBACK_SECTION_BARS = 4;

/** 一致率の段階の境目（%）。80% から「高い」、50% から「中くらい」、それより下は「低い」。 */
export const LEVEL_HIGH = 80;
export const LEVEL_MID = 50;

/** 地図の列（構成の区間 1 つ。構成が無ければ 4 小節の区切り）。小節はプロジェクトのグリッドで、どちらも含む。 */
export interface MapSection {
    /** 列の鍵（カルテの区間の ID。区切りなら `bars-1` のように最初の小節） */
    id: string;
    /** 画面に出す名前（「サビ」「Aメロ？」。区切りなら「1〜4」） */
    name: string;
    startBar: number;
    endBar: number;
    /** カルテの構成の区間か（4 小節ごとの区切りなら false） */
    fromChart: boolean;
}

/** 小節 1 つの結果（お手本のノートが在る小節だけ）。 */
export interface BarResult {
    bar: number;
    /** その小節のお手本のノートの数（いまのお手本） */
    referenceCount: number;
    /** 合っていた数。以前の記録を当てはめたときは小数になる */
    matched: number;
    /** 以前の記録（小節ごとの結果を持たない）の、範囲全体の一致率を当てはめた値か */
    estimated: boolean;
    /** 採った記録の番号 */
    attempt: number;
}

/** 升の状態。 */
export type CellState = 'empty' | 'untouched' | 'partial' | 'done';

/** 一致率の段階（色としるしを変える）。 */
export type CellLevel = 'high' | 'mid' | 'low';

/** 升 1 つ（パート × 区間）の集計。 */
export interface CellProgress {
    state: CellState;
    /** 一致率（%。整数）。比べた小節が無ければ null */
    percent: number | null;
    /** 一致率の段階。比べた小節が無ければ null */
    level: CellLevel | null;
    /** 区間の中の、お手本のノートが在る小節の数 */
    bars: number;
    /** そのうち、比べた小節の数 */
    comparedBars: number;
    /** 比べた小節の、お手本のノートの数 */
    referenceCount: number;
    /** そのうち、合っていた数（以前の記録が混じると小数になる） */
    matched: number;
    /** 以前の記録（小節ごとの内訳が無い）を当てはめた小節が在るか */
    estimated: boolean;
}

/** 構成の区間の名前（確定した名前、無ければ提案に「？」、それも無ければ記号）。練習画面の「構成」の段と同じ。 */
export function sectionName(section: { label: string | null; suggested_label: string | null; repeat_group: string }): string {
    if (section.label) return section.label;
    if (section.suggested_label) return `${SECTION_LABEL_JA[section.suggested_label] ?? section.suggested_label}？`;
    return section.repeat_group;
}

/** ステップが何小節目か（1 始まり）。ステップが小数でも、小節は整数。刻みの数（1/60 ステップの整数）で数える。 */
function barOf(step: number, per: number): number {
    return Math.floor(toTicks(step) / (per * STEP_UNITS)) + 1;
}

/** お手本のノートを、小節ごとに数える（小節 → その小節で始まるノートの数。1 小節目より前のノートは数えない）。 */
export function referenceBarCounts(notes: readonly Pick<PianoNote, 'step'>[], per: number): Map<number, number> {
    const counts = new Map<number, number>();
    for (const n of notes) {
        const bar = barOf(n.step, per);
        if (bar >= 1) counts.set(bar, (counts.get(bar) ?? 0) + 1);
    }
    return counts;
}

/** お手本のノートが在る、最後の小節（無ければ 0）。 */
export function lastReferenceBar(counts: ReadonlyMap<number, number>): number {
    let last = 0;
    for (const bar of counts.keys()) last = Math.max(last, bar);
    return last;
}

/**
 * 地図の列を決める。カルテに構成が在れば、その区間（秒からプロジェクトの小節に換える）。
 * 無ければ、1 小節目から `lastBar` までを 4 小節ごとに区切る。
 *
 * @param chart - カルテ（無ければ null）
 * @param grid - プロジェクトのグリッド
 * @param lastBar - お手本のノートが在る最後の小節（構成が無いときの、区切りの終わり）
 */
export function mapSections(chart: Pick<SongChart, 'sections'> | null, grid: ProjectGrid, lastBar: number): MapSection[] {
    if (chart && chart.sections.length > 0) {
        return chart.sections.map((s) => ({
            id: s.id, name: sectionName(s), ...secondsToBars(s.start_sec, s.end_sec, grid), fromChart: true,
        }));
    }
    const out: MapSection[] = [];
    for (let start = 1; start <= lastBar; start += FALLBACK_SECTION_BARS) {
        const end = start + FALLBACK_SECTION_BARS - 1;
        out.push({ id: `bars-${start}`, name: `${start}〜${end}`, startBar: start, endBar: end, fromChart: false });
    }
    return out;
}

/**
 * 小節ごとに、その小節を含む、いちばん新しい記録の結果を採る。
 *
 * @param history - 学習の記録（古い順）
 * @param pair - お手本のトラックと、打ち込みのトラック（両方が合う記録だけを数える）
 * @param counts - いまのお手本の、小節ごとのノートの数（`referenceBarCounts`）
 * @returns 小節 → 結果。どの記録も掛かっていない小節は入らない
 */
export function barResults(
    history: readonly LearnAttempt[], pair: { referenceId: number; attemptId: number }, counts: ReadonlyMap<number, number>,
): Map<number, BarResult> {
    const out = new Map<number, BarResult>();
    for (let i = history.length - 1; i >= 0; i--) {
        const a = history[i];
        if (a.referenceId !== pair.referenceId || a.attemptId !== pair.attemptId) continue;
        if (Array.isArray(a.barStats)) {
            for (const stat of a.barStats) {
                // お手本のノートの数が、いまのお手本と違う小節は使わない (お手本かグリッドが変わる前の記録)
                if (out.has(stat.bar) || counts.get(stat.bar) !== stat.referenceCount) continue;
                out.set(stat.bar, { bar: stat.bar, referenceCount: stat.referenceCount, matched: stat.matched, estimated: false, attempt: a.id });
            }
            continue;
        }
        // 以前の記録: 範囲全体の一致率しか分からない。範囲の中の小節に、一様に当てはめる
        if (!(a.endBar >= a.startBar) || !(a.matchRate >= 0 && a.matchRate <= 1)) continue;
        const inRange: [number, number][] = [];
        let total = 0;
        for (const [bar, count] of counts) {
            if (bar < a.startBar || bar > a.endBar) continue;
            inRange.push([bar, count]);
            total += count;
        }
        if (total === 0 || total !== a.referenceCount) continue;
        for (const [bar, count] of inRange) {
            if (!out.has(bar)) out.set(bar, { bar, referenceCount: count, matched: a.matchRate * count, estimated: true, attempt: a.id });
        }
    }
    return out;
}

/** 一致率（0〜1）を、差分チェックの `accuracy` と同じ桁（小数 4 桁）に丸めてから、画面の整数の % にする。 */
export function ratePercent(matched: number, referenceCount: number): number {
    if (referenceCount <= 0) return 0;
    const rate = Math.round((matched / referenceCount) * 1e4) / 1e4;
    return Math.round(rate * 100);
}

/** 一致率（%）の段階。 */
export function levelOf(percent: number): CellLevel {
    return percent >= LEVEL_HIGH ? 'high' : percent >= LEVEL_MID ? 'mid' : 'low';
}

/** 区間 1 つの集計（中の小節の合計）。 */
export function cellProgress(
    section: Pick<MapSection, 'startBar' | 'endBar'>, counts: ReadonlyMap<number, number>, results: ReadonlyMap<number, BarResult>,
): CellProgress {
    let bars = 0, comparedBars = 0, referenceCount = 0, matched = 0, estimated = false;
    for (const [bar, count] of counts) {
        if (bar < section.startBar || bar > section.endBar || count <= 0) continue;
        bars++;
        const r = results.get(bar);
        if (!r) continue;
        comparedBars++;
        referenceCount += r.referenceCount;
        matched += r.matched;
        if (r.estimated) estimated = true;
    }
    const state: CellState = bars === 0 ? 'empty' : comparedBars === 0 ? 'untouched' : comparedBars < bars ? 'partial' : 'done';
    const percent = comparedBars > 0 ? ratePercent(matched, referenceCount) : null;
    return { state, percent, level: percent === null ? null : levelOf(percent), bars, comparedBars, referenceCount, matched, estimated };
}

/**
 * パート 1 つぶんの行（区間ごとの升）を集計する。
 *
 * @param history - 学習の記録（古い順）
 * @param pair - お手本のトラックと、打ち込みのトラック。打ち込みのトラックがまだ無ければ（練習のトラックを作る前）null
 * @param reference - いまのお手本のノート
 * @param per - 1 小節のステップ数
 * @param sections - 地図の列
 */
export function mapRow(
    history: readonly LearnAttempt[], pair: { referenceId: number; attemptId: number | null },
    reference: readonly Pick<PianoNote, 'step'>[], per: number, sections: readonly MapSection[],
): CellProgress[] {
    const counts = referenceBarCounts(reference, per);
    const results = pair.attemptId === null
        ? new Map<number, BarResult>()
        : barResults(history, { referenceId: pair.referenceId, attemptId: pair.attemptId }, counts);
    return sections.map((s) => cellProgress(s, counts, results));
}

/** その組の記録が 1 件でも在るか（地図の空の状態を決める）。 */
export function hasAttempts(history: readonly LearnAttempt[], pairs: readonly { referenceId: number; attemptId: number | null }[]): boolean {
    return history.some((a) => pairs.some((p) => p.attemptId !== null && a.referenceId === p.referenceId && a.attemptId === p.attemptId));
}

/** 区間の小節の範囲の文（「17〜24 小節」「5 小節」）。 */
export function barsText(section: Pick<MapSection, 'startBar' | 'endBar'>): string {
    return section.startBar === section.endBar ? `${section.startBar} 小節` : `${section.startBar}〜${section.endBar} 小節`;
}

/** 升の状態の文（「一致 72%（お手本のノートが在る 8 小節のうち、6 小節を比べました）」）。 */
export function cellStateText(cell: CellProgress): string {
    if (cell.state === 'empty') return 'お手本のノートがありません';
    if (cell.state === 'untouched') return 'まだ比べていません';
    const head = `一致 ${cell.percent}%`;
    const part = cell.state === 'partial' ? `（お手本のノートが在る ${cell.bars} 小節のうち、${cell.comparedBars} 小節を比べました）` : '';
    const old = cell.estimated ? '。以前の記録なので、小節ごとの内訳はありません（比べた範囲全体の一致率です）' : '';
    return head + part + old;
}

/** 升の読み上げの名前と説明（「ベース・サビ（17〜24 小節）: 一致 72%（…）」）。 */
export function cellLabel(partName: string, section: MapSection, cell: CellProgress): string {
    // 4 小節ごとの区切りは、名前が小節の範囲そのものなので、2 回言わない
    const where = section.fromChart ? `${section.name}（${barsText(section)}）` : barsText(section);
    return `${partName}・${where}: ${cellStateText(cell)}`;
}

/** 升の中に出す短い文字（色だけに頼らないための数字としるし）。未着手は空。 */
export function cellText(cell: CellProgress): string {
    if (cell.state === 'empty') return '–';
    if (cell.state === 'untouched') return '';
    return `${cell.percent}%`;
}

/**
 * 升を押したときの区間ループ（その区間。長さは区間ループの上限まで）。
 * `clamped` は、区間が上限より長くて、はじめのぶんだけを区間にしたか。
 */
export function sectionLoop(section: Pick<MapSection, 'startBar' | 'endBar'>): { loop: PracticeLoop; clamped: boolean } {
    const loop = clampLoop({ startBar: section.startBar, endBar: section.endBar, enabled: true });
    return { loop, clamped: loop.endBar < section.endBar };
}
