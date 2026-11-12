/**
 * bunri DAW — この画面を開いた人ごとの、ちょっとした覚え書き（localStorage）。
 *
 * 左パネルの幅、進み具合の段を畳んだか、再生位置を追うか、初回の案内を読んだか、といった
 * 「覚えていなくても困らない」ものだけを置く。プライベートウィンドウなどで localStorage が
 * 使えないときは、読めば null、書いても何もしない（画面はそのまま動く）。
 */

/** localStorage を読む。使えない環境では null。 */
export function readStored(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}

/** localStorage に書く。使えない環境では何もしない。 */
export function writeStored(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* 覚えられなくても動く */ }
}

/** 左パネルの幅（px）の範囲と既定値。 */
export const LEFT_WIDTH_MIN = 280;
export const LEFT_WIDTH_MAX = 520;
export const LEFT_WIDTH_DEFAULT = 300;
