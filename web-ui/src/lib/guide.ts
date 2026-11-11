/**
 * bunri DAW — 再現ガイド（第2層）の型と API 呼び出し。
 *
 * 楽曲カルテを Claude に渡し、「こう作れば再現できる」という手順の説明を受け取る。
 * 説明はカルテの読み上げで、音符は含まない（backend/reproduction_guide.py）。
 */
import { apiFetch, invokeDesktop, isDesktop } from './api';
import type { SongChart } from './chart';
import { SECTION_LABEL_JA } from './chart';

/** 手順が指す、カルテ上の場所。セクション全体か、特定の小節（と拍）。 */
export interface GuideRef {
    section_id: string | null;
    bar: number | null;
    beat: number | null;
}

/** 再現の手順 1 つ。 */
export interface GuideStep {
    title: string;
    /** カルテのどの部分の話か。 */
    topic: 'grid' | 'key' | 'chords' | 'sections' | 'mix' | 'general';
    body: string;
    refs: GuideRef[];
}

/** 再現ガイド。 */
export interface Guide {
    overview: string;
    steps: GuideStep[];
    /** 確信度が低い項目・検出できなかった項目についての注意書き。 */
    cautions: string[];
    /** カルテに無い場所を指していて落とした参照の数。 */
    dropped_refs: number;
    /** 説明文に出てきたが、カルテに無い音名・コード名。 */
    unverified_terms: string[];
}

/** `/api/chart/{id}/guide` のレスポンス。 */
export interface GuideResponse {
    chart_id: string;
    focus: string | null;
    guide: Guide;
    model: string;
    usage: Record<string, number | null>;
}

/** `/api/settings/llm` のレスポンス。API キーそのものは含まない。 */
export interface LlmSettings {
    has_key: boolean;
    key_source: 'settings' | 'env' | 'none';
    model: string;
}

/** ガイドを作れなかったときのエラー。`code` で理由を出し分ける。 */
export class GuideRequestError extends Error {
    /** `no_key` / `auth` / `rate_limit` / `network` / `refused` / `truncated` / `api` / `invalid` */
    code: string;

    constructor(message: string, code: string) {
        super(message);
        this.name = 'GuideRequestError';
        this.code = code;
    }

    /** API キーを入れ直せば直る種類のエラーか。 */
    get needsKey(): boolean {
        return this.code === 'no_key' || this.code === 'auth';
    }
}

/** 失敗したレスポンスから、利用者向けの文と種類を取り出す。 */
async function toError(resp: Response): Promise<GuideRequestError> {
    try {
        const body = await resp.json();
        const detail = body?.detail;
        if (detail && typeof detail === 'object') {
            return new GuideRequestError(String(detail.message ?? '失敗しました'), String(detail.code ?? 'api'));
        }
        if (typeof detail === 'string') return new GuideRequestError(detail, 'api');
    } catch {
        // JSON でない応答。下の既定の文にする
    }
    return new GuideRequestError(`再現ガイドを作れませんでした（${resp.status}）`, 'api');
}

/**
 * 再現ガイドを作る。
 *
 * @param chartId - カルテの ID
 * @param focus - 絞り込むセクションの ID。null なら曲全体
 * @throws {GuideRequestError} 作れなかった場合
 */
export async function requestGuide(chartId: string, focus: string | null): Promise<GuideResponse> {
    const body = new FormData();
    body.append('focus', focus ?? '');
    const resp = await apiFetch(`/api/chart/${encodeURIComponent(chartId)}/guide`, { method: 'POST', body });
    if (!resp.ok) throw await toError(resp);
    return (await resp.json()) as GuideResponse;
}

/** LLM の設定の状態を取得する。 */
export async function fetchLlmSettings(): Promise<LlmSettings> {
    const resp = await apiFetch('/api/settings/llm');
    if (!resp.ok) throw await toError(resp);
    return (await resp.json()) as LlmSettings;
}

/**
 * Claude の API キーを設定する。
 *
 * デスクトップ版では、先に OS のキーチェーンへ保存する（次回の起動からも使える）。
 * そのうえで、動いているバックエンドにも渡す（バックエンドはメモリにだけ持つ）。
 * 開発用のブラウザ起動ではバックエンドに渡すだけなので、バックエンドを再起動すると消える。
 *
 * @param key - API キー
 */
export async function saveApiKey(key: string): Promise<LlmSettings> {
    if (isDesktop()) await invokeDesktop<void>('save_api_key', { key });
    const body = new FormData();
    body.append('key', key);
    const resp = await apiFetch('/api/settings/anthropic-key', { method: 'POST', body });
    if (!resp.ok) throw await toError(resp);
    return (await resp.json()) as LlmSettings;
}

/** 設定した API キーを消す（デスクトップ版ではキーチェーンからも消す）。 */
export async function deleteApiKey(): Promise<LlmSettings> {
    if (isDesktop()) await invokeDesktop<void>('delete_api_key');
    const resp = await apiFetch('/api/settings/anthropic-key', { method: 'DELETE' });
    if (!resp.ok) throw await toError(resp);
    return (await resp.json()) as LlmSettings;
}

/**
 * 参照を、画面に出す短い文にする。
 * 例: 「サビ（5〜8 小節）」「3 小節 2 拍目」
 *
 * @param ref - 参照
 * @param chart - 楽曲カルテ（セクションの名前と範囲を引く）
 */
export function refLabel(ref: GuideRef, chart: SongChart): string {
    const parts: string[] = [];
    if (ref.section_id !== null) {
        const section = chart.sections.find((s) => s.id === ref.section_id);
        if (section) {
            const raw = section.label ?? section.suggested_label;
            const name = raw ? (SECTION_LABEL_JA[raw] ?? raw) : `区間 ${section.id}`;
            parts.push(`${name}（${section.start_bar}〜${section.end_bar} 小節）`);
        } else {
            parts.push(`区間 ${ref.section_id}`);
        }
    }
    if (ref.bar !== null) {
        parts.push(ref.beat !== null ? `${ref.bar} 小節 ${ref.beat} 拍目` : `${ref.bar} 小節`);
    }
    return parts.join(' / ');
}
