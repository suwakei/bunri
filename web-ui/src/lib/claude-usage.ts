/**
 * bunri DAW — Claude を呼ぶ機能（再現ガイド・差分の説明）で共通の、費用まわりの文。
 *
 * どちらも 1 回呼ぶたびに費用がかかるので、1 回ごとのトークン数と概算の費用、今日の累計と 1 日の上限を見せる
 * （docs/reproduction-guide-design.md「費用」。上限は再現ガイドと差分の説明で 1 つの枠）。
 */
import { formatUsd, type GuideToday, type GuideUsage } from './guide';

/** トークン数を、桁区切りつきの文字にする。 */
const count = (value: number | null | undefined) => (value ?? 0).toLocaleString('ja-JP');

/**
 * 1 回の呼び出しの使用量を、1 行の文にする。
 * 例: 「入力 3,020 トークン、出力 400 トークン、概算 $0.11」
 */
export function usageLine(result: { usage?: GuideUsage | null; cost_usd?: number | null }): string {
    const u = result.usage ?? {};
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const parts = [`入力 ${count(input)} トークン`];
    if (u.cache_read_input_tokens) parts[0] += `（うち ${count(u.cache_read_input_tokens)} はキャッシュから）`;
    parts.push(`出力 ${count(u.output_tokens)} トークン`);
    if (typeof result.cost_usd === 'number') parts.push(`概算 ${formatUsd(result.cost_usd)}`);
    return parts.join('、');
}

/** 今日の累計と上限を、1 行の文にする。 */
export function todayLine(today: GuideToday): string {
    const limits: string[] = [];
    if (today.limit_calls !== null) limits.push(`${today.limit_calls} 回`);
    if (today.limit_usd !== null) limits.push(formatUsd(today.limit_usd));
    const limit = limits.length > 0 ? `上限 ${limits.join('・')}` : '上限なし';
    return `今日 Claude を呼んだ回数: ${today.calls} 回、概算 ${formatUsd(today.cost_usd)}（1 日の${limit}）`;
}
