/**
 * bunri DAW — 音源分離モデルの初回ダウンロードの案内。
 *
 * 分離モデルは、初めて使うときにネットワークから落ちてくる（数十〜数百 MB）。
 * その間は処理が止まって見えるので、分離を始める前にモデルが手元に在るかを聞き、
 * 無ければ「初回はダウンロードが入る」と状態表示に添える。
 */
import { apiFetch } from './api';

/** モデルが手元に無いときに、状態表示の末尾に添える文。 */
export const MODEL_DOWNLOAD_NOTICE = ' 初回のみ、分離用のモデルをダウンロードします（回線によっては数分かかります）';

/** ドラムを種類ごと（キック / スネア / タム / シンバル）に分ける追加のモデルの名前（backend/stem_models.py）。 */
export const DRUM_MODEL = 'drumsep';

interface ModelStatus {
    cached?: boolean;
    download_bytes?: number;
}

/** 問い合わせは案内のため。失敗しても、分離を始める処理は止めない。 */
async function fetchModelStatus(model: string): Promise<ModelStatus | null> {
    try {
        const resp = await apiFetch(`/api/models/${encodeURIComponent(model)}/status`);
        if (!resp.ok) return null;
        return await resp.json() as ModelStatus;
    } catch {
        return null;
    }
}

/**
 * モデルが手元に在るか。問い合わせに失敗した（API に届かない・知らないモデル）ときは null（分からない）。
 *
 * @param model - 分離モデルの名前か、追加のモデル名（`DRUM_MODEL`）
 */
export async function modelCached(model: string): Promise<boolean | null> {
    const status = await fetchModelStatus(model);
    return typeof status?.cached === 'boolean' ? status.cached : null;
}

/**
 * モデルが手元に無ければ案内の文を、在れば空文字を返す。
 *
 * 案内はおまけなので、問い合わせに失敗しても処理は止めない（空文字を返す）。
 *
 * @param model - 分離モデルの名前
 */
export async function modelDownloadNotice(model: string): Promise<string> {
    const status = await fetchModelStatus(model);
    if (status?.cached !== false) return '';
    const bytes = status.download_bytes;
    return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
        ? ` 初回のみ、分離用のモデル（約 ${Math.max(1, Math.round(bytes / 1_000_000))} MB）をダウンロードします（回線によっては数分かかります）`
        : MODEL_DOWNLOAD_NOTICE;
}
