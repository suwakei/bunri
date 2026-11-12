/**
 * bunri DAW — 時間の表し方。
 */

/** 経過秒数を「1分05秒」の形にする（小数は切り捨てる）。起動待ちと、時間のかかる処理の表示で使う。 */
export function formatElapsed(sec: number): string {
    const total = Math.max(0, Math.floor(sec));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
}
