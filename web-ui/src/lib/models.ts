/**
 * bunri DAW — 音源分離モデルの初回ダウンロードの案内。
 *
 * Demucs のモデルは、初めて使うときにネットワークから落ちてくる（数十〜数百 MB）。
 * その間は処理が止まって見えるので、分離を始める前にモデルが手元に在るかを聞き、
 * 無ければ「初回はダウンロードが入る」と状態表示に添える。
 */
import { apiFetch } from './api';

/** モデルが手元に無いときに、状態表示の末尾に添える文。 */
export const MODEL_DOWNLOAD_NOTICE = ' 初回のみ、分離用のモデルをダウンロードします（回線によっては数分かかります）';

/** ドラムを種類ごと（キック / スネア / タム / シンバル）に分ける追加のモデルの名前（backend/stem_models.py）。 */
export const DRUM_MODEL = 'drumsep';

/**
 * モデルが手元に在るか。問い合わせに失敗した（API に届かない・知らないモデル）ときは null（分からない）。
 *
 * @param model - Demucs のモデル名か、追加のモデル名（`DRUM_MODEL`）
 */
export async function modelCached(model: string): Promise<boolean | null> {
    try {
        const resp = await apiFetch(`/api/models/${encodeURIComponent(model)}/status`);
        if (!resp.ok) return null;
        const status = (await resp.json()) as { cached?: boolean };
        return typeof status.cached === 'boolean' ? status.cached : null;
    } catch {
        return null;
    }
}

/**
 * モデルが手元に無ければ案内の文を、在れば空文字を返す。
 *
 * 案内はおまけなので、問い合わせに失敗しても処理は止めない（空文字を返す）。
 *
 * @param model - Demucs のモデル名（`htdemucs` / `htdemucs_ft` / `htdemucs_6s`）
 */
export async function modelDownloadNotice(model: string): Promise<string> {
    return (await modelCached(model)) === false ? MODEL_DOWNLOAD_NOTICE : '';
}
