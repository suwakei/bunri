/**
 * bunri DAW — 差分コーチ（第3層）の型と API 呼び出し。
 *
 * お手本（原曲を採譜したノート）と、利用者の打ち込みの差分を受け取り、画面に出す文にする。
 * 差分は信号処理側が機械的に出す事実で、LLM は使っていない（backend/coach_diff.py）。
 * ここでの文も決まった型どおりに組み立てる。
 *
 * 強さ（ベロシティ）の違いは、お手本が MIDI ファイルから読み込んだもののときだけ比べる（`ReferenceSource`）。
 * 音源から採譜したお手本の強さは当てにならないので、比べない（docs/coach-diff-design.md「強さの違い」）。
 * 強さは、位置・高さ・長さの指摘とは別の欄（`DiffResult.velocity`）に、まとまりで言える違いとして届く。
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

/**
 * お手本の出どころ。強さを比べるのは `midi`（MIDI ファイルから読み込んだお手本）のときだけ。
 * `transcription`（音源から採譜したお手本）と、出どころの分からないお手本では、強さに触れない。
 */
export type ReferenceSource = 'midi' | 'transcription';

/** 強さの違いの向き（打ち込みが、お手本より弱い / 強い）。 */
export type VelocityDirection = 'weaker' | 'stronger';

/**
 * まとまりで言える強さの違いの種類。
 * - `overall`: 全体に弱い・強い
 * - `flat`: 強弱が付いていない（打ち込みの強さがほぼ一定で、お手本には幅が在る）
 * - `section`: その小節の範囲が弱い・強い
 * - `accent`: アクセント（お手本で周りより強いノート）が付いていない
 */
export type VelocityFindingKind = 'overall' | 'flat' | 'section' | 'accent';

/** まとまりで言える強さの違い 1 つ。 */
export interface VelocityFinding {
    kind: VelocityFindingKind;
    /** `flat` では null */
    direction: VelocityDirection | null;
    /** 最初の小節と最後の小節（1 始まり、両端を含む） */
    start_bar: number;
    end_bar: number;
    /** 強さの違うノートの数 */
    count: number;
    /** その範囲で比べたノートの数（`accent` では、お手本のアクセントの数） */
    compared: number;
    /** 強さの差（打ち込み − お手本）の中央値 */
    median_diff: number;
    /** 強さの違うノート（`VelocityDiff.notes` の番号） */
    notes: number[];
}

/** 強さが許す幅を超えて違うノートの組。 */
export interface VelocityNote {
    bar: number;
    beat: number;
    /** お手本のノート（強さつき） */
    expected: PianoNote;
    /** 打ち込みのノート（強さつき。強さを持たないノートは `default_velocity`） */
    actual: PianoNote;
    /** 強さの差（打ち込み − お手本） */
    diff: number;
}

/** 強さの範囲。 */
export interface VelocityRange {
    min: number;
    max: number;
    median: number;
}

/** 強さの違い（`/api/coach/diff` の `velocity`）。 */
export interface VelocityDiff {
    /** 許す幅。差がこれ以内なら、同じ強さとして扱う */
    tolerance: number;
    /** 強さを持たないノート（マウスで置いたもの）を比べるのに使った強さ */
    default_velocity: number;
    /** 比べたノートの数（位置と高さが合った組） */
    compared: number;
    /** 許す幅を超えて、打ち込みが弱い・強いノートの数 */
    weaker: number;
    stronger: number;
    /** 比べた打ち込みのうち、強さを持たないノートの数 */
    attempt_unset: number;
    median_diff: number | null;
    reference: VelocityRange | null;
    attempt: VelocityRange | null;
    findings: VelocityFinding[];
    notes: VelocityNote[];
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
    /**
     * 強さの違い。お手本が MIDI ファイルから読み込んだもののときだけ在る。採譜したお手本では null
     * （以前の版が保存した結果には、項目そのものが無い）。
     */
    velocity?: VelocityDiff | null;
}

/** 比べたときのノートと 1 小節のステップ数。 */
export interface ComparedNotes {
    reference: PianoNote[];
    attempt: PianoNote[];
    stepsPerBar: number;
    /** お手本の出どころ（説明も、同じ出どころで頼む）。以前の版が保存したものには無い（強さに触れない） */
    referenceSource?: ReferenceSource;
}

/**
 * 比べた結果ごとの、比べたときのノート。説明は、画面に出ている差分と同じノートで頼む
 * （比べたあとにノートを直していても、説明の指摘の ID が一覧とずれないように）。
 * プロジェクトにも入れ、開き直したときに同じ材料で保存済みの説明を探す（lib/project-file.ts）。
 */
const comparedWith = new WeakMap<DiffResult, ComparedNotes>();

/** 比べた結果に、比べたときのノートを結び付ける。 */
export function rememberCompared(result: DiffResult, compared: ComparedNotes): void {
    comparedWith.set(result, compared);
}

/** 比べた結果の、比べたときのノート（分からなければ undefined）。 */
export function comparedOf(result: DiffResult): ComparedNotes | undefined {
    return comparedWith.get(result);
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
 * @param referenceSource - お手本の出どころ。`midi` のときだけ送り、強さも比べる（ほかは、強さに触れない）
 * @throws 比べられなかった場合（理由つき）
 */
export async function requestDiff(reference: PianoNote[], attempt: PianoNote[], stepsPerBar = 16, referenceSource?: ReferenceSource): Promise<DiffResult> {
    const resp = await apiFetch('/api/coach/diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            reference, attempt, steps_per_bar: stepsPerBar,
            ...(referenceSource === 'midi' ? { reference_source: referenceSource } : {}),
        }),
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

// ---- 強さの違い ----

/** 向きの呼び名。 */
const DIRECTION_LABEL: Record<VelocityDirection, string> = { weaker: '弱い', stronger: '強い' };

/** 小節の範囲の言い方（「3 小節」「3〜4 小節」）。 */
function barsLabel(finding: Pick<VelocityFinding, 'start_bar' | 'end_bar'>): string {
    return finding.start_bar === finding.end_bar ? `${finding.start_bar} 小節` : `${finding.start_bar}〜${finding.end_bar} 小節`;
}

/** 強さの差の、おおよその大きさ（「30 ほど」）。 */
function about(diff: number): string {
    return `${Math.round(Math.abs(diff))} ほど`;
}

/**
 * 強さの違いがあるか（まとまりで言える違いか、許す幅を超えたノートが 1 つでも在る）。
 * 強さを比べていない（採譜したお手本・以前の版の結果）ときは false。
 */
export function hasVelocityDiff(result: Pick<DiffResult, 'velocity'> | null | undefined): boolean {
    const v = result?.velocity;
    return !!v && (v.findings.length > 0 || v.weaker + v.stronger > 0);
}

/**
 * 強さを比べた結果の、1 行のまとめ。
 * 例: 「合った 24 ノートの強さを比べました（お手本より弱い 6 / 強い 2）」
 * 文の終わりの「。」は付けない。
 */
export function velocitySummaryText(velocity: VelocityDiff): string {
    const head = `合った ${velocity.compared} ノートの強さを比べました`;
    const counts = [
        velocity.weaker > 0 ? `お手本より弱い ${velocity.weaker}` : '',
        velocity.stronger > 0 ? `${velocity.weaker > 0 ? '' : 'お手本より'}強い ${velocity.stronger}` : '',
    ].filter(Boolean);
    return counts.length ? `${head}（${counts.join(' / ')}）` : `${head}。どれも、お手本と合っています（差が ${velocity.tolerance} 以内）`;
}

/**
 * まとまりで言える強さの違いを、1 行の文にする。
 * 例: 「3〜4 小節が弱い: 8 ノートのうち 6 ノートが、お手本より弱くなっています（強さの差は 30 ほど）」
 */
export function velocityFindingText(finding: VelocityFinding, velocity: VelocityDiff): string {
    const direction = finding.direction ? DIRECTION_LABEL[finding.direction] : '';
    switch (finding.kind) {
        case 'overall':
            return `全体に${direction}: 合った ${finding.compared} ノートのうち ${finding.count} ノートが、お手本より${direction === '弱い' ? '弱く' : '強く'}なっています（強さの差は ${about(finding.median_diff)}）`;
        case 'section':
            return `${barsLabel(finding)}が${direction}: ${finding.compared} ノートのうち ${finding.count} ノートが、お手本より${direction === '弱い' ? '弱く' : '強く'}なっています（強さの差は ${about(finding.median_diff)}）`;
        case 'accent':
            return `アクセントが付いていません: お手本で周りより強いノート ${finding.compared} 個のうち ${finding.count} 個が、お手本より弱くなっています`;
        case 'flat': {
            const own = velocity.attempt, ref = velocity.reference;
            const mine = own ? (own.min === own.max ? `${own.min} で一定` : `${own.min}〜${own.max} でほぼ一定`) : 'ほぼ一定';
            const theirs = ref ? `${ref.min}〜${ref.max}` : '';
            return `強弱が付いていません: 打ち込みの強さは ${mine}ですが、お手本は ${theirs} の幅があります`;
        }
    }
}

/** ノートの形（強さを除く）。同じ形のノートを探すのに使う。 */
const shapeOf = (n: Pick<PianoNote, 'note' | 'octave' | 'step' | 'length'>) => `${n.note}${n.octave}@${n.step}+${n.length}`;

/**
 * まとまりで言える強さの違いに当たるノートの番号（打ち込み・お手本）。
 * 押したとき、そのノートを選んで光らせる（選ぶと、ピアノロールの上の「強さ」の欄で変えられる）。
 * 同じ形のノートが 2 つ在れば、1 つずつ順に当てる。
 *
 * @param finding - まとまりで言える違い
 * @param velocity - 強さの違い（`finding` を含む結果）
 * @param attempt - 打ち込みのノート（番号は、この並びの番号）
 * @param reference - お手本のノート
 */
export function velocityNotesOf(
    finding: VelocityFinding, velocity: VelocityDiff, attempt: readonly PianoNote[], reference: readonly PianoNote[] = [],
): { own: number[]; ghost: number[] } {
    const taker = (notes: readonly PianoNote[]) => {
        const used = new Set<number>();
        return (target: PianoNote): number => {
            const key = shapeOf(target);
            const index = notes.findIndex((n, i) => !used.has(i) && shapeOf(n) === key);
            if (index >= 0) used.add(index);
            return index;
        };
    };
    const takeOwn = taker(attempt), takeGhost = taker(reference);
    const own: number[] = [], ghost: number[] = [];
    for (const index of finding.notes) {
        const pair = velocity.notes[index];
        if (!pair) continue;
        const o = takeOwn(pair.actual), g = takeGhost(pair.expected);
        if (o >= 0) own.push(o);
        if (g >= 0) ghost.push(g);
    }
    return { own, ghost };
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
    /** 決まった文の理由（rule のとき）。velocity_only は、高さ・位置・長さは合っていて、強さだけが違う */
    reason: 'no_diff' | 'velocity_only' | 'no_attempt' | 'few_notes' | 'few_issues' | null;
    model: string | null;
    usage: GuideUsage;
    cost_usd?: number | null;
    duration_sec?: number | null;
    created_at?: string | null;
    /** 保存済みの説明を返したとき true（Claude は呼んでいない） */
    cached: boolean;
    /** 保存の鍵（Claude の説明のとき。学習の記録が説明を指す識別子。決まった文では null） */
    key?: string | null;
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
    /** お手本の出どころ。`midi` のときだけ付ける（強さの違いも説明の材料に足す） */
    reference_source?: ReferenceSource;
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
