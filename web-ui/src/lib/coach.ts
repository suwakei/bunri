/**
 * bunri DAW — 差分コーチ（第3層）の型と API 呼び出し。
 *
 * お手本（原曲を採譜したノート）と、利用者の打ち込みの差分を受け取り、画面に出す文にする。
 * 差分は信号処理側が機械的に出す事実で、LLM は使っていない（backend/coach_diff.py）。
 * ここでの文も決まった型どおりに組み立てる。
 *
 * 差分の説明（言語化。backend/coach_explain.py）は Claude を使う。説明が持てるのは文と、指摘の ID・小節だけ
 * （音符は出さない）。費用まわりの仕組み（保存・1 日の上限・使用量）は再現ガイドと共通。
 */
import { apiFetch, errorDetail } from './api';
import type { PianoNote } from './engine';
import { GuideRequestError, toError, type GuideToday, type GuideUsage } from './guide';

/** 差分の種類。 */
export type IssueKind = 'missing' | 'pitch' | 'octave' | 'extra' | 'timing' | 'length';

/** 指摘 1 件。 */
export interface DiffIssue {
    kind: IssueKind;
    /** 小節（1 始まり） */
    bar: number;
    /** 拍（1 始まり） */
    beat: number;
    /** お手本のノート。余分なノートのときは null。 */
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
    pitch: '高さの違い',
    octave: 'オクターブ違い',
    extra: '余分なノート',
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
    // 理由の文は errorDetail が作る (状態コードや生の JSON を、そのまま画面に出さない)
    if (!resp.ok) throw new Error('お手本と比べられませんでした。' + await errorDetail(resp));
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

// ---- 差分の説明（言語化） ----

/** 説明の点が指す場所。指摘を指すもの（`issue_id` が在る）と、小節だけを指すもの。 */
export interface ExplanationRef {
    /** 指摘の ID（`i1` `i2` …。`/api/coach/diff` の `bars[].issues[]` を上から数えた番号） */
    issue_id: string | null;
    bar: number;
    beat: number | null;
    kind: IssueKind | null;
}

/** 見直すとよい点 1 つ。 */
export interface ExplanationPoint {
    title: string;
    /** どんな傾向の違いか */
    observation: string;
    /** なぜと考えられるか（推測） */
    cause: string;
    /** どこを、何と見比べて直すか */
    fix: string;
    refs: ExplanationRef[];
}

/** 差分の説明。 */
export interface Explanation {
    summary: string;
    points: ExplanationPoint[];
    next_step: string;
    next_step_bar: number | null;
    /** 事実に無い場所を指していて落とした参照の数 */
    dropped_refs: number;
    /** 事実と結び付けられず落とした点の数 */
    dropped_points: number;
    /** 説明文に出てきたが、差分の結果に無い音名・コード名・小節番号 */
    unverified_terms: string[];
    /** 決まった文に差し替えた欄の名前（`summary` / `next_step`） */
    replaced: string[];
}

/** `POST /api/coach/explain` のレスポンス。 */
export interface ExplanationResponse {
    explanation: Explanation;
    /** claude: Claude が作った / rule: Claude に頼むまでもないときの決まった文（費用 0） */
    source: 'claude' | 'rule';
    /** 決まった文の理由（rule のとき）。no_diff / no_attempt / few_notes / few_issues */
    reason: 'no_diff' | 'no_attempt' | 'few_notes' | 'few_issues' | null;
    model: string | null;
    usage: GuideUsage;
    cost_usd?: number | null;
    duration_sec?: number | null;
    created_at?: string | null;
    /** 保存済みの説明を返したとき true（Claude は呼んでいない） */
    cached: boolean;
    /** 材料の要約（指摘の全件数と、Claude に渡した件数） */
    input?: { issues: number; issues_sent: number; chart_context: string };
    today?: GuideToday;
}

/** `POST /api/coach/explain/saved` のレスポンス。返せる説明が無ければ `saved` が false。 */
export type SavedExplanationResponse =
    | ({ saved: true } & ExplanationResponse)
    | { saved: false; today?: GuideToday };

/** 説明の材料（差分チェックと同じノートと、同じ曲のカルテ）。 */
export interface ExplainRequest {
    reference: PianoNote[];
    attempt: PianoNote[];
    steps_per_bar: number;
    /** お手本と同じ曲のカルテ。付けるとキー（と、bpm も在ればその場のコード）を説明の材料に足す */
    chart_id?: string;
    /** お手本を採譜したときのテンポ */
    bpm?: number;
    /** ピアノロールのステップ 0 の位置（秒） */
    grid_offset_sec?: number;
}

/** 失敗のときの文の頭（理由が取れなかったとき）。 */
const EXPLAIN_FAILED = '説明を作れませんでした。';

/**
 * 差分の説明を作る。同じ材料の説明が保存済みなら、Claude を呼ばずにそれが返る。
 * 違いが無い・少ないときは、Claude を呼ばずに決まった文が返る（`source: 'rule'`）。
 *
 * @param request - 差分チェックと同じノートと、カルテ
 * @param regenerate - true なら、保存済みが在っても作り直す（Claude を呼ぶので費用がかかる）
 * @throws {GuideRequestError} 作れなかった場合（`code` で理由を出し分ける。再現ガイドと同じ種類）
 */
export async function requestExplanation(request: ExplainRequest, regenerate = false): Promise<ExplanationResponse> {
    const resp = await apiFetch('/api/coach/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(regenerate ? { ...request, regenerate: true } : request),
    });
    if (!resp.ok) throw await toError(resp, EXPLAIN_FAILED);
    return (await resp.json()) as ExplanationResponse;
}

/**
 * Claude を呼ばずに返せる説明（保存済み、または決まった文）を取得する。費用はかからない。
 *
 * @param request - 差分チェックと同じノートと、カルテ
 * @throws {GuideRequestError} 取得できなかった場合
 */
export async function fetchSavedExplanation(request: ExplainRequest): Promise<SavedExplanationResponse> {
    const resp = await apiFetch('/api/coach/explain/saved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    });
    if (!resp.ok) throw await toError(resp, EXPLAIN_FAILED);
    return (await resp.json()) as SavedExplanationResponse;
}

export { GuideRequestError as ExplainRequestError };

/**
 * 指摘の ID（`i1` `i2` …）から指摘を引く表を作る。ID は `bars[].issues[]` を上から数えた番号
 * （backend/coach_explain.py の `build_facts` と同じ数え方）。
 */
export function issuesById(result: DiffResult): Map<string, DiffIssue> {
    const map = new Map<string, DiffIssue>();
    for (const bar of result.bars) for (const issue of bar.issues) map.set(`i${map.size + 1}`, issue);
    return map;
}

/** 説明の参照を、画面に出す短い文にする。例: 「2 小節 3 拍目（抜け）」「5 小節」 */
export function explanationRefLabel(ref: ExplanationRef): string {
    const where = ref.beat !== null ? `${ref.bar} 小節 ${ref.beat} 拍目` : `${ref.bar} 小節`;
    return ref.kind ? `${where}（${KIND_LABEL[ref.kind]}）` : where;
}
