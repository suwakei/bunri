/**
 * bunri DAW — 学習の記録（差分チェックで比べた結果の履歴）。
 *
 * 「お手本と比べる」を押すたびに、1 件記録する。何時に、どの範囲（小節）を、どれだけ合っていたか、
 * 違いの種類ごとの件数、Claude の説明があればその鍵。記録はプロジェクト（`.bunri`）に入る
 * （置き場を決めた理由は docs/coach-diff-design.md「学習の記録」）。
 *
 * ## 一致率の決まり（練習画面もこれに合わせる）
 *
 * 一致率 = 範囲の中のお手本のノートのうち、打ち込みと合っていたノートの数 ÷ 範囲の中のお手本のノートの数。
 * 「合っていた」は差分チェックと同じ: 同じ高さで、位置のずれが許容（16 分音符 2 個）以内。長さの違いと、
 * 許容内の位置のずれは、合っている側に数える（backend/coach_diff.py の `summary.accuracy` と同じ値）。
 * 範囲で比べるとき（練習画面のループ）は、範囲の中のノートだけを差分チェックに渡し、その `accuracy` を使う。
 *
 * 練習画面（「一致 72% ▲前回 +8%」）は `useMatchSummary(練習のトラックの ID)` か、`matchSummary` を使う。
 */
import { useDaw } from './store';
import type { DiffResult, IssueKind } from './coach';
import type { PianoNote } from './engine';

/** 差分の種類（件数を持つ順）。 */
export const HISTORY_KINDS: IssueKind[] = ['missing', 'pitch', 'octave', 'extra', 'timing', 'length'];

/** 記録 1 件。 */
export interface LearnAttempt {
    /** 記録の番号（この画面を開いているあいだだけ一意） */
    id: number;
    /** 比べた時刻（ISO 8601） */
    recordedAt: string;
    /** お手本のトラックの ID（読み込み直すと新しい ID に付け替える。トラックを消していれば null） */
    referenceId: number | null;
    /** 打ち込みのトラックの ID（練習のトラック） */
    attemptId: number | null;
    /** パートの名前（`bass` など。トラックを消しても、どのパートの記録か分かるように） */
    part: string | null;
    /** 比べた範囲の最初の小節（1 始まり） */
    startBar: number;
    /** 比べた範囲の最後の小節（その小節を含む） */
    endBar: number;
    /** 範囲の中のお手本のノートの数 */
    referenceCount: number;
    /** そのうち、合っていたノートの数 */
    matched: number;
    /** 一致率（0〜1。`matched / referenceCount`） */
    matchRate: number;
    /** 違いの種類ごとの件数 */
    counts: Record<IssueKind, number>;
    /** Claude の説明の鍵（説明を作った・保存済みの説明を出したとき。決まった文や、説明が無いときは null） */
    explanationId: string | null;
}

/** 記録を作るときに渡すもの。 */
export interface AttemptInput {
    referenceId: number;
    attemptId: number;
    part: string | null;
    /** 比べたお手本のノート（範囲の指定が無いとき、ここから範囲を決める） */
    reference: PianoNote[];
    stepsPerBar: number;
    /** 比べた範囲（練習画面のループなど）。無ければお手本のノートの最初から最後まで */
    range?: { startBar: number; endBar: number };
    /** 比べた時刻（テスト用。無ければいま） */
    now?: Date;
}

/** 一致率（0〜1）。差分チェックの `summary.accuracy` と同じ（上の「一致率の決まり」）。 */
export function matchRateOf(result: DiffResult): number {
    return result.summary.accuracy;
}

/** お手本のノートの範囲（小節。1 始まり、最後の小節を含む）。ノートが無ければ 1〜1。 */
export function barRangeOf(notes: PianoNote[], stepsPerBar: number): { startBar: number; endBar: number } {
    if (notes.length === 0) return { startBar: 1, endBar: 1 };
    let first = Infinity, last = -Infinity;
    for (const n of notes) {
        first = Math.min(first, n.step);
        last = Math.max(last, n.step);
    }
    return { startBar: Math.floor(first / stepsPerBar) + 1, endBar: Math.floor(last / stepsPerBar) + 1 };
}

/** 差分チェックの結果から、記録 1 件（番号はまだ付けない）を作る。 */
export function attemptFromDiff(result: DiffResult, input: AttemptInput): Omit<LearnAttempt, 'id'> {
    const s = result.summary;
    const range = input.range ?? barRangeOf(input.reference, input.stepsPerBar);
    const counts = {} as Record<IssueKind, number>;
    for (const kind of HISTORY_KINDS) counts[kind] = s[kind] ?? 0;
    return {
        recordedAt: (input.now ?? new Date()).toISOString(),
        referenceId: input.referenceId,
        attemptId: input.attemptId,
        part: input.part,
        startBar: range.startBar,
        endBar: range.endBar,
        referenceCount: s.reference_count,
        matched: Math.round(s.accuracy * s.reference_count),
        matchRate: matchRateOf(result),
        counts,
        explanationId: null,
    };
}

/**
 * ある打ち込みのトラック（とお手本）の記録を、古い順に返す。
 * @param range - 渡すと、同じ範囲で比べた記録だけにする（ループの範囲ごとに「前回」と比べるため）
 */
export function attemptsFor(
    history: readonly LearnAttempt[], attemptId: number, referenceId?: number | null,
    range?: { startBar: number; endBar: number },
): LearnAttempt[] {
    return history.filter(a => a.attemptId === attemptId
        && (referenceId === undefined || referenceId === null || a.referenceId === referenceId)
        && (!range || (a.startBar === range.startBar && a.endBar === range.endBar)));
}

/** 一致率を、画面に出す整数の % にする。 */
export function percentOf(rate: number): number {
    return Math.round(rate * 100);
}

/** 練習画面と差分の段に出す、いまの一致率と前回との差。 */
export interface MatchSummary {
    /** 最後に比べたときの一致率（%） */
    percent: number;
    /** その前に比べたときの一致率（%）。1 回しか比べていなければ null */
    previousPercent: number | null;
    /** 前回との差（% の差。+8 なら 8 ポイント上がった）。1 回目なら null */
    deltaPercent: number | null;
    /** いちばん良かった一致率（%） */
    bestPercent: number;
    /** 比べた回数 */
    attempts: number;
    /** 最後の記録 */
    latest: LearnAttempt;
}

/** 記録から、いまの一致率と前回との差を出す（記録が無ければ null）。 */
export function matchSummary(
    history: readonly LearnAttempt[], attemptId: number, referenceId?: number | null,
    range?: { startBar: number; endBar: number },
): MatchSummary | null {
    const list = attemptsFor(history, attemptId, referenceId, range);
    if (list.length === 0) return null;
    const latest = list[list.length - 1];
    const previous = list.length > 1 ? list[list.length - 2] : null;
    const percent = percentOf(latest.matchRate);
    const previousPercent = previous ? percentOf(previous.matchRate) : null;
    return {
        percent,
        previousPercent,
        deltaPercent: previousPercent === null ? null : percent - previousPercent,
        bestPercent: Math.max(...list.map(a => percentOf(a.matchRate))),
        attempts: list.length,
        latest,
    };
}

/** 前回との差を「+8%」「−3%」「±0%」の形にする。 */
export function formatDelta(delta: number): string {
    if (delta > 0) return `+${delta}%`;
    if (delta < 0) return `−${Math.abs(delta)}%`;
    return '±0%';
}

/** 前回との差を、画面の文にする（「前回より +8%」）。1 回目なら「はじめての記録」。 */
export function deltaText(summary: MatchSummary): string {
    return summary.deltaPercent === null ? 'はじめての記録' : `前回より ${formatDelta(summary.deltaPercent)}`;
}

/**
 * 練習画面などが使う、いまの一致率と前回との差（記録が無ければ null）。記録が増えると描き直される。
 * @param attemptId - 打ち込みのトラック（練習のトラック）の ID
 * @param referenceId - お手本のトラックの ID（省略すると、どのお手本と比べた記録も数える）
 * @param range - 比べた範囲（渡すと、同じ範囲の記録だけ）
 */
export function useMatchSummary(
    attemptId: number | null | undefined, referenceId?: number | null, range?: { startBar: number; endBar: number },
): MatchSummary | null {
    const { learnHistory } = useDaw();
    if (attemptId === null || attemptId === undefined) return null;
    return matchSummary(learnHistory, attemptId, referenceId, range);
}
