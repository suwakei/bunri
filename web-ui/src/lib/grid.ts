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
 * 1 ステップは 16 分音符（1 拍 = 4 ステップ）。
 */
import type { SongChart } from './chart';

/** 1 拍のステップ数（16 分音符）。 */
export const STEPS_PER_BEAT = 4;

/** プロジェクトのグリッド。 */
export interface ProjectGrid {
    /** テンポ（BPM） */
    bpm: number;
    /** 1 小節の拍数 */
    beatsPerBar: number;
    /** 1 小節目の 1 拍目の位置（秒） */
    offsetSec: number;
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

/** ステップが何小節目か（1 始まり）。 */
export function stepToBar(step: number, grid: Pick<ProjectGrid, 'beatsPerBar'>): number {
    return Math.floor(step / stepsPerBar(grid)) + 1;
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
