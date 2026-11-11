/**
 * bunri DAW — 差分コーチ（第3層の土台）の型と API 呼び出し。
 *
 * お手本（原曲を採譜したノート）と、利用者の打ち込みの差分を受け取り、画面に出す文にする。
 * 差分は信号処理側が機械的に出す事実で、LLM は使っていない（backend/coach_diff.py）。
 * ここでの文も決まった型どおりに組み立てる。
 */
import { apiFetch } from './api';
import type { PianoNote } from './engine';

/** 差分の種類。 */
export type IssueKind = 'missing' | 'pitch' | 'octave' | 'extra' | 'timing' | 'length';

/** 指摘 1 件。 */
export interface DiffIssue {
    kind: IssueKind;
    /** 小節（1 始まり） */
    bar: number;
    /** 拍（1 始まり） */
    beat: number;
    /** お手本のノート。余分な音のときは null。 */
    expected: PianoNote | null;
    /** 打ち込みのノート。抜けのときは null。 */
    actual: PianoNote | null;
    /** 位置のずれ（16 分音符単位。正なら遅い）。 */
    offset_steps: number | null;
    /** 長さの違い（16 分音符単位。正なら長い）。 */
    length_diff: number | null;
}

/** `/api/coach/diff` のレスポンス。 */
export interface DiffResult {
    summary: {
        reference_count: number;
        attempt_count: number;
        /** 位置も長さも一致した数 */
        exact: number;
        /** お手本のうち、高さと位置が合っていた割合（0〜1） */
        accuracy: number;
    } & Record<IssueKind, number>;
    bars: { bar: number; issues: DiffIssue[] }[];
    /** 指摘が重い順の小節番号（最大 5 つ） */
    worst_bars: number[];
}

/** 種類ごとの短い呼び名。 */
export const KIND_LABEL: Record<IssueKind, string> = {
    missing: '抜け',
    pitch: '音の間違い',
    octave: 'オクターブ違い',
    extra: '余分な音',
    timing: '位置のずれ',
    length: '長さの違い',
};

/**
 * お手本と打ち込みの差分を取る。
 *
 * @param reference - お手本のノート
 * @param attempt - 打ち込みのノート
 * @param stepsPerBar - 1 小節のステップ数（4/4 なら 16）
 * @throws 比べられなかった場合（理由つき）
 */
export async function requestDiff(reference: PianoNote[], attempt: PianoNote[], stepsPerBar = 16): Promise<DiffResult> {
    const resp = await apiFetch('/api/coach/diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, attempt, steps_per_bar: stepsPerBar }),
    });
    if (!resp.ok) {
        let message = `比べられませんでした（${resp.status}）`;
        try {
            const detail = (await resp.json())?.detail;
            if (typeof detail === 'string') message = detail;
        } catch {
            // JSON でない応答。既定の文のままにする
        }
        throw new Error(message);
    }
    return (await resp.json()) as DiffResult;
}

/** ノートを「E4」の形にする。 */
export function noteName(note: PianoNote): string {
    return `${note.note}${note.octave}`;
}

/** 16 分音符 n 個ぶんを、読みやすい長さの言い方にする。 */
function steps(n: number): string {
    const abs = Math.abs(n);
    if (abs % 4 === 0) return `${abs / 4} 拍ぶん`;
    return `16 分音符 ${abs} 個ぶん`;
}

/**
 * 指摘を 1 行の文にする。
 * 例: 「2 小節 3 拍目: E4 が抜けています」
 */
export function issueText(issue: DiffIssue): string {
    const where = `${issue.bar} 小節 ${issue.beat} 拍目`;
    const expected = issue.expected ? noteName(issue.expected) : '';
    const actual = issue.actual ? noteName(issue.actual) : '';
    switch (issue.kind) {
        case 'missing':
            return `${where}: ${expected} が抜けています`;
        case 'extra':
            return `${where}: ${actual} はお手本にありません`;
        case 'octave':
            return `${where}: ${actual} → お手本は ${expected}（オクターブ違い）`;
        case 'pitch':
            return `${where}: ${actual} → お手本は ${expected}`;
        case 'timing':
            return `${where}: ${expected} が${steps(issue.offset_steps ?? 0)}${(issue.offset_steps ?? 0) > 0 ? '遅い' : '早い'}`;
        case 'length':
            return `${where}: ${expected} が${steps(issue.length_diff ?? 0)}${(issue.length_diff ?? 0) > 0 ? '長い' : '短い'}`;
    }
}
