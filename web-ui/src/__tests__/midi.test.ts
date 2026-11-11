/**
 * lib/midi.ts のテスト。書き出したバイト列を読み戻して、中身を確かめる。
 */
import { describe, it, expect } from 'vitest';
import { notesToMidi, noteNumber, variableLength, channelFor, TICKS_PER_QUARTER, TICKS_PER_STEP } from '../lib/midi';

interface ParsedEvent { tick: number; kind: string; channel?: number; number?: number; velocity?: number; data?: number[] }

/** テスト用の最小の SMF パーサ */
function parse(bytes: Uint8Array) {
    let pos = 0;
    const text = (n: number) => { const s = String.fromCharCode(...bytes.slice(pos, pos + n)); pos += n; return s; };
    const u32 = () => { const v = (bytes[pos] << 24 | bytes[pos + 1] << 16 | bytes[pos + 2] << 8 | bytes[pos + 3]) >>> 0; pos += 4; return v; };
    const u16 = () => { const v = bytes[pos] << 8 | bytes[pos + 1]; pos += 2; return v; };
    const vlq = () => { let v = 0; for (;;) { const b = bytes[pos++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } };

    expect(text(4)).toBe('MThd');
    expect(u32()).toBe(6);
    const header = { format: u16(), trackCount: u16(), division: u16() };
    const tracks: ParsedEvent[][] = [];
    while (pos < bytes.length) {
        expect(text(4)).toBe('MTrk');
        const end = pos + 4 + u32();
        const events: ParsedEvent[] = [];
        let tick = 0;
        while (pos < end) {
            tick += vlq();
            const status = bytes[pos++];
            if (status === 0xff) {
                const type = bytes[pos++];
                const len = vlq();
                events.push({ tick, kind: `meta${type.toString(16)}`, data: Array.from(bytes.slice(pos, pos + len)) });
                pos += len;
            } else {
                events.push({ tick, kind: (status & 0xf0) === 0x90 ? 'on' : 'off', channel: status & 0x0f, number: bytes[pos], velocity: bytes[pos + 1] });
                pos += 2;
            }
        }
        expect(pos).toBe(end);
        tracks.push(events);
    }
    return { header, tracks };
}

describe('noteNumber', () => {
    it('C4 は 60、A4 は 69', () => {
        expect(noteNumber('C', 4)).toBe(60);
        expect(noteNumber('A', 4)).toBe(69);
        expect(noteNumber('C#', 2)).toBe(37);
        expect(noteNumber('B', 6)).toBe(95);
    });
    it('知らない音名や範囲外は null', () => {
        expect(noteNumber('H', 4)).toBeNull();
        expect(noteNumber('C', 10)).toBeNull();
        expect(noteNumber('C', -2)).toBeNull();
        expect(noteNumber('C', 4.5)).toBeNull();
    });
});

describe('variableLength', () => {
    it('SMF の仕様書の例どおり', () => {
        expect(variableLength(0)).toEqual([0x00]);
        expect(variableLength(0x7f)).toEqual([0x7f]);
        expect(variableLength(0x80)).toEqual([0x81, 0x00]);
        expect(variableLength(0x3fff)).toEqual([0xff, 0x7f]);
        expect(variableLength(0x4000)).toEqual([0x81, 0x80, 0x00]);
        expect(variableLength(0x0fffffff)).toEqual([0xff, 0xff, 0xff, 0x7f]);
    });
});

describe('channelFor', () => {
    it('ドラム用の 10 番（添字 9）を飛ばす', () => {
        const channels = Array.from({ length: 20 }, (_, i) => channelFor(i));
        expect(channels).not.toContain(9);
        expect(channels.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 10]);
    });
});

describe('notesToMidi', () => {
    const chord = [
        { note: 'C', octave: 4, step: 0, length: 4 },
        { note: 'E', octave: 4, step: 0, length: 4 },
        { note: 'G', octave: 4, step: 4, length: 2 },
    ];

    it('フォーマット 1、分解能 480、テンポと拍子を先頭のトラックに置く', () => {
        const { header, tracks } = parse(notesToMidi([{ name: 'Piano', notes: chord }], 120));
        expect(header).toEqual({ format: 1, trackCount: 2, division: TICKS_PER_QUARTER });
        const conductor = tracks[0];
        // 120 BPM = 4 分音符あたり 500000 マイクロ秒
        expect(conductor.find((e) => e.kind === 'meta51')?.data).toEqual([0x07, 0xa1, 0x20]);
        expect(conductor.find((e) => e.kind === 'meta58')?.data).toEqual([4, 2, 24, 8]);
        expect(conductor[conductor.length - 1].kind).toBe('meta2f');
    });

    it('ノートの位置と長さがステップどおりになる', () => {
        const { tracks } = parse(notesToMidi([{ name: 'Piano', notes: chord }], 120));
        const notes = tracks[1].filter((e) => e.kind === 'on' || e.kind === 'off');
        expect(notes.map((e) => [e.tick, e.kind, e.number])).toEqual([
            [0, 'on', 60], [0, 'on', 64],
            [4 * TICKS_PER_STEP, 'off', 60], [4 * TICKS_PER_STEP, 'off', 64],
            [4 * TICKS_PER_STEP, 'on', 67],
            [6 * TICKS_PER_STEP, 'off', 67],
        ]);
        expect(notes.filter((e) => e.kind === 'on').every((e) => e.velocity! > 0)).toBe(true);
    });

    it('同じ高さの音が続くとき、止めてから鳴らす', () => {
        const repeated = [{ note: 'C', octave: 4, step: 0, length: 2 }, { note: 'C', octave: 4, step: 2, length: 2 }];
        const { tracks } = parse(notesToMidi([{ name: 't', notes: repeated }], 120));
        const at2 = tracks[1].filter((e) => e.tick === 2 * TICKS_PER_STEP).map((e) => e.kind);
        expect(at2).toEqual(['off', 'on']);
    });

    it('トラック名が入り、トラックごとにチャンネルが分かれる', () => {
        const { header, tracks } = parse(notesToMidi([
            { name: 'ボーカル', notes: chord },
            { name: 'Bass', notes: [{ note: 'C', octave: 2, step: 0, length: 16 }] },
        ], 96));
        expect(header.trackCount).toBe(3);
        expect(new TextDecoder().decode(new Uint8Array(tracks[1].find((e) => e.kind === 'meta3')!.data!))).toBe('ボーカル');
        expect(new Set(tracks[1].filter((e) => e.kind === 'on').map((e) => e.channel))).toEqual(new Set([0]));
        expect(new Set(tracks[2].filter((e) => e.kind === 'on').map((e) => e.channel))).toEqual(new Set([1]));
    });

    it('ノートの無いトラックと、書き出せないノートは飛ばす', () => {
        const { header, tracks } = parse(notesToMidi([
            { name: '空', notes: [] },
            { name: 'Lead', notes: [
                { note: 'A', octave: 4, step: 0, length: 4 },
                { note: 'H', octave: 4, step: 4, length: 4 },      // 知らない音名
                { note: 'C', octave: 4, step: 8, length: 0 },      // 長さ 0
                { note: 'C', octave: 4, step: -1, length: 4 },     // 負の位置
            ] },
        ], 120));
        expect(header.trackCount).toBe(2);
        expect(tracks[1].filter((e) => e.kind === 'on').map((e) => e.number)).toEqual([69]);
    });

    it('長い曲でもデルタタイムが正しい（可変長が 2 バイト以上になる）', () => {
        const far = [{ note: 'C', octave: 4, step: 0, length: 1 }, { note: 'D', octave: 4, step: 1600, length: 1 }];
        const { tracks } = parse(notesToMidi([{ name: 't', notes: far }], 120));
        expect(tracks[1].filter((e) => e.kind === 'on').map((e) => e.tick)).toEqual([0, 1600 * TICKS_PER_STEP]);
    });

    it('書き出せるノートが無い、またはテンポが不正なら失敗する', () => {
        expect(() => notesToMidi([{ name: 't', notes: [] }], 120)).toThrow('書き出せるノートがありません');
        expect(() => notesToMidi([], 120)).toThrow('書き出せるノートがありません');
        expect(() => notesToMidi([{ name: 't', notes: chord }], 0)).toThrow('テンポ');
        expect(() => notesToMidi([{ name: 't', notes: chord }], NaN)).toThrow('テンポ');
    });
});
