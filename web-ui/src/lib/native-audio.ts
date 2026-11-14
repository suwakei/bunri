/**
 * bunri DAW — Rust の音のエンジンに渡す口（デスクトップ版だけ）。
 *
 * デスクトップ版では、再生・停止・位置・区間ループ・メトロノーム・録音前のカウント・鍵盤の試聴を、
 * Rust の engine（`src-tauri/audio-engine`）が鳴らす。ここは、その Tauri の command と event を包む。
 * 呼ぶのは再生エンジン（lib/engine.ts の `AudioEngine`）だけで、画面の部品はここを直接呼ばない。
 * ブラウザ（開発用のブラウザ起動と自動テスト）には Rust が居ないので、`enabled()` が false を返し、
 * 再生エンジンは今までどおり Web Audio で鳴らす（docs/instrument-engine-design.md「開発用のブラウザ起動と自動テスト」）。
 *
 * ## 決まり
 *
 * - **呼び出しは 1 本の列に並べる。** `play()` → `stop()` → `play()` を続けて呼んでも、Rust に届く順は変わらない。
 *   鍵盤の試聴だけは別の列にする（曲の組み立てやクリップの送信を待たせない。試聴は再生の順番と関係が無い）
 * - **どの呼び出しでも失敗したら、そのセッションのあいだ Web Audio に切り替える。** 理由を console に出し、
 *   `onFailure` で再生エンジンに知らせる（再生中なら、再生エンジンが Web Audio で同じ位置から鳴らし直す）。
 *   鳴らし始めたのに位置の event が届かないときも、失敗として扱う（`POSITION_WATCHDOG_MS`）
 * - **曲の内容は、再生を始めるときに渡す。** `play()` を呼んだ時点のノートとクリップで組み立てる
 *   （Web Audio の再生が、`play()` の時点の内容を予約するのと同じ）。前に渡した内容と同じなら送らない
 * - **クリップの音声は、先に分けて送っておく。** `AudioBuffer` ごとに番号を振り、同じ音声を 2 度送らない。
 *   再生は、その曲で使う音声が届くのを待ってから始める
 * - **速度は、ここで時間軸を変換して渡す。** Rust は速度を知らない（`toPlayAxis` / `fromPlayAxis`）
 *
 * 開発者が Web Audio に戻したいときは、`localStorage` の `bunri.audioBackend` を `web` にして読み込み直す。
 */
import { invokeDesktop, invokeDesktopRaw, isDesktop, listenDesktop } from './api';
import { readStored } from './storage';
import type { LoopRange } from './loop';

/** Web Audio に戻す抜け道の、`localStorage` のキー。値が `web` なら Rust を使わない。 */
export const AUDIO_BACKEND_KEY = 'bunri.audioBackend';
/** 1 ステップ（16 分音符）のティック数。1 拍 = 960 ティック。 */
export const TICKS_PER_STEP = 240;
/** クリップの音声を送るときの、1 回の塊の大きさ（バイト）の上限。取り決めは 8MB 程度まで。 */
export const CLIP_CHUNK_BYTES = 4 * 1024 * 1024;
/** 位置の event の名前。 */
export const POSITION_EVENT = 'audio://position';
/** 強さを持たないノートの強さ（lib/engine.ts の `DEFAULT_VELOCITY` と同じ。あちらがここを読み込むので、値で持つ）。 */
const DEFAULT_VELOCITY = 96;
/** 位置の event のあいだを補う長さ（秒）の上限。時計が飛んだときに、位置を大きく飛ばさないため。 */
const MAX_EXTRAPOLATE_SEC = 1;
/**
 * 鳴らし始めてから、最初の位置の event を待つ長さ（ミリ秒）。Rust は鳴らし始めにすぐ 1 回、そのあと 1 秒に 30 回ほど送る。
 * これだけ待っても 1 つも届かなければ、Rust の側で鳴っていない（か、知らせが届かない）とみなして Web Audio に切り替える
 * （エラーにならずに、音が出ない・再生位置が動かないままになるのを防ぐ）。
 */
export const POSITION_WATCHDOG_MS = 2000;
/**
 * 見張りの時間が過ぎてから、失敗と決めるまでにもう一度待つ長さ（ミリ秒）。画面のメインスレッドがふさがっていた
 * （大きい音声のデコードなど）せいで、届いていた event をまだ受け取れていないだけのときに、切り替えないため。
 */
export const POSITION_WATCHDOG_GRACE_MS = 250;
/** 頼んでいないのに再生が止まった（出力デバイスが外れたなど）とき、鳴らし直してみる回数の上限と、数える長さ（ミリ秒）。 */
const INTERRUPT_LIMIT = 3;
const INTERRUPT_WINDOW_MS = 10_000;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** `audio_set_song` に渡す曲の内容。 */
export interface SongPayload {
    /** テンポ（速度を掛けたあとの値） */
    bpm: number;
    /** 1 小節目の 1 拍目の位置（秒。負のこともある） */
    offsetSec: number;
    /** 拍子（メトロノームの 1 拍目を決める） */
    beatsPerBar: number;
    tracks: SongTrackPayload[];
}

/** 曲の中のトラック 1 本。 */
export interface SongTrackPayload {
    id: number;
    gainDb: number;
    pan: number;
    /** ミュート・ソロ・「聴く」・トラック単体の再生を、画面が判定した結果 */
    audible: boolean;
    /** ティック（1 拍 = 960）、MIDI 番号、強さ 1〜127 */
    notes: { start: number; length: number; pitch: number; velocity: number }[];
    /** `audio_clip_put` の番号と、置く位置（秒） */
    clips: { clip: number; startSec: number }[];
}

/** `audio_play` に渡す値。時刻は、速度を変換したあとの「鳴らす時間軸」。 */
export interface PlayArgs {
    token: number;
    fromSec: number;
    loop: { startSec: number; endSec: number } | null;
    countIn: { beats: number; beatSec: number } | null;
    metronome: boolean;
}

/** 位置の event（`audio://position`）の中身。 */
export interface PositionEvent {
    token: number;
    playing: boolean;
    /** 録音前のカウントの最中（`positionSec` は始める位置のまま） */
    countingIn: boolean;
    /** `atMs` の時点の位置（秒。鳴らす時間軸。区間ループでは区間の中の位置） */
    positionSec: number;
    /** `positionSec` を測った時刻（Unix エポックからのミリ秒） */
    atMs: number;
    /** 区間ループの何周目か（0 始まり） */
    pass: number;
    /** `atMs` の時点で、カウントが終わって曲が始まるまでの残り（秒）。カウントの最中でなければ 0 */
    countInRemainingSec?: number;
}

/** トラックの音量・パン・鳴らすか。 */
export interface TrackMix {
    gainDb: number;
    pan: number;
    audible: boolean;
}

/** 曲に入れるノート（lib/engine.ts の `PianoNote` と同じ形）。 */
interface SourceNote {
    note: string;
    octave: number;
    step: number;
    length: number;
    velocity?: number;
}

/** 曲に入れるクリップ（lib/engine.ts の `Clip` と同じ形）。 */
interface SourceClip {
    buffer: AudioBuffer;
    offset: number;
    missing?: boolean;
}

/** 曲を組み立てる材料のうち、トラック 1 本ぶん。 */
export interface PlayTrack extends TrackMix {
    id: number;
    /** 鳴らすノート（`soundingNotes(track)`） */
    notes: readonly SourceNote[];
    clips: readonly SourceClip[];
}

/** 再生 1 回ぶんの頼みごと。時刻はどれも曲の時刻（速度を変換する前）。 */
export interface PlayRequest {
    bpm: number;
    beatsPerBar: number;
    /** 1 小節目の 1 拍目の位置（秒） */
    offsetSec: number;
    tracks: PlayTrack[];
    /** 始める位置（区間ループなら、区間の中） */
    fromSec: number;
    /** 区間ループ。無ければ null */
    loop: LoopRange | null;
    /** 速度（1 = そのまま）。区間ループの中でだけ効く */
    rate: number;
    /** 速度に合わせて伸ばした音声（そのトラック・その区間・その速度のものだけ使う） */
    stretched: { trackId: number; start: number; end: number; rate: number; buffer: AudioBuffer } | null;
    /** 録音前のカウント。1 拍の長さには速度を掛けない */
    countIn: { beats: number; beatSec: number } | null;
    metronome: boolean;
}

/** 再生しているあいだの状態。位置の event を受けて、再生位置を出すのに使う。 */
export interface NativePlayback {
    /** この再生の番号。位置の event は、この番号のものだけ使う */
    token: number;
    /** 始めた位置（曲の時刻） */
    startPos: number;
    /** 区間ループ（曲の時刻）。無ければ null */
    loop: LoopRange | null;
    /** 効いている速度（区間ループが無ければ 1） */
    rate: number;
    /** 録音前のカウントを頼んだか */
    countIn: boolean;
    /** 最後に届いた位置の event。まだ届いていなければ null */
    last: PositionEvent | null;
}

/** 速度の変換に要る値（区間の頭と速度）。変換しないなら null。 */
type Tempo = { start: number; rate: number } | null;

/** その再生で、速度の変換をするか（区間ループの中で、速度が 1 でないときだけ）。 */
function tempoOf(source: { loop: LoopRange | null; rate: number }): Tempo {
    return source.loop && source.rate > 0 && source.rate !== 1 ? { start: source.loop.start, rate: source.rate } : null;
}

/** 曲の時刻を、鳴らす時間軸の時刻にする（区間の頭を動かさずに、速度のぶんだけ伸び縮みさせる）。 */
export function toPlayAxis(sec: number, tempo: Tempo): number {
    return tempo ? tempo.start + (sec - tempo.start) / tempo.rate : sec;
}

/** 鳴らす時間軸の時刻を、曲の時刻に戻す。 */
export function fromPlayAxis(sec: number, tempo: Tempo): number {
    return tempo ? tempo.start + (sec - tempo.start) * tempo.rate : sec;
}

/**
 * ノートの音名とオクターブを、MIDI 番号にする（C4 = 60）。
 * Web Audio の再生が鳴らさないノート（`NOTE_FREQ` に無い音名。オクターブ 0〜8 の外）は null。
 */
export function notePitch(note: string, octave: number): number | null {
    const index = NOTE_NAMES.indexOf(note);
    if (index < 0 || !Number.isInteger(octave) || octave < 0 || octave > 8) return null;
    return (octave + 1) * 12 + index;
}

/** 強さを 1〜127 の整数にする。無ければ `DEFAULT_VELOCITY`。 */
function velocityOf(velocity: number | undefined): number {
    if (typeof velocity !== 'number' || !Number.isFinite(velocity)) return DEFAULT_VELOCITY;
    return Math.max(1, Math.min(127, Math.round(velocity)));
}

/**
 * 曲の内容を組み立てる。
 *
 * - ノートは `step × 240` ティック。鳴らない音名のノート、長さの無いノートは入れない
 * - 音声の無いクリップ（`missing`）は入れない
 * - 速度を変えているとき（区間ループの中で `rate` ≠ 1）は、鳴らす時間軸に直す: テンポに速度を掛け、
 *   1 小節目の位置を区間の頭から測り直し、クリップは伸ばした音声だけを区間の頭に置く
 *
 * @param request - 再生の頼みごと
 * @param clipId - 音声の番号を返す関数（`audio_clip_put` で送るときの番号）
 */
export function buildSong(request: PlayRequest, clipId: (buffer: AudioBuffer) => number): SongPayload {
    const tempo = tempoOf(request);
    const bpm = Math.max(1, request.bpm);
    const tracks = request.tracks.map((t): SongTrackPayload => {
        const notes: SongTrackPayload['notes'] = [];
        for (const n of t.notes) {
            const pitch = notePitch(n.note, n.octave);
            const start = Math.round(n.step * TICKS_PER_STEP), length = Math.round(n.length * TICKS_PER_STEP);
            if (pitch === null || !(start >= 0) || !(length > 0)) continue;
            notes.push({ start, length, pitch, velocity: velocityOf(n.velocity) });
        }
        const clips: SongTrackPayload['clips'] = [];
        if (!tempo) {
            for (const c of t.clips) if (!c.missing) clips.push({ clip: clipId(c.buffer), startSec: c.offset });
        } else {
            // 伸ばした音声が無いトラックのクリップは鳴らさない (そのまま鳴らすと、ノートとずれる)
            const s = request.stretched, loop = request.loop!;
            if (s && s.trackId === t.id && s.rate === tempo.rate && Math.abs(s.start - loop.start) < 1e-6 && Math.abs(s.end - loop.end) < 1e-6) {
                clips.push({ clip: clipId(s.buffer), startSec: loop.start });
            }
        }
        return { id: t.id, gainDb: t.gainDb, pan: t.pan, audible: t.audible, notes, clips };
    });
    return {
        bpm: tempo ? bpm * tempo.rate : bpm,
        offsetSec: toPlayAxis(request.offsetSec, tempo),
        beatsPerBar: Math.max(1, Math.round(request.beatsPerBar) || 4),
        tracks,
    };
}

/** `audio_play` に渡す値を作る（始める位置と区間を、鳴らす時間軸に直す）。 */
export function playArgs(request: PlayRequest, token: number): PlayArgs {
    const tempo = tempoOf(request);
    return {
        token,
        fromSec: toPlayAxis(request.fromSec, tempo),
        loop: request.loop ? { startSec: request.loop.start, endSec: toPlayAxis(request.loop.end, tempo) } : null,
        countIn: request.countIn ? { beats: request.countIn.beats, beatSec: request.countIn.beatSec } : null,
        metronome: request.metronome,
    };
}

/**
 * いまの再生位置を出す。最後の event の位置に、そこからの経過時間を足す。
 *
 * - event がまだ届いていない・カウントの最中: 始めた位置のまま進めない。カウントの終わりは、event が知らせる
 *   残りの長さから求める（次の event を待つと、そのあいだに弾いた 1 拍目の音を、録音が捨ててしまう）
 * - 区間ループ: 区間の終わりを越えたぶんは頭へ折り返し、越えた回数を何周目かに足す
 * - 速度を変えているとき: event の位置は鳴らす時間軸なので、曲の時刻に戻す
 *
 * @param playback - 再生の状態
 * @param nowMs - いまの時刻（Unix エポックからのミリ秒）
 */
export function estimatePosition(playback: NativePlayback, nowMs: number): { position: number; pass: number; countingIn: boolean } {
    const last = playback.last;
    if (!last) return { position: playback.startPos, pass: 0, countingIn: playback.countIn };
    const tempo = tempoOf(playback);
    const since = last.playing ? Math.max(0, (nowMs - last.atMs) / 1000) : 0;
    let axis: number;
    let pass = last.pass;
    if (last.countingIn) {
        // カウントが終わる時刻を過ぎていたら、曲はもう始まっている (始めた位置から、過ぎたぶんだけ進んでいる)
        const remaining = last.countInRemainingSec;
        const over = typeof remaining === 'number' && Number.isFinite(remaining) && last.playing ? since - Math.max(0, remaining) : -1;
        if (over < 0) return { position: playback.startPos, pass: 0, countingIn: true };
        axis = toPlayAxis(playback.startPos, tempo) + Math.min(MAX_EXTRAPOLATE_SEC, over);
        pass = 0;
    } else {
        axis = last.positionSec + Math.min(MAX_EXTRAPOLATE_SEC, since);
    }
    if (playback.loop) {
        const start = playback.loop.start;
        const length = toPlayAxis(playback.loop.end, tempo) - start;
        if (length > 0 && axis >= start + length) {
            const wraps = Math.floor((axis - start) / length);
            axis -= wraps * length;
            pass += wraps;
        }
    }
    return { position: fromPlayAxis(axis, tempo), pass, countingIn: false };
}

/**
 * いまの時刻（Unix エポックからのミリ秒）。
 *
 * 位置の event の `atMs` は Rust の壁時計なので、こちらも壁時計（`Date.now()`）で読む。
 * `performance.timeOrigin + performance.now()` は、WebKit では PC がスリープしているあいだ進まないので、
 * 窓を開いたままスリープから戻ると、そのぶんだけ壁時計より遅れる。
 */
function epochNowMs(): number {
    return Date.now();
}

/**
 * どちらで鳴らしているかを、画面の根の要素に印として残す（`<html data-bunri-audio="native">` か `"web"`）。
 * 本物の窓のテスト（e2e-desktop）が、Rust の経路で鳴らし通せたかを確かめるのに使う。
 * デスクトップ版でだけ付ける（Rust の出力を開けたら `native`、Web Audio に切り替えたら `web`）。
 */
function markBackend(backend: 'native' | 'web'): void {
    if (typeof document !== 'undefined') document.documentElement.dataset.bunriAudio = backend;
}

/** 送った（送っている）音声 1 つぶんの状態。 */
interface ClipEntry {
    /** `audio_clip_put` の番号（1 以上） */
    id: number;
    /** 全部届いたか */
    ready: boolean;
    /** 捨てた（送っている途中なら、送る側が気づいてやめる） */
    dropped: boolean;
    /** この音声を使う再生が、列に並んで待っている数。待っているあいだは捨てない */
    pins: number;
    /** 送り終わったら（やめたときも）解決する */
    done: Promise<void>;
}

/** トラックの音量・パン・鳴らすかを、比べやすい文字列にする。 */
function mixKey(mix: TrackMix): string {
    return `${mix.gainDb}|${mix.pan}|${mix.audible}`;
}

/** Rust の音のエンジンとのやり取り。 */
class NativeAudio {
    /** どこかで失敗して、このセッションは使わないと決めた */
    private failed = false;
    /** `localStorage` の抜け道の値（最初に 1 回だけ読む） */
    private override: string | null | undefined = undefined;
    private initPromise: Promise<void> | null = null;
    private info: { sampleRate: number; outputLatencySec: number } | null = null;
    private unlisten: (() => void) | null = null;
    /** 再生・停止・曲・ミックスの列 */
    private chain: Promise<void> = Promise.resolve();
    /** 鍵盤の試聴の列 */
    private liveChain: Promise<void> = Promise.resolve();
    /** クリップの音声を送る列 */
    private uploadChain: Promise<void> = Promise.resolve();
    private byBuffer = new WeakMap<AudioBuffer, ClipEntry>();
    private entries = new Map<number, ClipEntry>();
    private nextClipId = 1;
    private token = 0;
    private current: NativePlayback | null = null;
    /** 鳴らし始めたあと、位置の event が届くかを見張るタイマー */
    private watchdog: ReturnType<typeof setTimeout> | null = null;
    /** Rust に渡してある曲（JSON）。渡し直しが要るなら null */
    private sentSong: string | null = null;
    /** Rust に渡してある曲の、トラックごとの音量・パン・鳴らすか */
    private sentMix = new Map<number, string>();
    /** Rust に渡してある曲が使っている音声の番号 */
    private songClips = new Set<number>();

    /** 頼んでいないのに再生が止まった時刻（`INTERRUPT_WINDOW_MS` のあいだのぶん） */
    private interruptions: number[] = [];

    /** 失敗して Web Audio に切り替えるときに呼ぶ関数（再生エンジンが登録する）。 */
    onFailure: (() => void) | null = null;
    /**
     * 頼んでいないのに再生が止まった（出力デバイスが外れたなど）ときに呼ぶ関数（再生エンジンが登録する）。
     * 再生エンジンは、いまの位置から鳴らし直す（Rust が出力を開き直す）。
     */
    onInterrupted: (() => void) | null = null;
    /** いまの曲（プロジェクト）で使っている音声を返す関数（再生エンジンが登録する）。 */
    project: (() => Iterable<AudioBuffer>) | null = null;

    /** Rust の engine を使うか。ブラウザ・抜け道（`bunri.audioBackend = web`）・失敗のあとは false。 */
    enabled(): boolean {
        if (this.failed || !isDesktop()) return false;
        if (this.override === undefined) this.override = readStored(AUDIO_BACKEND_KEY);
        return this.override !== 'web';
    }

    /** 出力デバイスを開く（最初の 1 回だけ）。位置の event の受け口を、先に用意する。 */
    private ready(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = (async () => {
                this.unlisten = await listenDesktop<PositionEvent>(POSITION_EVENT, (e) => this.onPosition(e));
                const info = await invokeDesktop<{ sampleRate: number; outputLatencySec: number }>('audio_init');
                this.info = { sampleRate: Number(info?.sampleRate) || 0, outputLatencySec: Number(info?.outputLatencySec) || 0 };
                // 画面を読み込み直す前の再生や、押したままだった試聴が、Rust の側に残っていたら止める
                // (Web Audio の音は画面と一緒に消えるが、Rust の音は消えない)
                await invokeDesktop('audio_stop');
                await invokeDesktop('audio_live_all_off');
                markBackend('native');
            })();
        }
        return this.initPromise;
    }

    /**
     * 出力デバイスを開き終わる（か、失敗して Web Audio に切り替わる）まで待つ。まだなら開き始める。
     * 失敗しても reject しない。
     */
    whenReady(): Promise<void> {
        if (!this.enabled()) return Promise.resolve();
        return this.ready().catch((e) => this.fail(e));
    }

    /** 列に並んでいる呼び出しが全部終わるまで待つ（テスト用）。 */
    async idle(): Promise<void> {
        for (let i = 0; i < 50; i++) {
            const before = [this.chain, this.liveChain, this.uploadChain];
            await Promise.all(before);
            if (before[0] === this.chain && before[1] === this.liveChain && before[2] === this.uploadChain) return;
        }
    }

    /** 音が耳に届くまでの遅れ（秒）。出力デバイスを開き終わっていなければ null。 */
    outputLatencySec(): number | null {
        if (!this.info) return null;
        const v = this.info.outputLatencySec;
        return Number.isFinite(v) && v > 0 ? v : 0;
    }

    /** 失敗を記録して、このセッションのあいだ Web Audio に切り替える。 */
    private fail(reason: unknown): void {
        if (this.failed) return;
        this.failed = true;
        markBackend('web');
        console.warn('[bunri] Rust の音のエンジンを使えないので、このあとは Web Audio で鳴らします:', reason);
        this.current = null;
        this.unwatch();
        try { this.unlisten?.(); } catch { /* 受け口を外せなくても、event は token で捨てる */ }
        this.unlisten = null;
        if (this.info) {
            // Rust の側でまだ鳴っていたら、Web Audio と二重に鳴る。届くかは分からないが、止めておく
            void invokeDesktop('audio_stop').catch(() => undefined);
            void invokeDesktop('audio_live_all_off').catch(() => undefined);
        }
        try {
            this.onFailure?.();
        } catch (e) {
            console.error('[bunri] Web Audio に切り替えられませんでした:', e);
        }
    }

    /** 列に並べる。前の呼び出しが終わってから実行する。失敗したら Web Audio に切り替える。 */
    private enqueue(lane: 'chain' | 'liveChain' | 'uploadChain', job: () => Promise<unknown>): Promise<void> {
        const next = this[lane].then(async () => {
            if (this.failed) return;
            try {
                await this.ready();
                if (!this.failed) await job();
            } catch (e) {
                this.fail(e);
            }
        });
        this[lane] = next;
        return next;
    }

    /** 位置の event が届くかの見張りをやめる。 */
    private unwatch(): void {
        if (this.watchdog !== null) clearTimeout(this.watchdog);
        this.watchdog = null;
    }

    /**
     * 鳴らし始めた再生に、位置の event が届くかを見張る。`POSITION_WATCHDOG_MS` のあいだに 1 つも届かなければ、
     * 失敗として Web Audio に切り替える（再生エンジンが、始めた位置から鳴らし直す）。
     */
    private watch(playback: NativePlayback): void {
        this.unwatch();
        const arrived = () => this.failed || this.current !== playback || playback.last !== null;
        this.watchdog = setTimeout(() => {
            this.watchdog = null;
            if (arrived()) return;
            // メインスレッドがふさがっていて、届いていた event をまだ受け取れていないだけかもしれない。少し待ってから決める
            this.watchdog = setTimeout(() => {
                this.watchdog = null;
                if (arrived()) return;
                this.fail(new Error('再生を始めたのに、位置の知らせが届きません'));
            }, POSITION_WATCHDOG_GRACE_MS);
        }, POSITION_WATCHDOG_MS);
    }

    /**
     * 頼んでいないのに再生が止まった。再生エンジンに知らせて、鳴らし直してもらう。
     * 短いあいだに何度も止まるなら、Rust の出力は当てにならないので、Web Audio に切り替える。
     */
    private interrupted(nowMs: number): void {
        this.interruptions = this.interruptions.filter((at) => nowMs - at < INTERRUPT_WINDOW_MS);
        this.interruptions.push(nowMs);
        if (this.interruptions.length > INTERRUPT_LIMIT) {
            this.fail(new Error('Rust の再生が、頼んでいないのに何度も止まりました'));
            return;
        }
        console.warn('[bunri] Rust の再生が止まったので (出力デバイスが替わったなど)、同じ位置から鳴らし直します');
        try {
            this.onInterrupted?.();
        } catch (e) {
            this.fail(e);
        }
    }

    /** 位置の event を受ける。いまの再生のものだけ使う。 */
    private onPosition(event: PositionEvent): void {
        const playback = this.current;
        if (!playback || !event || event.token !== playback.token) return;
        if (!Number.isFinite(event.positionSec) || !Number.isFinite(event.atMs)) return;
        if (playback.last && event.atMs < playback.last.atMs) return;
        const wasPlaying = playback.last?.playing === true;
        const remaining = Number(event.countInRemainingSec);
        playback.last = {
            token: event.token, playing: !!event.playing, countingIn: !!event.countingIn,
            positionSec: event.positionSec, atMs: event.atMs, pass: Math.max(0, Math.floor(Number(event.pass) || 0)),
            // 残りを知らせない event では、カウントの終わりを次の event で知る
            countInRemainingSec: Number.isFinite(remaining) ? Math.max(0, remaining) : undefined,
        };
        // 止めるときは、先に `current` を外している。ここに来た「止まった」は、頼んでいないもの
        // (出力デバイスが外れた、ストリームが無効になった)
        if (wasPlaying && !event.playing) this.interrupted(epochNowMs());
    }

    /** いまの再生位置・何周目か・カウントの最中か。 */
    position(playback: NativePlayback): { position: number; pass: number; countingIn: boolean } {
        return estimatePosition(playback, epochNowMs());
    }

    /**
     * 音声に番号を振り、裏で送り始める。送ってあれば（送っている途中でも）何もしない。
     * @returns その音声の状態
     */
    private register(buffer: AudioBuffer): ClipEntry {
        const known = this.byBuffer.get(buffer);
        if (known && !known.dropped) return known;
        const entry: ClipEntry = { id: this.nextClipId++, ready: false, dropped: false, pins: 0, done: Promise.resolve() };
        this.byBuffer.set(buffer, entry);
        this.entries.set(entry.id, entry);
        entry.done = this.enqueue('uploadChain', () => this.upload(entry, buffer));
        return entry;
    }

    /**
     * 音声を分けて送る。本体は Float32 のリトルエンディアンで、チャンネルごとに並べる
     * （塊が n フレームなら、ch0 の n 個のあとに ch1 の n 個）。3 チャンネル以上は先頭の 2 つだけ送る。
     * Float32Array のバイトの並びは機械に従うが、アプリが動く機械はどれもリトルエンディアン。
     */
    private async upload(entry: ClipEntry, buffer: AudioBuffer): Promise<void> {
        const channels = Math.max(1, Math.min(2, buffer.numberOfChannels));
        const frames = buffer.length;
        const data: Float32Array[] = [];
        for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch));
        const perChunk = Math.max(1, Math.floor(CLIP_CHUNK_BYTES / (4 * channels)));
        let offset = 0, sent = false, complete = false;
        do {
            if (entry.dropped || this.failed) break;
            const n = Math.max(0, Math.min(perChunk, frames - offset));
            const body = new Float32Array(n * channels);
            for (let ch = 0; ch < channels; ch++) body.set(data[ch].subarray(offset, offset + n), ch * n);
            const result = await invokeDesktopRaw<{ complete: boolean }>('audio_clip_put', new Uint8Array(body.buffer), {
                'x-clip-id': String(entry.id),
                'x-sample-rate': String(Math.round(buffer.sampleRate)),
                'x-channels': String(channels),
                'x-frames': String(frames),
                'x-offset': String(offset),
            });
            sent = true;
            offset += n;
            complete = !!result?.complete;
        } while (offset < frames);
        if (this.failed) return;
        if (entry.dropped) {
            // 送っている途中で要らなくなった。届いたぶんを捨てる
            if (sent) await invokeDesktop('audio_clip_drop', { ids: [entry.id] });
            return;
        }
        if (!complete) throw new Error(`クリップの音声 (番号 ${entry.id}) を最後まで送ったのに、受け取りが終わりませんでした`);
        entry.ready = true;
    }

    /**
     * いまの曲で使っている音声を送り始め、使わなくなった音声を捨てる。
     * クリップを足したとき・外したときに、再生エンジンが呼ぶ。
     */
    syncClips(): void {
        if (!this.enabled()) return;
        for (const buffer of this.project?.() ?? []) this.register(buffer);
        if (this.entries.size > 0) void this.enqueue('chain', () => this.sweep());
    }

    /**
     * 使わなくなった音声を捨てる。捨てないもの: いまの曲（プロジェクト）に在るもの、Rust に渡してある曲が
     * 使っているもの、列に並んで待っている再生が使うもの。
     */
    private async sweep(): Promise<void> {
        const keep = new Set<number>(this.songClips);
        for (const buffer of this.project?.() ?? []) {
            const entry = this.byBuffer.get(buffer);
            if (entry && !entry.dropped) keep.add(entry.id);
        }
        const ids: number[] = [];
        for (const entry of [...this.entries.values()]) {
            if (entry.pins > 0 || keep.has(entry.id)) continue;
            entry.dropped = true;
            this.entries.delete(entry.id);
            // 送っている途中のものは、送る側が気づいてやめ、届いたぶんを自分で捨てる
            if (entry.ready) ids.push(entry.id);
        }
        if (ids.length > 0) await invokeDesktop('audio_clip_drop', { ids });
    }

    /** 曲の内容を渡す。前に渡した内容と同じなら送らない。 */
    private async sendSong(song: SongPayload): Promise<void> {
        const key = JSON.stringify(song);
        if (key === this.sentSong) return;
        this.sentSong = null;
        await invokeDesktop('audio_set_song', { song });
        this.sentSong = key;
        this.sentMix = new Map(song.tracks.map((t) => [t.id, mixKey(t)]));
        this.songClips = new Set(song.tracks.flatMap((t) => t.clips.map((c) => c.clip)));
    }

    /**
     * 再生を始める。曲の内容は、呼んだ時点のもので組み立てる。使う音声が届くのを待ち、曲を渡して（変わっていれば）、鳴らす。
     * 待っているあいだに止めた・次の再生を始めたときは、鳴らさない。
     *
     * @returns この再生の状態。再生位置を出すのに使う（`position`）
     */
    play(request: PlayRequest): NativePlayback {
        const pinned: ClipEntry[] = [];
        const song = buildSong(request, (buffer) => {
            const entry = this.register(buffer);
            if (!pinned.includes(entry)) { entry.pins++; pinned.push(entry); }
            return entry.id;
        });
        const tempo = tempoOf(request);
        const playback: NativePlayback = {
            token: ++this.token,
            startPos: request.fromSec,
            loop: request.loop ? { start: request.loop.start, end: request.loop.end } : null,
            rate: tempo ? tempo.rate : 1,
            countIn: request.countIn !== null,
            last: null,
        };
        const args = playArgs(request, playback.token);
        this.current = playback;
        void this.enqueue('chain', async () => {
            try {
                if (this.current !== playback) return;
                await Promise.all(pinned.map((entry) => entry.done));
                if (this.failed || this.current !== playback) return;
                await this.sendSong(song);
                if (this.current !== playback) return;
                await invokeDesktop('audio_play', { ...args });
                if (this.current === playback) this.watch(playback);
            } finally {
                for (const entry of pinned) entry.pins--;
            }
            // 曲を差し替えたあとで、前の曲だけが使っていた音声を捨てる
            await this.sweep();
        });
        return playback;
    }

    /** 止める（停止と一時停止のどちらも。位置は再生エンジンが持つ）。 */
    stop(): void {
        this.current = null;
        this.unwatch();
        void this.enqueue('chain', () => invokeDesktop('audio_stop'));
    }

    /**
     * 再生中のトラックの音量・パン・鳴らすかを変える。Rust に渡してある曲に無いトラック、値が変わっていないトラックは送らない。
     * 送ったら、次の再生では曲を渡し直す（再生し直したときに、Rust の側の値がどちらになるかに頼らない）。
     */
    setTrack(id: number, mix: TrackMix): void {
        const key = mixKey(mix);
        void this.enqueue('chain', async () => {
            if (!this.sentMix.has(id) || this.sentMix.get(id) === key) return;
            await invokeDesktop('audio_set_track', { id, gainDb: mix.gainDb, pan: mix.pan, audible: mix.audible });
            this.sentMix.set(id, key);
            this.sentSong = null;
        });
    }

    /** メトロノームの入/切（再生中に変えたとき）。 */
    setMetronome(enabled: boolean): void {
        void this.enqueue('chain', () => invokeDesktop('audio_set_metronome', { enabled }));
    }

    /**
     * 鍵盤の試聴。`velocity` が 0 なら離す。
     * @param pitch - MIDI ノート番号
     * @param velocity - 強さ（1〜127。0 で離す）
     */
    liveNote(pitch: number, velocity: number): void {
        const args = {
            pitch: Math.max(0, Math.min(127, Math.round(pitch))),
            velocity: velocity > 0 ? velocityOf(velocity) : 0,
        };
        void this.enqueue('liveChain', () => invokeDesktop('audio_live_note', args));
    }

    /** 鍵盤の試聴の音をすべて止める。 */
    liveAllOff(): void {
        void this.enqueue('liveChain', () => invokeDesktop('audio_live_all_off'));
    }

    /** テスト用: 覚えていることを全部忘れる（失敗の記録、送った音声、渡した曲）。登録した関数は残す。 */
    resetForTest(): void {
        try { this.unlisten?.(); } catch { /* 無視 */ }
        this.unwatch();
        this.failed = false;
        this.override = undefined;
        this.initPromise = null;
        this.info = null;
        this.unlisten = null;
        this.chain = Promise.resolve();
        this.liveChain = Promise.resolve();
        this.uploadChain = Promise.resolve();
        this.byBuffer = new WeakMap();
        this.entries = new Map();
        this.nextClipId = 1;
        this.token = 0;
        this.current = null;
        this.sentSong = null;
        this.sentMix = new Map();
        this.songClips = new Set();
        this.interruptions = [];
    }
}

/** Rust の音のエンジンに渡す口（アプリに 1 つ）。 */
export const nativeAudio = new NativeAudio();
export type { NativeAudio };
