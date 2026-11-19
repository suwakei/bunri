/**
 * bunri DAW — 小節・ステップと秒の対応（プロジェクトのグリッド）。
 *
 * ピアノロール・タイムライン・再生・差分チェックは、どれも同じグリッドで小節を数える。
 * グリッドは 3 つの値で決まる。
 *
 * - `bpm`: テンポ（小数も可。カルテの実測のテンポをそのまま持つ）
 * - `beatsPerBar`: 1 小節の拍数
 * - `offsetSec`: 1 小節目の 1 拍目の位置（秒）。ピアノロールのステップ 0 はここ
 *
 * 曲を取り込むと、カルテのグリッド（テンポと 1 拍目の位置）をそのまま使う。
 * こうすると「カルテの 5 小節」と「ピアノロールの 5 小節」が同じ時刻を指す。
 * 以前はピアノロールが 0 秒から整数のテンポで数えていて、1 拍目が 0 秒に無い曲では
 * 番号がずれていた（docs/coach-diff-design.md の「カルテとピアノロールの小節番号」）。
 *
 * 1 ステップは 16 分音符（1 拍 = 4 ステップ）。ノートの位置（`step`）と長さ（`length`）は、この単位のまま
 * 小数を持てる（0.5 = 32 分音符、4/3 = 8 分の三連、2/3 = 16 分の三連）。値は 1/60 ステップの倍数にそろえて持つ
 * （`normStep`）。ノートを作る・動かす・貼る・読み込む場所は、必ずこれを通す。処理を担当する部分（Python）も
 * 同じ丸め（`round(x * 60) / 60`）をするので、同じ位置は、どちらの側でも同じ値になる。
 * 刻み（ノートを置く・動かすときに吸い付く間隔。三連・スウィング）の計算は lib/snap.ts。
 */
import type { SongChart } from './chart';

/** 1 拍のステップ数（16 分音符）。 */
export const STEPS_PER_BEAT = 4;

/**
 * 1 ステップを分ける数。位置と長さは、1/60 ステップの倍数で持つ。
 * 60 は 2・3・4・5・6 で割り切れるので、32 分（1/2）・三連（2/3、4/3）・64 分（1/4）・MIDI の読み込みの細かさ（1/6）が、
 * どれも整数の単位になる。
 */
export const STEP_UNITS = 60;

/** スウィングの既定（50% = ずらさない）と上限（75%）。 */
export const SWING_NONE = 0.5;
export const SWING_MAX = 0.75;

/**
 * ステップの値を、刻みの数（1/60 ステップの単位の整数）にする。
 *
 * **差・等しいか・範囲に入るかは、この整数で比べる**（処理を担当する部分の `note_steps.to_ticks` と同じ決まり）。
 * 小数のまま引き算や比較をすると、境目で外れる（`25/6 - 13/6` は 2.0000000000000004、`0.7 - 0.2` は 0.49999999999999994）。
 */
export function toTicks(step: number): number {
    return Math.round(step * STEP_UNITS);
}

/** 刻みの数を、ステップに戻す（整数になる値は、整数）。 */
export function fromTicks(ticks: number): number {
    return ticks / STEP_UNITS;
}

/** `toTicks` の別名（1/60 ステップの単位の整数）。 */
export const stepUnits = toTicks;

/**
 * ステップの値（位置・長さ）を、1/60 ステップの倍数にそろえる。整数は整数のまま
 * （`4.0000001` のような値を、保存や API に流さない）。数でない値は 0。
 */
export function normStep(step: number): number {
    return Number.isFinite(step) ? Math.round(step * STEP_UNITS) / STEP_UNITS : 0;
}

/** ノートの長さの下限（1/60 ステップ）。そろえると 0 になる長さ（1/120 ステップ未満）を、作らない・保存しない・API に送らない。 */
export const MIN_LENGTH = 1 / STEP_UNITS;

/**
 * 長さを、1/60 ステップの倍数にそろえる。正の長さは、そろえても 0 にしない（下限は 1/60 ステップ。
 * 処理を担当する部分は、0 になる長さを差分の API で断り、保存では 1/60 ステップにする）。
 */
export function normLength(length: number): number {
    const value = normStep(length);
    return length > 0 && value < MIN_LENGTH ? MIN_LENGTH : value;
}

/** 2 つのステップの値が、同じ位置（長さ）か。刻みの数で比べる。 */
export function sameStep(a: number, b: number): boolean {
    return toTicks(a) === toTicks(b);
}

/**
 * 位置が、範囲 `[start, end)` に入るか（終わりは含まない）。刻みの数で比べる。
 * 範囲の端は、Infinity でもよい（終わりを決めない範囲）。
 */
export function inStepRange(step: number, start: number, end: number): boolean {
    const at = toTicks(step);
    return at >= toTicks(start) && (end === Infinity || at < toTicks(end));
}

/** ノートの位置と長さを、1/60 ステップの倍数にそろえた写しを返す（ほかの項目は、そのまま）。 */
export function normNote<T extends { step: number; length: number }>(note: T): T {
    const step = normStep(note.step), length = normLength(note.length);
    return step === note.step && length === note.length ? { ...note } : { ...note, step, length };
}

/**
 * スウィングの値（0.5〜0.75）にそろえる。数でなければ 0.5（ずらさない）。
 * 三連と同じ位置（67%）は、ちょうど 2/3 にする（0.67 のままだと、三連の位置から 1/60 ステップずれる）。
 * それ以外は、小数 2 桁。
 */
export function normSwing(value: unknown): number {
    const v = typeof value === 'number' && Number.isFinite(value) ? value : SWING_NONE;
    if (Math.abs(v - 2 / 3) < 0.006) return 2 / 3;
    return Math.max(SWING_NONE, Math.min(SWING_MAX, Math.round(v * 100) / 100));
}

/** プロジェクトのグリッド。 */
export interface ProjectGrid {
    /** テンポ（BPM） */
    bpm: number;
    /** 1 小節の拍数 */
    beatsPerBar: number;
    /** 1 小節目の 1 拍目の位置（秒） */
    offsetSec: number;
    /**
     * スウィング（裏の位置を後ろへずらす割合。0.5 = ずらさない 〜 0.75。2/3 が三連と同じ位置）。
     * 刻みが 8 分か 16 分のときの、吸い付く位置とグリッドの線に効く（lib/snap.ts）。無ければ 0.5
     */
    swing?: number;
}

/** 1 ステップの長さ（秒）。 */
export function stepSeconds(grid: Pick<ProjectGrid, 'bpm'>): number {
    return 60 / Math.max(1, grid.bpm) / STEPS_PER_BEAT;
}

/** 1 小節のステップ数。 */
export function stepsPerBar(grid: Pick<ProjectGrid, 'beatsPerBar'>): number {
    return Math.max(1, grid.beatsPerBar || 4) * STEPS_PER_BEAT;
}

/** ステップの位置（秒）。 */
export function stepToSec(step: number, grid: ProjectGrid): number {
    return grid.offsetSec + step * stepSeconds(grid);
}

/** 秒の位置を、ステップ（小数）にする。1 小節目より前は負になる。 */
export function secToStep(sec: number, grid: ProjectGrid): number {
    return (sec - grid.offsetSec) / stepSeconds(grid);
}

/** 小節（1 始まり）と拍（1 始まり）の頭の位置（秒）。 */
export function barToSec(bar: number, grid: ProjectGrid, beat = 1): number {
    return stepToSec((bar - 1) * stepsPerBar(grid) + (beat - 1) * STEPS_PER_BEAT, grid);
}

/**
 * ステップが何小節目か（1 始まり）。小数のステップ（三連など）は、その位置が在る小節。
 * 刻みの数で数える（小節の頭ちょうどに在る値が、誤差で前の小節に落ちない）。
 */
export function stepToBar(step: number, grid: Pick<ProjectGrid, 'beatsPerBar'>): number {
    return Math.floor(toTicks(step) / (stepsPerBar(grid) * STEP_UNITS)) + 1;
}

/** ステップが、その小節の何拍目か（1 始まり）。三連の 2 つ目・3 つ目は、その拍に数える。 */
export function stepToBeat(step: number, grid: Pick<ProjectGrid, 'beatsPerBar'>): number {
    const perBar = stepsPerBar(grid) * STEP_UNITS;
    const inBar = ((toTicks(step) % perBar) + perBar) % perBar;
    return Math.floor(inBar / (STEPS_PER_BEAT * STEP_UNITS)) + 1;
}

/** BPM を、画面と保存に使う精度（小数 2 桁）に丸める。 */
export function roundBpm(bpm: number): number {
    return Math.round(bpm * 100) / 100;
}

/**
 * カルテのグリッドから、プロジェクトのグリッドを作る。
 * テンポは実測の値（小数 2 桁に丸める）、1 小節目の位置はカルテの 1 拍目。
 */
export function gridFromChart(chart: SongChart): ProjectGrid {
    return {
        bpm: roundBpm(chart.grid.bpm),
        beatsPerBar: Math.max(1, chart.grid.time_signature[0] || 4),
        offsetSec: Math.max(0, chart.grid.downbeat_offset_sec),
    };
}

/**
 * カルテの小節・拍の頭の位置（秒）。カルテの実測のビート列から引く。
 * ビート列の外（曲の終わりの先）は、カルテのテンポで延ばす。
 *
 * @param chart - カルテ
 * @param bar - 小節（1 始まり。カルテの番号）
 * @param beat - 拍（1 始まり）
 */
export function chartBarToSec(chart: SongChart, bar: number, beat = 1): number {
    const { grid } = chart;
    const perBar = Math.max(1, grid.time_signature[0] || 4);
    const index = Math.max(0, (bar - 1) * perBar + (beat - 1));
    const beats = grid.beat_times_sec;
    if (index < beats.length) return beats[index];
    const beatSec = 60 / Math.max(1, grid.bpm);
    if (beats.length > 0) return beats[beats.length - 1] + (index - (beats.length - 1)) * beatSec;
    return grid.downbeat_offset_sec + index * beatSec;
}
