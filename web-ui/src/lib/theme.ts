/**
 * bunri DAW — 色の名前 (CSS のトークン) を、canvas の描画から使うための入口。
 *
 * canvas は `var(--accent)` を解釈できないので、描く直前に実際の値を読む。
 * 色の値をコードに直接書くと、CSS (styles/global.css の `:root`) を変えたときに
 * canvas だけ古い色のまま残る。
 */

/**
 * CSS のトークンの値を返す。
 *
 * @param name - トークンの名前 (`--accent` のように `--` から書く)
 * @param fallback - 値が取れないとき (スタイルを読み込んでいないテスト環境など) に返す値
 */
export function cssVar(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}
