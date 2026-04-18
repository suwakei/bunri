/**
 * bunri DAW — WebAudio リアルタイム再生エンジン
 * トラック管理、クリップ再生、ピアノノート再生、メトロノーム、録音を担当
 */

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
    metronomeEnabled: boolean;
    metronomeInterval: ReturnType<typeof setInterval> | null = null;

    tracks: Track[] = [];
    nextTrackId: number;

    mediaStream: MediaStream | null = null;
    mediaRecorder: MediaRecorder | null = null;
    recordedChunks: Blob[] = [];

    activeSources: (AudioBufferSourceNode | OscillatorNode)[] = [];
    soloTrackId: number | null = null;

    constructor() {
        this.isPlaying = false;
        this.isRecording = false;
        this.startTime = 0;
        this.playOffset = 0;
        this.bpm = 120;
        this.beatsPerBar = 4;
        this.metronomeEnabled = false;
        this.nextTrackId = 1;
    }

    /**
     * AudioContext とマスターゲインを初期化する。
     * 既に初期化済みの場合は何もしない。
     */
    init(): void {
        if (this.ctx) return;
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
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
            name: name || `Track ${this.tracks.length + 1}`,
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
        track.gainNode.gain.value = track.mute ? 0 : Math.pow(10, db / 20);
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
        track.gainNode.gain.value = track.mute ? 0 : Math.pow(10, track.gain / 20);
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
        const resp = await fetch(url);
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
     * 全トラックを再生する。ソロ/ミュート状態を考慮してスケジューリングする。
     * @param fromSec - 再生開始位置（秒）。null の場合は現在の playOffset を使用
     */
    play(fromSec: number | null = null): void {
        this.init();
        if (this.isPlaying) this.stop();
        if (fromSec !== null) this.playOffset = fromSec;
        this.startTime = this.ctx!.currentTime;
        this.isPlaying = true;
        this.soloTrackId = null;
        this.activeSources = [];

        const hasSolo = this.tracks.some(t => t.solo);
        for (const track of this.tracks) {
            if (track.mute) continue;
            if (hasSolo && !track.solo) continue;
            this._scheduleTrack(track);
        }
        if (this.metronomeEnabled) this._startMetronome();
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
        const stepSec = 60 / this.bpm / 4;
        for (const n of track.pianoNotes) {
            const freq = NOTE_FREQ[`${n.note}${n.octave}`];
            if (!freq) continue;
            const noteStart = n.step * stepSec;
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
     * 再生を一時停止し、現在の再生位置を playOffset に保存する。
     * 再度 play() を呼ぶと同位置から再開できる。
     */
    pause(): void {
        if (!this.isPlaying) return;
        this.playOffset += this.ctx!.currentTime - this.startTime;
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
        return this.playOffset + (this.ctx!.currentTime - this.startTime);
    }

    /**
     * 全トラックを通じた総再生時間を返す。
     * @returns 最も遅く終わるクリップ/ノートの終端時刻（秒）
     */
    getTotalDuration(): number {
        let maxEnd = 0;
        const stepSec = 60 / this.bpm / 4;
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
        const stepSec = 60 / this.bpm / 4;
        return this._getTrackEndTime(track, stepSec);
    }

    /**
     * トラック内の全クリップ・ノートの終端時刻の最大値を返す内部メソッド。
     * @param track - 対象トラック
     * @param stepSec - 1 ステップの秒数（60 / bpm / 4）
     * @returns 最終終端時刻（秒）
     */
    _getTrackEndTime(track: Track, stepSec: number): number {
        let maxEnd = 0;
        for (const clip of track.clips) {
            maxEnd = Math.max(maxEnd, clip.offset + clip.duration);
        }
        for (const n of (track.pianoNotes || [])) {
            maxEnd = Math.max(maxEnd, (n.step + n.length) * stepSec);
        }
        return maxEnd;
    }

    /**
     * メトロノームのスケジューリングループを開始する。
     * 50 ms 間隔でビートをルックアヘッドしてクリック音を鳴らす。
     */
    _startMetronome(): void {
        this._stopMetronome();
        const beatSec = 60 / this.bpm;
        let nextBeat = Math.ceil(this.playOffset / beatSec) * beatSec;
        const schedule = (): void => {
            if (!this.isPlaying || !this.metronomeEnabled) return;
            const now = this.getCurrentTime();
            while (nextBeat < now + 0.1) {
                const beatInBar = Math.round(nextBeat / beatSec) % this.beatsPerBar;
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

    async mixdown(): Promise<AudioBuffer | null> {
        this.init();
        const duration = this.getTotalDuration();
        if (duration === 0) return null;
        const sampleRate = 44100;
        const offCtx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
        const master = offCtx.createGain();
        master.connect(offCtx.destination);
        const stepSec = 60 / this.bpm / 4;

        for (const track of this.tracks) {
            if (track.mute) continue;
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
                const noteStart = n.step * stepSec;
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

    async exportWav(): Promise<Blob | null> {
        const buffer = await this.mixdown();
        if (!buffer) return null;
        return this._audioBufferToWav(buffer);
    }

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
