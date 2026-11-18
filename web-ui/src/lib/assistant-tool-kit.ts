/**
 * bunri DAW — アシスタントのツールの部品（引数の確かめ、高さ、ノートの並びの計算、画面の入口の形）。
 *
 * ツールの本体（lib/assistant-tools.ts と、種類ごとの lib/assistant-tools-*.ts）が共通で使う。
 * ここには、画面に触らない純粋な関数と、型だけを置く。
 *
 * - 引数は `unknown` として受け、ここの関数で確かめる（台帳は `strict` を使わない）。だめなら、何を直せば通るかが分かる文で
 *   失敗させる（`ToolError`。呼ぶ側が `is_error` の結果にして Claude に返し、Claude は直して呼び直せる）
 * - 画面の状態に触る部分は、入口をまとめたオブジェクト（`ToolEnv`）を引数に取る。本物は lib/assistant-env.ts が
 *   `useDaw()` などから作り、テストは偽物を渡す
 *
 * 位置はステップ（16 分音符。0 が 1 小節目の頭）、小節は 1 から、高さは `"C4"` の形。
 */
import type { PianoNote } from './engine';
import type { SongChart } from './chart';
import type { ProjectGrid } from './grid';
import type { RecordMode } from './midi-input';
import type { DiffResult, ReferenceSource } from './coach';
import type { SavedGuideResponse } from './guide';
import type { ProgressFacts } from './learn';
import type { ListenMode, PracticeLoop } from './practice';

/** 1 回の呼び出しで置けるノートの数の上限。 */
export const MAX_NOTES_PER_CALL = 512;
/** `get_notes` が 1 回で返すノートの数の上限。 */
export const MAX_NOTES_READ = 400;
/** トラックの名前の長さの上限（文字）。 */
export const TRACK_NAME_MAX = 40;
/** テンポの範囲（BPM。ヘッダの欄と同じ）。 */
export const BPM_MIN = 20;
export const BPM_MAX = 300;
/** オクターブの範囲（ピアノロールが描ける範囲。C0〜B8）。 */
export const OCTAVE_MIN = 0;
export const OCTAVE_MAX = 8;

/**
 * ツールの失敗（引数がだめ、対象が無い、など）。文は 2 つ持つ。
 *
 * - `message`: Claude に返す文。何を直せば通るかを、ツールや引数の名前を使って書く（Claude は、直して呼び直せる）
 * - `shown`: 操作ログと動きの記録に出す文（利用者向け）。ツールや引数の名前（`track_id` `get_project` など）と、
 *   「利用者に〜してもらってください」のような Claude への頼みを入れない。省くと `message` と同じ
 *   （もともと利用者にそのまま見せられる文のとき）
 */
export class ToolError extends Error {
    shown: string;

    constructor(message: string, shown?: string) {
        super(message);
        this.name = 'ToolError';
        this.shown = shown ?? message;
    }
}

/** 引数の指定が合わなかったときに、操作ログに出す文（どの引数の何がだめかは、Claude にだけ返す）。 */
export const ARG_SHOWN = '指定が合わず、行っていません';

/**
 * 引数の指定が合わなかった失敗（名前の間違い、型、範囲、組み合わせ）。Claude の呼び方の問題で、利用者が直すものではないので、
 * 操作ログには決まった文（`ARG_SHOWN`）だけを出す。
 */
export class ArgError extends ToolError {
    constructor(message: string) {
        super(message, ARG_SHOWN);
        this.name = 'ToolError';
    }
}

/** ツールの成功の結果。`summary` は操作ログに出す 1 行。ほかの項目は Claude に返すデータ。 */
export type ToolResult = { ok: true; summary: string } & Record<string, unknown>;

/**
 * ツールを実行した結果（成功か、失敗の理由）。
 * `message` は Claude に返す文、`shown` は操作ログに出す文（`ToolError` の説明）。 */
export type ToolOutcome = { ok: true; result: ToolResult } | { ok: false; message: string; shown: string };

// ---- 高さ ----

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 高さ（音名とオクターブ）。 */
export interface Pitch {
    note: string;
    octave: number;
}

/**
 * `"C4"` / `"F#3"` の形の高さを読む。フラット（`"Bb3"`）はシャープ（`A#3`）に直す（ピアノロールはシャープしか描けない）。
 * `"Cb4"` は `B3`、`"B#3"` は `C4` になる。
 *
 * @throws {ToolError} 形が違う、またはオクターブが 0〜8 の外
 */
export function parsePitch(value: unknown): Pitch {
    if (typeof value !== 'string') throw new ArgError(`高さは "C4" や "F#3" のような文字で指定してください（いまは ${show(value)}）`);
    const match = /^([A-Ga-g])([#♯b♭]?)(-?\d+)$/.exec(value.trim());
    if (!match) throw new ArgError(`高さ「${value}」を読めません。"C4" や "F#3" のように、音名とオクターブで指定してください`);
    const accidental = match[2] === '' ? 0 : (match[2] === '#' || match[2] === '♯' ? 1 : -1);
    // C4 = 60 の番号にしてから、シャープの名前に戻す (Cb や B# はオクターブをまたぐ)
    const midi = (Number(match[3]) + 1) * 12 + LETTER_SEMITONE[match[1].toUpperCase()] + accidental;
    const octave = Math.floor(midi / 12) - 1;
    if (octave < OCTAVE_MIN || octave > OCTAVE_MAX) {
        throw new ArgError(`高さ「${value}」は範囲の外です。C${OCTAVE_MIN}〜B${OCTAVE_MAX} の中で指定してください`);
    }
    return { note: SHARP_NAMES[((midi % 12) + 12) % 12], octave };
}

/** 高さを `"C4"` の形にする。 */
export function formatPitch(pitch: Pitch): string {
    return `${pitch.note}${pitch.octave}`;
}

/** 高さの番号（C4 = 60）。並べ替えに使う。 */
export function pitchNumber(pitch: Pitch): number {
    return (pitch.octave + 1) * 12 + SHARP_NAMES.indexOf(pitch.note);
}

// ---- 引数の確かめ ----

/** 値を、失敗の文に出す短い形にする。 */
export function show(value: unknown): string {
    if (value === undefined) return '指定なし';
    const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value) ?? String(value);
    return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

/** 引数を、項目の表として受ける。台帳に無い項目が在れば失敗させる（名前の間違いを、黙って無視しない）。 */
export function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (input === null || input === undefined) return {};
    if (typeof input !== 'object' || Array.isArray(input)) throw new ArgError('引数は、項目の名前と値の組（オブジェクト）で渡してください');
    const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw new ArgError(`「${unknown.join('」「')}」という項目はありません。`
            + (allowed.length > 0 ? `使える項目: ${allowed.join(', ')}` : 'このツールに引数はありません'));
    }
    return input as Record<string, unknown>;
}

/** 整数の項目を読む。省いてよい項目が無ければ undefined。 */
export function integer(args: Record<string, unknown>, key: string, range: { min?: number; max?: number; required?: boolean; what?: string } = {}): number | undefined {
    const value = args[key];
    const what = range.what ?? key;
    if (value === undefined || value === null) {
        if (range.required) throw new ArgError(`${what} を指定してください`);
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new ArgError(`${what} は整数で指定してください（いまは ${show(value)}）`);
    if (range.min !== undefined && value < range.min) throw new ArgError(`${what} は ${range.min} 以上にしてください（いまは ${value}）`);
    if (range.max !== undefined && value > range.max) throw new ArgError(`${what} は ${range.max} 以下にしてください（いまは ${value}）`);
    return value;
}

/** 数（小数も可）の項目を読む。 */
export function number(args: Record<string, unknown>, key: string, range: { min: number; max: number; required?: boolean }): number | undefined {
    const value = args[key];
    if (value === undefined || value === null) {
        if (range.required) throw new ArgError(`${key} を指定してください`);
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ArgError(`${key} は数で指定してください（いまは ${show(value)}）`);
    if (value < range.min || value > range.max) throw new ArgError(`${key} は ${range.min}〜${range.max} の範囲にしてください（いまは ${value}）`);
    return value;
}

/** true / false の項目を読む。 */
export function flag(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') throw new ArgError(`${key} は true か false で指定してください（いまは ${show(value)}）`);
    return value;
}

/** 決まった文字のどれか、の項目を読む。 */
export function choice<T extends string>(args: Record<string, unknown>, key: string, options: readonly T[], required = false): T | undefined {
    const value = args[key];
    if (value === undefined || value === null) {
        if (required) throw new ArgError(`${key} を指定してください（${options.map((o) => `"${o}"`).join(' / ')}）`);
        return undefined;
    }
    if (typeof value !== 'string' || !options.includes(value as T)) {
        throw new ArgError(`${key} は ${options.map((o) => `"${o}"`).join(' / ')} のどれかにしてください（いまは ${show(value)}）`);
    }
    return value as T;
}

/** トラックの名前を読む（前後の空白を除いて 1〜40 文字）。 */
export function readTrackName(value: unknown): string {
    if (typeof value !== 'string') throw new ArgError(`name は文字で指定してください（いまは ${show(value)}）`);
    const name = value.trim();
    const length = [...name].length;
    if (length < 1 || length > TRACK_NAME_MAX) throw new ArgError(`name は 1〜${TRACK_NAME_MAX} 文字にしてください（いまは ${length} 文字）`);
    return name;
}

/**
 * ノートの並び（`[{pitch, step, length, velocity?}, …]`）を読んで、ピアノロールのノートにする。
 * だめなノートが在れば、どのノートの何を直せばよいかを並べて失敗させる（最初の 5 個まで）。
 *
 * @param value - 引数の `notes`
 * @param maxSteps - ピアノロールの長さの上限（ステップ）。ノートの終わりは、ここまで
 * @param range - 在れば、ノートの始まりが入っていなければならない範囲 `[start, end)`（`replace_notes`）
 * @param allowEmpty - 空の並びを受けるか
 * @throws {ToolError}
 */
export function readNotes(value: unknown, maxSteps: number, range?: { start: number; end: number }, allowEmpty = false): PianoNote[] {
    if (!Array.isArray(value)) throw new ArgError('notes は、ノートの並び（配列）で指定してください。例: [{"pitch": "C4", "step": 0, "length": 4}]');
    if (value.length === 0 && !allowEmpty) throw new ArgError('notes が空です。置くノートを 1 個以上指定してください');
    if (value.length > MAX_NOTES_PER_CALL) {
        throw new ArgError(`notes は 1 回に ${MAX_NOTES_PER_CALL} 個までです（いまは ${value.length} 個）。小節ごとなどに分けて、何回かで呼んでください`);
    }
    const notes: PianoNote[] = [];
    const problems: string[] = [];
    value.forEach((raw, index) => {
        try {
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
                throw new ArgError('ノートは {"pitch": "C4", "step": 0, "length": 4} の形で指定してください');
            }
            const item = fields(raw, ['pitch', 'step', 'length', 'velocity']);
            if (item.pitch === undefined) throw new ArgError('pitch を指定してください（"C4" のような高さ）');
            const pitch = parsePitch(item.pitch);
            const step = integer(item, 'step', { min: 0, required: true })!;
            const length = integer(item, 'length', { min: 1, required: true })!;
            const velocity = integer(item, 'velocity', { min: 1, max: 127 });
            if (step + length > maxSteps) {
                throw new ArgError(`step + length が ${maxSteps} を超えています（ピアノロールの長さの上限。いまは ${step} + ${length}）`);
            }
            if (range && (step < range.start || step >= range.end)) {
                throw new ArgError(`step ${step} は範囲 [${range.start}, ${range.end}) の外です。置き換えるノートは、範囲の中で始めてください`);
            }
            const note: PianoNote = { note: pitch.note, octave: pitch.octave, step, length };
            if (velocity !== undefined) note.velocity = velocity;
            notes.push(note);
        } catch (e) {
            problems.push(`notes[${index}]: ${(e as Error).message}`);
        }
    });
    if (problems.length > 0) {
        const more = problems.length > 5 ? `（ほかに ${problems.length - 5} 個）` : '';
        throw new ArgError(`直すところがあります。${problems.slice(0, 5).join(' / ')}${more}`);
    }
    return notes;
}

/** ステップの範囲 `[start_step, end_step)` を読む。 */
export function readRange(args: Record<string, unknown>): { start: number; end: number } {
    const start = integer(args, 'start_step', { min: 0, required: true })!;
    const end = integer(args, 'end_step', { min: 1, required: true })!;
    if (end <= start) throw new ArgError(`end_step は start_step より大きくしてください（いまは start_step ${start}、end_step ${end}。end_step は範囲に含みません）`);
    return { start, end };
}

// ---- ノートの並びの計算（元の配列もノートも書き換えない。新しい配列を返す） ----

/** 同じ高さ・同じ位置か、を見る鍵。 */
export function noteKey(note: Pick<PianoNote, 'note' | 'octave' | 'step'>): string {
    return `${note.note}${note.octave}@${note.step}`;
}

/** ノートを写す（強さは、持っているときだけ）。 */
export function copyNote(n: PianoNote): PianoNote {
    const copy: PianoNote = { note: n.note, octave: n.octave, step: n.step, length: n.length };
    if (typeof n.velocity === 'number') copy.velocity = n.velocity;
    return copy;
}

/** 位置の順（同じ位置なら低い順）に並べる。 */
export function byPosition(a: PianoNote, b: PianoNote): number {
    return a.step - b.step || pitchNumber(a) - pitchNumber(b);
}

/**
 * ノートを足す。同じ高さ・同じ位置のノートは二重に置かない（すでに在るものも、足すものどうしも）。
 *
 * @returns 足した後の並び、実際に足したノート、置かなかった（重なった）数
 */
export function addNotes(existing: readonly PianoNote[], incoming: readonly PianoNote[]): { notes: PianoNote[]; added: PianoNote[]; skipped: number } {
    const seen = new Set(existing.map(noteKey));
    const added: PianoNote[] = [];
    for (const note of incoming) {
        const key = noteKey(note);
        if (seen.has(key)) continue;
        seen.add(key);
        added.push(copyNote(note));
    }
    return { notes: [...existing, ...added], added, skipped: incoming.length - added.length };
}

/** 範囲 `[start, end)` に「始まり」が入っているか。`pitches` が在れば、その高さだけ。 */
export function inRange(note: PianoNote, start: number, end: number, pitches?: ReadonlySet<string>): boolean {
    return note.step >= start && note.step < end && (!pitches || pitches.has(formatPitch(note)));
}

/**
 * 範囲 `[start, end)` に始まりが入っているノートを消す。
 *
 * @param pitches - 在れば、この高さ（`"C4"` の形。シャープにそろえたもの）のノートだけを消す
 * @returns 消した後の並びと、消したノート
 */
export function removeNotes(existing: readonly PianoNote[], start: number, end: number, pitches?: ReadonlySet<string>): { notes: PianoNote[]; removed: PianoNote[] } {
    const removed = existing.filter((n) => inRange(n, start, end, pitches));
    return { notes: existing.filter((n) => !inRange(n, start, end, pitches)), removed };
}

/**
 * 範囲 `[start, end)` に始まりが入っているノートを消して、渡したノートを足す。範囲の外のノートは、そのまま。
 *
 * @returns 置き換えた後の並び、消したノート、足したノート
 */
export function replaceNotes(existing: readonly PianoNote[], start: number, end: number, incoming: readonly PianoNote[]): { notes: PianoNote[]; removed: PianoNote[]; added: PianoNote[] } {
    const cut = removeNotes(existing, start, end);
    const put = addNotes(cut.notes, incoming);
    return { notes: put.notes, removed: cut.removed, added: put.added };
}

/** ステップの範囲 `[start, end)` を「1〜2 小節」の形にする。 */
export function barsLabel(start: number, end: number, perBar: number): string {
    const first = Math.floor(start / perBar) + 1;
    const last = Math.floor(Math.max(start, end - 1) / perBar) + 1;
    return first === last ? `${first} 小節` : `${first}〜${last} 小節`;
}

/** ノートの並びが在る小節（「1〜2 小節」）。 */
export function barsOfNotes(notes: readonly PianoNote[], perBar: number): string {
    const start = Math.min(...notes.map((n) => n.step));
    const end = Math.max(...notes.map((n) => n.step + n.length));
    return barsLabel(start, end, perBar);
}

/** ノートを、Claude に返す形（`{pitch, step, length, velocity?}`）にする。強さを持たないノートには付けない。 */
export function describeNote(n: PianoNote): Record<string, unknown> {
    const out: Record<string, unknown> = { pitch: formatPitch(n), step: n.step, length: n.length };
    if (typeof n.velocity === 'number') out.velocity = n.velocity;
    return out;
}

/** 拍子（1 小節の拍数）を「4/4」の形にする（ヘッダの拍子の欄と同じ呼び名）。 */
export function meterLabel(beatsPerBar: number): string {
    return beatsPerBar === 6 ? '6/8' : `${beatsPerBar}/4`;
}

// ---- 画面の入口 ----

/** ツールから見たトラック（再生エンジンの `Track` のうち、読むところだけ）。 */
export interface ToolTrack {
    id: number;
    name: string;
    role?: 'song' | 'part' | 'practice';
    /** パートの名前（API の識別子。`bass` `drums` など。MIDI ファイルから読み込んだお手本は `midi`） */
    part?: string;
    practiceOf?: number;
    mute: boolean;
    solo: boolean;
    gain: number;
    pan: number;
    pianoNotes: PianoNote[];
    referenceNotes?: PianoNote[];
    clips: readonly ToolClip[];
}

/** ツールから見た音声のクリップ（再生エンジンの `Clip` のうち、読むところだけ）。 */
export interface ToolClip {
    name: string;
    /** タイムラインの上の位置（秒） */
    offset: number;
    /** 長さ（秒） */
    duration: number;
    /** 音声が見つからなかったクリップ（プロジェクトを開いたときに、音声が無かった） */
    missing?: boolean;
}

/** ピアノロールで選んでいるノート（そのトラックの `pianoNotes` の中の番号）。 */
export interface ToolSelection {
    trackId: number;
    indices: number[];
}

/** 練習画面の設定（`PracticeState` のうち、アシスタントが読み書きするところ）。 */
export interface ToolPracticeSettings {
    loop: PracticeLoop;
    /** 速度（1 = そのまま） */
    speed: number;
    listen: ListenMode;
    showGhost: boolean;
}

/** 動いている、時間のかかる処理（ジョブ。パート分離・カルテの作成など）。 */
export interface ToolJob {
    id: string;
    /** 処理の名前（「パート分離と採譜」など） */
    title: string;
    /** 対象のファイルの名前 */
    filename: string | null;
    /** queued: 順番待ち / running: 実行中 */
    state: string;
    /** いまの段階の 1 行（「パートに分けています」など） */
    stage: string;
    /** 進み具合（0〜1）。分からなければ null */
    progress: number | null;
    /** 始めてからの秒数 */
    elapsedSec: number;
    /** 中止を頼んであるか */
    cancelRequested: boolean;
}

/** 書き出し・保存の結果。失敗は、利用者にそのまま見せられる文。 */
export type ToolFileOutcome = { ok: true; fileName: string } | { ok: false; message: string };

/** 場所を示した結果。 */
export interface PointResult {
    /** その場所が画面に出ていて、示せたか */
    shown: boolean;
}

/** ツールから見た MIDI 入力（`useMidiInput()` のうち、使うところだけ）。 */
export interface ToolMidi {
    available: boolean;
    connected: boolean;
    devices: string[];
    mode: RecordMode;
    connect: () => Promise<boolean>;
    disconnect: () => Promise<void>;
    setMode: (mode: RecordMode) => void;
}

/**
 * ツールが画面の状態を読み書きする入口。本物は lib/assistant-env.ts（`useDaw()`・タイムライン・ピアノロール・再生エンジン）。
 * 変える入口は、どれも元に戻す履歴に載る形で行う（依頼ごとの記録にまとまる）。
 */
export interface ToolEnv {
    /** いまのグリッド（テンポ・拍子・1 小節目の位置） */
    grid: () => ProjectGrid;
    /** いまのトラック（並び順）。開いているトラックの、ピアノロールの手元のノートを書き戻してから返す */
    tracks: () => readonly ToolTrack[];
    /** ピアノロールで開いているトラック。無ければ null */
    activeTrackId: () => number | null;
    /** ピアノロールの長さの上限（ステップ） */
    maxSteps: () => number;
    playing: () => boolean;
    /** 再生位置（秒） */
    positionSec: () => number;
    /** 曲の長さ（秒） */
    durationSec: () => number;
    chart: () => SongChart | null;
    /** 練習画面を開いているかと、そのパート・練習のトラック */
    practice: () => { open: boolean; partId: number | null; trackId: number | null };
    /** 練習画面の設定（区間ループ・速度・聴く・お手本）。練習画面を開いていなければ null */
    practiceSettings: () => ToolPracticeSettings | null;
    /** 練習画面の設定を変える（元に戻す履歴には載らない。画面の設定なので） */
    updatePractice: (patch: Partial<ToolPracticeSettings>) => void;
    /** ピアノロールで選んでいるノート。選んでいなければ null */
    selection: () => ToolSelection | null;
    /** 開いているトラックなら、そのノートを選んで短いあいだ光らせる（どこが変わったかを見せる）。開いていなければ何もしない */
    flashNotes: (trackId: number, indices: number[]) => void;
    metronome: () => boolean;
    setMetronome: (on: boolean) => void;
    /** カルテの ID（保存済みの再現ガイドを引くのに使う）。カルテが無ければ null */
    chartId: () => string | null;
    /** 学ぶ流れの進み具合（取り込んだか・カルテが在るか・パートに分けたか・打ち込んだか・比べたか） */
    learn: () => ProgressFacts;
    /** お手本の出どころ（MIDI ファイルから読み込んだお手本のときだけ、強さも比べる） */
    referenceSource: (trackId: number) => ReferenceSource;
    /** お手本と打ち込みの差分を取る（信号処理の側の計算。Claude は呼ばない） */
    requestDiff: (reference: PianoNote[], attempt: PianoNote[], stepsPerBar: number, source: ReferenceSource) => Promise<DiffResult>;
    /**
     * 練習画面の「比べる」を押したのと同じことをする（ノートに色が付き、学習の記録に 1 件残る）。
     * 比べられなかったら null（理由は練習画面に出る）
     */
    practiceCompare: () => Promise<DiffResult | null>;
    /** 保存済みの再現ガイドを読む（Claude は呼ばない） */
    savedGuide: (chartId: string, sectionId: string | null) => Promise<SavedGuideResponse>;
    /** 画面の場所を示す（そのタブを開き、その部品を短いあいだ光らせる）。`key` は lib/assistant-landmarks.ts の名前 */
    pointAt: (key: string) => Promise<PointResult>;
    /** 動いている、時間のかかる処理。無ければ null */
    job: () => ToolJob | null;
    /** 動いている処理の中止を頼む（すぐ止まるとは限らない） */
    cancelJob: (id: string) => Promise<void>;
    /** 原曲のファイルを、この画面で取り込んであるか（パート分離に要る。プロジェクトを開き直すと、取り込み直しが要る） */
    hasSongFile: () => boolean;
    /**
     * パート分離と採譜を始める（終わるのを待たない。数分かかる。終わると、パートのトラックができる）。
     * 始められなかったら、理由の文
     */
    startSeparation: (sensitivity: number) => Promise<{ started: true } | { started: false; reason: string }>;
    /** 再生で鳴る音をまとめて、WAV ファイルに書き出す */
    exportWav: () => Promise<ToolFileOutcome>;
    /** ピアノロールのノートを、MIDI ファイルに書き出す */
    exportMidi: () => ToolFileOutcome;
    /** プロジェクトの名前（まだ保存していなければ null）と、保存していない変更が在るか */
    project: () => { name: string | null; dirty: boolean };
    /** プロジェクトを保存する。初めての保存では、保存先を選ぶ窓が開く（選ぶのは利用者）。保存できたら true */
    saveProject: () => Promise<boolean>;
    /** クリップを、タイムラインの上の別の位置（秒）へ動かす */
    moveClip: (trackId: number, clipIndex: number, offsetSec: number) => void;
    deleteClip: (trackId: number, clipIndex: number) => void;
    /** クリップを複製して、すぐ後ろに置く */
    duplicateClip: (trackId: number, clipIndex: number) => void;
    /** クリップにエフェクトをかけて、かけた後のクリップに差し替える。かけられなかったら例外（理由つき） */
    applyEffect: (trackId: number, clipIndex: number, effect: string, params: Record<string, number>, label: string) => Promise<void>;
    /** @param fromSec - 始める位置（秒）。省略すると、いまの再生位置から */
    play: (fromSec?: number) => void;
    stop: () => void;
    /** 再生位置をそのステップへ移し、タイムラインとピアノロールをそこまでスクロールする */
    seekStep: (step: number) => void;
    setBpm: (bpm: number) => void;
    setBeatsPerBar: (beats: number) => void;
    addTrack: (name?: string) => { id: number; name: string };
    renameTrack: (id: number, name: string) => void;
    deleteTrack: (id: number) => void;
    /** トラックをピアノロールで開く */
    selectTrack: (id: number) => void;
    setMute: (id: number, on: boolean) => void;
    setSolo: (id: number, on: boolean) => void;
    setGain: (id: number, db: number) => void;
    setPan: (id: number, pan: number) => void;
    /** どのトラックでも（開いていても、いなくても）、ノートを丸ごと差し替える */
    setTrackNotes: (id: number, notes: PianoNote[], label: string) => void;
    /** そのパートの練習画面を開く（練習のトラックが無ければ作る） */
    openPractice: (partId: number) => void;
    closePractice: () => void;
    /** MIDI 入力の、いまの状態と操作。まだ用意できていなければ null */
    midi: () => ToolMidi | null;
}

/** 画面の状態が変わるのを、少しだけ待つ（React の描画を挟むもの。練習画面の開閉、MIDI 入力のつなぎ）。 */
export async function settle(done: () => boolean, timeoutMs = 600): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!done() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 15));
}

/** id でトラックを引く。無ければ、いま在る id を添えて失敗させる。 */
export function trackOf(args: Record<string, unknown>, env: ToolEnv): ToolTrack {
    const id = integer(args, 'track_id', { required: true })!;
    const tracks = env.tracks();
    const track = tracks.find((t) => t.id === id);
    if (!track) {
        const known = tracks.length > 0 ? `いま在るトラックの id: ${tracks.map((t) => `${t.id}（${t.name}）`).join('、')}` : 'いまはトラックが 1 本もありません';
        throw new ToolError(`track_id ${id} のトラックはありません。get_project で id を確かめてください。${known}`, 'そのトラックが見つかりませんでした');
    }
    return track;
}

/** トラックの役割を、Claude に返す名前にする（役割の無い、自由に作ったトラックは "free"）。 */
export function roleOf(track: ToolTrack): string {
    return track.role ?? 'free';
}

/** ツール 1 つの定義。 */
export interface ToolSpec {
    /** 画面での名前（台帳の `label` と同じ） */
    label: string;
    /** 実行中に操作ログへ出す文（「〜しています…」） */
    running: string;
    /** 読むだけか、変えるか（台帳の `access` と同じ）。「変える」を実行する前に、依頼ごとの記録を開く */
    access: 'read' | 'write';
    /** 引数の項目の名前（台帳の `input_schema.properties` と同じ） */
    keys: readonly string[];
    run: (args: Record<string, unknown>, env: ToolEnv) => ToolResult | Promise<ToolResult>;
}

/** 小数を、決まった桁で丸める。 */
export function round(value: number, digits: number): number {
    const scale = 10 ** digits;
    return Math.round((Number.isFinite(value) ? value : 0) * scale) / scale;
}
