/**
 * デスクトップ版の再生 (Rust の engine に渡す口。lib/native-audio.ts) のテスト。
 *
 * `window.__TAURI__` を偽物にして、再生エンジン (lib/engine.ts) が Rust の command をどう呼ぶかを確かめる:
 * 曲の内容の組み立て、同じ内容なら送り直さないこと、クリップの分割送信、呼び出しの順番、速度の変換、
 * event からの位置の補い方、失敗したら Web Audio に切り替わって鳴ること、ブラウザでは Rust を呼ばないこと。
 * AudioContext は、時計を進められるモック。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Rust に渡す口 (invoke / listen) を、呼ばれたかどうか確かめられるように包む (中身は本物)
vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        invokeDesktop: vi.fn(actual.invokeDesktop),
        invokeDesktopRaw: vi.fn(actual.invokeDesktopRaw),
        listenDesktop: vi.fn(actual.listenDesktop),
    };
});

const started: { kind: 'buffer' | 'osc'; when: number; offset?: number; buffer?: unknown; freq?: number }[] = [];
class MockParam { value = 1; setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
class MockGain { gain = new MockParam(); connect() { return this; } disconnect() {} }
class MockContext {
    currentTime = 0;
    state = 'running';
    destination = {};
    createGain() { return new MockGain() as unknown as GainNode; }
    createStereoPanner() { return { pan: { value: 0 }, connect() { return this; } } as unknown as StereoPannerNode; }
    createBufferSource() {
        const node = { buffer: null as unknown, onended: null, connect() {}, stop() {},
            start(when: number, offset?: number) { started.push({ kind: 'buffer', when, offset, buffer: node.buffer }); } };
        return node;
    }
    createOscillator() {
        const now = () => this.currentTime;
        const node = { type: 'sine', frequency: { value: 0 }, onended: null, connect() {}, stop() {},
            start(when?: number) { started.push({ kind: 'osc', when: when ?? now(), freq: node.frequency.value }); } };
        return node;
    }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockContext;

const { default: engine } = await import('../lib/engine');
const { invokeDesktop, invokeDesktopRaw, listenDesktop } = await import('../lib/api');
const {
    nativeAudio, buildSong, playArgs, estimatePosition, toPlayAxis, fromPlayAxis, notePitch,
    AUDIO_BACKEND_KEY, CLIP_CHUNK_BYTES, POSITION_WATCHDOG_MS, POSITION_WATCHDOG_GRACE_MS,
} = await import('../lib/native-audio');
const { applyProject, captureProject } = await import('../lib/project-snapshot');
type PlayRequest = import('../lib/native-audio').PlayRequest;
type NativePlayback = import('../lib/native-audio').NativePlayback;

const ctx = () => engine.ctx as unknown as MockContext;

/** 中身の在る音声 (チャンネルごとのサンプル)。 */
function audioBuffer(channels: ArrayLike<number>[], sampleRate = 48000): AudioBuffer {
    const data = channels.map((c) => Float32Array.from(c));
    return {
        duration: data[0].length / sampleRate, length: data[0].length, sampleRate, numberOfChannels: data.length,
        getChannelData: (ch: number) => data[ch],
    } as unknown as AudioBuffer;
}

interface Call {
    cmd: string;
    args?: any;
    headers?: Record<string, string>;
    body?: Float32Array;
}

/** 偽の Rust。呼ばれた command を順に覚え、位置の event を送れる。 */
function desktop() {
    const calls: Call[] = [];
    const state = {
        /** true を返した command は失敗する */
        fail: null as ((cmd: string) => boolean) | null,
        /** 再生・停止・曲・ミックスの command が、同時に 2 つ動いたか */
        overlapped: false,
        /** 出力を開いた直後の後始末 (前の画面の再生と試聴を止める) で呼ばれた command。`calls` には入れない */
        cleanup: [] as string[],
    };
    /** 出力を開いた直後の後始末として、まだ来ていない command */
    let cleanupLeft: string[] = [];
    let handler: ((e: { payload: unknown }) => void) | null = null;
    let active = 0;
    const invoke = vi.fn(async (cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => {
        const call: Call = { cmd };
        if (args instanceof Uint8Array) {
            call.headers = options?.headers;
            call.body = new Float32Array(args.buffer.slice(args.byteOffset, args.byteOffset + args.byteLength));
        } else if (args !== undefined) {
            call.args = JSON.parse(JSON.stringify(args));
        }
        if (cmd === 'audio_init') cleanupLeft = ['audio_stop', 'audio_live_all_off'];
        if (cleanupLeft[0] === cmd && args === undefined) {
            // 後始末の呼び出しは、どのテストにも出てくるので、順番の確かめの邪魔にならないよう別に覚える
            cleanupLeft.shift();
            state.cleanup.push(cmd);
            if (state.fail?.(cmd)) throw '偽の Rust: 失敗させた';
            return undefined;
        }
        if (cmd !== 'audio_init') cleanupLeft = [];
        calls.push(call);
        const transport = !cmd.startsWith('audio_live') && cmd !== 'audio_clip_put';
        if (transport) { active++; if (active > 1) state.overlapped = true; }
        try {
            // Rust の処理には時間がかかる。そのあいだに次の command が割り込まないことを確かめる
            await Promise.resolve();
            await Promise.resolve();
            if (state.fail?.(cmd)) throw '偽の Rust: 失敗させた';
            if (cmd === 'audio_init') return { sampleRate: 48000, outputLatencySec: 0.012 };
            if (cmd === 'audio_clip_put') {
                const h = call.headers!;
                const got = Number(h['x-offset']) + call.body!.length / Number(h['x-channels']);
                return { complete: got >= Number(h['x-frames']) };
            }
            return undefined;
        } finally {
            if (transport) active--;
        }
    });
    const listen = vi.fn(async (_name: string, h: (e: { payload: unknown }) => void) => {
        handler = h;
        return () => { handler = null; };
    });
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke }, event: { listen } };
    return {
        calls, state, invoke, listen,
        cmds: () => calls.map((c) => c.cmd),
        of: (cmd: string) => calls.filter((c) => c.cmd === cmd),
        /** その command の、最後の呼び出し */
        last: (cmd: string) => calls.filter((c) => c.cmd === cmd).slice(-1)[0],
        /** 位置の event を送る (既定は「いま、鳴っている」) */
        emit: (event: { token: number; positionSec: number; playing?: boolean; countingIn?: boolean; atMs?: number; pass?: number; countInRemainingSec?: number }) =>
            handler?.({ payload: { playing: true, countingIn: false, atMs: Date.now(), pass: 0, ...event } }),
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    started.length = 0;
    vi.mocked(invokeDesktop).mockClear();
    vi.mocked(invokeDesktopRaw).mockClear();
    vi.mocked(listenDesktop).mockClear();
    nativeAudio.resetForTest();
    engine.tracks = [];
    engine.bpm = 120; engine.beatsPerBar = 4; engine.gridOffset = 0;
    engine.loopRange = null; engine.tempoRate = 1; engine.stretched = null; engine.listenOverride = null;
    engine.metronomeEnabled = false;
    engine.countInBeats = 0;
    engine.playOffset = 0;
    engine.init();
    ctx().currentTime = 0;
});

afterEach(async () => {
    engine.stop();
    engine.liveAllNotesOff();
    await nativeAudio.idle();
    nativeAudio.resetForTest();
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    localStorage.removeItem(AUDIO_BACKEND_KEY);
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** 曲を組み立てる材料 (足りないところは既定の値)。 */
function request(partial: Partial<PlayRequest>): PlayRequest {
    return {
        bpm: 120, beatsPerBar: 4, offsetSec: 0, tracks: [], fromSec: 0, loop: null, rate: 1, stretched: null,
        countIn: null, metronome: false, ...partial,
    };
}

describe('曲の内容の組み立て', () => {
    it('ノートはティック (step × 240) と MIDI 番号 (C4 = 60) にし、強さが無ければ 96 にする', () => {
        const song = buildSong(request({
            bpm: 96.5, beatsPerBar: 3, offsetSec: 0.25,
            tracks: [{
                id: 7, gainDb: -3, pan: 0.25, audible: true, clips: [],
                notes: [
                    { note: 'C', octave: 4, step: 0, length: 4 },
                    { note: 'A', octave: 4, step: 6, length: 2, velocity: 40 },
                    { note: 'C#', octave: 0, step: 16, length: 1, velocity: 300 },
                    { note: 'B', octave: 8, step: 1, length: 1, velocity: 0.2 },
                ],
            }],
        }), () => 0);
        expect(song).toEqual({
            bpm: 96.5, offsetSec: 0.25, beatsPerBar: 3,
            tracks: [{
                id: 7, gainDb: -3, pan: 0.25, audible: true, clips: [],
                notes: [
                    { start: 0, length: 960, pitch: 60, velocity: 96 },
                    { start: 1440, length: 480, pitch: 69, velocity: 40 },
                    { start: 3840, length: 240, pitch: 13, velocity: 127 },
                    { start: 240, length: 240, pitch: 119, velocity: 1 },
                ],
            }],
        });
    });

    it('Web Audio で鳴らないノート (知らない音名、オクターブ 0〜8 の外、長さが無い) は入れない', () => {
        expect(notePitch('C', 4)).toBe(60);
        expect(notePitch('H', 4)).toBeNull();
        expect(notePitch('C', 9)).toBeNull();
        expect(notePitch('C', -1)).toBeNull();
        const song = buildSong(request({
            tracks: [{
                id: 1, gainDb: 0, pan: 0, audible: true, clips: [],
                notes: [
                    { note: 'H', octave: 4, step: 0, length: 4 },
                    { note: 'C', octave: 9, step: 0, length: 4 },
                    { note: 'C', octave: 4, step: 0, length: 0 },
                    { note: 'D', octave: 4, step: 2, length: 1 },
                ],
            }],
        }), () => 0);
        expect(song.tracks[0].notes).toEqual([{ start: 480, length: 240, pitch: 62, velocity: 96 }]);
    });

    it('音声の無いクリップ (missing) は入れない。鳴らさないトラックも、audible を false にして入れる', () => {
        const a = audioBuffer([[0, 0]]), b = audioBuffer([[0, 0]]), placeholder = audioBuffer([[0]]);
        const ids = new Map([[a, 11], [b, 12]]);
        const asked: AudioBuffer[] = [];
        const song = buildSong(request({
            tracks: [
                { id: 1, gainDb: 0, pan: 0, audible: false, notes: [], clips: [{ buffer: a, offset: 1.5 }, { buffer: placeholder, offset: 3, missing: true }] },
                { id: 2, gainDb: 0, pan: -1, audible: true, notes: [], clips: [{ buffer: b, offset: 0 }, { buffer: a, offset: 8 }] },
            ],
        }), (buffer) => { asked.push(buffer); return ids.get(buffer)!; });
        expect(song.tracks.map((t) => [t.id, t.audible, t.clips])).toEqual([
            [1, false, [{ clip: 11, startSec: 1.5 }]],
            [2, true, [{ clip: 12, startSec: 0 }, { clip: 11, startSec: 8 }]],
        ]);
        expect(asked).not.toContain(placeholder);
    });
});

describe('速度の変換', () => {
    it('行きと帰り: 区間の頭は動かず、区間の中は速度のぶんだけ伸びる', () => {
        const tempo = { start: 2, rate: 0.5 };
        expect(toPlayAxis(2, tempo)).toBe(2);
        expect(toPlayAxis(3, tempo)).toBe(4);
        expect(toPlayAxis(4, tempo)).toBe(6);
        expect(fromPlayAxis(4, tempo)).toBe(3);
        for (const sec of [0, 2, 2.75, 3.999, 10]) expect(fromPlayAxis(toPlayAxis(sec, tempo), tempo)).toBeCloseTo(sec, 12);
        // 変換しないとき
        expect(toPlayAxis(3, null)).toBe(3);
        expect(fromPlayAxis(3, null)).toBe(3);
    });

    it('テンポに速度を掛け、1 小節目の位置を区間の頭から測り直し、クリップは伸ばした音声だけを区間の頭に置く', () => {
        const original = audioBuffer([[0, 0]]), stretched = audioBuffer([[0, 0, 0, 0]]), other = audioBuffer([[0]]);
        const ids = new Map([[original, 1], [stretched, 2], [other, 3]]);
        const req = request({
            bpm: 120, offsetSec: 0.5, fromSec: 3, loop: { start: 2, end: 4 }, rate: 0.5,
            stretched: { trackId: 1, start: 2, end: 4, rate: 0.5, buffer: stretched },
            countIn: { beats: 4, beatSec: 0.5 }, metronome: true,
            tracks: [
                { id: 1, gainDb: 0, pan: 0, audible: true, clips: [{ buffer: original, offset: 0 }], notes: [{ note: 'A', octave: 4, step: 4, length: 2 }] },
                { id: 2, gainDb: 0, pan: 0, audible: true, clips: [{ buffer: other, offset: 0 }], notes: [] },
            ],
        });
        const song = buildSong(req, (buffer) => ids.get(buffer)!);
        expect(song.bpm).toBe(60);
        expect(song.offsetSec).toBe(-1);        // 2 + (0.5 − 2) / 0.5
        expect(song.tracks[0].clips).toEqual([{ clip: 2, startSec: 2 }]);
        // 伸ばした音声が無いトラックのクリップは渡さない (そのまま鳴らすと、ノートとずれる)
        expect(song.tracks[1].clips).toEqual([]);
        // ノートのティックは変えない (テンポで伸びる)
        expect(song.tracks[0].notes).toEqual([{ start: 960, length: 480, pitch: 69, velocity: 96 }]);
        expect(playArgs(req, 5)).toEqual({
            token: 5, fromSec: 4, loop: { startSec: 2, endSec: 6 },
            // カウントの 1 拍の長さには速度を掛けない
            countIn: { beats: 4, beatSec: 0.5 }, metronome: true,
        });
    });

    it('別の区間・別の速度の伸ばした音声は使わない。区間ループが無ければ、速度は効かない', () => {
        const original = audioBuffer([[0, 0]]), stretched = audioBuffer([[0, 0, 0, 0]]);
        const track = { id: 1, gainDb: 0, pan: 0, audible: true, clips: [{ buffer: original, offset: 0 }], notes: [] };
        const wrong = buildSong(request({
            loop: { start: 2, end: 4 }, rate: 0.5, tracks: [track],
            stretched: { trackId: 1, start: 2, end: 6, rate: 0.5, buffer: stretched },
        }), () => 9);
        expect(wrong.tracks[0].clips).toEqual([]);
        const req = request({ loop: null, rate: 0.5, fromSec: 3, tracks: [track], stretched: { trackId: 1, start: 2, end: 4, rate: 0.5, buffer: stretched } });
        const plain = buildSong(req, (buffer) => (buffer === original ? 1 : 2));
        expect(plain.bpm).toBe(120);
        expect(plain.tracks[0].clips).toEqual([{ clip: 1, startSec: 0 }]);
        expect(playArgs(req, 1)).toMatchObject({ fromSec: 3, loop: null });
    });
});

describe('event からの位置の補い方', () => {
    const base: NativePlayback = { token: 1, startPos: 3, loop: null, rate: 1, countIn: false, last: null };
    const event = (positionSec: number, more: Partial<NonNullable<NativePlayback['last']>> = {}) =>
        ({ token: 1, playing: true, countingIn: false, positionSec, atMs: 10_000, pass: 0, ...more });

    it('最初の event が届くまでは、始める位置のまま', () => {
        expect(estimatePosition(base, 99_999)).toEqual({ position: 3, pass: 0, countingIn: false });
        expect(estimatePosition({ ...base, countIn: true }, 99_999)).toEqual({ position: 3, pass: 0, countingIn: true });
    });

    it('最後の event の位置に、そこからの経過時間を足す (時計が戻っていたら足さない。足すのは 1 秒まで)', () => {
        const p = { ...base, last: event(5) };
        expect(estimatePosition(p, 10_250).position).toBeCloseTo(5.25);
        expect(estimatePosition(p, 9_000).position).toBe(5);
        expect(estimatePosition(p, 70_000).position).toBe(6);
    });

    it('カウントの最中は進めない。止まっていたら進めない', () => {
        const counting = { ...base, countIn: true, last: event(3, { countingIn: true }) };
        expect(estimatePosition(counting, 10_900)).toEqual({ position: 3, pass: 0, countingIn: true });
        const stopped = { ...base, last: event(5, { playing: false }) };
        expect(estimatePosition(stopped, 10_900).position).toBe(5);
    });

    it('区間ループでは、区間の中に折り返し、何周目かも合わせる', () => {
        const p = { ...base, loop: { start: 2, end: 4 }, last: event(3.9, { pass: 2 }) };
        expect(estimatePosition(p, 10_050)).toMatchObject({ pass: 2 });
        expect(estimatePosition(p, 10_050).position).toBeCloseTo(3.95);
        const wrapped = estimatePosition(p, 10_300);
        expect(wrapped.position).toBeCloseTo(2.2);
        expect(wrapped.pass).toBe(3);
    });

    it('速度を変えているときは、鳴らす時間軸の位置を曲の時刻に戻す (折り返しは、伸びた区間の長さで)', () => {
        // 区間 [2, 4) を半分の速さで: 鳴らす時間軸では [2, 6)
        const p = { ...base, loop: { start: 2, end: 4 }, rate: 0.5, last: event(5) };
        expect(estimatePosition(p, 10_000).position).toBeCloseTo(3.5);
        expect(estimatePosition(p, 10_400).position).toBeCloseTo(3.7);
        const wrapped = estimatePosition({ ...p, last: event(5.9) }, 10_300);
        expect(wrapped.position).toBeCloseTo(2.1);
        expect(wrapped.pass).toBe(1);
    });
});

describe('Rust で再生する (デスクトップ版)', () => {
    it('最初の再生で、出力を開く → 曲を渡す → 鳴らす、の順に呼ぶ。isPlaying は play() の直後に true', async () => {
        const d = desktop();
        const t = engine.addTrack('A');
        t.pianoNotes = [{ note: 'C', octave: 4, step: 4, length: 2 }];
        engine.play(0);
        expect(engine.isPlaying).toBe(true);
        expect(engine.usesNativeAudio()).toBe(true);
        await nativeAudio.idle();
        expect(d.cmds()).toEqual(['audio_init', 'audio_set_song', 'audio_play']);
        // 位置の event の受け口は、出力を開く前に用意する
        expect(d.listen).toHaveBeenCalledWith('audio://position', expect.any(Function));
        expect(d.listen.mock.invocationCallOrder[0]).toBeLessThan(d.invoke.mock.invocationCallOrder[0]);
        expect(d.calls[1].args).toEqual({
            song: {
                bpm: 120, offsetSec: 0, beatsPerBar: 4,
                tracks: [{ id: t.id, gainDb: 0, pan: 0, audible: true, notes: [{ start: 960, length: 480, pitch: 60, velocity: 96 }], clips: [] }],
            },
        });
        expect(d.calls[2].args).toEqual({ token: 1, fromSec: 0, loop: null, countIn: null, metronome: false });
        // Web Audio では鳴らしていない
        expect(started).toEqual([]);
    });

    it('出力を開いた直後に、前の画面の再生と試聴を止める (読み込み直しても、Rust の側で鳴り続けない)', async () => {
        const d = desktop();
        engine.addTrack('A').pianoNotes = [{ note: 'A', octave: 4, step: 0, length: 2 }];
        engine.play(0);
        await nativeAudio.idle();
        expect(d.state.cleanup).toEqual(['audio_stop', 'audio_live_all_off']);
        expect(d.cmds()).toEqual(['audio_init', 'audio_set_song', 'audio_play']);
        expect(document.documentElement.dataset.bunriAudio).toBe('native');
    });

    it('同じ内容なら曲を送り直さない。ノートを変えたら送り直す', async () => {
        const d = desktop();
        const t = engine.addTrack('A');
        t.pianoNotes = [{ note: 'C', octave: 4, step: 4, length: 2 }];
        engine.play(0);
        await nativeAudio.idle();
        engine.stop();
        engine.play(1);
        await nativeAudio.idle();
        expect(d.cmds().slice(3)).toEqual(['audio_stop', 'audio_play']);
        expect(d.calls[4].args).toMatchObject({ token: 2, fromSec: 1 });
        // 再生中の編集は、鳴らし直すまで Rust に届けない
        t.pianoNotes = [...t.pianoNotes, { note: 'E', octave: 4, step: 8, length: 2, velocity: 110 }];
        await nativeAudio.idle();
        expect(d.calls).toHaveLength(5);
        engine.pause();
        engine.play();
        await nativeAudio.idle();
        expect(d.cmds().slice(5)).toEqual(['audio_stop', 'audio_set_song', 'audio_play']);
        expect(d.calls[6].args.song.tracks[0].notes).toHaveLength(2);
    });

    it('play → stop → play を続けて呼んでも、Rust には呼んだ順に 1 つずつ届く。止めた再生は鳴らさない', async () => {
        const d = desktop();
        const t = engine.addTrack('A');
        t.pianoNotes = [{ note: 'C', octave: 4, step: 4, length: 2 }];
        engine.play(0);
        engine.stop();
        engine.play(2);
        engine.seek(3);     // 止めて、鳴らし直す
        await nativeAudio.idle();
        expect(d.cmds()).toEqual(['audio_init', 'audio_stop', 'audio_stop', 'audio_set_song', 'audio_play']);
        expect(d.of('audio_play').map((c) => c.args.token)).toEqual([3]);
        expect(d.of('audio_play')[0].args.fromSec).toBe(3);
        expect(d.state.overlapped).toBe(false);
    });

    it('再生のたびに startTime が変わる (PracticeView が再生 1 回ごとの印に使う。AudioContext の時計が止まっていても)', async () => {
        desktop();
        engine.addTrack('A');
        engine.play(0);
        const first = engine.startTime;
        engine.stop();
        engine.play(0);
        const second = engine.startTime;
        engine.pause();
        engine.play();
        expect(new Set([first, second, engine.startTime]).size).toBe(3);
    });

    it('トラック単体の再生は、そのトラックだけを鳴らす (区間ループ・カウントは入れない)', async () => {
        const d = desktop();
        const a = engine.addTrack('A'), b = engine.addTrack('B');
        engine.setLoopRange({ start: 2, end: 4 });
        engine.countInBeats = 4;
        engine.playSingleTrack(b.id, 1);
        expect(engine.isPlaying).toBe(true);
        expect(engine.soloTrackId).toBe(b.id);
        expect(engine.getLoopPass()).toBeNull();
        await nativeAudio.idle();
        expect(d.of('audio_set_song')[0].args.song.tracks.map((t: { id: number; audible: boolean }) => [t.id, t.audible])).toEqual([[a.id, false], [b.id, true]]);
        expect(d.of('audio_play')[0].args).toEqual({ token: 1, fromSec: 1, loop: null, countIn: null, metronome: false });
        // シークしても、そのトラックだけのまま
        engine.seek(5);
        await nativeAudio.idle();
        expect(engine.soloTrackId).toBe(b.id);
        expect(d.of('audio_play')[1].args).toMatchObject({ fromSec: 5, loop: null });
        expect(d.of('audio_set_song')).toHaveLength(1);
    });

    it('ミュート・ソロ・「聴く」で鳴らさないトラックは audible が false', async () => {
        const d = desktop();
        const a = engine.addTrack('A'), b = engine.addTrack('B'), c = engine.addTrack('C');
        engine.toggleMute(a.id);
        const audible = () => d.last('audio_set_song').args.song.tracks.map((t: { audible: boolean }) => t.audible);
        engine.play(0);
        await nativeAudio.idle();
        expect(audible()).toEqual([false, true, true]);
        engine.stop();
        c.solo = true;
        engine.play(0);
        await nativeAudio.idle();
        expect(audible()).toEqual([false, false, true]);
        engine.stop();
        engine.setListenOverride([a.id, b.id]);
        engine.play(0);
        await nativeAudio.idle();
        expect(audible()).toEqual([true, true, false]);
    });
});

describe('クリップの音声を送る', () => {
    it('足した時点で、分けて送り始める (ヘッダと、チャンネルごとに並べた本体)。同じ音声は 2 度送らない', async () => {
        const d = desktop();
        const t = engine.addTrack('曲');
        const perChunk = CLIP_CHUNK_BYTES / 8;      // ステレオの 1 回ぶんのフレーム数
        const frames = perChunk + 1000;
        const left = Float32Array.from({ length: frames }, (_, i) => i + 1);
        const right = left.map((v) => -v);
        const buffer = audioBuffer([left, right], 44100);
        await engine.addClipFromBuffer(t.id, buffer, 'song', 1.5);
        await nativeAudio.idle();
        const puts = d.of('audio_clip_put');
        const header = { 'x-clip-id': '1', 'x-sample-rate': '44100', 'x-channels': '2', 'x-frames': String(frames) };
        expect(puts.map((c) => c.headers)).toEqual([{ ...header, 'x-offset': '0' }, { ...header, 'x-offset': String(perChunk) }]);
        // 1 つめの塊: ch0 の perChunk 個のあとに、ch1 の perChunk 個
        expect(puts[0].body!.length).toBe(perChunk * 2);
        expect([puts[0].body![0], puts[0].body![perChunk - 1]]).toEqual([1, perChunk]);
        expect([puts[0].body![perChunk], puts[0].body![perChunk * 2 - 1]]).toEqual([-1, -perChunk]);
        // 2 つめの塊: 残りの 1000 フレーム
        expect(puts[1].body!.length).toBe(2000);
        expect([puts[1].body![0], puts[1].body![999]]).toEqual([perChunk + 1, frames]);
        expect([puts[1].body![1000], puts[1].body![1999]]).toEqual([-(perChunk + 1), -frames]);
        expect(puts[0].body!.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);

        // 同じ音声を別の位置にも置き、再生する。送り直さず、同じ番号で曲に入れる
        await engine.addClipFromBuffer(t.id, buffer, 'again', 9);
        engine.play(0);
        await nativeAudio.idle();
        expect(d.of('audio_clip_put')).toHaveLength(2);
        expect(d.of('audio_set_song')[0].args.song.tracks[0].clips).toEqual([{ clip: 1, startSec: 1.5 }, { clip: 1, startSec: 9 }]);
    });

    it('モノラルは 1 チャンネル、3 チャンネル以上は先頭の 2 チャンネルだけを送る', async () => {
        const d = desktop();
        const t = engine.addTrack('曲');
        await engine.addClipFromBuffer(t.id, audioBuffer([[0.5, 0.25, -0.5]], 22050), 'mono');
        await engine.addClipFromBuffer(t.id, audioBuffer([[1, 2], [3, 4], [5, 6]]), 'surround');
        await nativeAudio.idle();
        const puts = d.of('audio_clip_put');
        expect(puts[0].headers).toEqual({ 'x-clip-id': '1', 'x-sample-rate': '22050', 'x-channels': '1', 'x-frames': '3', 'x-offset': '0' });
        expect([...puts[0].body!]).toEqual([0.5, 0.25, -0.5]);
        expect(puts[1].headers).toMatchObject({ 'x-clip-id': '2', 'x-channels': '2', 'x-frames': '2' });
        expect([...puts[1].body!]).toEqual([1, 2, 3, 4]);
    });

    it('再生は、使う音声が届くのを待ってから始める。音声の無いクリップ (missing) は送らず、曲にも入れない', async () => {
        const d = desktop();
        const t = engine.addTrack('曲');
        const buffer = audioBuffer([[0.1, 0.2, 0.3]]);
        // エンジンのメソッドを通さずに置いたクリップ (プロジェクトを開いたときなど) も、再生のときに送る
        t.clips.push({ buffer, offset: 2, name: 'x', duration: 1 });
        t.clips.push({ buffer: audioBuffer([[0, 0]]), offset: 5, name: '音声が無い', duration: 1, missing: true });
        engine.play(0);
        await nativeAudio.idle();
        expect(d.cmds()).toEqual(['audio_init', 'audio_clip_put', 'audio_set_song', 'audio_play']);
        expect(d.of('audio_set_song')[0].args.song.tracks[0].clips).toEqual([{ clip: 1, startSec: 2 }]);
    });

    it('使わなくなった音声は、曲を差し替えたあとで捨てる。また要るようになったら、新しい番号で送り直す', async () => {
        const d = desktop();
        const t = engine.addTrack('曲');
        const buffer = audioBuffer([[0.1, 0.2, 0.3]]);
        await engine.addClipFromBuffer(t.id, buffer, 'x');
        engine.play(0);
        await nativeAudio.idle();
        engine.stop();
        engine.removeClip(t.id, 0);
        await nativeAudio.idle();
        // Rust に渡してある曲がまだ使っているので、ここでは捨てない
        expect(d.of('audio_clip_drop')).toEqual([]);
        engine.play(0);
        await nativeAudio.idle();
        expect(d.cmds().slice(-3)).toEqual(['audio_set_song', 'audio_play', 'audio_clip_drop']);
        expect(d.of('audio_clip_drop')[0].args).toEqual({ ids: [1] });
        engine.stop();
        await engine.addClipFromBuffer(t.id, buffer, 'x');
        engine.play(0);
        await nativeAudio.idle();
        expect(d.of('audio_clip_put').map((c) => c.headers!['x-clip-id'])).toEqual(['1', '2']);
        expect(d.last('audio_set_song').args.song.tracks[0].clips).toEqual([{ clip: 2, startSec: 0 }]);
    });

    it('一度も鳴らしていない音声は、外した時点で捨てる', async () => {
        const d = desktop();
        const t = engine.addTrack('曲');
        await engine.addClipFromBuffer(t.id, audioBuffer([[0.1, 0.2]]), 'x');
        await nativeAudio.idle();
        engine.removeTrack(t.id);
        await nativeAudio.idle();
        expect(d.cmds()).toEqual(['audio_init', 'audio_clip_put', 'audio_clip_drop']);
        expect(d.of('audio_clip_drop')[0].args).toEqual({ ids: [1] });
    });
});

describe('再生位置', () => {
    it('event を受けて位置を出し、event のあいだは経過時間で補う。前の再生の event は使わない', async () => {
        const d = desktop();
        engine.addTrack('A');
        engine.play(2);
        // 最初の event が届くまでは、始める位置のまま
        vi.setSystemTime(Date.now() + 400);
        expect(engine.getCurrentTime()).toBe(2);
        await nativeAudio.idle();
        d.emit({ token: 1, positionSec: 2.5, atMs: Date.now() - 20 });
        expect(engine.getCurrentTime()).toBeCloseTo(2.52);
        vi.setSystemTime(Date.now() + 100);
        expect(engine.getCurrentTime()).toBeCloseTo(2.62);
        expect(engine.getPlayPosition()).toBeCloseTo(2.62);
        expect(engine.getLoopPass()).toBeNull();
        // 番号の違う event は無視する
        d.emit({ token: 7, positionSec: 99 });
        expect(engine.getCurrentTime()).toBeCloseTo(2.62);
        // 一時停止すると、その位置を覚える
        engine.pause();
        expect(engine.isPlaying).toBe(false);
        expect(engine.playOffset).toBeCloseTo(2.62);
        // 次の再生 (token 2) では、前の再生 (token 1) の event を使わない
        engine.play();
        d.emit({ token: 1, positionSec: 50 });
        d.emit({ token: 1, positionSec: 50, playing: false });
        expect(engine.getCurrentTime()).toBeCloseTo(2.62);
        d.emit({ token: 2, positionSec: 2.7 });
        expect(engine.getCurrentTime()).toBeCloseTo(2.7);
        // 停止すると先頭に戻る
        engine.stop();
        expect(engine.getCurrentTime()).toBe(0);
        expect(engine.getPlayPosition()).toBeNull();
    });

    it('区間ループ: 区間の外から始めると頭から。終わりで頭に折り返し、何周目かが分かる', async () => {
        const d = desktop();
        engine.addTrack('A');
        engine.setLoopRange({ start: 2, end: 4 });
        engine.playOffset = 0;
        engine.play();
        expect(engine.getCurrentTime()).toBe(2);
        expect(engine.getLoopPass()).toBe(0);
        await nativeAudio.idle();
        expect(d.of('audio_play')[0].args).toEqual({ token: 1, fromSec: 2, loop: { startSec: 2, endSec: 4 }, countIn: null, metronome: false });
        d.emit({ token: 1, positionSec: 3.9 });
        vi.setSystemTime(Date.now() + 300);
        expect(engine.getCurrentTime()).toBeCloseTo(2.2);
        expect(engine.getLoopPass()).toBe(1);
        d.emit({ token: 1, positionSec: 2.25, pass: 1 });
        expect(engine.getCurrentTime()).toBeCloseTo(2.25);
        expect(engine.getLoopPass()).toBe(1);
        // 区間を外すと、いまの位置から、ループなしで鳴らし直す
        engine.setLoopRange(null);
        await nativeAudio.idle();
        expect(d.of('audio_play')[1].args).toMatchObject({ token: 2, loop: null });
        expect(d.of('audio_play')[1].args.fromSec).toBeCloseTo(2.25);
    });

    it('速度: テンポ・区間・始める位置を鳴らす時間軸で渡し、event の位置を曲の時刻に戻す', async () => {
        const d = desktop();
        const part = engine.addTrack('パート');
        part.clips.push({ buffer: audioBuffer([[0, 0]]), offset: 0, name: 'x', duration: 10 });
        part.pianoNotes = [{ note: 'A', octave: 4, step: 4, length: 2 }];
        engine.gridOffset = 0.5;
        engine.setLoopRange({ start: 2, end: 4 });
        const stretched = { trackId: part.id, start: 2, end: 4, rate: 0.5, buffer: audioBuffer([[0, 0, 0, 0]]) };
        engine.setTempo(0.5, stretched);
        engine.play(3);
        await nativeAudio.idle();
        // 元の音声 (番号 1) と伸ばした音声 (番号 2) を送ってある。曲に入れるのは、伸ばした音声だけ
        expect(d.of('audio_clip_put').map((c) => c.headers!['x-clip-id'])).toEqual(['1', '2']);
        const song = d.of('audio_set_song')[0].args.song;
        expect(song).toMatchObject({ bpm: 60, offsetSec: -1 });
        expect(song.tracks[0].clips).toEqual([{ clip: 2, startSec: 2 }]);
        expect(d.of('audio_play')[0].args).toEqual({ token: 1, fromSec: 4, loop: { startSec: 2, endSec: 6 }, countIn: null, metronome: false });
        d.emit({ token: 1, positionSec: 5 });
        expect(engine.getCurrentTime()).toBeCloseTo(3.5);
        d.emit({ token: 1, positionSec: 5.9 });
        vi.setSystemTime(Date.now() + 300);
        expect(engine.getCurrentTime()).toBeCloseTo(2.1);
        expect(engine.getLoopPass()).toBe(1);
        // 速度を戻すと、伸ばした音声を捨て、元のクリップで鳴らし直す
        engine.setTempo(1, null);
        await nativeAudio.idle();
        expect(d.of('audio_set_song')[1].args.song).toMatchObject({ bpm: 120, offsetSec: 0.5 });
        expect(d.of('audio_set_song')[1].args.song.tracks[0].clips).toEqual([{ clip: 1, startSec: 0 }]);
        expect(d.of('audio_clip_drop').map((c) => c.args)).toEqual([{ ids: [2] }]);
    });

    it('録音前のカウント: カウントのあいだは位置を進めず、録る位置も返さない。鳴らし直しではカウントを入れない', async () => {
        const d = desktop();
        engine.addTrack('A');
        engine.bpm = 100;
        engine.countInBeats = 4;
        engine.play(1);
        expect(engine.isCountingIn()).toBe(true);
        expect(engine.getPlayPosition()).toBeNull();
        await nativeAudio.idle();
        expect(d.of('audio_play')[0].args.countIn).toEqual({ beats: 4, beatSec: 0.6 });
        d.emit({ token: 1, positionSec: 1, countingIn: true });
        vi.setSystemTime(Date.now() + 500);
        expect(engine.isCountingIn()).toBe(true);
        expect(engine.getCurrentTime()).toBe(1);
        d.emit({ token: 1, positionSec: 1.01 });
        expect(engine.isCountingIn()).toBe(false);
        expect(engine.getPlayPosition()).toBeCloseTo(1.01);
        engine.seek(3);
        expect(engine.isCountingIn()).toBe(false);
        await nativeAudio.idle();
        expect(d.of('audio_play')[1].args).toMatchObject({ fromSec: 3, countIn: null });
    });

    it('カウントの終わりは、event が知らせる残りの長さから求める (次の event を待たずに、1 拍目の音を録れる)', async () => {
        const d = desktop();
        engine.addTrack('A').pianoNotes = [{ note: 'A', octave: 4, step: 8, length: 2 }];
        engine.countInBeats = 4;
        engine.play(1);
        await nativeAudio.idle();
        // 残り 30ms のところで event が届いた
        d.emit({ token: 1, positionSec: 1, countingIn: true, countInRemainingSec: 0.03 });
        vi.setSystemTime(Date.now() + 20);
        expect(engine.isCountingIn()).toBe(true);
        expect(engine.getPlayPosition()).toBeNull();
        // 次の event はまだ届いていないが、カウントは 20ms 前に終わっている
        vi.setSystemTime(Date.now() + 30);
        expect(engine.isCountingIn()).toBe(false);
        expect(engine.getPlayPosition()).toBeCloseTo(1.02);
        // 残りを知らせない event (古い形) では、次の event まで待つ
        expect(estimatePosition(
            { token: 1, startPos: 1, loop: null, rate: 1, countIn: true, last: { token: 1, playing: true, countingIn: true, positionSec: 1, atMs: 0, pass: 0 } },
            500,
        )).toEqual({ position: 1, pass: 0, countingIn: true });
    });

    it('音が耳に届くまでの遅れは、Rust が開いた出力デバイスの値', async () => {
        desktop();
        expect(engine.outputLatencySec()).toBe(0);
        await engine.audioReady();
        expect(engine.outputLatencySec()).toBeCloseTo(0.012);
    });
});

describe('再生中にすぐ効かせるもの', () => {
    it('音量・パン・ミュートは、再生中なら Rust に伝える。止まっているあいだは伝えず、次の再生で曲ごと渡す', async () => {
        const d = desktop();
        const a = engine.addTrack('A'), b = engine.addTrack('B');
        engine.play(0);
        await nativeAudio.idle();
        d.calls.length = 0;
        engine.updateTrackGain(a.id, -6);
        engine.updateTrackPan(a.id, 0.5);
        engine.toggleMute(b.id);
        engine.updateTrackGain(a.id, -6);       // 変わっていなければ送らない
        await nativeAudio.idle();
        expect(d.calls).toEqual([
            { cmd: 'audio_set_track', args: { id: a.id, gainDb: -6, pan: 0, audible: true } },
            { cmd: 'audio_set_track', args: { id: a.id, gainDb: -6, pan: 0.5, audible: true } },
            { cmd: 'audio_set_track', args: { id: b.id, gainDb: 0, pan: 0, audible: false } },
        ]);
        // Web Audio のつなぎにも同じ値を持たせておく (途中で切り替わっても、そのまま鳴らせる)
        expect(a.gainNode.gain.value).toBeCloseTo(Math.pow(10, -6 / 20));
        expect(b.gainNode.gain.value).toBe(0);
        engine.stop();
        await nativeAudio.idle();
        d.calls.length = 0;
        engine.updateTrackGain(a.id, -12);
        engine.toggleMute(b.id);
        await nativeAudio.idle();
        expect(d.calls).toEqual([]);
        engine.play(0);
        await nativeAudio.idle();
        expect(d.cmds()).toEqual(['audio_set_song', 'audio_play']);
        expect(d.calls[0].args.song.tracks.map((t: { gainDb: number; audible: boolean }) => [t.gainDb, t.audible])).toEqual([[-12, true], [0, true]]);
    });

    it('ソロの切り替えと、元に戻す・やり直す (トラックを直接書き換える) も、再生中なら Rust に届く', async () => {
        const d = desktop();
        const a = engine.addTrack('A'), b = engine.addTrack('B');
        const before = captureProject(engine);
        engine.play(0);
        await nativeAudio.idle();
        d.calls.length = 0;
        // ソロ (components/CenterArea.tsx は、track.solo を書き換えてから syncNative を呼ぶ)
        a.solo = true;
        engine.syncNative();
        engine.updateTrackGain(b.id, -9);
        await nativeAudio.idle();
        expect(d.calls).toEqual([
            { cmd: 'audio_set_track', args: { id: b.id, gainDb: 0, pan: 0, audible: false } },
            { cmd: 'audio_set_track', args: { id: b.id, gainDb: -9, pan: 0, audible: false } },
        ]);
        // 元に戻す (lib/project-snapshot.ts)
        d.calls.length = 0;
        applyProject(engine, before, captureProject(engine));
        await nativeAudio.idle();
        expect(a.solo).toBe(false);
        expect(d.calls).toEqual([{ cmd: 'audio_set_track', args: { id: b.id, gainDb: 0, pan: 0, audible: true } }]);
        expect(b.gainNode.gain.value).toBe(1);
    });

    it('「聴く」を変えると、鳴らすトラックを伝えてから、いまの位置から鳴らし直す', async () => {
        const d = desktop();
        const a = engine.addTrack('A'), b = engine.addTrack('B');
        engine.play(0);
        await nativeAudio.idle();
        d.emit({ token: 1, positionSec: 1.5 });
        d.calls.length = 0;
        engine.setListenOverride([a.id]);
        await nativeAudio.idle();
        expect(d.cmds()).toEqual(['audio_set_track', 'audio_stop', 'audio_set_song', 'audio_play']);
        expect(d.calls[0].args).toEqual({ id: b.id, gainDb: 0, pan: 0, audible: false });
        expect(d.calls[3].args).toMatchObject({ token: 2, fromSec: 1.5 });
    });

    it('メトロノームの入/切は、再生中なら Rust に伝える。止まっているときは、次の再生で渡す', async () => {
        const d = desktop();
        engine.addTrack('A');
        engine.metronomeEnabled = true;
        await nativeAudio.idle();
        expect(d.calls).toEqual([]);
        engine.play(0);
        await nativeAudio.idle();
        expect(d.of('audio_play')[0].args.metronome).toBe(true);
        // ヘッダのボタンは engine.metronomeEnabled を直接書き換える
        engine.metronomeEnabled = !engine.metronomeEnabled;
        engine.metronomeEnabled = false;        // 変わっていなければ送らない
        engine.metronomeEnabled = true;
        await nativeAudio.idle();
        expect(d.of('audio_set_metronome').map((c) => c.args)).toEqual([{ enabled: false }, { enabled: true }]);
        expect(engine.metronomeEnabled).toBe(true);
    });

    it('鍵盤の試聴は Rust で鳴らす (再生していなくても)。離すと強さ 0 を送る', async () => {
        const d = desktop();
        engine.liveNoteOn(60, 100);
        engine.liveNoteOn(64);
        engine.liveNoteOff(60);
        engine.liveNoteOff(72);     // 押していない高さ
        engine.liveAllNotesOff();
        engine.liveAllNotesOff();   // 鳴っていなければ送らない
        await nativeAudio.idle();
        expect(d.calls).toEqual([
            { cmd: 'audio_init' },
            { cmd: 'audio_live_note', args: { pitch: 60, velocity: 100 } },
            { cmd: 'audio_live_note', args: { pitch: 64, velocity: 96 } },
            { cmd: 'audio_live_note', args: { pitch: 60, velocity: 0 } },
            { cmd: 'audio_live_all_off' },
        ]);
        expect(started).toEqual([]);
    });
});

describe('失敗したら Web Audio に切り替える', () => {
    it('出力を開けなければ、そのセッションは Web Audio で鳴らす (頼んだ再生は、同じ位置から鳴る)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = desktop();
        d.state.fail = (cmd) => cmd === 'audio_init';
        const t = engine.addTrack('A');
        t.pianoNotes = [{ note: 'A', octave: 4, step: 8, length: 2 }];     // 1.0 秒から
        engine.play(0.5);
        expect(started).toEqual([]);
        await nativeAudio.idle();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][1])).toContain('偽の Rust');
        expect(engine.usesNativeAudio()).toBe(false);
        expect(engine.isPlaying).toBe(true);
        expect(started).toEqual([{ kind: 'osc', when: 0.5, freq: 440 }]);
        ctx().currentTime = 1;
        expect(engine.getCurrentTime()).toBeCloseTo(1.5);
        // このあとは Rust を呼ばない
        engine.stop();
        engine.play(0);
        engine.liveNoteOn(60);
        engine.updateTrackGain(t.id, -6);
        await engine.addClipFromBuffer(t.id, audioBuffer([[0, 0]]), 'x');
        await nativeAudio.idle();
        expect(d.cmds()).toEqual(['audio_init']);
        expect(started.length).toBeGreaterThan(2);
    });

    it('再生の途中で失敗したら、Rust を止めて、Web Audio で同じ位置から鳴らし直す', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = desktop();
        const t = engine.addTrack('A');
        t.pianoNotes = [{ note: 'A', octave: 4, step: 8, length: 2 }];
        engine.metronomeEnabled = true;
        engine.play(0);
        await nativeAudio.idle();
        d.emit({ token: 1, positionSec: 0.5 });
        vi.setSystemTime(Date.now() + 100);
        d.state.fail = (cmd) => cmd === 'audio_set_track';
        engine.updateTrackGain(t.id, -6);
        await nativeAudio.idle();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(engine.usesNativeAudio()).toBe(false);
        expect(engine.isPlaying).toBe(true);
        expect(engine.playOffset).toBeCloseTo(0.6);
        // ノート (1.0 秒) は 0.4 秒後。メトロノームも Web Audio で鳴る
        const note = started.find((s) => s.kind === 'osc' && s.freq === 440)!;
        expect(note.when).toBeCloseTo(0.4);
        ctx().currentTime = 0.35;
        vi.advanceTimersByTime(50);
        const click = started.find((s) => s.kind === 'osc' && s.freq === 1000)!;
        expect(click.when).toBeCloseTo(0.4);
        // 音量は、変えた値で鳴る
        expect(t.gainNode.gain.value).toBeCloseTo(Math.pow(10, -6 / 20));
        // 二重に鳴らないよう、Rust の側は止める
        expect(d.cmds().slice(-2).sort()).toEqual(['audio_live_all_off', 'audio_stop']);
        ctx().currentTime = 0.5;
        expect(engine.getCurrentTime()).toBeCloseTo(1.1);
        // 失敗の記録は 1 回だけ
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('鳴らし始めたのに位置の event が 1 つも届かなければ、Web Audio で始めた位置から鳴らし直す', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = desktop();
        const t = engine.addTrack('A');
        t.pianoNotes = [{ note: 'A', octave: 4, step: 8, length: 2 }];
        engine.play(0.5);
        await nativeAudio.idle();
        expect(d.cmds()).toContain('audio_play');
        // 待つあいだは Rust に任せたまま
        expect(document.documentElement.dataset.bunriAudio).toBe('native');
        vi.advanceTimersByTime(POSITION_WATCHDOG_MS + POSITION_WATCHDOG_GRACE_MS - 1);
        expect(engine.usesNativeAudio()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(document.documentElement.dataset.bunriAudio).toBe('web');
        expect(engine.usesNativeAudio()).toBe(false);
        expect(engine.isPlaying).toBe(true);
        expect(engine.playOffset).toBeCloseTo(0.5);
        // ノート (1.0 秒) は 0.5 秒後に、Web Audio で鳴る
        expect(started.find((s) => s.kind === 'osc' && s.freq === 440)!.when).toBeCloseTo(0.5);
        await nativeAudio.idle();
        expect(d.cmds()).toContain('audio_stop');
    });

    it('見張りの時間を過ぎても、決める前に届いた event が在れば切り替えない (メインスレッドがふさがっていただけ)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = desktop();
        engine.addTrack('A').pianoNotes = [{ note: 'A', octave: 4, step: 8, length: 2 }];
        engine.play(0);
        await nativeAudio.idle();
        vi.advanceTimersByTime(POSITION_WATCHDOG_MS);
        d.emit({ token: 1, positionSec: 2 });
        vi.advanceTimersByTime(POSITION_WATCHDOG_GRACE_MS * 2);
        expect(engine.usesNativeAudio()).toBe(true);
        expect(warn).not.toHaveBeenCalled();
    });

    it('頼んでいないのに再生が止まったら (出力デバイスが外れたなど)、止まった位置から鳴らし直す。何度も続くなら Web Audio に切り替える', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = desktop();
        engine.addTrack('A').pianoNotes = [{ note: 'A', octave: 4, step: 8, length: 2 }];
        engine.play(0);
        await nativeAudio.idle();
        d.emit({ token: 1, positionSec: 1.2 });
        d.emit({ token: 1, positionSec: 1.25, playing: false });
        await nativeAudio.idle();
        // 止めてから、同じ位置で鳴らし直している (曲は変わっていないので、渡し直さない)
        expect(engine.isPlaying).toBe(true);
        expect(engine.usesNativeAudio()).toBe(true);
        expect(d.cmds().slice(-2)).toEqual(['audio_stop', 'audio_play']);
        expect(d.last('audio_play').args).toMatchObject({ token: 2, fromSec: 1.25, countIn: null });
        expect(warn).toHaveBeenCalledTimes(1);
        // 自分で止めたときの「止まった」は、鳴らし直さない
        engine.stop();
        d.emit({ token: 2, positionSec: 1.3, playing: false });
        await nativeAudio.idle();
        expect(engine.isPlaying).toBe(false);
        expect(d.cmds().slice(-1)).toEqual(['audio_stop']);

        // 短いあいだに何度も止まるなら、Rust の出力を当てにせず Web Audio に切り替える
        engine.play(0);
        await nativeAudio.idle();
        for (let token = 3; token <= 5; token++) {
            d.emit({ token, positionSec: 0.5 });
            d.emit({ token, positionSec: 0.5, playing: false });
            await nativeAudio.idle();
        }
        expect(engine.usesNativeAudio()).toBe(false);
        expect(engine.isPlaying).toBe(true);
    });

    it('位置の event が届いていれば、見張りは何もしない。止めた再生も見張らない', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = desktop();
        engine.addTrack('A').pianoNotes = [{ note: 'A', octave: 4, step: 8, length: 2 }];
        engine.play(0);
        await nativeAudio.idle();
        d.emit({ token: 1, positionSec: 0.01 });
        vi.advanceTimersByTime(POSITION_WATCHDOG_MS * 2);
        expect(engine.usesNativeAudio()).toBe(true);
        engine.stop();
        engine.play(0);
        await nativeAudio.idle();
        engine.stop();
        await nativeAudio.idle();
        vi.advanceTimersByTime(POSITION_WATCHDOG_MS * 2);
        expect(engine.usesNativeAudio()).toBe(true);
        expect(warn).not.toHaveBeenCalled();
    });

    it('クリップの音声を送れなかったときも、Web Audio でクリップを鳴らす', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = desktop();
        d.state.fail = (cmd) => cmd === 'audio_clip_put';
        const t = engine.addTrack('曲');
        const buffer = audioBuffer([[0.1, 0.2]]);
        t.clips.push({ buffer, offset: 0, name: 'x', duration: 10 });
        engine.play(2);
        await nativeAudio.idle();
        expect(d.cmds()).not.toContain('audio_play');
        expect(engine.isPlaying).toBe(true);
        expect(started).toEqual([{ kind: 'buffer', when: 0, offset: 2, buffer }]);
    });

    it('曲を渡せなかったとき (区間ループ・カウント付き) は、Web Audio でカウントから鳴らし直す', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = desktop();
        d.state.fail = (cmd) => cmd === 'audio_set_song';
        const t = engine.addTrack('A');
        t.pianoNotes = [{ note: 'A', octave: 4, step: 16, length: 2 }];    // 2.0 秒
        engine.setLoopRange({ start: 2, end: 4 });
        engine.countInBeats = 2;
        engine.play(0);
        await nativeAudio.idle();
        expect(engine.isPlaying).toBe(true);
        expect(engine.isCountingIn()).toBe(true);
        // カウントのクリック 2 つ (最初だけ高い音) のあと、区間の頭のノートが鳴る
        expect(started.filter((s) => s.kind === 'osc').map((s) => s.freq)).toEqual([1500, 1000, 440]);
        expect(started[2].when).toBeCloseTo(0.03 + 2 * 0.5);
        expect(engine.getLoopPass()).toBe(0);
    });

    it('鍵盤を押したまま失敗したら、Web Audio で鳴らし直す (音が出ないままにしない)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = desktop();
        d.state.fail = (cmd) => cmd === 'audio_init';
        engine.liveNoteOn(69, 100);
        await nativeAudio.idle();
        expect(started).toEqual([{ kind: 'osc', when: 0, freq: 440 }]);
        // 離すと、Web Audio の音を止める (Rust は呼ばない)
        engine.liveNoteOff(69);
        expect(engine.liveVoices.size).toBe(0);
        await nativeAudio.idle();
        expect(d.cmds()).toEqual(['audio_init']);
    });
});

describe('ブラウザ (Rust が居ない)', () => {
    it('__TAURI__ が無ければ、今までどおり Web Audio だけで鳴らす (Rust の口を 1 度も呼ばない)', async () => {
        const t = engine.addTrack('A');
        t.pianoNotes = [{ note: 'A', octave: 4, step: 4, length: 2 }];
        const buffer = audioBuffer([[0.1, 0.2]]);
        await engine.addClipFromBuffer(t.id, buffer, 'x', 1);
        expect(engine.usesNativeAudio()).toBe(false);
        engine.metronomeEnabled = true;
        engine.play(0);
        expect(started).toContainEqual({ kind: 'buffer', when: 1, offset: undefined, buffer });
        expect(started).toContainEqual({ kind: 'osc', when: 0.5, freq: 440 });
        ctx().currentTime = 0.25;
        expect(engine.getCurrentTime()).toBeCloseTo(0.25);
        engine.updateTrackGain(t.id, -6);
        engine.updateTrackPan(t.id, 0.5);
        engine.toggleMute(t.id);
        engine.syncNative();
        engine.metronomeEnabled = false;
        engine.setLoopRange({ start: 0, end: 2 });
        engine.setTempo(0.5, null);
        engine.seek(1);
        engine.liveNoteOn(60);
        engine.liveNoteOff(60);
        engine.pause();
        engine.playSingleTrack(t.id);
        engine.stop();
        engine.removeClip(t.id, 0);
        await engine.audioReady();
        await nativeAudio.idle();
        expect(invokeDesktop).not.toHaveBeenCalled();
        expect(invokeDesktopRaw).not.toHaveBeenCalled();
        expect(listenDesktop).not.toHaveBeenCalled();
    });

    it('デスクトップ版でも、localStorage の bunri.audioBackend が web なら Rust を使わない', async () => {
        localStorage.setItem(AUDIO_BACKEND_KEY, 'web');
        const d = desktop();
        const t = engine.addTrack('A');
        t.pianoNotes = [{ note: 'A', octave: 4, step: 4, length: 2 }];
        await engine.addClipFromBuffer(t.id, audioBuffer([[0.1, 0.2]]), 'x');
        expect(engine.usesNativeAudio()).toBe(false);
        engine.play(0);
        engine.liveNoteOn(60);
        engine.stop();
        await nativeAudio.idle();
        expect(d.calls).toEqual([]);
        expect(d.listen).not.toHaveBeenCalled();
        expect(started.some((s) => s.kind === 'osc' && s.freq === 440)).toBe(true);
    });
});
