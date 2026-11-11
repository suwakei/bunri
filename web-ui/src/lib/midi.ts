/**
 * bunri DAW — ピアノロールのノートを標準 MIDI ファイル（SMF）に書き出す。
 *
 * 採譜して直したノートを、ほかの DAW や楽譜ソフトへ持っていけるようにするためのもの。
 * 外部のライブラリは使わず、SMF フォーマット 1 を直接組み立てる。
 *
 * - 分解能は 4 分音符あたり 480 tick。ピアノロールの 1 ステップ（16 分音符）は 120 tick
 * - 先頭のトラックにテンポと拍子を置き、ノートの在るトラックを 1 本ずつ続ける
 * - チャンネルはトラックごとに分ける（10 番はドラム用なので飛ばす）
 */
import type { PianoNote } from './engine';

/** 4 分音符あたりの tick 数。 */
export const TICKS_PER_QUARTER = 480;
/** ピアノロールの 1 ステップ（16 分音符）の tick 数。 */
export const TICKS_PER_STEP = TICKS_PER_QUARTER / 4;
/** ノートの強さ（ベロシティ）。ピアノロールは強弱を持たないので固定値。 */
const VELOCITY = 96;

const NOTE_INDEX: Record<string, number> = {
    C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

/** 書き出すトラック 1 本。 */
export interface MidiTrackInput {
    /** トラック名（MIDI のトラック名として入る）。 */
    name: string;
    /** ノート。 */
    notes: PianoNote[];
}

/**
 * 音名とオクターブを MIDI ノート番号にする（C4 = 60）。
 * 知らない音名や、0〜127 に収まらないものは null。
 */
export function noteNumber(note: string, octave: number): number | null {
    const index = NOTE_INDEX[note];
    if (index === undefined || !Number.isInteger(octave)) return null;
    const number = (octave + 1) * 12 + index;
    return number >= 0 && number <= 127 ? number : null;
}

/** 可変長数値（VLQ）にする。SMF のデルタタイムと長さの表し方。 */
export function variableLength(value: number): number[] {
    let v = Math.max(0, Math.floor(value));
    const bytes = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
        bytes.unshift((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
    }
    return bytes;
}

function uint32(value: number): number[] {
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function uint16(value: number): number[] {
    return [(value >>> 8) & 0xff, value & 0xff];
}

/** チャンクを組み立てる（種類 4 文字 + 長さ + 中身）。 */
function chunk(type: string, data: number[]): number[] {
    return [...Array.from(type, (c) => c.charCodeAt(0)), ...uint32(data.length), ...data];
}

/** メタイベント（デルタタイム 0）を組み立てる。 */
function meta(type: number, data: number[]): number[] {
    return [0x00, 0xff, type, ...variableLength(data.length), ...data];
}

const END_OF_TRACK = [0x00, 0xff, 0x2f, 0x00];

/** テンポと拍子を置く先頭のトラック。 */
function conductorTrack(bpm: number): number[] {
    const microsPerQuarter = Math.round(60_000_000 / bpm);
    return chunk('MTrk', [
        ...meta(0x51, [(microsPerQuarter >>> 16) & 0xff, (microsPerQuarter >>> 8) & 0xff, microsPerQuarter & 0xff]),
        // 拍子 4/4（分母は 2 の冪で表すので 2）、メトロノームは 4 分音符ごと
        ...meta(0x58, [4, 2, 24, 8]),
        ...END_OF_TRACK,
    ]);
}

/** ノートの在るトラック 1 本。 */
function noteTrack(track: MidiTrackInput, channel: number): number[] {
    const events: { tick: number; on: boolean; number: number }[] = [];
    for (const n of track.notes) {
        const number = noteNumber(n.note, n.octave);
        if (number === null || !(n.length > 0) || !(n.step >= 0)) continue;
        const start = Math.round(n.step * TICKS_PER_STEP);
        const end = Math.round((n.step + n.length) * TICKS_PER_STEP);
        events.push({ tick: start, on: true, number }, { tick: end, on: false, number });
    }
    // 同じ時刻では、音を止めるほうを先に置く（同じ高さの音が続くとき、次の音まで止めないため）
    events.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on) || a.number - b.number);

    const data = [...meta(0x03, Array.from(new TextEncoder().encode(track.name)))];
    let last = 0;
    for (const e of events) {
        data.push(...variableLength(e.tick - last), (e.on ? 0x90 : 0x80) | channel, e.number, e.on ? VELOCITY : 0);
        last = e.tick;
    }
    data.push(...END_OF_TRACK);
    return chunk('MTrk', data);
}

/** トラックの番号から MIDI チャンネルを決める（10 番 = 添字 9 はドラム用なので飛ばす）。 */
export function channelFor(index: number): number {
    const melodic = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
    return melodic[index % melodic.length];
}

/**
 * ノートを標準 MIDI ファイルのバイト列にする。
 *
 * ノートの無いトラックは書き出さない。
 *
 * @param tracks - 書き出すトラック
 * @param bpm - テンポ
 * @returns SMF フォーマット 1 のバイト列
 * @throws 書き出せるノートが 1 つも無い場合、またはテンポが正しくない場合
 */
export function notesToMidi(tracks: MidiTrackInput[], bpm: number): Uint8Array {
    if (!(bpm > 0) || !Number.isFinite(bpm)) throw new Error('テンポが正しくありません');
    const withNotes = tracks.filter((t) => t.notes.some((n) => noteNumber(n.note, n.octave) !== null && n.length > 0 && n.step >= 0));
    if (withNotes.length === 0) throw new Error('書き出せるノートがありません');

    const bytes = [
        ...chunk('MThd', [...uint16(1), ...uint16(withNotes.length + 1), ...uint16(TICKS_PER_QUARTER)]),
        ...conductorTrack(bpm),
        ...withNotes.flatMap((track, i) => noteTrack(track, channelFor(i))),
    ];
    return new Uint8Array(bytes);
}
