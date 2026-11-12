/**
 * bunri DAW — WebAudio リアルタイム再生エンジン
 * トラック管理、クリップ再生、ピアノノート再生、メトロノーム、録音を担当
 */
import { apiFetch } from './api';
import { stepSeconds, type ProjectGrid } from './grid';
import { beatsInSegment, clampToLoop, clipInSegment, loopLength, loopPosition, loopSegment, noteInSegment, type LoopRange, type LoopSegment } from './loop';

/**
 * 速度を変えたときに、そのトラックのクリップの代わりに鳴らす音声（練習画面の「速度」。lib/practice-audio.ts が作る）。
 * 区間 `[start, end)` を、音の高さを変えずに `rate` 倍の速さにしたもの。
 */
export interface StretchedAudio {
    trackId: number;
    start: number;
    end: number;
    rate: number;
    buffer: AudioBuffer;
}

/** 区間ループで、先に鳴らしておく長さ (秒)。画面の裏で見回りが遅れても途切れないよう、長めに取る */
const LOOP_LOOKAHEAD = 1.5;
/** 区間ループの見回りの間隔 (ミリ秒) */
const LOOP_TICK_MS = 100;
/** 区間のつなぎ目で、ぷつっと鳴らないように上げ下げする長さ (秒) */
const LOOP_FADE = 0.004;

/** 区間ループで再生しているあいだの状態。 */
interface LoopPlayback {
    loop: LoopRange;
    /** 再生を始めた曲の時刻 */
    startPos: number;
    /** 再生を始めた時刻 (AudioContext の時計) */
    startWhen: number;
    rate: number;
    /** 次に用意する周 */
    next: number;
    tracks: Track[];
    timer: ReturnType<typeof setInterval> | null;
}

/**
 * ピアノロール上の1ノートを表すデータ構造。
 * ステップ単位（16分音符基準）で位置と長さを保持する。
 */
export interface PianoNote {
    /** 音名（例: "C", "C#", "D"） */
    note: string;
    /** オクターブ番号（0〜8） */
    octave: number;
    /** 開始ステップ（16分音符単位） */
    step: number;
    /** 音長（ステップ数） */
    length: number;
}

/**
 * タイムライン上に配置された音声クリップ。
 * デコード済み AudioBuffer とタイムライン上の開始位置を持つ。
 */
export interface Clip {
    /** デコード済み PCM バッファ */
    buffer: AudioBuffer;
    /** タイムライン上の開始位置（秒） */
    offset: number;
    /** クリップの表示名 */
    name: string;
    /** クリップの長さ（秒） */
    duration: number;
}

/**
 * ミキサートラック。クリップとピアノノートをまとめ、
 * ゲイン/パン/ミュート/ソロを制御する WebAudio ノードを保持する。
 */
export interface Track {
    /** トラック固有 ID（1始まりの連番） */
    id: number;
    /** トラック表示名 */
    name: string;
    /** タイムライン上のクリップ一覧 */
    clips: Clip[];
    /** ピアノロールのノート一覧 */
    pianoNotes: PianoNote[];
    /**
     * お手本のノート（原曲を採譜した時点の控え）。差分コーチが打ち込みと比べる相手。
     * 採譜で作ったトラックにだけ在り、ピアノロールで編集しても変わらない。
     */
    referenceNotes?: PianoNote[];
    /**
     * 学ぶ流れの中での役割。
     * - `song`: 取り込んだ原曲の音声を置いたトラック
     * - `part`: パート分離で作った、パートの音声（とお手本）を持つトラック
     * - `practice`: そのパートを自分で打ち込むトラック（「このパートを練習する」で作る）
     * 自由に作ったトラックには無い。
     */
    role?: 'song' | 'part' | 'practice';
    /** パートの名前（API の識別子。`bass` など）。`part` と `practice` のトラックに在る */
    part?: string;
    /** 練習のトラックが、どのパートのトラックのお手本を見ながら打ち込むか（トラック ID） */
    practiceOf?: number;
    /** ゲイン量（dB） */
    gain: number;
    /** パン位置（-1.0〜1.0） */
    pan: number;
    /** ミュート状態 */
    mute: boolean;
    /** ソロ状態 */
    solo: boolean;
    /** WebAudio GainNode */
    gainNode: GainNode;
    /** WebAudio StereoPannerNode */
    panNode: StereoPannerNode;
}

/**
 * 音名（例: "A4", "C#3"）を周波数（Hz）にマッピングするテーブル。
 * A4 = 440 Hz を基準に 12 平均律で計算済み。
 * @example NOTE_FREQ["A4"] // => 440
 */
const NOTE_FREQ: Record<string, number> = {};
(() => {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    for (let oct = 0; oct <= 8; oct++) {
        for (let i = 0; i < 12; i++) {
            const midi = (oct + 1) * 12 + i;
            const freq = 440 * Math.pow(2, (midi - 69) / 12);
            NOTE_FREQ[`${names[i]}${oct}`] = freq;
        }
    }
})();

/**
 * WebAudio API を使ったリアルタイム再生エンジン。
 * トラック管理・クリップスケジューリング・ピアノノート再生・
 * メトロノーム・マイク録音・WAV書き出しを一元管理する。
 */
class AudioEngine {
    ctx: AudioContext | null = null;
    masterGain: GainNode | null = null;
    isPlaying: boolean;
    isRecording: boolean;
    startTime: number;
    playOffset: number;
    bpm: number;
    beatsPerBar: number;
    /**
     * 1 小節目の 1 拍目の位置（秒）。ピアノロールのステップ 0 はここに当たる。
     * 曲を取り込むとカルテの 1 拍目の位置になる（lib/grid.ts）。自由に作るときは 0
     */
    gridOffset: number;
    metronomeEnabled: boolean;
    metronomeInterval: ReturnType<typeof setInterval> | null = null;

    tracks: Track[] = [];
    nextTrackId: number;

    /** 鍵盤を押している間だけ鳴らす音（MIDI 入力のモニター用）。キーは MIDI ノート番号 */
    liveVoices: Map<number, { osc: OscillatorNode; gain: GainNode }> = new Map();

    mediaStream: MediaStream | null = null;
    mediaRecorder: MediaRecorder | null = null;
    recordedChunks: Blob[] = [];

    activeSources: (AudioBufferSourceNode | OscillatorNode)[] = [];
    soloTrackId: number | null = null;

    /**
     * 区間ループ（曲の時刻、秒）。在るあいだ、再生はこの区間を繰り返す。練習画面だけが決める
     * （練習画面を離れると null に戻す）。
     */
    loopRange: LoopRange | null = null;
    /**
     * 速度（練習画面。1 = そのまま）。区間ループの中でだけ効く。ノートとメトロノームは間隔を伸ばして鳴らし、
     * クリップは `stretched`（高さを変えずに伸ばした音声）が在るトラックだけ鳴らす。
     */
    tempoRate = 1;
    /** 速度を変えたときに鳴らす、伸ばした音声 */
    stretched: StretchedAudio | null = null;
    /**
     * 練習画面の「聴く」。在るあいだは、ミュートとソロの代わりに、ここに在るトラックだけを鳴らす。
     * トラックのミュート・ソロは書き換えないので、プロジェクトにも、元に戻す履歴にも残らない。
     * 書き出し（mixdown）は従わない（書き出すのはプロジェクトのミュートとソロのとおり）。
     */
    listenOverride: Set<number> | null = null;
    /** 区間ループで再生しているあいだの状態 */
    private loopPlayback: LoopPlayback | null = null;

    constructor() {
        this.isPlaying = false;
        this.isRecording = false;
        this.startTime = 0;
        this.playOffset = 0;
        this.bpm = 120;
        this.beatsPerBar = 4;
        this.gridOffset = 0;
        this.metronomeEnabled = false;
        this.nextTrackId = 1;
    }

    /**
     * AudioContext とマスターゲインを初期化する。
     * 既に初期化済みの場合は作り直さない。
     *
     * 画面を開いた時点 (利用者がまだ何も操作していない時点) で作った AudioContext は、
     * ブラウザが止めた状態 (suspended) にしていることがある。そのままだと、鍵盤を押しても
     * 音が出ないので、呼ばれるたびに起こす (再生や試し聴きは、利用者の操作から呼ばれる)。
     */
    init(): void {
        if (this.ctx) {
            if (this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
                void this.ctx.resume().catch(() => { /* 起こせなくても、次の操作でもう一度試す */ });
            }
            return;
        }
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
    }

    /** いまのグリッド（テンポ・拍子・1 小節目の位置）。 */
    get grid(): ProjectGrid {
        return { bpm: this.bpm, beatsPerBar: this.beatsPerBar, offsetSec: this.gridOffset };
    }

    /**
     * 新しいトラックの既定の名前を返す。いま在る "Track N" のいちばん大きい番号の次を使う。
     * 本数 + 1 にすると、途中のトラックを消してから足したときに、同じ名前が 2 本できる。
     * @returns "Track N" の形の、ほかのトラックと重ならない名前
     */
    _nextTrackName(): string {
        let last = 0;
        for (const track of this.tracks) {
            const match = /^Track (\d+)$/.exec(track.name);
            if (match) last = Math.max(last, Number(match[1]));
        }
        return `Track ${last + 1}`;
    }

    /**
     * 新しいトラックを追加し、WebAudio ノードをマスターに接続する。
     * @param name - トラック名（省略時は "Track N"）
     * @returns 作成した Track オブジェクト
     */
    addTrack(name?: string): Track {
        this.init();
        const track: Track = {
            id: this.nextTrackId++,
            name: name || this._nextTrackName(),
            clips: [],
            pianoNotes: [],
            gain: 0,
            pan: 0,
            mute: false,
            solo: false,
            gainNode: this.ctx!.createGain(),
            panNode: this.ctx!.createStereoPanner(),
        };
        track.panNode.connect(track.gainNode);
        track.gainNode.connect(this.masterGain!);
        this.tracks.push(track);
        return track;
    }

    /**
     * 指定 ID のトラックをエンジンから削除する。
     * @param trackId - 削除するトラックの ID
     */
    removeTrack(trackId: number | string): void {
        trackId = Number(trackId);
        this.tracks = this.tracks.filter(t => t.id !== trackId);
    }

    /**
     * トラックの並びを変え、指定したトラックのすぐ後ろに置く。
     * 練習のトラックを、そのパートのトラックの隣に並べるのに使う。
     * @param trackId - 動かすトラックの ID
     * @param afterId - このトラックの後ろに置く
     */
    moveTrackAfter(trackId: number, afterId: number): void {
        const track = this.getTrack(trackId);
        if (!track || !this.getTrack(afterId)) return;
        this.tracks = this.tracks.filter(t => t.id !== trackId);
        const index = this.tracks.findIndex(t => t.id === afterId);
        this.tracks.splice(index + 1, 0, track);
    }

    /**
     * 指定 ID のトラックを取得する。
     * @param trackId - 検索するトラック ID
     * @returns 見つかった Track、存在しない場合は undefined
     */
    getTrack(trackId: number | string): Track | undefined {
        trackId = Number(trackId);
        return this.tracks.find(t => t.id === trackId);
    }

    /**
     * トラックのゲインを更新する。ミュート中は音量を 0 に保つ。
     * @param trackId - 対象トラック ID
     * @param db - ゲイン量（dB）
     */
    updateTrackGain(trackId: number | string, db: number): void {
        const track = this.getTrack(trackId);
        if (!track) return;
        track.gain = db;
        this.applyTrackGain(track);
    }

    /**
     * トラックの音量を、再生のつなぎに当てる。ミュート中は 0。
     * 練習画面の「聴く」（`listenOverride`）が在るときは、そこに在るトラックだけを鳴らす。
     */
    applyTrackGain(track: Track): void {
        const on = this.listenOverride ? this.listenOverride.has(track.id) : !track.mute;
        track.gainNode.gain.value = on ? Math.pow(10, track.gain / 20) : 0;
    }

    /**
     * 練習画面の「聴く」を決める（null で外す）。トラックのミュート・ソロは書き換えない。
     * 再生中なら、いまの位置から鳴らし直す。
     * @param trackIds - 鳴らすトラックの ID
     */
    setListenOverride(trackIds: number[] | null): void {
        this.listenOverride = trackIds ? new Set(trackIds) : null;
        for (const track of this.tracks) this.applyTrackGain(track);
        this.restartIfPlaying();
    }

    /**
     * トラックのパン位置を更新する。
     * @param trackId - 対象トラック ID
     * @param pan - パン値（-1.0=左, 0=中央, 1.0=右）
     */
    updateTrackPan(trackId: number | string, pan: number): void {
        const track = this.getTrack(trackId);
        if (!track) return;
        track.pan = pan;
        track.panNode.pan.value = pan;
    }

    /**
     * トラックのミュート状態をトグルする。
     * @param trackId - 対象トラック ID
     * @returns ミュート後の状態（true=ミュート中）、トラックが存在しない場合は undefined
     */
    toggleMute(trackId: number | string): boolean | undefined {
        const track = this.getTrack(trackId);
        if (!track) return;
        track.mute = !track.mute;
        this.applyTrackGain(track);
        return track.mute;
    }

    /**
     * ローカルファイルをデコードしてトラックにクリップを追加する。
     * @param trackId - 追加先トラック ID
     * @param file - 音声ファイル（WAV/MP3 等）
     * @param offsetSec - タイムライン上の開始位置（秒、デフォルト 0）
     * @returns 追加した Clip、トラックが存在しない場合は undefined
     */
    async addClipFromFile(trackId: number | string, file: File, offsetSec: number = 0): Promise<Clip | undefined> {
        this.init();
        const track = this.getTrack(trackId);
        if (!track) return;
        const arrayBuf = await file.arrayBuffer();
        const buffer = await this.ctx!.decodeAudioData(arrayBuf);
        const clip: Clip = { buffer, offset: offsetSec, name: file.name, duration: buffer.duration };
        track.clips.push(clip);
        return clip;
    }

    /**
     * URL から音声をフェッチ・デコードしてトラックにクリップを追加する。
     * @param trackId - 追加先トラック ID
     * @param url - 音声ファイルの URL
     * @param name - クリップ名（省略時は "clip"）
     * @param offsetSec - タイムライン上の開始位置（秒、デフォルト 0）
     * @returns 追加した Clip、トラックが存在しない場合は undefined
     */
    async addClipFromUrl(trackId: number | string, url: string, name?: string, offsetSec: number = 0): Promise<Clip | undefined> {
        this.init();
        const track = this.getTrack(trackId);
        if (!track) return;
        const resp = await apiFetch(url);
        const arrayBuf = await resp.arrayBuffer();
        const buffer = await this.ctx!.decodeAudioData(arrayBuf);
        const clip: Clip = { buffer, offset: offsetSec, name: name || 'clip', duration: buffer.duration };
        track.clips.push(clip);
        return clip;
    }

    /**
     * デコード済み AudioBuffer をそのままトラックにクリップとして追加する。
     * @param trackId - 追加先トラック ID
     * @param audioBuffer - デコード済みバッファ
     * @param name - クリップ名（省略時は "clip"）
     * @param offsetSec - タイムライン上の開始位置（秒、デフォルト 0）
     * @returns 追加した Clip、トラックが存在しない場合は undefined
     */
    async addClipFromBuffer(trackId: number | string, audioBuffer: AudioBuffer, name?: string, offsetSec: number = 0): Promise<Clip | undefined> {
        const track = this.getTrack(trackId);
        if (!track) return;
        const clip: Clip = { buffer: audioBuffer, offset: offsetSec, name: name || 'clip', duration: audioBuffer.duration };
        track.clips.push(clip);
        return clip;
    }

    /**
     * タイムライン上のクリップ開始位置を変更する（0 秒未満にはならない）。
     * @param trackId - 対象トラック ID
     * @param clipIndex - クリップのインデックス
     * @param newOffset - 新しい開始位置（秒）
     */
    moveClip(trackId: number | string, clipIndex: number, newOffset: number): void {
        const track = this.getTrack(trackId);
        if (!track || !track.clips[clipIndex]) return;
        track.clips[clipIndex].offset = Math.max(0, newOffset);
    }

    /**
     * トラックから指定インデックスのクリップを削除する。
     * @param trackId - 対象トラック ID
     * @param clipIndex - 削除するクリップのインデックス
     */
    removeClip(trackId: number | string, clipIndex: number): void {
        const track = this.getTrack(trackId);
        if (!track) return;
        track.clips.splice(clipIndex, 1);
    }

    /**
     * いま鳴らすトラックを返す。ミュートしたトラックは鳴らさず、ソロにしたトラックが
     * 1 本でも在れば、ソロのトラックだけを鳴らす。
     *
     * 再生と書き出しの両方がこれを使う。別々に判定すると、聴いている音と書き出した音が食い違う
     * (以前は、書き出しだけがソロを無視していた)。練習画面の「聴く」は、再生だけに効く (`playbackTracks`)。
     * @returns 鳴らすトラックの一覧
     */
    audibleTracks(): Track[] {
        const hasSolo = this.tracks.some(t => t.solo);
        return this.tracks.filter(t => !t.mute && (!hasSolo || t.solo));
    }

    /** 再生で鳴らすトラック。練習画面の「聴く」が在ればそれに、無ければミュートとソロに従う。 */
    playbackTracks(): Track[] {
        const override = this.listenOverride;
        return override ? this.tracks.filter(t => override.has(t.id)) : this.audibleTracks();
    }

    /**
     * 全トラックを再生する。ソロ/ミュート状態を考慮してスケジューリングする。
     * @param fromSec - 再生開始位置（秒）。null の場合は現在の playOffset を使用
     */
    play(fromSec: number | null = null): void {
        this.init();
        if (this.isPlaying) this.stop();
        if (fromSec !== null) this.playOffset = fromSec;
        if (this.loopRange && loopLength(this.loopRange) > 0.05) {
            this._playLoop(this.loopRange);
            return;
        }
        this.startTime = this.ctx!.currentTime;
        this.isPlaying = true;
        this.soloTrackId = null;
        this.activeSources = [];

        for (const track of this.playbackTracks()) {
            this._scheduleTrack(track);
        }
        if (this.metronomeEnabled) this._startMetronome();
    }

    /** いま効いている速度。区間ループが無ければ 1（速度は区間の中でだけ効く）。 */
    effectiveRate(): number {
        return this.loopRange && this.tempoRate > 0 ? this.tempoRate : 1;
    }

    /**
     * 区間ループで再生する。1 周ずつ、鳴らす時刻 (AudioContext の時計) をサンプル単位で決めて先に用意しておく
     * (LOOP_LOOKAHEAD 秒ぶん)。周のつなぎ目に隙間ができない。用意するのは見回り (100ms ごと) のときだけで、
     * 1 周ぶんの音源の数はクリップとノートの数だけなので、CPU はほとんど使わない。
     *
     * AudioBufferSourceNode の `loop` (音声そのものの繰り返し) を使わないのは、ノート (オシレータ) と
     * メトロノームも同じ周で繰り返す必要があり、区間の途中から始まるクリップも扱うため。
     */
    _playLoop(loop: LoopRange): void {
        const ctx = this.ctx!;
        const rate = this.effectiveRate();
        this.playOffset = clampToLoop(this.playOffset, loop);
        // 少しだけ先から鳴らす (いまの時刻に置くと、最初の数ミリ秒が欠けて、2 周目からの時刻とずれる)
        const startWhen = ctx.currentTime + 0.03;
        this.startTime = startWhen;
        this.isPlaying = true;
        this.soloTrackId = null;
        this.activeSources = [];
        const playback: LoopPlayback = {
            loop: { ...loop }, startPos: this.playOffset, startWhen, rate, next: 0, tracks: this.playbackTracks(), timer: null,
        };
        this.loopPlayback = playback;
        this._fillLoop(playback);
        playback.timer = setInterval(() => this._fillLoop(playback), LOOP_TICK_MS);
    }

    /** 区間ループの、先に鳴らしておく周を用意する (LOOP_LOOKAHEAD 秒先まで)。 */
    _fillLoop(playback: LoopPlayback): void {
        if (this.loopPlayback !== playback || !this.ctx) return;
        const horizon = this.ctx.currentTime + LOOP_LOOKAHEAD;
        // 1 回の見回りで用意する周の数に上限を置く (極端に短い区間で止まらなくならないように)
        for (let guard = 0; guard < 64; guard++) {
            const segment = loopSegment(playback.loop, playback.startPos, playback.startWhen, playback.rate, playback.next);
            if (playback.next > 0 && segment.when > horizon) break;
            this._scheduleSegment(playback, segment);
            playback.next += 1;
        }
    }

    /** 1 周ぶんの音 (クリップ・ノート・メトロノーム) を用意する。 */
    _scheduleSegment(playback: LoopPlayback, segment: LoopSegment): void {
        const { rate, loop } = playback;
        const stepSec = stepSeconds(this);
        for (const t of playback.tracks) {
            if (rate === 1) {
                for (const clip of t.clips) {
                    const part = clipInSegment(segment, clip.offset, clip.duration);
                    if (part) this._startLoopSource(t, clip.buffer, part.when, part.offset, part.duration);
                }
            } else {
                // 速度を変えたときは、高さを変えずに伸ばした音声を鳴らす。伸ばした音声が無いトラックのクリップは鳴らさない
                // (そのまま鳴らすと、ノートとずれる。練習画面は、用意できるまで速度を 1 にしておく)
                const s = this.stretched;
                if (s && s.trackId === t.id && s.rate === rate && Math.abs(s.start - loop.start) < 1e-6 && Math.abs(s.end - loop.end) < 1e-6) {
                    this._startLoopSource(t, s.buffer, segment.when, (segment.from - loop.start) / rate, segment.duration);
                }
            }
            for (const n of t.pianoNotes || []) {
                const start = this.gridOffset + n.step * stepSec;
                const part = noteInSegment(segment, rate, start, n.length * stepSec);
                if (part) this._startLoopNote(t, n, part.when, part.duration, part.partial);
            }
        }
        if (this.metronomeEnabled) {
            for (const beat of beatsInSegment(segment, this.gridOffset, 60 / this.bpm, this.beatsPerBar)) {
                this._playClick(segment.when + (beat.at - segment.from) / rate, beat.downbeat ? 1500 : 1000);
            }
        }
    }

    /** 区間ループの音声を 1 つ鳴らす。つなぎ目で、ぷつっと鳴らないよう、頭と終わりをごく短く上げ下げする。 */
    _startLoopSource(track: Track, buffer: AudioBuffer, when: number, offset: number, duration: number): void {
        const ctx = this.ctx!;
        if (duration <= 0) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const fade = ctx.createGain();
        const edge = Math.min(LOOP_FADE, duration / 4);
        fade.gain.setValueAtTime(0, when);
        fade.gain.linearRampToValueAtTime(1, when + edge);
        fade.gain.setValueAtTime(1, when + duration - edge);
        fade.gain.linearRampToValueAtTime(0, when + duration);
        source.connect(fade);
        fade.connect(track.panNode);
        source.start(when, Math.max(0, offset), duration);
        this._trackSource(source);
    }

    /** 区間ループのノートを 1 つ鳴らす (エンベロープは、ふだんの再生と同じ)。 */
    _startLoopNote(track: Track, n: PianoNote, when: number, duration: number, partial: boolean): void {
        const ctx = this.ctx!;
        const freq = NOTE_FREQ[`${n.note}${n.octave}`];
        if (!freq || duration <= 0) return;
        const attack = partial ? 0 : 0.01;
        const release = Math.min(0.15, duration * 0.3);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(partial ? 0.25 : 0, when);
        if (!partial) gain.gain.linearRampToValueAtTime(0.25, when + attack);
        gain.gain.setValueAtTime(0.25, when + Math.max(attack, duration - release));
        gain.gain.linearRampToValueAtTime(0, when + duration);
        osc.connect(gain);
        gain.connect(track.panNode);
        osc.start(when);
        osc.stop(when + duration + 0.01);
        this._trackSource(osc);
    }

    /** 鳴らした音源を覚えておき (止めるとき用)、鳴り終わったら忘れる (長く回しても溜めない)。 */
    _trackSource(source: AudioBufferSourceNode | OscillatorNode): void {
        this.activeSources.push(source);
        source.onended = () => {
            const i = this.activeSources.indexOf(source);
            if (i >= 0) this.activeSources.splice(i, 1);
        };
    }

    /** 区間ループの見回りを止める。 */
    _stopLoop(): void {
        if (this.loopPlayback?.timer) clearInterval(this.loopPlayback.timer);
        this.loopPlayback = null;
    }

    /**
     * 区間ループで、いま何周目か (0 始まり)。区間ループで再生していなければ null。
     * MIDI のリアルタイム録音が、1 周ごとに記録を分けるのに使う。
     */
    getLoopPass(): number | null {
        const p = this.loopPlayback;
        if (!this.isPlaying || !p || !this.ctx) return null;
        return loopPosition(p.loop, p.startPos, p.rate, this.ctx.currentTime - p.startWhen).pass;
    }

    /**
     * 再生中なら、いまの位置から鳴らし直す。区間ループ・速度・「聴く」を変えたときに使う。
     */
    restartIfPlaying(): void {
        if (!this.isPlaying || this.soloTrackId !== null) return;
        const position = this.getCurrentTime();
        this.stop();
        this.playOffset = position;
        this.play();
    }

    /**
     * 区間ループを決める (null で外す)。再生中なら、いまの位置 (区間の外なら区間の頭) から鳴らし直す。
     * @param range - 区間 (曲の時刻、秒)
     */
    setLoopRange(range: LoopRange | null): void {
        const same = (range === null && this.loopRange === null)
            || (range !== null && this.loopRange !== null && range.start === this.loopRange.start && range.end === this.loopRange.end);
        if (same) return;
        this.loopRange = range ? { start: range.start, end: range.end } : null;
        this.restartIfPlaying();
    }

    /**
     * 速度と、伸ばした音声を決める。再生中なら、いまの位置から鳴らし直す。
     * @param rate - 速度 (1 = そのまま)
     * @param stretched - 速度に合わせて伸ばした音声 (無ければ null)
     */
    setTempo(rate: number, stretched: StretchedAudio | null): void {
        if (rate === this.tempoRate && stretched === this.stretched) return;
        this.tempoRate = rate;
        this.stretched = stretched;
        this.restartIfPlaying();
    }

    /**
     * 指定トラック単体を再生する（他のトラックは無音）。
     * @param trackId - 再生するトラック ID
     * @param fromSec - 再生開始位置（秒）。null の場合は現在の playOffset を使用
     */
    playSingleTrack(trackId: number | string, fromSec: number | null = null): void {
        this.init();
        if (this.isPlaying) this.stop();
        const track = this.getTrack(trackId);
        if (!track) return;
        if (fromSec !== null) this.playOffset = fromSec;
        this.startTime = this.ctx!.currentTime;
        this.isPlaying = true;
        this.soloTrackId = Number(trackId);
        this.activeSources = [];
        this._scheduleTrack(track);
        if (this.metronomeEnabled) this._startMetronome();
    }

    /**
     * トラック内のクリップとピアノノートを AudioContext にスケジュールする。
     * @param track - スケジュール対象の Track
     */
    _scheduleTrack(track: Track): void {
        for (const clip of track.clips) {
            const source = this.ctx!.createBufferSource();
            source.buffer = clip.buffer;
            source.connect(track.panNode);
            const clipStart = clip.offset - this.playOffset;
            if (clipStart >= 0) {
                source.start(this.ctx!.currentTime + clipStart);
            } else if (-clipStart < clip.duration) {
                source.start(this.ctx!.currentTime, -clipStart);
            } else {
                continue;
            }
            this.activeSources.push(source);
        }
        this._scheduleTrackNotes(track);
    }

    /**
     * トラックのピアノノートをオシレータでスケジュールする。
     * アタック/サステイン/リリースによるエンベロープを適用する。
     * @param track - ノートをスケジュールするトラック
     */
    _scheduleTrackNotes(track: Track): void {
        if (!track.pianoNotes || track.pianoNotes.length === 0) return;
        const stepSec = stepSeconds(this);
        for (const n of track.pianoNotes) {
            const freq = NOTE_FREQ[`${n.note}${n.octave}`];
            if (!freq) continue;
            const noteStart = this.gridOffset + n.step * stepSec;
            const noteDur = n.length * stepSec;
            const relStart = noteStart - this.playOffset;
            if (relStart + noteDur <= 0) continue;

            const attack = 0.01;
            const release = Math.min(0.15, noteDur * 0.3);
            const sustainDur = Math.max(0, noteDur - attack - release);

            const osc = this.ctx!.createOscillator();
            const gain = this.ctx!.createGain();
            osc.type = 'triangle';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, this.ctx!.currentTime);
            osc.connect(gain);
            gain.connect(track.panNode);

            if (relStart >= 0) {
                const when = this.ctx!.currentTime + relStart;
                gain.gain.setValueAtTime(0, when);
                gain.gain.linearRampToValueAtTime(0.25, when + attack);
                gain.gain.setValueAtTime(0.25, when + attack + sustainDur);
                gain.gain.linearRampToValueAtTime(0, when + noteDur);
                osc.start(when);
                osc.stop(when + noteDur + 0.01);
            } else {
                const elapsed = -relStart;
                const remaining = noteDur - elapsed;
                if (remaining <= 0) continue;
                const when = this.ctx!.currentTime;
                gain.gain.setValueAtTime(0.25, when);
                gain.gain.setValueAtTime(0.25, when + Math.max(0, remaining - release));
                gain.gain.linearRampToValueAtTime(0, when + remaining);
                osc.start(when);
                osc.stop(when + remaining + 0.01);
            }
            this.activeSources.push(osc);
        }
    }

    /**
     * 再生を停止し、再生位置を先頭（0 秒）に戻す。
     * アクティブな全ソースノードを停止する。
     */
    stop(): void {
        this._stopLoop();
        this.isPlaying = false;
        this.soloTrackId = null;
        for (const src of this.activeSources) {
            try { src.stop(); } catch (_e) { /* 既に停止済み */ }
        }
        this.activeSources = [];
        this._stopMetronome();
        this.playOffset = 0;
    }

    /**
     * 現在の再生位置（秒）を返す。再生中でなければ null。
     * MIDI 入力のリアルタイム録音が、鍵盤を押した位置を知るために使う。
     */
    getPlayPosition(): number | null {
        if (!this.isPlaying || !this.ctx) return null;
        return this.getCurrentTime();
    }

    /**
     * 再生位置を移す。再生中なら、その位置から鳴らし直す（トラック単体の再生なら、そのトラックを）。
     * シークバー、カルテやガイドの小節、差分チェックの指摘からの移動が使う。
     * @param sec - 移る先（秒）。0 未満は 0 にする
     */
    seek(sec: number): void {
        const target = Math.max(0, sec);
        const wasPlaying = this.isPlaying, wasSolo = this.soloTrackId;
        if (wasPlaying) this.stop();
        this.playOffset = target;
        if (wasPlaying) {
            if (wasSolo != null) this.playSingleTrack(wasSolo);
            else this.play();
        }
    }

    /**
     * 鍵盤を押している間だけ音を鳴らす（MIDI 入力のモニター用）。
     * `liveNoteOff` を呼ぶまで鳴り続ける。同じ高さをもう一度呼ぶと鳴らし直す。
     * @param pitch - MIDI ノート番号（60 = C4）
     * @param velocity - 強さ（1〜127）
     */
    liveNoteOn(pitch: number, velocity = 96): void {
        this.init();
        const ctx = this.ctx!;
        this.liveNoteOff(pitch);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
        const level = 0.25 * Math.max(0.2, Math.min(1, velocity / 127));
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(level, ctx.currentTime + 0.005);
        osc.connect(gain);
        gain.connect(this.masterGain!);
        osc.start();
        this.liveVoices.set(pitch, { osc, gain });
    }

    /**
     * `liveNoteOn` で鳴らした音を止める。鳴っていなければ何もしない。
     * @param pitch - MIDI ノート番号
     */
    liveNoteOff(pitch: number): void {
        const voice = this.liveVoices.get(pitch);
        if (!voice || !this.ctx) return;
        this.liveVoices.delete(pitch);
        const now = this.ctx.currentTime;
        // ぷつっという音が出ないよう、短く減衰させてから止める
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + 0.05);
        try { voice.osc.stop(now + 0.06); } catch { /* 既に停止済み */ }
    }

    /** `liveNoteOn` で鳴らしている音をすべて止める。 */
    liveAllNotesOff(): void {
        for (const pitch of Array.from(this.liveVoices.keys())) this.liveNoteOff(pitch);
    }

    /**
     * 再生を一時停止し、現在の再生位置を playOffset に保存する。
     * 再度 play() を呼ぶと同位置から再開できる。
     */
    pause(): void {
        if (!this.isPlaying) return;
        this.playOffset = this.getCurrentTime();
        this._stopLoop();
        this.isPlaying = false;
        for (const src of this.activeSources) {
            try { src.stop(); } catch (_e) { /* 既に停止済み */ }
        }
        this.activeSources = [];
        this._stopMetronome();
    }

    /**
     * 現在の再生位置を秒単位で返す。
     * @returns 再生中はリアルタイム位置、停止中は playOffset
     */
    getCurrentTime(): number {
        if (!this.isPlaying) return this.playOffset;
        const p = this.loopPlayback;
        // 区間ループ中は、区間の終わりで頭に戻る。速度を変えていれば、その速さで進む
        if (p) return loopPosition(p.loop, p.startPos, p.rate, this.ctx!.currentTime - p.startWhen).position;
        return this.playOffset + (this.ctx!.currentTime - this.startTime);
    }

    /**
     * 全トラックを通じた総再生時間を返す。
     * @returns 最も遅く終わるクリップ/ノートの終端時刻（秒）
     */
    getTotalDuration(): number {
        let maxEnd = 0;
        const stepSec = stepSeconds(this);
        for (const track of this.tracks) {
            maxEnd = Math.max(maxEnd, this._getTrackEndTime(track, stepSec));
        }
        return maxEnd;
    }

    /**
     * 指定トラックの再生時間を返す。
     * @param trackId - 対象トラック ID
     * @returns トラック内の最終クリップ/ノート終端時刻（秒）。トラックが存在しない場合は 0
     */
    getTrackDuration(trackId: number | string): number {
        const track = this.getTrack(trackId);
        if (!track) return 0;
        const stepSec = stepSeconds(this);
        return this._getTrackEndTime(track, stepSec);
    }

    /**
     * トラック内の全クリップ・ノートの終端時刻の最大値を返す内部メソッド。
     * @param track - 対象トラック
     * @param stepSec - 1 ステップの秒数（60 / bpm / 4）。ノートは 1 小節目の位置（gridOffset）から数える
     * @returns 最終終端時刻（秒）
     */
    _getTrackEndTime(track: Track, stepSec: number): number {
        let maxEnd = 0;
        for (const clip of track.clips) {
            maxEnd = Math.max(maxEnd, clip.offset + clip.duration);
        }
        for (const n of (track.pianoNotes || [])) {
            maxEnd = Math.max(maxEnd, this.gridOffset + (n.step + n.length) * stepSec);
        }
        return maxEnd;
    }

    /**
     * メトロノームのスケジューリングループを開始する。
     * 50 ms 間隔でビートをルックアヘッドしてクリック音を鳴らす。
     */
    _startMetronome(): void {
        this._stopMetronome();
        // 拍は 1 小節目の 1 拍目 (gridOffset) から数える。それより前 (弱起) の拍も同じ間隔で鳴らす
        const beatSec = 60 / this.bpm;
        const origin = this.gridOffset;
        let nextBeat = origin + Math.ceil((this.playOffset - origin) / beatSec) * beatSec;
        const schedule = (): void => {
            if (!this.isPlaying || !this.metronomeEnabled) return;
            const now = this.getCurrentTime();
            while (nextBeat < now + 0.1) {
                const perBar = Math.max(1, this.beatsPerBar);
                const beatInBar = ((Math.round((nextBeat - origin) / beatSec) % perBar) + perBar) % perBar;
                const freq = beatInBar === 0 ? 1500 : 1000;
                this._playClick(nextBeat - this.playOffset + this.startTime, freq);
                nextBeat += beatSec;
            }
        };
        schedule();
        this.metronomeInterval = setInterval(schedule, 50);
    }

    /** メトロノームのインターバルタイマーを停止・クリアする。 */
    _stopMetronome(): void {
        if (this.metronomeInterval) {
            clearInterval(this.metronomeInterval);
            this.metronomeInterval = null;
        }
    }

    /**
     * 指定タイミングに短いクリック音（サイン波）を再生する。
     * @param when - 再生タイミング（AudioContext の絶対時刻、秒）
     * @param freq - クリック音の周波数（Hz）。拍頭は 1500 Hz、それ以外は 1000 Hz
     */
    _playClick(when: number, freq: number): void {
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, when);
        gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
        osc.connect(gain);
        gain.connect(this.ctx!.destination);
        osc.start(when);
        osc.stop(when + 0.05);
    }

    /**
     * マイク入力を開始し、MediaRecorder で録音バッファを蓄積する。
     * @returns マイクの権限取得と録音開始が完了したら resolve する Promise
     */
    async startRecording(): Promise<void> {
        this.init();
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mediaRecorder = new MediaRecorder(this.mediaStream);
        this.recordedChunks = [];
        this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
            if (e.data.size > 0) this.recordedChunks.push(e.data);
        };
        this.mediaRecorder.start();
        this.isRecording = true;
    }

    /**
     * 録音を停止し、録音データをデコードして AudioBuffer を返す。
     * @returns デコード済みの録音データを含む AudioBuffer
     */
    stopRecording(): Promise<AudioBuffer> {
        return new Promise((resolve) => {
            this.mediaRecorder!.onstop = async () => {
                this.isRecording = false;
                this.mediaStream!.getTracks().forEach(t => t.stop());
                const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
                const arrayBuf = await blob.arrayBuffer();
                const buffer = await this.ctx!.decodeAudioData(arrayBuf);
                resolve(buffer);
            };
            this.mediaRecorder!.stop();
        });
    }

    /**
     * OfflineAudioContext を使って全トラックをミックスダウンする。
     * 鳴らすトラックは再生と同じ（ミュートとソロに従う。`audibleTracks`）。
     * @returns ミックス済み AudioBuffer。コンテンツが空の場合は null
     */
    async mixdown(): Promise<AudioBuffer | null> {
        this.init();
        const duration = this.getTotalDuration();
        if (duration === 0) return null;
        const sampleRate = 44100;
        const offCtx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
        const master = offCtx.createGain();
        master.connect(offCtx.destination);
        const stepSec = stepSeconds(this);

        for (const track of this.audibleTracks()) {
            const gainNode = offCtx.createGain();
            gainNode.gain.value = Math.pow(10, track.gain / 20);
            const panNode = offCtx.createStereoPanner();
            panNode.pan.value = track.pan;
            panNode.connect(gainNode);
            gainNode.connect(master);

            for (const clip of track.clips) {
                const src = offCtx.createBufferSource();
                src.buffer = clip.buffer;
                src.connect(panNode);
                src.start(clip.offset);
            }

            for (const n of (track.pianoNotes || [])) {
                const freq = NOTE_FREQ[`${n.note}${n.octave}`];
                if (!freq) continue;
                const noteStart = this.gridOffset + n.step * stepSec;
                const noteDur = n.length * stepSec;
                const attack = 0.01;
                const release = Math.min(0.15, noteDur * 0.3);
                const sustainDur = Math.max(0, noteDur - attack - release);
                const osc = offCtx.createOscillator();
                const g = offCtx.createGain();
                osc.type = 'triangle';
                osc.frequency.value = freq;
                g.gain.setValueAtTime(0, noteStart);
                g.gain.linearRampToValueAtTime(0.25, noteStart + attack);
                g.gain.setValueAtTime(0.25, noteStart + attack + sustainDur);
                g.gain.linearRampToValueAtTime(0, noteStart + noteDur);
                osc.connect(g);
                g.connect(panNode);
                osc.start(noteStart);
                osc.stop(noteStart + noteDur + 0.01);
            }
        }

        return await offCtx.startRendering();
    }

    /**
     * 全トラックをミックスダウンして WAV Blob を返す。
     * @returns WAV 形式の Blob。コンテンツが空の場合は null
     */
    async exportWav(): Promise<Blob | null> {
        const buffer = await this.mixdown();
        if (!buffer) return null;
        return this._audioBufferToWav(buffer);
    }

    /**
     * AudioBuffer を PCM 16bit WAV フォーマットの Blob に変換する。
     * @param buffer - 変換元の AudioBuffer
     * @returns audio/wav の Blob
     */
    _audioBufferToWav(buffer: AudioBuffer): Blob {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const length = buffer.length;
        const bytesPerSample = 2;
        const dataLength = length * numChannels * bytesPerSample;
        const headerLength = 44;
        const wav = new ArrayBuffer(headerLength + dataLength);
        const view = new DataView(wav);
        const writeString = (offset: number, str: string): void => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataLength, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
        view.setUint16(32, numChannels * bytesPerSample, true);
        view.setUint16(34, 8 * bytesPerSample, true);
        writeString(36, 'data');
        view.setUint32(40, dataLength, true);
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));
        let offset = 44;
        for (let i = 0; i < length; i++) {
            for (let ch = 0; ch < numChannels; ch++) {
                const sample = Math.max(-1, Math.min(1, channels[ch][i]));
                view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
                offset += 2;
            }
        }
        return new Blob([wav], { type: 'audio/wav' });
    }
}

// シングルトンインスタンス
const engine = new AudioEngine();
export default engine;
export { NOTE_FREQ };
