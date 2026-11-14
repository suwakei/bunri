/**
 * ノートの強さを画面から直すための計算 (lib/velocity.ts) のテスト。
 */
import { describe, it, expect } from 'vitest';
import { applyVelocity, clampVelocity, summarizeVelocity, VELOCITY_MAX, VELOCITY_MIN } from '../lib/velocity';
import type { PianoNote } from '../lib/engine';

const note = (velocity?: number): PianoNote => {
    const n: PianoNote = { note: 'C', octave: 4, step: 0, length: 4 };
    if (velocity !== undefined) n.velocity = velocity;
    return n;
};

describe('summarizeVelocity', () => {
    it('何も選んでいなければ 0 個', () => {
        expect(summarizeVelocity([])).toEqual({ count: 0, value: null, unset: 0 });
    });

    it('強さを持たないノートは 96 として数え、持たない数も返す', () => {
        expect(summarizeVelocity([note(), note()])).toEqual({ count: 2, value: 96, unset: 2 });
        expect(summarizeVelocity([note(), note(96)])).toEqual({ count: 2, value: 96, unset: 1 });
    });

    it('ばらばらなら value は null', () => {
        expect(summarizeVelocity([note(80), note(100)]).value).toBeNull();
        expect(summarizeVelocity([note(), note(100)]).value).toBeNull();
    });
});

describe('clampVelocity', () => {
    it('1〜127 の整数に収める', () => {
        expect(clampVelocity(0)).toBe(VELOCITY_MIN);
        expect(clampVelocity(-30)).toBe(VELOCITY_MIN);
        expect(clampVelocity(200)).toBe(VELOCITY_MAX);
        expect(clampVelocity(64.6)).toBe(65);
    });
});

describe('applyVelocity', () => {
    it('全部を同じ値にする。強さを持たないノートにも値を持たせる', () => {
        const notes = [note(), note(40)];
        expect(applyVelocity(notes, () => 70)).toBe(2);
        expect(notes.map(n => n.velocity)).toEqual([70, 70]);
    });

    it('値が変わらないノートには書き込まない (触っていないノートは強さを持たないまま)', () => {
        const notes = [note(), note(40)];
        expect(applyVelocity(notes, () => 96)).toBe(1);
        expect('velocity' in notes[0]).toBe(false);
        expect(notes[1].velocity).toBe(96);
    });

    it('相対の変更は差を保ち、端では 1〜127 で止める', () => {
        const notes = [note(50), note(), note(120)];
        applyVelocity(notes, v => v + 10);
        expect(notes.map(n => n.velocity)).toEqual([60, 106, 127]);
        applyVelocity(notes, v => v - 100);
        expect(notes.map(n => n.velocity)).toEqual([1, 6, 27]);
    });
});
