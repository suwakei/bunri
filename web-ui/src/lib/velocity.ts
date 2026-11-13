/**
 * bunri DAW — ノートの強さ (ベロシティ) を画面から直すための計算。
 *
 * ピアノロールで選んだノートの強さをまとめて見せ、まとめて変える。
 * 強さを持たないノート (マウスで置いたもの) は `DEFAULT_VELOCITY` として鳴るので、表示と相対の変更では
 * その値として扱う。ただし、変えたノートにだけ値を書き込み、触っていないノートは持たないまま残す
 * (保存ファイルの `project_notes.velocity` を NULL のままにする)。
 */
import { DEFAULT_VELOCITY } from './engine';
import type { PianoNote } from './engine';

/** 強さの下限と上限 (MIDI の範囲。0 は「音を止める」なので使わない)。 */
export const VELOCITY_MIN = 1;
export const VELOCITY_MAX = 127;

/** −/＋ のボタンと Option (Alt) + ↑↓ で変える量。Shift も押すと 1 ずつ。 */
export const VELOCITY_STEP = 10;

/** 選んだノートの強さのまとめ。 */
export interface VelocitySummary {
    /** 選んでいるノートの数 */
    count: number;
    /** 全部が同じ強さならその値 (強さを持たないノートは `DEFAULT_VELOCITY` として数える)。ばらばらなら null */
    value: number | null;
    /** 強さを持たないノートの数 */
    unset: number;
}

/** ノートが鳴る強さ (持たなければ `DEFAULT_VELOCITY`)。 */
export function effectiveVelocity(n: PianoNote): number {
    return typeof n.velocity === 'number' && Number.isFinite(n.velocity) ? clampVelocity(n.velocity) : DEFAULT_VELOCITY;
}

/** 強さを 1〜127 の整数にする。 */
export function clampVelocity(v: number): number {
    return Math.max(VELOCITY_MIN, Math.min(VELOCITY_MAX, Math.round(v)));
}

/** 選んだノートの強さをまとめる。 */
export function summarizeVelocity(notes: Iterable<PianoNote>): VelocitySummary {
    let count = 0, unset = 0;
    let value: number | null = null, mixed = false;
    for (const n of notes) {
        count += 1;
        if (typeof n.velocity !== 'number') unset += 1;
        const v = effectiveVelocity(n);
        if (count === 1) value = v;
        else if (v !== value) mixed = true;
    }
    return { count, value: mixed ? null : value, unset };
}

/** 2 つのまとめが同じか (画面の描き直しを減らす)。 */
export function sameSummary(a: VelocitySummary, b: VelocitySummary): boolean {
    return a.count === b.count && a.value === b.value && a.unset === b.unset;
}

/**
 * ノートの強さを書き換える (その場で変える)。値が変わらないノートには書き込まない
 * (強さを持たないノートに 96 を入れても鳴り方は同じだが、「触っていないノートは持たないまま」を守る)。
 *
 * @param notes - 変えるノート
 * @param next - 今の強さから、新しい強さを出す関数
 * @returns 強さが変わったノートの数
 */
export function applyVelocity(notes: Iterable<PianoNote>, next: (current: number) => number): number {
    let changed = 0;
    for (const n of notes) {
        const current = effectiveVelocity(n);
        const v = clampVelocity(next(current));
        if (v === current) continue;
        n.velocity = v;
        changed += 1;
    }
    return changed;
}
