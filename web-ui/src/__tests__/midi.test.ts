/**
 * lib/midi.ts のテスト。書き出したバイト列を読み戻して、中身を確かめる。
 */
import { describe, it, expect } from 'vitest';
import { notesToMidi, parseMidi, noteNumber, variableLength, channelFor, TICKS_PER_QUARTER, TICKS_PER_STEP } from '../lib/midi';

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


// ── 読み込み ─────────────────────────────────────────────────

/** バイト列の部品。 */
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const be32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const be16 = (v: number) => [(v >>> 8) & 0xff, v & 0xff];
const header = (format: number, tracks: number, division: number) => [...ascii('MThd'), ...be32(6), ...be16(format), ...be16(tracks), ...be16(division)];
const track = (data: number[]) => [...ascii('MTrk'), ...be32(data.length), ...data];
const END = [0x00, 0xff, 0x2f, 0x00];
/** テンポのメタイベント（デルタタイム付き）。 */
const tempo = (delta: number, bpm: number) => { const us = Math.round(60_000_000 / bpm); return [delta, 0xff, 0x51, 0x03, (us >>> 16) & 0xff, (us >>> 8) & 0xff, us & 0xff]; };
const plain = (notes: { note: string; octave: number; step: number; length: number }[]) =>
    notes.map(({ note, octave, step, length }) => ({ note, octave, step, length }));

describe('parseMidi', () => {
    it('書き出したものを読み戻すと、テンポ・トラック名・ノートが一致する', () => {
        const tracks = [
            { name: 'ベース', notes: [{ note: 'E', octave: 1, step: 0, length: 4 }, { note: 'G', octave: 1, step: 4, length: 2 }, { note: 'E', octave: 1, step: 6, length: 2 }] },
            { name: 'Lead', notes: [{ note: 'C', octave: 4, step: 0, length: 8 }, { note: 'E', octave: 4, step: 0, length: 8 }, { note: 'A#', octave: 5, step: 300, length: 1 }] },
        ];
        const result = parseMidi(notesToMidi(tracks, 96));

        expect(result.bpm).toBe(96);
        expect(result.timeSignature).toEqual([4, 4]);
        expect(result.tracks.map((t) => t.name)).toEqual(['ベース', 'Lead']);
        expect(plain(result.tracks[0].notes)).toEqual(tracks[0].notes);
        expect(plain(result.tracks[1].notes)).toEqual(tracks[1].notes);
        expect(result.tracks.every((t) => !t.isDrum)).toBe(true);
        expect(result.loss).toEqual({ rounded: 0, merged: 0, unterminated: 0, tempoChanges: 0 });
    });

    it('同じ高さの音が続いても、別のノートとして読み戻せる', () => {
        const notes = [{ note: 'C', octave: 4, step: 0, length: 4 }, { note: 'C', octave: 4, step: 4, length: 4 }];
        expect(plain(parseMidi(notesToMidi([{ name: 't', notes }], 120)).tracks[0].notes)).toEqual(notes);
    });

    it('フォーマット 0 は、チャンネルごとにトラックを分ける（ドラムのチャンネルは印を付ける）', () => {
        // 分解能 96（1 ステップ = 24 tick）。チャンネル 1 に C4、チャンネル 10 に 36（バスドラム）
        const bytes = new Uint8Array([
            ...header(0, 1, 96),
            ...track([
                0x00, 0xff, 0x03, 0x04, ...ascii('Song'),
                ...tempo(0, 140),
                0x00, 0x90, 60, 100,
                0x00, 0x99, 36, 110,
                0x18, 0x80, 60, 0,
                0x00, 0x89, 36, 0,
                ...END,
            ]),
        ]);
        const result = parseMidi(bytes);

        expect(result.bpm).toBe(140);
        expect(result.tracks.map((t) => [t.name, t.isDrum])).toEqual([['Song（チャンネル 1）', false], ['Song（チャンネル 10）', true]]);
        expect(result.tracks[0].notes).toEqual([{ note: 'C', octave: 4, step: 0, length: 1, velocity: 100 }]);
        expect(result.tracks[1].notes).toEqual([{ note: 'C', octave: 2, step: 0, length: 1, velocity: 110 }]);
    });

    it('ランニングステータスと、強さ 0 のノートオン（= ノートオフ）を読める', () => {
        // 0x90 を 1 回だけ書き、以後は種類のバイトを省く。止めるのは強さ 0 のノートオン
        const bytes = new Uint8Array([
            ...header(1, 1, 480),
            ...track([
                0x00, 0x90, 60, 90,          // C4 鳴らす
                0x83, 0x60, 60, 0,           // 480 tick 後に止める（種類のバイト無し、強さ 0）
                0x00, 64, 80,                // E4 鳴らす（種類のバイト無し）
                0x81, 0x70, 64, 0,           // 240 tick 後に止める
                ...END,
            ]),
        ]);
        const [only] = parseMidi(bytes).tracks;

        expect(only.notes).toEqual([
            { note: 'C', octave: 4, step: 0, length: 4, velocity: 90 },
            { note: 'E', octave: 4, step: 4, length: 2, velocity: 80 },
        ]);
    });

    it('メタイベントやシステムエクスクルーシブを挟んでも、続きを読める', () => {
        const bytes = new Uint8Array([
            ...header(1, 1, 480),
            ...track([
                0x00, 0xf0, 0x03, 0x7e, 0x7f, 0xf7,      // システムエクスクルーシブ
                0x00, 0xc0, 5,                            // 音色の切り替え（データ 1 バイト）
                0x00, 0xb0, 7, 100,                       // コントロールチェンジ（データ 2 バイト）
                0x00, 0x90, 67, 64,
                0x00, 0xff, 0x01, 0x02, ...ascii('hi'),   // 文字のメタイベント
                0x78, 67, 0,                              // ランニングステータスのまま止める
                ...END,
            ]),
        ]);
        expect(parseMidi(bytes).tracks[0].notes).toEqual([{ note: 'G', octave: 4, step: 0, length: 1, velocity: 64 }]);
    });

    it('16 分音符に乗らない位置と長さは丸め、丸めた数を返す', () => {
        // 分解能 480。3 連符の位置（160 tick）と、32 分音符の長さ（60 tick）
        const bytes = new Uint8Array([
            ...header(1, 1, 480),
            ...track([
                0x00, 0x90, 60, 100, 0x78, 0x80, 60, 0,              // 0〜120: 格子どおり
                0x28, 0x90, 62, 100, 0x81, 0x20, 0x80, 62, 0,       // 160〜320: 3 連符の 2 つ目
                0x00, 0x90, 64, 100, 0x3c, 0x80, 64, 0,              // 320〜380: 位置も長さも乗らない
                ...END,
            ]),
        ]);
        const result = parseMidi(bytes);

        expect(plain(result.tracks[0].notes)).toEqual([
            { note: 'C', octave: 4, step: 0, length: 1 },
            { note: 'D', octave: 4, step: 1, length: 2 },
            { note: 'E', octave: 4, step: 3, length: 1 },   // 長さは最短 1 ステップ
        ]);
        expect(result.loss.rounded).toBe(2);
        // トラックごとの数も持つ（読み込むトラックのぶんだけを画面で伝えるため）
        expect(result.tracks[0]).toMatchObject({ rounded: 2, merged: 0, unterminated: 0 });
    });

    it('丸めた結果、同じ高さ・同じ位置に重なったノートは 1 つにまとめる', () => {
        // 細かい連打（0〜40 tick と 40〜100 tick）。1 ステップ = 120 tick なので、どちらも 0 ステップ目に丸まる
        const bytes = new Uint8Array([
            ...header(1, 1, 480),
            ...track([
                0x00, 0x90, 60, 70, 0x28, 0x80, 60, 0,     // 0〜40
                0x00, 0x90, 60, 99, 0x3c, 0x80, 60, 0,     // 40〜100
                ...END,
            ]),
        ]);
        const result = parseMidi(bytes);

        expect(result.tracks[0].notes).toEqual([{ note: 'C', octave: 4, step: 0, length: 1, velocity: 99 }]);
        expect(result.loss.merged).toBe(1);
    });

    it('止める合図の無いノートは、トラックの終わりで止めて、数を返す', () => {
        const bytes = new Uint8Array([
            ...header(1, 1, 480),
            ...track([0x00, 0x90, 60, 100, 0x87, 0x40, 0xff, 0x2f, 0x00]),   // 960 tick 後にトラックが終わる
        ]);
        const result = parseMidi(bytes);

        expect(plain(result.tracks[0].notes)).toEqual([{ note: 'C', octave: 4, step: 0, length: 8 }]);
        expect(result.loss.unterminated).toBe(1);
    });

    it('テンポが途中で変わる曲は、最初のテンポを返し、変化の数を返す', () => {
        const bytes = new Uint8Array([
            ...header(1, 2, 480),
            ...track([...tempo(0, 100), ...tempo(0x60, 150), ...tempo(0x60, 90), ...END]),
            ...track([0x00, 0x90, 60, 100, 0x78, 0x80, 60, 0, ...END]),
        ]);
        const result = parseMidi(bytes);

        expect(result.bpm).toBe(100);
        expect(result.loss.tempoChanges).toBe(2);
        // ノートの無いトラック（テンポだけ）は、トラックとして返さない
        expect(result.tracks).toHaveLength(1);
    });

    it('テンポも拍子もトラック名も無いファイルを読める', () => {
        const bytes = new Uint8Array([...header(1, 1, 96), ...track([0x00, 0x90, 48, 1, 0x18, 0x80, 48, 0, ...END])]);
        const result = parseMidi(bytes);

        expect(result.bpm).toBeNull();
        expect(result.timeSignature).toBeNull();
        expect(result.tracks[0].name).toBe('MIDI 1');
        expect(result.tracks[0].notes[0]).toMatchObject({ note: 'C', octave: 3 });
    });

    it('拍子を読める（6/8）、Shift_JIS のトラック名を読める', () => {
        const bytes = new Uint8Array([
            ...header(1, 1, 480),
            ...track([
                0x00, 0xff, 0x58, 0x04, 6, 3, 24, 8,
                0x00, 0xff, 0x03, 0x06, 0x83, 0x73, 0x83, 0x41, 0x83, 0x6d,   // 「ピアノ」の Shift_JIS
                0x00, 0x90, 60, 100, 0x78, 0x80, 60, 0, ...END,
            ]),
        ]);
        const result = parseMidi(bytes);

        expect(result.timeSignature).toEqual([6, 8]);
        expect(result.tracks[0].name).toBe('ピアノ');
    });

    it('MIDI ファイルでないもの、読めない形式、途中で切れたファイルは、理由を付けて失敗する', () => {
        expect(() => parseMidi(new Uint8Array(ascii('RIFF....WAVEfmt ')))).toThrow('MIDI ファイルではありません');
        expect(() => parseMidi(new Uint8Array([]))).toThrow('MIDI ファイルではありません');
        expect(() => parseMidi(new Uint8Array([...header(2, 1, 480), ...track(END)]))).toThrow('フォーマット 2');
        expect(() => parseMidi(new Uint8Array([...header(1, 1, 0xe728), ...track(END)]))).toThrow('時間の単位が拍ではありません');
        // ノートオンの途中でファイルが終わる
        expect(() => parseMidi(new Uint8Array([...header(1, 1, 480), ...ascii('MTrk'), ...be32(20), 0x00, 0x90, 60])))
            .toThrow('途中で切れています');
        // 種類のバイトが無いままデータが始まる
        expect(() => parseMidi(new Uint8Array([...header(1, 1, 480), ...track([0x00, 60, 100, ...END])]))).toThrow('壊れています');
    });
});
