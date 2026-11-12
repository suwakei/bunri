/**
 * bunri DAW — トラックの音量とパン（トラックの見出しのつまみ）の、値の範囲と画面に出す文。
 *
 * 音量は dB で持つ（engine.ts の `Track.gain`）。パンは -1（左）〜 1（右）。
 * 読み上げ（`aria-valuetext`）と、つまみの横の数字は同じ文にする。
 */

/** 音量のつまみの範囲（dB）と刻み。 */
export const GAIN_MIN_DB = -60;
export const GAIN_MAX_DB = 6;
export const GAIN_STEP_DB = 0.5;

/** パンのつまみの刻み（-100〜100 の 1 刻み。左右 1% ずつ）。 */
export const PAN_STEPS = 100;

/** 負の数に付ける記号（ハイフンではなく、数学のマイナス）。 */
const MINUS = '−';

/**
 * 音量を文にする。例: "−6.0 dB" / "0.0 dB" / "+3.0 dB"
 * @param db - 音量（dB）
 */
export function formatGainDb(db: number): string {
    const value = Math.round((Number.isFinite(db) ? db : 0) * 10) / 10;
    const sign = value > 0 ? '+' : value < 0 ? MINUS : '';
    return `${sign}${Math.abs(value).toFixed(1)} dB`;
}

/**
 * パンを文にする。例: "左 30" / "中央" / "右 100"
 * @param pan - パン（-1〜1）
 */
export function formatPan(pan: number): string {
    const value = Math.round((Number.isFinite(pan) ? pan : 0) * PAN_STEPS);
    if (value === 0) return '中央';
    return value < 0 ? `左 ${-value}` : `右 ${value}`;
}

/** 音量をつまみの範囲に収める。 */
export function clampGainDb(db: number): number {
    return Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, Number.isFinite(db) ? db : 0));
}

/** パンを -1〜1 に収める。 */
export function clampPan(pan: number): number {
    return Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0));
}
