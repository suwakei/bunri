/**
 * bunri DAW — 再現ガイド（第2層）の型と API 呼び出し。
 *
 * 楽曲カルテを Claude に渡し、「こう作れば再現できる」という手順の説明を受け取る。
 * 説明はカルテの読み上げで、音符は含まない（backend/reproduction_guide.py）。
 */
import { apiFetch, invokeDesktop, isDesktop, statusMessage } from './api';
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

/**
 * 1 回の呼び出しの使用量（トークン数）。課金の単位になる 4 つの計器と、出力のうち思考に使われたぶん。
 * 入力の合計は `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`。
 */
export interface GuideUsage {
    input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    output_tokens?: number | null;
    thinking_tokens?: number | null;
}

/** 今日の使用量と、1 日の上限。 */
export interface GuideToday {
    date: string;
    /** 今日、Claude を呼んだ回数（保存済みを表示しただけの回は数えない）。 */
    calls: number;
    /** 今日の費用（USD。単価の表から計算した概算）。 */
    cost_usd: number;
    limit_calls: number | null;
    limit_usd: number | null;
    /** 上限に達していて呼べないときの理由。呼べるなら null。 */
    blocked: string | null;
}

/** `POST /api/chart/{id}/guide` のレスポンス。 */
export interface GuideResponse {
    chart_id: string;
    focus: string | null;
    guide: Guide;
    model: string;
    usage: GuideUsage;
    /** このガイドを作った呼び出しの費用（USD。概算）。単価が分からないモデルなら null。 */
    cost_usd?: number | null;
    duration_sec?: number | null;
    /** 作った時刻（ISO 形式）。 */
    created_at?: string | null;
    /** 保存済みのガイドを返したとき true（Claude は呼んでいない）。 */
    cached?: boolean;
    today?: GuideToday;
}

/** `GET /api/chart/{id}/guide` のレスポンス。保存済みが無ければ `saved` が false で、ガイドは無い。 */
export type SavedGuideResponse =
    | ({ saved: true } & GuideResponse)
    | { saved: false; chart_id: string; focus: string | null; today?: GuideToday };

/** 再現ガイドの費用まわりの設定。上限は null で「上限なし」。 */
export interface GuideSettings {
    daily_limit_calls: number | null;
    daily_limit_usd: number | null;
    max_input_tokens: number;
}

/** `/api/settings/guide` のレスポンス。 */
export interface GuideSettingsResponse {
    settings: GuideSettings;
    today: GuideToday;
}

/** `/api/settings/llm` のレスポンス。API キーそのものは含まない。 */
export interface LlmSettings {
    has_key: boolean;
    key_source: 'settings' | 'env' | 'none';
    model: string;
}

/** ガイドを作れなかったときのエラー。`code` で理由を出し分ける。 */
export class GuideRequestError extends Error {
    /**
     * `no_key` / `auth` / `rate_limit` / `network` / `refused` / `truncated` / `api` / `invalid` /
     * `daily_limit`（1 日の上限）/ `too_long`（カルテが長すぎる）/ `no_material`（材料が足りない）
     */
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
    // 理由が取れなかったときも、状態コードの番号ではなく、次にどうすればよいかを出す
    return new GuideRequestError(`再現ガイドを作れませんでした。${statusMessage(resp.status)}`, 'api');
}

/**
 * 再現ガイドを作る。同じ条件のガイドが保存済みなら、Claude を呼ばずにそれが返る。
 *
 * @param chartId - カルテの ID
 * @param focus - 絞り込むセクションの ID。null なら曲全体
 * @param regenerate - true なら、保存済みが在っても作り直す（Claude を呼ぶので費用がかかる）
 * @throws {GuideRequestError} 作れなかった場合
 */
export async function requestGuide(chartId: string, focus: string | null, regenerate = false): Promise<GuideResponse> {
    const body = new FormData();
    body.append('focus', focus ?? '');
    if (regenerate) body.append('regenerate', 'true');
    const resp = await apiFetch(`/api/chart/${encodeURIComponent(chartId)}/guide`, { method: 'POST', body });
    if (!resp.ok) throw await toError(resp);
    return (await resp.json()) as GuideResponse;
}

/**
 * 保存済みの再現ガイドを取得する。Claude は呼ばない（費用はかからない）。
 *
 * @param chartId - カルテの ID
 * @param focus - 絞り込むセクションの ID。null なら曲全体
 * @throws {GuideRequestError} 取得できなかった場合
 */
export async function fetchSavedGuide(chartId: string, focus: string | null): Promise<SavedGuideResponse> {
    const query = focus ? `?focus=${encodeURIComponent(focus)}` : '';
    const resp = await apiFetch(`/api/chart/${encodeURIComponent(chartId)}/guide${query}`);
    if (!resp.ok) throw await toError(resp);
    return (await resp.json()) as SavedGuideResponse;
}

/** 再現ガイドの費用まわりの設定と、今日の使用量を取得する。 */
export async function fetchGuideSettings(): Promise<GuideSettingsResponse> {
    const resp = await apiFetch('/api/settings/guide');
    if (!resp.ok) throw await toError(resp);
    return (await resp.json()) as GuideSettingsResponse;
}

/**
 * 再現ガイドの費用まわりの設定を変える。
 *
 * @param changes - 変える項目だけ。上限なしは null
 */
export async function saveGuideSettings(changes: Partial<GuideSettings>): Promise<GuideSettingsResponse> {
    const resp = await apiFetch('/api/settings/guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
    });
    if (!resp.ok) throw await toError(resp);
    return (await resp.json()) as GuideSettingsResponse;
}

/**
 * 概算の費用を、画面に出す文字にする。1 セント未満は桁を増やす。
 * 例: `0.1123` → `$0.11`、`0.0042` → `$0.004`
 */
export function formatUsd(value: number): string {
    return value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
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
