/**
 * トラックの音量とパンの表示 (lib/mix.ts)。
 */
import { describe, it, expect } from 'vitest';
import { clampGainDb, clampPan, formatGainDb, formatPan } from '../lib/mix';

describe('formatGainDb', () => {
    it.each([
        [-6, '−6.0 dB'], [0, '0.0 dB'], [3, '+3.0 dB'], [-0.04, '0.0 dB'], [-60, '−60.0 dB'], [Number.NaN, '0.0 dB'],
    ])('%s dB → %s', (db, text) => {
        expect(formatGainDb(db)).toBe(text);
    });
});

describe('formatPan', () => {
    it.each([[0, '中央'], [-0.3, '左 30'], [0.3, '右 30'], [1, '右 100'], [-1, '左 100'], [0.004, '中央']])('%s → %s', (pan, text) => {
        expect(formatPan(pan)).toBe(text);
    });
});

describe('範囲に収める', () => {
    it('音量は −60〜+6 dB、パンは −1〜1', () => {
        expect(clampGainDb(-100)).toBe(-60);
        expect(clampGainDb(12)).toBe(6);
        expect(clampGainDb(-3)).toBe(-3);
        expect(clampPan(-2)).toBe(-1);
        expect(clampPan(Number.NaN)).toBe(0);
    });
});
