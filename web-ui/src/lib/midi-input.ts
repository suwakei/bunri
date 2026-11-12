/**
 * bunri DAW — MIDI キーボードからの入力。
 *
 * 3 つの部品を持つ。
 *
 * 1. メッセージの読み取り（`parseMidiMessage`）: バイト列を「鍵盤を押した / 離した」にする
 * 2. 入力元（`pickMidiSource`）: ブラウザの Web MIDI API、またはデスクトップ版のネイティブ側。
 *    mac の WebView は Web MIDI を持たないので、デスクトップ版では Rust が OS の MIDI を受けて
 *    イベントで渡してくる（src-tauri/src/midi.rs）。どちらも同じバイト列で届く
 * 3. 録り方（`MidiNoteRecorder`）: 押した / 離したを、ピアノロールのノートにする。
 *    ステップ入力（弾くたびに 1 つずつ進む）と、リアルタイム録音（再生に合わせて弾く）の 2 通り
 */
import { invokeDesktop, isDesktop, listenDesktop } from './api';
import type { PianoNote } from './engine';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** 鍵盤の操作 1 つ。 */
export interface NoteEvent {
    type: 'on' | 'off';
    /** MIDI ノート番号（60 = C4） */
    pitch: number;
    /** 強さ（押したときは 1〜127、離したときは 0） */
    velocity: number;
}

/**
 * MIDI メッセージを「鍵盤を押した / 離した」にする。それ以外（ペダル、ピッチベンドなど）は null。
 *
 * 強さ 0 の「押した」は「離した」として扱う（多くの鍵盤がそう送ってくる）。
 * チャンネルは区別しない。
 */
export function parseMidiMessage(bytes: ArrayLike<number> | null | undefined): NoteEvent | null {
    if (!bytes || bytes.length < 3) return null;
    const kind = bytes[0] & 0xf0;
    const pitch = bytes[1] & 0x7f;
    const velocity = bytes[2] & 0x7f;
    if (kind === 0x90 && velocity > 0) return { type: 'on', pitch, velocity };
    if (kind === 0x80 || kind === 0x90) return { type: 'off', pitch, velocity: 0 };
    return null;
}

/** MIDI ノート番号を、音名とオクターブにする（60 → C4）。 */
export function pitchToNote(pitch: number): { note: string; octave: number } {
    return { note: NOTE_NAMES[((pitch % 12) + 12) % 12], octave: Math.floor(pitch / 12) - 1 };
}

/** ステップ位置を「2 小節 3 拍」の形にする。 */
export function cursorLabel(step: number, beatsPerBar: number): string {
    const stepsPerBar = Math.max(1, beatsPerBar) * 4;
    return `${Math.floor(step / stepsPerBar) + 1} 小節 ${Math.floor((step % stepsPerBar) / 4) + 1} 拍`;
}

/** 録り方。off: 録らない（音を鳴らすだけ）/ step: ステップ入力 / realtime: リアルタイム録音 */
export type RecordMode = 'off' | 'step' | 'realtime';

/** `MidiNoteRecorder.handle` の結果。画面の状態表示に使う。 */
export type RecordResult =
    | { kind: 'added'; note: PianoNote }
    | { kind: 'ignored' }
    /** range: ピアノロールの音域の外 / end: ピアノロールの末尾を越える / stopped: 再生していない */
    | { kind: 'skipped'; reason: 'range' | 'end' | 'stopped' };

/** `MidiNoteRecorder` の設定。 */
export interface RecorderOptions {
    /** 再生中なら現在位置（ステップ単位、小数）、再生していなければ null。 */
    position: () => number | null;
    /** ノートを追加する先（ピアノロール）。 */
    addNote: (note: PianoNote) => void;
    /** ピアノロールの長さ（ステップ）。 */
    totalSteps: number;
    /** 表示できる最低のオクターブ（含む）。 */
    minOctave: number;
    /** 表示できる最高のオクターブ（含まない）。 */
    maxOctave: number;
    /**
     * 録る範囲（ステップ。`end` は含まない）。練習画面の区間ループ。無ければ（null）ピアノロール全体。
     * ステップ入力は範囲の頭から始めて、終わりで止まる。リアルタイム録音は、区間の終わりをまたいで
     * 押していたノートを、区間の終わりまでの長さにする（再生位置が区間の頭に戻るため）。
     */
    bounds?: () => { start: number; end: number } | null;
}

/**
 * 鍵盤の操作を、ピアノロールのノートにする。
 *
 * - ステップ入力: 鍵盤を押すと、カーソルの位置に決まった長さのノートを置く。
 *   押している鍵盤を全部離すと、カーソルがその長さぶん進む。同時に押せば和音になる。
 *   リズムを取れなくても、音の高さだけ追って打ち込める
 * - リアルタイム録音: 再生中に鍵盤を押した位置から離した位置までを、ノートにする。
 *   位置と長さは 16 分音符に丸める。再生していないときは録らない
 */
export class MidiNoteRecorder {
    mode: RecordMode = 'off';
    /** ステップ入力で置くノートの長さ（ステップ。4 = 4 分音符）。 */
    stepLength = 4;
    /** ステップ入力の、次に置く位置（ステップ）。 */
    cursor = 0;

    private options: RecorderOptions;
    /** リアルタイム録音で、押している鍵盤と押した位置。 */
    private held = new Map<number, number>();
    /** ステップ入力で、押している鍵盤。 */
    private stepHeld = new Set<number>();
    /** ステップ入力で、いまの和音にノートを 1 つでも置いたか。 */
    private stepPlaced = false;

    constructor(options: RecorderOptions) {
        this.options = options;
    }

    /** 録り方を切り替える。押しかけの鍵盤は忘れる。 */
    setMode(mode: RecordMode): void {
        this.mode = mode;
        this.held.clear();
        this.stepHeld.clear();
        this.stepPlaced = false;
    }

    /** ピアノロールで表示できる高さか。 */
    private inRange(pitch: number): boolean {
        const { octave } = pitchToNote(pitch);
        return octave >= this.options.minOctave && octave < this.options.maxOctave;
    }

    /** 鍵盤の操作を 1 つ処理する。 */
    handle(event: NoteEvent): RecordResult {
        if (this.mode === 'step') return this.handleStep(event);
        if (this.mode === 'realtime') return this.handleRealtime(event);
        return { kind: 'ignored' };
    }

    private handleStep(event: NoteEvent): RecordResult {
        if (event.type === 'off') {
            this.stepHeld.delete(event.pitch);
            if (this.stepHeld.size === 0 && this.stepPlaced) {
                this.cursor += this.stepLength;
                this.stepPlaced = false;
            }
            return { kind: 'ignored' };
        }
        this.stepHeld.add(event.pitch);
        if (!this.inRange(event.pitch)) return { kind: 'skipped', reason: 'range' };
        const bounds = this.options.bounds?.() ?? null;
        // 範囲の外にカーソルが在れば、範囲の頭から始める (和音の途中では動かさない)
        if (bounds && !this.stepPlaced && (this.cursor < bounds.start || this.cursor >= bounds.end)) this.cursor = bounds.start;
        if (this.cursor + this.stepLength > (bounds ? bounds.end : this.options.totalSteps)) return { kind: 'skipped', reason: 'end' };
        const note = { ...pitchToNote(event.pitch), step: this.cursor, length: this.stepLength };
        this.options.addNote(note);
        this.stepPlaced = true;
        return { kind: 'added', note };
    }

    private handleRealtime(event: NoteEvent): RecordResult {
        const position = this.options.position();
        if (event.type === 'on') {
            if (position === null) return { kind: 'skipped', reason: 'stopped' };
            if (!this.inRange(event.pitch)) return { kind: 'skipped', reason: 'range' };
            this.held.set(event.pitch, position);
            return { kind: 'ignored' };
        }
        const start = this.held.get(event.pitch);
        if (start === undefined) return { kind: 'ignored' };
        this.held.delete(event.pitch);
        const step = Math.max(0, Math.round(start));
        if (step >= this.options.totalSteps) return { kind: 'skipped', reason: 'end' };
        // 離す前に再生が止まっていたら、長さは最短（16 分音符 1 つ）にする
        let end = position ?? start;
        // 区間ループの終わりをまたいだ (再生位置が頭に戻った) ら、区間の終わりまでにする
        const bounds = this.options.bounds?.() ?? null;
        if (bounds && end < start) end = bounds.end;
        const length = Math.min(Math.max(1, Math.round(end - start)), this.options.totalSteps - step);
        const note = { ...pitchToNote(event.pitch), step, length };
        this.options.addNote(note);
        return { kind: 'added', note };
    }
}

/** MIDI の入力元。 */
export interface MidiSource {
    /** web: ブラウザの Web MIDI API / desktop: デスクトップ版のネイティブ側 */
    kind: 'web' | 'desktop';
    /**
     * 入力を開く。つながっている機器をすべて対象にする。
     *
     * @param onMessage - MIDI メッセージを受けるたびに呼ばれる
     * @param onDevices - つながっている機器の名前が分かったとき・変わったときに呼ばれる
     */
    start(onMessage: (bytes: ArrayLike<number>) => void, onDevices: (names: string[]) => void): Promise<void>;
    /** 入力を閉じる。 */
    stop(): Promise<void>;
}

/** Web MIDI API のうち、ここで使うぶん。 */
interface WebMidiInput {
    name?: string | null;
    state?: string;
    onmidimessage: ((event: { data: Uint8Array | null }) => void) | null;
}
interface WebMidiAccess {
    inputs: { forEach(fn: (input: WebMidiInput) => void): void };
    onstatechange: (() => void) | null;
}
type RequestMidiAccess = (options?: { sysex?: boolean }) => Promise<WebMidiAccess>;

function webMidiRequest(): RequestMidiAccess | null {
    const nav = globalThis.navigator as (Navigator & { requestMIDIAccess?: RequestMidiAccess }) | undefined;
    return nav && typeof nav.requestMIDIAccess === 'function' ? nav.requestMIDIAccess.bind(nav) : null;
}

/** ブラウザの Web MIDI API を使う入力元。機器の抜き差しにも追従する。 */
class WebMidiSource implements MidiSource {
    kind = 'web' as const;
    private access: WebMidiAccess | null = null;

    async start(onMessage: (bytes: ArrayLike<number>) => void, onDevices: (names: string[]) => void): Promise<void> {
        const request = webMidiRequest();
        if (!request) throw new Error('このブラウザは MIDI 入力に対応していません');
        const access = await request({ sysex: false });
        this.access = access;
        const attach = () => {
            const names: string[] = [];
            access.inputs.forEach((input) => {
                if (input.state === 'disconnected') return;
                input.onmidimessage = (event) => { if (event.data) onMessage(event.data); };
                names.push(input.name || 'MIDI 入力');
            });
            onDevices(names);
        };
        access.onstatechange = attach;
        attach();
    }

    async stop(): Promise<void> {
        if (!this.access) return;
        this.access.onstatechange = null;
        this.access.inputs.forEach((input) => { input.onmidimessage = null; });
        this.access = null;
    }
}

/** デスクトップ版のネイティブ側（Rust）を使う入力元。 */
class DesktopMidiSource implements MidiSource {
    kind = 'desktop' as const;
    private unlisten: (() => void) | null = null;

    async start(onMessage: (bytes: ArrayLike<number>) => void, onDevices: (names: string[]) => void): Promise<void> {
        await this.stop();
        // 先に受け口を用意してから開く（開いた直後のメッセージを取りこぼさないため）
        this.unlisten = await listenDesktop<number[]>('midi-message', onMessage);
        try {
            onDevices(await invokeDesktop<string[]>('midi_start'));
        } catch (e) {
            await this.stop();
            throw e;
        }
    }

    async stop(): Promise<void> {
        if (this.unlisten) {
            this.unlisten();
            this.unlisten = null;
            await invokeDesktop<void>('midi_stop');
        }
    }
}

/**
 * この環境で使える MIDI の入力元を返す。使えなければ null。
 *
 * Web MIDI API が在ればそれを使う（Chrome / Edge）。無くて、デスクトップ版の中なら
 * ネイティブ側を使う。どちらでもなければ（開発用に Safari や Firefox で開いているときなど）null。
 */
export function pickMidiSource(): MidiSource | null {
    if (webMidiRequest()) return new WebMidiSource();
    if (isDesktop()) return new DesktopMidiSource();
    return null;
}
