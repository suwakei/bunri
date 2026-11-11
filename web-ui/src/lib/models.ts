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

/**
 * モデルが手元に無ければ案内の文を、在れば空文字を返す。
 *
 * 案内はおまけなので、問い合わせに失敗しても処理は止めない（空文字を返す）。
 *
 * @param model - Demucs のモデル名（`htdemucs` / `htdemucs_ft` / `htdemucs_6s`）
 */
export async function modelDownloadNotice(model: string): Promise<string> {
    try {
        const resp = await apiFetch(`/api/models/${encodeURIComponent(model)}/status`);
        if (!resp.ok) return '';
        const status = (await resp.json()) as { cached?: boolean };
        return status.cached === false ? MODEL_DOWNLOAD_NOTICE : '';
    } catch {
        return '';
    }
}
