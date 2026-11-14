/**
 * 小節・ステップと秒の対応（lib/grid.ts）のテスト。
 *
 * いちばん大事なのは「カルテの N 小節」と「ピアノロールの N 小節」が同じ時刻を指すこと。
 * 1 拍目が 0 秒に無い曲 (以前は、ここで番号がずれていた) で確かめる。
 */
import { describe, it, expect } from 'vitest';
import {
    barToSec, chartBarToSec, gridFromChart, roundBpm, secToStep, stepToBar, stepToSec, stepsPerBar,
} from '../lib/grid';
import type { SongChart } from '../lib/chart';

/** 1 拍目が downbeat 秒に在り、bpm で等間隔に拍が並ぶカルテ。 */
function chartWith(bpm: number, downbeat: number, beatsPerBar = 4, beats = 64): SongChart {
    const beat = 60 / bpm;
    return {
        version: 1,
        source: { filename: 'x.wav', duration_sec: downbeat + beats * beat },
        grid: {
            bpm, bpm_confidence: 0.9, bpm_source: 'auto', downbeat_offset_sec: downbeat,
            time_signature: [beatsPerBar, 4], beat_times_sec: Array.from({ length: beats }, (_, i) => downbeat + i * beat),
            user_confirmed: false,
        },
        key: { tonic: 'C', mode: 'major', confidence: 0.8, alternatives: [] },
        sections: [], chords: [],
        mix: { loudness_lufs: null, peak_dbfs: null, dynamic_range_db: null, stereo_width: null, bass_mono: null, reverb_tail_sec: null, spectrum_bands: [] },
        unavailable: {},
    };
}

describe('グリッド', () => {
    const grid = { bpm: 120, beatsPerBar: 4, offsetSec: 0.75 };

    it('ステップ 0 は 1 小節目の 1 拍目の位置', () => {
        expect(stepToSec(0, grid)).toBeCloseTo(0.75);
        expect(stepToSec(16, grid)).toBeCloseTo(2.75);
        expect(secToStep(2.75, grid)).toBeCloseTo(16);
        // 1 小節目より前 (弱起) は負になる
        expect(secToStep(0.25, grid)).toBeLessThan(0);
    });

    it('小節と拍の頭の位置', () => {
        expect(barToSec(1, grid)).toBeCloseTo(0.75);
        expect(barToSec(3, grid)).toBeCloseTo(4.75);
        expect(barToSec(3, grid, 2)).toBeCloseTo(5.25);
        expect(stepToBar(32, grid)).toBe(3);
        expect(stepsPerBar({ beatsPerBar: 3 })).toBe(12);
    });

    it('BPM は小数 2 桁に丸める', () => {
        expect(roundBpm(123.0469)).toBe(123.05);
    });
});

describe('カルテの小節とピアノロールの小節', () => {
    it.each([
        ['1 拍目が 0.75 秒', 120, 0.75, 4],
        ['1 拍目が 1.3 秒、小数のテンポ', 97.3, 1.3, 4],
        ['3 拍子', 140, 0.4, 3],
    ])('%s の曲で、カルテの N 小節とピアノロールの N 小節が同じ時刻を指す', (_name, bpm, downbeat, perBar) => {
        const chart = chartWith(bpm, downbeat, perBar);
        const grid = gridFromChart(chart);
        expect(grid.offsetSec).toBeCloseTo(downbeat);
        for (const bar of [1, 2, 5, 12]) {
            const chartSec = chartBarToSec(chart, bar);
            const pianoSec = barToSec(bar, grid);
            // テンポを小数 2 桁に丸めるぶんの誤差 (12 小節で数ミリ秒) より小さい
            expect(Math.abs(chartSec - pianoSec)).toBeLessThan(0.01);
            // 秒からピアノロールのステップに戻すと、その小節の頭
            expect(stepToBar(Math.round(secToStep(chartSec, grid)), grid)).toBe(bar);
        }
    });

    it('以前の数え方 (0 秒から、整数のテンポ) だと番号がずれる (直す前の不具合)', () => {
        const chart = chartWith(120, 0.75);
        const old = { bpm: 120, beatsPerBar: 4, offsetSec: 0 };
        // カルテの 3 小節目 (4.75 秒) は、0 秒から数えると 3 小節目の頭ではない
        expect(Math.round(secToStep(chartBarToSec(chart, 3), old))).not.toBe(32);
    });

    it('ビート列の外は、カルテのテンポで延ばす', () => {
        const chart = chartWith(120, 0.5, 4, 8);
        expect(chartBarToSec(chart, 4)).toBeCloseTo(0.5 + 12 * 0.5);
    });
});
