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
import { inStepRange, normLength, normStep, stepToBar, stepToBeat, toTicks } from './grid';
import { quantize } from './snap';

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

/** ステップ位置を「2 小節 3 拍」の形にする。小数の位置（三連の 2 つ目・3 つ目など）は、その拍に数える。 */
export function cursorLabel(step: number, beatsPerBar: number): string {
    const grid = { beatsPerBar: Math.max(1, beatsPerBar) };
    return `${stepToBar(step, grid)} 小節 ${stepToBeat(step, grid)} 拍`;
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
    /**
     * ステップ入力の 1 歩を、選んだ刻みから決める（lib/snap.ts の `stepCell`）。カーソルの位置を受けて、
     * 置く位置・長さ・次のカーソルを返す。null を返すか、渡さなければ、`stepLength` ずつ進む。
     */
    cell?: (cursor: number) => { step: number; length: number; next: number } | null;
    /**
     * リアルタイム録音で、位置と長さをそろえる間隔（ステップ）。渡さなければ 1（16 分音符）。
     * 選んだ刻みが 16 分より細かいか三連のときは、その刻み（lib/snap.ts の `realtimeQuantum`）。
     */
    quantum?: () => number;
}

/**
 * 鍵盤の操作を、ピアノロールのノートにする。
 *
 * - ステップ入力: 鍵盤を押すと、カーソルの位置に決まった長さのノートを置く。
 *   押している鍵盤を全部離すと、カーソルがその長さぶん進む。同時に押せば和音になる。
 *   リズムを取れなくても、音の高さだけ追って打ち込める。1 歩は、選んだ刻み（`options.cell`。三連なら三連の位置を
 *   1 つずつ進む）か、決めた長さ（`stepLength`）
 * - リアルタイム録音: 再生中に鍵盤を押した位置から離した位置までを、ノートにする。
 *   位置と長さは 16 分音符に丸める（選んだ刻みが 16 分より細かいか三連のときは、その刻みに。`options.quantum`）。
 *   再生していないときは録らない
 */
export class MidiNoteRecorder {
    mode: RecordMode = 'off';
    /** ステップ入力で置くノートの長さ（ステップ。4 = 4 分音符）。`options.cell` が 1 歩を返すあいだは使わない。 */
    stepLength = 4;
    /** ステップ入力の、次に置く位置（ステップ）。 */
    cursor = 0;
    /** ステップ入力で、押している鍵盤を全部離したときに進む先（いまの和音を置いたときに決める）。 */
    private stepNext = 0;

    private options: RecorderOptions;
    /** リアルタイム録音で、押している鍵盤と、押した位置・強さ。 */
    private held = new Map<number, { position: number; velocity: number }>();
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
                this.cursor = this.stepNext;
                this.stepPlaced = false;
            }
            return { kind: 'ignored' };
        }
        this.stepHeld.add(event.pitch);
        if (!this.inRange(event.pitch)) return { kind: 'skipped', reason: 'range' };
        const bounds = this.options.bounds?.() ?? null;
        // 範囲の外にカーソルが在れば、範囲の頭から始める (和音の途中では動かさない)
        // (位置は、刻みの数で比べる。三連を 3 つ置いた先が、区間の終わりちょうどなら、区間の外)
        if (bounds && !this.stepPlaced && !inStepRange(this.cursor, bounds.start, bounds.end)) this.cursor = bounds.start;
        // 1 歩: 選んだ刻み (在れば) か、決めた長さ。和音の 2 つ目からも、同じカーソルから同じ 1 歩になる
        const target = this.options.cell?.(this.cursor)
            ?? { step: this.cursor, length: this.stepLength, next: this.cursor + this.stepLength };
        const step = normStep(target.step), length = normLength(target.length);
        if (toTicks(step) + toTicks(length) > toTicks(bounds ? bounds.end : this.options.totalSteps)) return { kind: 'skipped', reason: 'end' };
        const note = { ...pitchToNote(event.pitch), step, length, velocity: event.velocity };
        this.options.addNote(note);
        this.stepPlaced = true;
        this.stepNext = normStep(target.next);
        return { kind: 'added', note };
    }

    private handleRealtime(event: NoteEvent): RecordResult {
        const position = this.options.position();
        if (event.type === 'on') {
            if (position === null) return { kind: 'skipped', reason: 'stopped' };
            if (!this.inRange(event.pitch)) return { kind: 'skipped', reason: 'range' };
            this.held.set(event.pitch, { position, velocity: event.velocity });
            return { kind: 'ignored' };
        }
        const pressed = this.held.get(event.pitch);
        if (pressed === undefined) return { kind: 'ignored' };
        this.held.delete(event.pitch);
        const start = pressed.position;
        // そろえる間隔。ふだんは 16 分音符 (1 ステップ)。選んだ刻みが 16 分より細かいか三連なら、その刻み
        const quantum = Math.max(1 / 60, this.options.quantum?.() ?? 1);
        const step = Math.max(0, quantize(start, quantum));
        if (step >= this.options.totalSteps) return { kind: 'skipped', reason: 'end' };
        // 離す前に再生が止まっていたら、長さは最短（そろえる間隔 1 つぶん）にする
        let end = position ?? start;
        // 区間ループの終わりをまたいだ (再生位置が頭に戻った) ら、区間の終わりまでにする
        const bounds = this.options.bounds?.() ?? null;
        if (bounds && end < start) end = bounds.end;
        const length = normLength(Math.min(Math.max(quantum, quantize(end - start, quantum)), this.options.totalSteps - step));
        // 強さは、押したときのもの (離すときの強さは、ノートの強さではない)
        const note = { ...pitchToNote(event.pitch), step, length, velocity: pressed.velocity };
        this.options.addNote(note);
        return { kind: 'added', note };
    }
}

/** MIDI メッセージの受け口。 */
export type MidiMessageHandler = (bytes: ArrayLike<number>, receivedAt?: number) => void;

/** MIDI の入力元。 */
export interface MidiSource {
    /** web: ブラウザの Web MIDI API / desktop: デスクトップ版のネイティブ側 */
    kind: 'web' | 'desktop';
    /**
     * 入力を開く。つながっている機器をすべて対象にする。
     *
     * @param onMessage - MIDI メッセージを受けるたびに呼ばれる。`receivedAt` は、機器から届いた時刻
     *   （`performance.now()` と同じ時計。ミリ秒）。分からない入力元では渡さない
     * @param onDevices - つながっている機器の名前が分かったとき・変わったときに呼ばれる
     */
    start(onMessage: MidiMessageHandler, onDevices: (names: string[]) => void): Promise<void>;
    /** 入力を閉じる。 */
    stop(): Promise<void>;
    /**
     * つながっている機器の名前を、入力を開かずに調べる。調べられない入力元には無い
     * （ブラウザの Web MIDI API は、調べるだけでも利用者に許可を尋ねるので、ここでは使わない）。
     */
    ports?(): Promise<string[]>;
}

/** Web MIDI API のうち、ここで使うぶん。 */
interface WebMidiInput {
    name?: string | null;
    state?: string;
    onmidimessage: ((event: { data: Uint8Array | null; timeStamp?: number }) => void) | null;
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

    async start(onMessage: MidiMessageHandler, onDevices: (names: string[]) => void): Promise<void> {
        const request = webMidiRequest();
        if (!request) throw new Error('このブラウザは MIDI 入力に対応していません');
        // 開き直すときは、前の受け口を外してから（デスクトップ版の入力元と同じ）
        await this.stop();
        const access = await request({ sysex: false });
        this.access = access;
        const attach = () => {
            const names: string[] = [];
            access.inputs.forEach((input) => {
                if (input.state === 'disconnected') return;
                // timeStamp は、ブラウザが機器からメッセージを受けた時刻。この関数が呼ばれるまでの
                // 待ち (画面の処理が詰まっていると数十ミリ秒になる) を、録る側で差し引ける
                input.onmidimessage = (event) => {
                    if (event.data) onMessage(event.data, typeof event.timeStamp === 'number' && event.timeStamp > 0 ? event.timeStamp : undefined);
                };
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

    async start(onMessage: MidiMessageHandler, onDevices: (names: string[]) => void): Promise<void> {
        await this.stop();
        // 先に受け口を用意してから開く（開いた直後のメッセージを取りこぼさないため）
        // ネイティブ側は届いた時刻を渡してこないので、バイト列だけを受ける
        this.unlisten = await listenDesktop<number[]>('midi-message', (bytes) => onMessage(bytes));
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

    ports(): Promise<string[]> {
        return invokeDesktop<string[]>('midi_ports');
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
