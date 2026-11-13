/**
 * bunri DAW — ピアノロールのノートと、標準 MIDI ファイル（SMF）の読み書き。
 *
 * 採譜して直したノートをほかの DAW や楽譜ソフトへ持っていき（`notesToMidi`）、
 * ほかで作った MIDI をピアノロールへ持ってくる（`parseMidi`）ためのもの。
 * 外部のライブラリは使わず、SMF を直接組み立て、直接読む。
 *
 * 書き出し:
 * - フォーマット 1。分解能は 4 分音符あたり 480 tick。ピアノロールの 1 ステップ（16 分音符）は 120 tick
 * - 先頭のトラックにテンポと拍子を置き、ノートの在るトラックを 1 本ずつ続ける
 * - チャンネルはトラックごとに分ける（10 番はドラム用なので飛ばす）
 *
 * 読み込み:
 * - フォーマット 0 と 1。ランニングステータス、強さ 0 のノートオン（= ノートオフ）、テンポ、拍子、トラック名を扱う
 * - 位置と長さは、ピアノロールの単位（16 分音符）に丸める。丸めで変わった数は `loss` で返す
 */
import { DEFAULT_VELOCITY, type PianoNote } from './engine';

/** 4 分音符あたりの tick 数。 */
export const TICKS_PER_QUARTER = 480;
/** ピアノロールの 1 ステップ（16 分音符）の tick 数。 */
export const TICKS_PER_STEP = TICKS_PER_QUARTER / 4;
/** ノートの強さ（ベロシティ）を、MIDI に書ける範囲（1〜127）にする。強さを持たないノートは既定の強さ。 */
function velocityOf(note: PianoNote): number {
    const v = typeof note.velocity === 'number' && Number.isFinite(note.velocity) ? Math.round(note.velocity) : DEFAULT_VELOCITY;
    return Math.max(1, Math.min(127, v));
}

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
    const events: { tick: number; on: boolean; number: number; velocity: number }[] = [];
    for (const n of track.notes) {
        const number = noteNumber(n.note, n.octave);
        if (number === null || !(n.length > 0) || !(n.step >= 0)) continue;
        const start = Math.round(n.step * TICKS_PER_STEP);
        const end = Math.round((n.step + n.length) * TICKS_PER_STEP);
        events.push({ tick: start, on: true, number, velocity: velocityOf(n) }, { tick: end, on: false, number, velocity: 0 });
    }
    // 同じ時刻では、音を止めるほうを先に置く（同じ高さの音が続くとき、次の音まで止めないため）
    events.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on) || a.number - b.number);

    const data = [...meta(0x03, Array.from(new TextEncoder().encode(track.name)))];
    let last = 0;
    for (const e of events) {
        data.push(...variableLength(e.tick - last), (e.on ? 0x90 : 0x80) | channel, e.number, e.velocity);
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

// ── 読み込み ─────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** ドラム用のチャンネル（10 番 = 添字 9）。ノート番号は音の高さではなく、打楽器の種類を表す。 */
const DRUM_CHANNEL = 9;

/** 読み込んだノート。ピアノロールのノートに、強さ（ベロシティ 1〜127）を添えたもの。 */
export interface ImportedNote extends PianoNote {
    velocity: number;
}

/** 読み込んだトラック 1 本。 */
export interface MidiImportTrack {
    /** トラック名。ファイルに無ければ "MIDI 1" のような名前を付ける。 */
    name: string;
    /** ノート（位置の順）。 */
    notes: ImportedNote[];
    /** ドラム用のチャンネルのノートか。ノートの高さは打楽器の種類なので、音程としては読めない。 */
    isDrum: boolean;
    /** このトラックで、位置か長さを 16 分音符に丸めたノートの数。 */
    rounded: number;
    /** このトラックで、丸めた結果重なったので 1 つにまとめたノートの数。 */
    merged: number;
    /** このトラックで、止める合図が無くトラックの終わりで止めたノートの数。 */
    unterminated: number;
}

/** 読み込みで、元のファイルから変わったこと・落ちたことの数（ファイル全体）。トラックごとの数は、各トラックが持つ。 */
export interface MidiImportLoss {
    /** 位置か長さが 16 分音符の格子に乗っておらず、丸めたノートの数（3 連符、32 分音符、人の演奏の揺れなど）。 */
    rounded: number;
    /** 丸めた結果、同じ高さ・同じ位置に重なったので、1 つにまとめたノートの数。 */
    merged: number;
    /** 止める合図（ノートオフ）が無く、トラックの終わりで止めたノートの数。 */
    unterminated: number;
    /** 途中のテンポの変化の数（ピアノロールのテンポは 1 つなので、最初のテンポだけを使う）。 */
    tempoChanges: number;
}

/** 読み込んだ結果。 */
export interface MidiImportResult {
    /** 最初のテンポ（BPM）。ファイルに無ければ null（MIDI の既定は 120）。 */
    bpm: number | null;
    /** 最初の拍子 [分子, 分母]。ファイルに無ければ null。 */
    timeSignature: [number, number] | null;
    /** ノートの在るトラック。 */
    tracks: MidiImportTrack[];
    loss: MidiImportLoss;
}

/** トラック名などの文字列を読む。UTF-8 として読めなければ、日本語の MIDI に多い Shift_JIS で読む。 */
function decodeText(bytes: Uint8Array): string {
    for (const encoding of ['utf-8', 'shift_jis']) {
        try {
            return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/\0+$/, '').trim();
        } catch {
            // 次の文字コードで試す
        }
    }
    return Array.from(bytes, (b) => String.fromCharCode(b)).join('').trim();
}

/** 読んでいる途中のノート（鳴り始めたが、まだ止まっていない）。 */
interface OpenNote { tick: number; velocity: number }
/** tick のままのノート。 */
interface RawNote { channel: number; pitch: number; start: number; end: number; velocity: number; closed: boolean }

/** MTrk チャンク 1 本を読んで、tick のままのノートと、メタ情報を返す。 */
function readTrack(bytes: Uint8Array, begin: number, end: number) {
    let pos = begin;
    const need = (count: number) => { if (pos + count > end) throw new Error('MIDI ファイルが途中で切れています'); };
    const variable = () => {
        let value = 0;
        for (let i = 0; i < 4; i++) {
            need(1);
            const byte = bytes[pos++];
            value = value * 128 + (byte & 0x7f);
            if (!(byte & 0x80)) return value;
        }
        throw new Error('MIDI ファイルが壊れています（長さの表し方が正しくありません）');
    };

    const notes: RawNote[] = [];
    const tempos: { tick: number; bpm: number }[] = [];
    const signatures: { tick: number; value: [number, number] }[] = [];
    // チャンネルと高さごとに、鳴っているノートを先に鳴ったものから順に持つ
    const open = new Map<number, OpenNote[]>();
    let name = '';
    let tick = 0;
    let status = 0;

    const noteOff = (channel: number, pitch: number) => {
        const started = open.get(channel * 128 + pitch)?.shift();
        if (started) notes.push({ channel, pitch, start: started.tick, end: tick, velocity: started.velocity, closed: true });
    };

    while (pos < end) {
        tick += variable();
        need(1);
        let first = bytes[pos];
        if (first & 0x80) { pos++; } else {
            // 上位ビットの立っていないバイトで始まるのは、直前と同じ種類のイベント（ランニングステータス）
            if (status < 0x80) throw new Error('MIDI ファイルが壊れています（イベントの種類がありません）');
            first = status;
        }

        if (first === 0xff) {
            need(1);
            const type = bytes[pos++];
            const length = variable();
            need(length);
            const data = bytes.subarray(pos, pos + length);
            pos += length;
            if (type === 0x03 && !name) name = decodeText(data);
            else if (type === 0x51 && length >= 3) {
                const micros = (data[0] << 16) | (data[1] << 8) | data[2];
                if (micros > 0) tempos.push({ tick, bpm: 60_000_000 / micros });
            } else if (type === 0x58 && length >= 2) signatures.push({ tick, value: [data[0], 2 ** data[1]] });
            else if (type === 0x2f) break;
            continue;
        }
        if (first === 0xf0 || first === 0xf7) {
            // システムエクスクルーシブ。中身は使わないので飛ばす
            const length = variable();
            need(length);
            pos += length;
            continue;
        }
        if (first >= 0xf0) {
            // ファイルには本来現れないシステムメッセージ。データの長さだけ飛ばす
            const length = first === 0xf2 ? 2 : first === 0xf1 || first === 0xf3 ? 1 : 0;
            need(length);
            pos += length;
            continue;
        }

        status = first;
        const kind = first & 0xf0, channel = first & 0x0f;
        const length = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
        need(length);
        const a = bytes[pos], b = length === 2 ? bytes[pos + 1] : 0;
        pos += length;
        if (kind === 0x90 && b > 0) {
            const key = channel * 128 + a;
            if (!open.has(key)) open.set(key, []);
            open.get(key)!.push({ tick, velocity: b });
        } else if (kind === 0x80 || kind === 0x90) {
            // 強さ 0 のノートオンは、ノートオフと同じ意味
            noteOff(channel, a);
        }
    }

    // 止める合図の無いノートは、トラックの終わりで止める
    for (const [key, started] of open) {
        for (const note of started) {
            notes.push({ channel: Math.floor(key / 128), pitch: key % 128, start: note.tick, end: Math.max(tick, note.tick), velocity: note.velocity, closed: false });
        }
    }
    return { name, notes, tempos, signatures };
}

/**
 * 標準 MIDI ファイルを読んで、ピアノロールのノートにする。
 *
 * - フォーマット 1 は、MTrk 1 本を 1 トラックにする
 * - フォーマット 0（全部が 1 本に入っている）は、チャンネルごとに分けて 1 トラックにする
 * - ドラム用のチャンネル（10 番）のノートは、同じ MTrk の中でも別のトラックに分け、`isDrum` を立てる
 * - 位置と長さは 16 分音符に丸める（最短 1 ステップ）。丸めで変わった数などは `loss` で返す
 * - ピアノロールのテンポは 1 つなので、最初のテンポだけを返す
 *
 * @param bytes - MIDI ファイルの中身
 * @returns テンポ・拍子・トラック・落ちた情報の数
 * @throws MIDI ファイルではない、読めない形式（フォーマット 2、時間の単位が SMPTE）、途中で切れている場合
 */
export function parseMidi(bytes: Uint8Array): MidiImportResult {
    const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
    const u32 = (at: number) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    const u16 = (at: number) => (bytes[at] << 8) | bytes[at + 1];

    if (bytes.length < 14 || text(0) !== 'MThd') throw new Error('MIDI ファイルではありません');
    const headerLength = u32(4);
    const format = u16(8), division = u16(12);
    if (format !== 0 && format !== 1) throw new Error(`この形式の MIDI ファイルは読めません（フォーマット ${format}）`);
    if (division & 0x8000 || division === 0) throw new Error('この形式の MIDI ファイルは読めません（時間の単位が拍ではありません）');
    const ticksPerStep = division / 4;

    const chunks: ReturnType<typeof readTrack>[] = [];
    let pos = 8 + headerLength;
    while (pos + 8 <= bytes.length) {
        const type = text(pos), length = u32(pos + 4);
        const begin = pos + 8, end = Math.min(bytes.length, begin + length);
        if (type === 'MTrk') chunks.push(readTrack(bytes, begin, end));
        pos = begin + length;
    }

    const tempos = chunks.flatMap((c) => c.tempos).sort((a, b) => a.tick - b.tick);
    const signatures = chunks.flatMap((c) => c.signatures).sort((a, b) => a.tick - b.tick);
    const loss: MidiImportLoss = { rounded: 0, merged: 0, unterminated: 0, tempoChanges: Math.max(0, tempos.length - 1) };

    const tracks: MidiImportTrack[] = [];
    for (const chunk of chunks) {
        // ノートを、トラックに分ける単位でまとめる。フォーマット 0 はチャンネルごと、
        // フォーマット 1 は MTrk ごと（ドラムのチャンネルだけは別にする）
        const groups = new Map<string, RawNote[]>();
        for (const note of chunk.notes) {
            const drum = note.channel === DRUM_CHANNEL;
            const key = format === 0 ? `ch${note.channel}` : drum ? 'drum' : 'notes';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(note);
        }
        for (const [key, raw] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
            const isDrum = raw[0].channel === DRUM_CHANNEL;
            const placed = new Map<string, ImportedNote>();
            const counts = { rounded: 0, merged: 0, unterminated: 0 };
            for (const note of raw.sort((a, b) => a.start - b.start || a.pitch - b.pitch)) {
                if (!note.closed) counts.unterminated += 1;
                const step = Math.round(note.start / ticksPerStep);
                const length = Math.max(1, Math.round(note.end / ticksPerStep) - step);
                if (step * ticksPerStep !== note.start || (step + length) * ticksPerStep !== note.end) counts.rounded += 1;
                const slot = `${note.pitch}:${step}`;
                const existing = placed.get(slot);
                if (existing) {
                    // 丸めたら同じ高さ・同じ位置に重なった。長いほうを残して 1 つにする
                    counts.merged += 1;
                    existing.length = Math.max(existing.length, length);
                    existing.velocity = Math.max(existing.velocity, note.velocity);
                    continue;
                }
                placed.set(slot, {
                    note: NOTE_NAMES[note.pitch % 12], octave: Math.floor(note.pitch / 12) - 1, step, length, velocity: note.velocity,
                });
            }
            const base = chunk.name || `MIDI ${tracks.length + 1}`;
            const suffix = format === 0 && groups.size > 1 ? `（チャンネル ${raw[0].channel + 1}）` : isDrum && key === 'drum' && groups.size > 1 ? '（ドラム）' : '';
            tracks.push({ name: base + suffix, notes: [...placed.values()], isDrum, ...counts });
            loss.rounded += counts.rounded;
            loss.merged += counts.merged;
            loss.unterminated += counts.unterminated;
        }
    }

    return {
        bpm: tempos.length > 0 ? Math.round(tempos[0].bpm * 100) / 100 : null,
        timeSignature: signatures.length > 0 ? signatures[0].value : null,
        tracks,
        loss,
    };
}
