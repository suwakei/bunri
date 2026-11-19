/**
 * bunri DAW — アシスタントのチャットに出すカード（再現ガイド・差分の説明）の形と、組み立て・保存・読み戻し（純粋な関数だけ）。
 *
 * 再現ガイドと差分の説明は、アシスタントのツール（`make_guide` / `explain_diff`。lib/assistant-tools-learn.ts）が作り、
 * 結果をチャットにカードとして出す（Claude には、中身を JSON で返す）。カードの表示は components/AssistantCards.tsx。
 *
 * - カードは、作ったときに場所の名前（「サビ（5〜8 小節）」「2 小節 3 拍目（抜け）」）を決めて持つ。プロジェクトを
 *   開き直したあとや、別の曲のカルテに替わったあとでも、作ったときの名前のまま読める
 * - カードは、プロジェクトの節 `assistant`（版 3）に、会話の並びの 1 つとして入る（lib/assistant-history.ts）。
 *   読み戻すときは、形を確かめ、おかしなカードは読み飛ばす（`cardFromSaved`）
 * - 「これまでの記録」（Claude に渡す、前の会話の要約）には、カード 1 つを 1 行だけ入れる（`cardDigestLine`）。
 *   中身は入れない（読み直すなら `get_guide` / `check_diff`）
 */
import type { SongChart } from './chart';
import type { GuideRef, GuideResponse, GuideStep, GuideUsage } from './guide';
import { refLabel } from './guide';
import {
    explanationRefLabel, issuesById, type DiffResult, type ExplanationRef, type ExplanationResponse, type IssueKind,
} from './coach';

/** 再現ガイドの手順が指す場所（作ったときの名前つき）。 */
export interface CardGuideRef extends GuideRef {
    label: string;
}

/** 再現ガイドのカード。 */
export interface GuideCard {
    card: 'guide';
    /** どのカルテのガイドか（場所へ移動するときに、いまのカルテと同じかを見る） */
    chartId: string;
    /** 絞り込んだセクションの ID。曲全体なら null */
    focus: string | null;
    /** 対象の名前（「曲全体」「サビ（5〜8 小節）」） */
    target: string;
    overview: string;
    steps: (Omit<GuideStep, 'refs'> & { refs: CardGuideRef[] })[];
    cautions: string[];
    /** 説明文に出てきたが、カルテに無い音名・コード名 */
    unverifiedTerms: string[];
    model: string | null;
    createdAt: string | null;
    /** 保存済みのガイドを出した（このときは Claude を呼んでいない） */
    cached: boolean;
    /** 作ったときの概算の費用（USD）。分からなければ null */
    costUsd: number | null;
    usage: GuideUsage | null;
}

/** 差分の説明の点が指す場所（作ったときの名前と、指摘のノートの高さつき）。 */
export interface CardExplanationRef {
    issueId: string | null;
    bar: number;
    beat: number | null;
    kind: IssueKind | null;
    label: string;
    /** 指摘のノートの高さ（ピアノロールを、その高さまでスクロールする）。分からなければ無い */
    pitch?: { note: string; octave: number };
}

/** 差分の説明のカード。 */
export interface ExplanationCard {
    card: 'explanation';
    /** claude: Claude が作った / rule: Claude に頼むまでもないときの決まった文（費用 0） */
    source: 'claude' | 'rule';
    /** 決まった文の理由（rule のとき） */
    reason: string | null;
    /** 比べた打ち込みのトラック（場所へ移動するときに、ピアノロールで開く）と、その名前 */
    attemptId: number;
    referenceId: number;
    trackName: string;
    summary: string;
    points: { title: string; observation: string; cause: string; fix: string; refs: CardExplanationRef[] }[];
    nextStep: string;
    nextStepBar: number | null;
    unverifiedTerms: string[];
    droppedPoints: number;
    /** 指摘の全件数と、Claude に渡した件数 */
    input: { issues: number; issuesSent: number } | null;
    model: string | null;
    createdAt: string | null;
    cached: boolean;
    costUsd: number | null;
    usage: GuideUsage | null;
}

/** チャットに出すカード。 */
export type ChatCard = GuideCard | ExplanationCard;

/** Claude に頼むまでもないとき（決まった文）の、理由の一言。 */
export const RULE_NOTE: Record<string, string> = {
    no_diff: 'お手本と違うところが無いので、Claude は呼んでいません（費用はかかっていません）。',
    velocity_only: '違うのは強さだけで、差分の段の「強さの違い」を読めば足りるので、Claude は呼んでいません（費用はかかっていません）。',
    no_attempt: '打ち込みがまだ無いので、Claude は呼んでいません（費用はかかっていません）。',
    few_notes: 'お手本のノートが少なく傾向を言えないので、Claude は呼んでいません（費用はかかっていません）。',
    few_issues: '違いが少なく一覧を読めば足りるので、Claude は呼んでいません（費用はかかっていません）。',
};

/** 決まった文の理由の一言（知らない理由なら、決まった言い方）。 */
export function ruleNote(reason: string | null): string {
    return RULE_NOTE[reason ?? ''] ?? 'Claude は呼んでいません（費用はかかっていません）。';
}

/**
 * 再現ガイドの応答から、カードを作る。場所の名前は、いまのカルテで決める。
 *
 * @param resp - `POST /api/chart/{id}/guide` の応答
 * @param chart - いまのカルテ
 * @param target - 対象の名前（「曲全体」など）
 */
export function guideCardOf(resp: GuideResponse, chart: SongChart, target: string): GuideCard {
    const guide = resp.guide;
    return {
        card: 'guide',
        chartId: resp.chart_id,
        focus: resp.focus ?? null,
        target,
        overview: guide.overview,
        steps: guide.steps.map((step) => ({ ...step, refs: step.refs.map((ref) => ({ ...ref, label: refLabel(ref, chart) })) })),
        cautions: guide.cautions ?? [],
        unverifiedTerms: guide.unverified_terms ?? [],
        model: resp.model ?? null,
        createdAt: resp.created_at ?? null,
        cached: resp.cached === true,
        costUsd: typeof resp.cost_usd === 'number' ? resp.cost_usd : null,
        usage: resp.usage ?? null,
    };
}

/** 説明の点の参照を、カードの参照にする（指摘が分かれば、そのノートの高さも持つ）。 */
function cardRef(ref: ExplanationRef, issues: Map<string, DiffResult['bars'][number]['issues'][number]>): CardExplanationRef {
    const issue = ref.issue_id ? issues.get(ref.issue_id) : undefined;
    const note = issue?.actual ?? issue?.expected ?? null;
    return {
        issueId: ref.issue_id, bar: ref.bar, beat: ref.beat, kind: ref.kind, label: explanationRefLabel(ref),
        ...(note ? { pitch: { note: note.note, octave: note.octave } } : {}),
    };
}

/**
 * 差分の説明の応答から、カードを作る。
 *
 * @param resp - `POST /api/coach/explain` の応答
 * @param diff - 説明の材料にした差分（指摘の ID から、ノートの高さを引く）
 * @param pair - 比べた組と、打ち込みのトラックの名前
 */
export function explanationCardOf(
    resp: ExplanationResponse, diff: DiffResult, pair: { referenceId: number; attemptId: number; trackName: string },
): ExplanationCard {
    const body = resp.explanation;
    const issues = issuesById(diff);
    return {
        card: 'explanation',
        source: resp.source,
        reason: resp.reason ?? null,
        attemptId: pair.attemptId,
        referenceId: pair.referenceId,
        trackName: pair.trackName,
        summary: body.summary,
        points: (resp.source === 'claude' ? body.points : []).map((point) => ({
            title: point.title, observation: point.observation, cause: point.cause, fix: point.fix,
            refs: point.refs.map((ref) => cardRef(ref, issues)),
        })),
        nextStep: body.next_step,
        nextStepBar: body.next_step_bar ?? null,
        unverifiedTerms: body.unverified_terms ?? [],
        droppedPoints: body.dropped_points ?? 0,
        input: resp.input ? { issues: resp.input.issues, issuesSent: resp.input.issues_sent } : null,
        model: resp.model ?? null,
        createdAt: resp.created_at ?? null,
        cached: resp.cached === true,
        costUsd: typeof resp.cost_usd === 'number' ? resp.cost_usd : null,
        usage: resp.usage ?? null,
    };
}

/** 「これまでの記録」に入れる、カード 1 つぶんの 1 行（中身は入れない）。 */
export function cardDigestLine(card: ChatCard): string {
    if (card.card === 'guide') return `Guide shown: 手順 ${card.steps.length} 個（${card.target}）`;
    if (card.source === 'rule') return `Explanation shown: 決まった文（${card.trackName}）`;
    return `Explanation shown: 点 ${card.points.length} 個（${card.trackName}）`;
}

// ---- 保存した形の読み戻し ----

/** 保存するカード 1 つの大きさの上限（JSON にした文字数）。超えるカードは保存しない。 */
export const MAX_CARD_CHARS = 60_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : []);
const usageOf = (v: unknown): GuideUsage | null => (isObject(v) ? (v as GuideUsage) : null);

const TOPICS = new Set(['grid', 'key', 'chords', 'sections', 'mix', 'general']);
const KINDS = new Set(['missing', 'pitch', 'octave', 'extra', 'timing', 'length']);

/**
 * 保存してあったカードを読む。形がおかしければ null（その 1 つだけを読み飛ばす）。
 *
 * @param value - 保存した値（並びの 1 つの `card`）
 */
export function cardFromSaved(value: unknown): ChatCard | null {
    if (!isObject(value)) return null;
    if (value.card === 'guide') {
        const chartId = strOrNull(value.chartId);
        if (!chartId || typeof value.overview !== 'string' || !Array.isArray(value.steps)) return null;
        return {
            card: 'guide', chartId, focus: strOrNull(value.focus), target: str(value.target, '曲全体'), overview: value.overview,
            steps: list(value.steps).map((step) => ({
                title: str(step.title), body: str(step.body),
                topic: (TOPICS.has(str(step.topic)) ? step.topic : 'general') as GuideStep['topic'],
                refs: list(step.refs).map((ref) => ({
                    section_id: strOrNull(ref.section_id), bar: numOrNull(ref.bar), beat: numOrNull(ref.beat), label: str(ref.label),
                })).filter((ref) => ref.label !== ''),
            })),
            cautions: strings(value.cautions), unverifiedTerms: strings(value.unverifiedTerms),
            model: strOrNull(value.model), createdAt: strOrNull(value.createdAt), cached: value.cached === true,
            costUsd: numOrNull(value.costUsd), usage: usageOf(value.usage),
        };
    }
    if (value.card === 'explanation') {
        const attemptId = numOrNull(value.attemptId), referenceId = numOrNull(value.referenceId);
        if (attemptId === null || referenceId === null || typeof value.summary !== 'string') return null;
        const input = isObject(value.input) && typeof value.input.issues === 'number' && typeof value.input.issuesSent === 'number'
            ? { issues: value.input.issues, issuesSent: value.input.issuesSent } : null;
        return {
            card: 'explanation', source: value.source === 'rule' ? 'rule' : 'claude', reason: strOrNull(value.reason),
            attemptId, referenceId, trackName: str(value.trackName), summary: value.summary,
            points: list(value.points).map((point) => ({
                title: str(point.title), observation: str(point.observation), cause: str(point.cause), fix: str(point.fix),
                refs: list(point.refs).flatMap((ref): CardExplanationRef[] => {
                    const bar = numOrNull(ref.bar);
                    if (bar === null) return [];
                    const pitch = isObject(ref.pitch) && typeof ref.pitch.note === 'string' && typeof ref.pitch.octave === 'number'
                        ? { note: ref.pitch.note, octave: ref.pitch.octave } : undefined;
                    return [{
                        issueId: strOrNull(ref.issueId), bar, beat: numOrNull(ref.beat),
                        kind: KINDS.has(str(ref.kind)) ? (ref.kind as IssueKind) : null,
                        label: str(ref.label, `${bar} 小節`), ...(pitch ? { pitch } : {}),
                    }];
                }),
            })),
            nextStep: str(value.nextStep), nextStepBar: numOrNull(value.nextStepBar),
            unverifiedTerms: strings(value.unverifiedTerms), droppedPoints: numOrNull(value.droppedPoints) ?? 0, input,
            model: strOrNull(value.model), createdAt: strOrNull(value.createdAt), cached: value.cached === true,
            costUsd: numOrNull(value.costUsd), usage: usageOf(value.usage),
        };
    }
    return null;
}

/** カードを保存してよい大きさか。 */
export function cardFits(card: ChatCard): boolean {
    try { return JSON.stringify(card).length <= MAX_CARD_CHARS; } catch { return false; }
}
