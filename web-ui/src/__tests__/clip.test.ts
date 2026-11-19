/**
 * クリップを縮める・分割する・フェード (lib/clip.ts) と、それを鳴らす場所 (再生・区間ループ・書き出し・練習画面の速度)、
 * 元に戻すための控え、波形の山の値 (lib/waveform.ts)。
 *
 * 再生は、鳴らした音源と音量の上げ下げを控える AudioContext のモックで確かめる。書き出しは、音源と音量の折れ線から
 * 実際にサンプルを作る OfflineAudioContext のモックで、出てくる音を確かめる。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Clip } from '../lib/engine';

// ---- AudioContext のモック (つなぎと、音量の上げ下げを控える) ----

type ParamEvent = { kind: 'set' | 'ramp'; value: number; time: number };
class MockParam {
    value = 1;
    events: ParamEvent[] = [];
    setValueAtTime(value: number, time: number) { this.events.push({ kind: 'set', value, time }); }
    linearRampToValueAtTime(value: number, time: number) { this.events.push({ kind: 'ramp', value, time }); }
    exponentialRampToValueAtTime() {}
    /** 時刻 `t` の値 (AudioParam と同じ決まり: 直前の点の値。次の点が ramp なら、そこまでまっすぐ) */
    at(t: number): number {
        const events = [...this.events].sort((a, b) => a.time - b.time);
        let prev: ParamEvent | null = null;
        for (const e of events) {
            if (e.time <= t) { prev = e; continue; }
            if (e.kind === 'ramp') {
                const from = prev ?? { value: this.value, time: 0 };
                return from.value + (e.value - from.value) * ((t - from.time) / (e.time - from.time));
            }
            break;
        }
        return prev ? prev.value : this.value;
    }
}
class MockNode {
    to: MockNode | null = null;
    gain = new MockParam();
    pan = { value: 0 };
    connect(target: MockNode) { this.to = target; return target; }
    disconnect() {}
}
type Started = { node: MockSource; when: number; offset?: number; duration?: number };
class MockSource extends MockNode {
    buffer: AudioBuffer | null = null;
    onended: (() => void) | null = null;
    constructor(private readonly log: Started[]) { super(); }
    start(when: number, offset?: number, duration?: number) { this.log.push({ node: this, when, offset, duration }); }
    stop() {}
}
const started: Started[] = [];
class MockContext {
    currentTime = 0;
    state = 'running';
    destination = new MockNode();
    createGain() { return new MockNode() as unknown as GainNode; }
    createStereoPanner() { return new MockNode() as unknown as StereoPannerNode; }
    createBufferSource() { return new MockSource(started) as unknown as AudioBufferSourceNode; }
    createOscillator() {
        return { type: 'sine', frequency: { value: 0 }, onended: null, connect() {}, start() {}, stop() {} } as unknown as OscillatorNode;
    }
    createBuffer(channels: number, length: number, sampleRate: number) { return makeBuffer(new Float32Array(length), sampleRate, channels); }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockContext;

/** 書き出しのモック: 鳴らした音源と、途中の音量の折れ線から、サンプルを作る。 */
class RenderingOffline {
    destination = new MockNode();
    sources: Started[] = [];
    constructor(readonly channels: number, readonly length: number, readonly sampleRate: number) {}
    createGain() { return new MockNode() as unknown as GainNode; }
    createStereoPanner() { return new MockNode() as unknown as StereoPannerNode; }
    createBufferSource() { return new MockSource(this.sources) as unknown as AudioBufferSourceNode; }
    createOscillator() {
        return { type: 'sine', frequency: { value: 0 }, connect() {}, start() {}, stop() {} } as unknown as OscillatorNode;
    }
    async startRendering(): Promise<AudioBuffer> {
        const out = new Float32Array(this.length);
        for (const { node, when, offset = 0, duration } of this.sources) {
            const buffer = node.buffer!;
            const data = buffer.getChannelData(0);
            // 音源から出口までの途中に在る、音量のつなぎ
            const gains: MockParam[] = [];
            for (let n = node.to; n && n !== this.destination; n = n.to) gains.push(n.gain);
            const frames = Math.round((duration ?? buffer.duration - offset) * this.sampleRate);
            const first = Math.round(when * this.sampleRate);
            for (let i = 0; i < frames && first + i < this.length; i++) {
                const t = i / this.sampleRate;
                const sample = data[Math.min(data.length - 1, Math.floor((offset + t) * buffer.sampleRate + 1e-6))] ?? 0;
                out[first + i] += gains.reduce((v, g) => v * g.at(when + t), sample);
            }
        }
        return makeBuffer(out, this.sampleRate, 2);
    }
}

/** サンプルを持つ AudioBuffer もどき (全チャンネルが同じ音)。 */
function makeBuffer(data: Float32Array, sampleRate = 100, channels = 1): AudioBuffer {
    return {
        duration: data.length / sampleRate, length: data.length, sampleRate, numberOfChannels: channels,
        getChannelData: () => data,
    } as unknown as AudioBuffer;
}
/** `seconds` 秒の音声。サンプルの値は、頭からの秒数 (どこを読んだかが、音から分かる)。 */
const rampBuffer = (seconds: number, sampleRate = 100) => makeBuffer(Float32Array.from({ length: seconds * sampleRate }, (_, i) => i / sampleRate), sampleRate);
/** `seconds` 秒の、ずっと 1 の音声 (音量の上げ下げが、そのまま音に出る)。 */
const flatBuffer = (seconds: number, sampleRate = 100) => makeBuffer(new Float32Array(seconds * sampleRate).fill(1), sampleRate);

const { default: engine } = await import('../lib/engine');
const clipLib = await import('../lib/clip');
const { clipInSegment, loopSegment } = await import('../lib/loop');
const { extractRegion } = await import('../lib/stretch');
const { captureProject, applyProject, projectsEqual } = await import('../lib/project-snapshot');
const { computePeaks, peakColumns, peaksOf, onPeaksReady, PEAK_BUCKET } = await import('../lib/waveform');
const { visibleBuffer } = await import('../lib/fx');
const {
    MIN_CLIP_SEC, audioStartOf, clipGainAt, clipPortion, fadeEnvelope, fadeInOf, fadeOutOf, fitClipToBuffer, playLength,
    setClipFades, setClipRange, sourceDuration, splitClip, trimClipEnd, trimClipStart,
} = clipLib;

const ctx = () => engine.ctx as unknown as MockContext;
const clip = (extra: Partial<Clip> = {}): Clip => ({ buffer: rampBuffer(10), offset: 2, name: 'take.wav', duration: 10, ...extra });
/** 音源から、トラックのパンのつなぎまでの途中に在る音量のつなぎ。 */
function gainsOf(s: Started, until: unknown): MockParam[] {
    const out: MockParam[] = [];
    for (let n = s.node.to; n && n !== until; n = n.to) out.push(n.gain);
    return out;
}
const points = (param: MockParam) => param.events.map((e) => [e.kind, Number(e.value.toFixed(4)), Number(e.time.toFixed(4))]);

beforeEach(() => {
    started.length = 0;
    engine.stop();
    engine.tracks = [];
    engine.bpm = 120; engine.beatsPerBar = 4; engine.gridOffset = 0;
    engine.loopRange = null; engine.tempoRate = 1; engine.stretched = null; engine.listenOverride = null;
    engine.metronomeEnabled = false;
    engine.init();
    ctx().currentTime = 0;
});
afterEach(() => { engine.stop(); vi.useRealTimers(); });

describe('範囲とフェードの計算', () => {
    it('項目の無いクリップ (以前のクリップ) は、音声の全体をそのまま鳴らす', () => {
        const c = clip();
        expect([audioStartOf(c), playLength(c), fadeInOf(c), fadeOutOf(c), sourceDuration(c)]).toEqual([0, 10, 0, 0, 10]);
        expect(clipGainAt(c, 0)).toBe(1);
        expect(fadeEnvelope(c, 0, 10)).toBeNull();
        expect(clipPortion(c, 0)).toEqual({ at: 2, into: 0, bufferOffset: 0, length: 10 });
    });

    it('鳴らす長さは、音声の残りを超えない。フェードは鳴らす長さに収まり、重ならない', () => {
        const c = clip({ audioStart: 7, duration: 5, fadeIn: 2, fadeOut: 4 });
        expect(playLength(c)).toBe(3);
        expect([fadeInOf(c), fadeOutOf(c)]).toEqual([2, 1]);
        // 音声の長さが分からないとき (偽物) は、いまの範囲を音声の全体とみなす
        expect(sourceDuration({ duration: 4, audioStart: 1 })).toBe(5);
    });

    it('音量: 頭からまっすぐ上がり、終わりへまっすぐ下がる', () => {
        const c = clip({ audioStart: 3, duration: 4, fadeIn: 1, fadeOut: 2 });
        expect([0, 0.25, 1, 1.5, 2, 3, 4].map((t) => clipGainAt(c, t))).toEqual([0, 0.25, 1, 1, 1, 0.5, 0]);
    });

    it('音量の折れ線: 途中から鳴らすときは、その位置の音量から始まる', () => {
        const c = clip({ audioStart: 3, duration: 4, fadeIn: 1, fadeOut: 2 });
        expect(fadeEnvelope(c, 0, 4)).toEqual([{ at: 0, gain: 0 }, { at: 1, gain: 1 }, { at: 2, gain: 1 }, { at: 4, gain: 0 }]);
        // フェードインの途中から
        expect(fadeEnvelope(c, 0.5, 4)).toEqual([{ at: 0, gain: 0.5 }, { at: 0.5, gain: 1 }, { at: 1.5, gain: 1 }, { at: 3.5, gain: 0 }]);
        // フェードアウトの途中から
        expect(fadeEnvelope(c, 3, 4)).toEqual([{ at: 0, gain: 0.5 }, { at: 1, gain: 0 }]);
        // フェードの掛からない範囲だけ (音量を挟まずに鳴らしてよい)
        expect(fadeEnvelope(c, 1, 2)).toBeNull();
        // 範囲がフェードアウトの途中で切れる (区間ループ)
        expect(fadeEnvelope(c, 1, 3)).toEqual([{ at: 0, gain: 1 }, { at: 1, gain: 1 }, { at: 2, gain: 0.5 }]);
    });

    it('鳴らすところ: 再生位置がクリップの途中なら、そこから。音声の中の読み始めは、縮めた頭のぶんだけ進む', () => {
        const c = clip({ audioStart: 3, duration: 4 });
        expect(clipPortion(c, 0)).toEqual({ at: 2, into: 0, bufferOffset: 3, length: 4 });
        expect(clipPortion(c, 3.5)).toEqual({ at: 3.5, into: 1.5, bufferOffset: 4.5, length: 2.5 });
        expect(clipPortion(c, 6)).toBeNull();
        expect(clipPortion(c, 0, 2)).toBeNull();
    });
});

describe('縮める・伸ばす', () => {
    it('左の端を動かすと、音の位置は動かず、鳴らし始めだけが変わる (右の端はそのまま)', () => {
        const c = trimClipStart(clip(), 5);
        expect(c).toMatchObject({ offset: 5, audioStart: 3, duration: 7 });
        // 伸ばす (戻す): 音声の頭より前へは行かない
        expect(trimClipStart(c, 0)).toMatchObject({ offset: 2, duration: 10 });
        expect(trimClipStart(c, 0).audioStart).toBeUndefined();
        // 右の端の手前までしか縮まない
        expect(trimClipStart(clip(), 50)).toMatchObject({ offset: 12 - MIN_CLIP_SEC, duration: expect.closeTo(MIN_CLIP_SEC, 6) });
    });

    it('右の端は、音声の終わりより外へは伸びない。0 秒より前にも置けない', () => {
        expect(trimClipEnd(clip(), 6)).toMatchObject({ offset: 2, duration: 4 });
        expect(trimClipEnd(trimClipEnd(clip(), 6), 99)).toMatchObject({ duration: 10 });
        expect(trimClipEnd(clip(), 0).duration).toBeCloseTo(MIN_CLIP_SEC, 6);
        // 0.5 秒に置いた、頭を 3 秒縮めたクリップ: 左の端は 0 秒まで (音声の 2.5 秒目から)
        const early = trimClipStart(clip({ offset: 0.5, audioStart: 3, duration: 7 }), -10);
        expect(early).toMatchObject({ offset: 0, audioStart: 2.5, duration: 7.5 });
    });

    it('両方の端を一度に決められる (いまの範囲の外でも、音声の在る範囲なら)', () => {
        const c = setClipRange(clip({ duration: 2 }), { start: 6, end: 8 });
        expect(c).toMatchObject({ offset: 6, audioStart: 4, duration: 2 });
    });

    it('縮めると、フェードは新しい長さに収まる。元のクリップは書き換えない', () => {
        const before = clip({ fadeIn: 3, fadeOut: 4 });
        const after = trimClipEnd(before, 7);
        expect(after).toMatchObject({ duration: 5, fadeIn: 3, fadeOut: 2 });
        expect(before).toMatchObject({ duration: 10, fadeIn: 3, fadeOut: 4 });
        expect(after.buffer).toBe(before.buffer);
    });
});

describe('分割', () => {
    it('同じ音声を指す 2 つのクリップになる。音は変わらない (左がフェードインを、右がフェードアウトを引き継ぐ)', () => {
        const source = clip({ audioStart: 1, duration: 6, fadeIn: 1, fadeOut: 2 });
        const [left, right] = splitClip(source, 5)!;
        expect(left.buffer).toBe(source.buffer);
        expect(right.buffer).toBe(source.buffer);
        expect(left).toEqual({ buffer: source.buffer, offset: 2, name: 'take.wav', duration: 3, audioStart: 1, fadeIn: 1 });
        expect(right).toEqual({ buffer: source.buffer, offset: 5, name: 'take.wav', duration: 3, audioStart: 4, fadeOut: 2 });
        // 分ける前と後で、どの時刻も同じ音声の位置・同じ音量
        for (const t of [2, 2.5, 4.9, 5, 6.5, 7.9]) {
            const piece = t < 5 ? left : right;
            expect(audioStartOf(piece) + (t - piece.offset)).toBeCloseTo(audioStartOf(source) + (t - source.offset), 9);
            expect(clipGainAt(piece, t - piece.offset)).toBeCloseTo(clipGainAt(source, t - source.offset), 9);
        }
    });

    it('クリップの外・端に近すぎる位置では分けない', () => {
        expect(splitClip(clip(), 1)).toBeNull();
        expect(splitClip(clip(), 12)).toBeNull();
        expect(splitClip(clip(), 2 + MIN_CLIP_SEC / 2)).toBeNull();
        expect(splitClip(clip(), 2 + MIN_CLIP_SEC)).not.toBeNull();
    });
});

describe('フェードを決める', () => {
    it('指定したほうだけを変える。もう一方と重なるぶんは、指定したほうを短くする。0 で項目ごと外れる', () => {
        const c = setClipFades(clip({ duration: 4 }), { fadeIn: 1 });
        expect(c).toMatchObject({ fadeIn: 1 });
        expect(c.fadeOut).toBeUndefined();
        expect(setClipFades(c, { fadeOut: 9 })).toMatchObject({ fadeIn: 1, fadeOut: 3 });
        expect(setClipFades(setClipFades(c, { fadeOut: 2 }), { fadeIn: 9 })).toMatchObject({ fadeIn: 2, fadeOut: 2 });
        const none = setClipFades(c, { fadeIn: 0 });
        expect('fadeIn' in none).toBe(false);
        expect(setClipFades(clip({ duration: 4 }), { fadeIn: 3, fadeOut: 3 })).toMatchObject({ fadeIn: 3, fadeOut: 1 });
    });
});

describe('音声に合わせる (読み込み直し・開いたプロジェクト)', () => {
    it('範囲が音声の長さを超えないようにする。位置とフェードは残す', () => {
        const missing = clip({ audioStart: 3, duration: 6, fadeIn: 1, fadeOut: 4 });
        const short = fitClipToBuffer(missing, rampBuffer(5));
        expect(short).toMatchObject({ offset: 2, audioStart: 3, duration: 2, fadeIn: 1, fadeOut: 1 });
        expect(short.buffer.duration).toBe(5);
        // 鳴らし始めが音声の外なら、音声の終わりの手前まで戻す
        expect(fitClipToBuffer(missing, rampBuffer(2))).toMatchObject({ audioStart: 2 - MIN_CLIP_SEC });
    });

    it('長さを持たないクリップは音声の全体に、終わりが音声の終わりのすぐ手前なら終わりまでにする', () => {
        expect(fitClipToBuffer(clip({ duration: 0 }), rampBuffer(4))).toMatchObject({ duration: 4 });
        expect(fitClipToBuffer(clip({ duration: 3.98 }), rampBuffer(4))).toMatchObject({ duration: 4 });
        // 縮めてあるクリップ (終わりが音声の終わりから離れている) は、そのまま
        expect(fitClipToBuffer(clip({ duration: 3 }), rampBuffer(4))).toMatchObject({ duration: 3 });
    });
});

describe('ふだんの再生', () => {
    it('以前のクリップは、これまでと同じ (位置から、音声の全体を、音量を挟まずに鳴らす)', () => {
        const t = engine.addTrack();
        t.clips.push(clip());
        engine.play(0);
        expect(started).toHaveLength(1);
        expect(started[0]).toMatchObject({ when: 2, offset: 0, duration: 10 });
        expect(gainsOf(started[0], t.panNode)).toHaveLength(0);
        expect(started[0].node.to).toBe(t.panNode);
    });

    it('縮めたクリップは、見えている範囲だけを鳴らす。フェードは、その長さで上げ下げする', () => {
        const t = engine.addTrack();
        t.clips.push(clip({ audioStart: 3, duration: 4, fadeIn: 1, fadeOut: 2 }));
        engine.play(0);
        expect(started[0]).toMatchObject({ when: 2, offset: 3, duration: 4 });
        const [fade] = gainsOf(started[0], t.panNode);
        expect(points(fade)).toEqual([['set', 0, 2], ['ramp', 1, 3], ['ramp', 1, 4], ['ramp', 0, 6]]);
    });

    it('再生の途中から鳴らすときは、フェードの途中の音量から始まる', () => {
        const t = engine.addTrack();
        t.clips.push(clip({ audioStart: 3, duration: 4, fadeIn: 1, fadeOut: 2 }));
        // フェードインの途中 (クリップの頭から 0.5 秒)
        engine.play(2.5);
        expect(started[0]).toMatchObject({ when: 0, offset: 3.5, duration: 3.5 });
        expect(points(gainsOf(started[0], t.panNode)[0])).toEqual([['set', 0.5, 0], ['ramp', 1, 0.5], ['ramp', 1, 1.5], ['ramp', 0, 3.5]]);
        // フェードアウトの途中 (終わりの 1 秒前)
        started.length = 0;
        engine.play(5);
        expect(started[0]).toMatchObject({ when: 0, offset: 6, duration: 1 });
        expect(points(gainsOf(started[0], t.panNode)[0])).toEqual([['set', 0.5, 0], ['ramp', 0, 1]]);
        // クリップの終わりより後ろからは、鳴らさない
        started.length = 0;
        engine.play(6);
        expect(started).toHaveLength(0);
    });

    it('曲の長さは、見えている範囲の終わりまで', () => {
        const t = engine.addTrack();
        t.clips.push(clip({ audioStart: 3, duration: 4 }));
        expect(engine.getTotalDuration()).toBe(6);
        expect(engine.getTrackDuration(t.id)).toBe(6);
    });
});

describe('区間ループ', () => {
    it('クリップの読み始めは、縮めた頭のぶんだけ進む (lib/loop.ts)', () => {
        const segment = loopSegment({ start: 3, end: 5 }, 3, 10, 1, 1);
        // クリップは 2〜6 秒。音声の 3 秒目から始まる
        expect(clipInSegment(segment, 2, 4, 3)).toEqual({ when: segment.when, offset: 4, duration: 2 });
        // 区間がクリップの終わりをまたぐ
        expect(clipInSegment(loopSegment({ start: 5, end: 8 }, 5, 0, 1, 0), 2, 4, 3)).toEqual({ when: 0, offset: 6, duration: 1 });
    });

    it('つなぎ目の短い上げ下げと、クリップのフェードの両方が効く。区間で切れるところは、その位置の音量まで', () => {
        vi.useFakeTimers();
        const t = engine.addTrack();
        t.clips.push(clip({ audioStart: 3, duration: 4, fadeIn: 1, fadeOut: 2 }));
        // 区間 3〜5 秒: クリップの頭から 1〜3 秒 (フェードアウトは 2 秒目から)
        engine.setLoopRange({ start: 3, end: 5 });
        engine.playOffset = 0;
        engine.play();
        const first = started[0];
        expect(first.when).toBeCloseTo(0.03);
        expect(first).toMatchObject({ offset: 4, duration: 2 });
        const [fade, edge] = gainsOf(first, t.panNode);
        expect(points(fade)).toEqual([['set', 1, 0.03], ['ramp', 1, 1.03], ['ramp', 0.5, 2.03]]);
        // つなぎ目の上げ下げ (4 ミリ秒)
        expect(points(edge)).toEqual([['set', 0, 0.03], ['ramp', 1, 0.034], ['set', 1, 2.026], ['ramp', 0, 2.03]]);
        // 見えている範囲の外だけの区間では、鳴らさない (縮めた先の音声は読まない)
        engine.stop();
        started.length = 0;
        engine.setLoopRange({ start: 6.5, end: 8 });
        engine.playOffset = 0;
        engine.play();
        expect(started).toHaveLength(0);
    });
});

describe('WAV の書き出し (mixdown)', () => {
    const at = (buffer: AudioBuffer, sec: number) => buffer.getChannelData(0)[Math.round(sec * buffer.sampleRate)];

    beforeEach(() => {
        // @ts-expect-error OfflineAudioContext モック
        globalThis.OfflineAudioContext = RenderingOffline;
    });

    it('縮めた範囲だけが入る (音声のどこを読んだかが、音で分かる)', async () => {
        const t = engine.addTrack();
        // サンプルの値 = 音声の頭からの秒数。クリップは 1〜3 秒に置き、音声の 4 秒目から 2 秒ぶんを鳴らす
        t.clips.push(clip({ offset: 1, audioStart: 4, duration: 2 }));
        const out = (await engine.mixdown())!;
        expect(out.duration).toBeCloseTo(3, 3);
        expect(at(out, 0.5)).toBe(0);
        expect(at(out, 1.005)).toBeCloseTo(4, 1);
        expect(at(out, 2)).toBeCloseTo(5, 1);
        expect(at(out, 2.9)).toBeCloseTo(5.9, 1);
        // 書き出した WAV の長さも、見えている範囲の終わりまで (16 bit ステレオ)
        const wav = (await engine.exportWav())!;
        expect(wav.size).toBe(44 + Math.ceil(3 * 44100) * 4);
    });

    it('フェードが音に入る。再生と同じ折れ線 (聴く音と書き出す音が同じ)', async () => {
        const t = engine.addTrack();
        t.clips.push({ buffer: flatBuffer(10), offset: 1, name: 'pad', duration: 4, audioStart: 2, fadeIn: 1, fadeOut: 2 });
        const out = (await engine.mixdown())!;
        // 1〜2 秒で上がり、2〜3 秒はそのまま、3〜5 秒で下がる
        const expected: [number, number][] = [[1.25, 0.25], [1.5, 0.5], [2.5, 1], [3.5, 0.75], [4, 0.5], [4.5, 0.25]];
        for (const [sec, gain] of expected) expect(at(out, sec)).toBeCloseTo(gain, 2);
        // 同じクリップを再生したときの、音量の折れ線と同じ値
        engine.play(0);
        const [fade] = gainsOf(started[0], t.panNode);
        for (const [sec, gain] of expected) expect(fade.at(sec)).toBeCloseTo(gain, 6);
    });

    it('以前のクリップは、音声の全体がそのまま入る', async () => {
        const t = engine.addTrack();
        t.clips.push({ buffer: flatBuffer(2), offset: 0.5, name: 'old', duration: 2 });
        const out = (await engine.mixdown())!;
        expect([at(out, 0.25), at(out, 0.6), at(out, 2.4)]).toEqual([0, 1, 1]);
    });
});

describe('練習画面の速度 (伸ばす前の切り出し)', () => {
    it('縮めたクリップは、見えている範囲だけを読み、フェードも掛ける', () => {
        const data = Float32Array.from({ length: 100 }, (_, i) => i);
        const buffer = { numberOfChannels: 1, sampleRate: 10, length: 100, getChannelData: () => data as Float32Array<ArrayBuffer> };
        // クリップは 1〜2 秒 (音声の 3 秒目から 1 秒ぶん)。その外は、音声が在っても読まない
        const region = extractRegion([{ offset: 1, buffer, audioStart: 3, duration: 1 }], 0.5, 2.5)!;
        expect(Array.from(region.channels[0])).toEqual([0, 0, 0, 0, 0, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 0, 0, 0, 0, 0]);
        // フェード: 頭の 0.5 秒で上げる
        const faded = extractRegion([{ offset: 1, buffer, audioStart: 3, duration: 1, fadeIn: 0.5 }], 1, 2)!;
        expect(Array.from(faded.channels[0]).map((v) => Number(v.toFixed(2)))).toEqual([0, 6.2, 12.8, 19.8, 27.2, 35, 36, 37, 38, 39]);
    });
});

describe('エフェクト', () => {
    it('縮めたクリップは、見えている範囲だけの音声にしてから送る。縮めていなければ、音声をそのまま使う', () => {
        const whole = clip();
        expect(visibleBuffer(whole)).toBe(whole.buffer);
        const cut = visibleBuffer(clip({ audioStart: 3, duration: 4 }));
        expect(cut.length).toBe(400);
        expect(cut.getChannelData(0)[0]).toBeCloseTo(3, 5);
        expect(cut.getChannelData(0)[399]).toBeCloseTo(6.99, 5);
    });
});

describe('元に戻すための控え', () => {
    it('範囲とフェードも控える。元に戻すと、縮める前・分割する前・フェードを付ける前に戻る', () => {
        const t = engine.addTrack();
        const original = clip();
        t.clips.push(original);
        const before = captureProject(engine);
        expect(before.tracks[0].clips[0]).toEqual({ buffer: original.buffer, offset: 2, name: 'take.wav', duration: 10 });

        // 縮める
        t.clips[0] = trimClipStart(original, 5);
        const trimmed = captureProject(engine, before);
        expect(projectsEqual(before, trimmed)).toBe(false);
        expect(trimmed.tracks[0].clips[0]).toMatchObject({ offset: 5, audioStart: 3, duration: 7 });
        // フェード (位置も長さも同じでも、違う控えになる)
        t.clips[0] = setClipFades(t.clips[0], { fadeOut: 2 });
        const faded = captureProject(engine, trimmed);
        expect(projectsEqual(trimmed, faded)).toBe(false);
        // 分割
        t.clips.splice(0, 1, ...splitClip(t.clips[0], 8)!);
        const split = captureProject(engine, faded);
        expect(split.tracks[0].clips).toHaveLength(2);

        // 1 つずつ戻す
        applyProject(engine, faded, split);
        expect(t.clips).toHaveLength(1);
        expect(t.clips[0]).toMatchObject({ offset: 5, audioStart: 3, duration: 7, fadeOut: 2 });
        applyProject(engine, trimmed, faded);
        expect(t.clips[0].fadeOut).toBeUndefined();
        applyProject(engine, before, trimmed);
        expect(t.clips[0]).toEqual({ buffer: original.buffer, offset: 2, name: 'take.wav', duration: 10 });
        // やり直す
        applyProject(engine, trimmed, before);
        expect(t.clips[0]).toMatchObject({ offset: 5, audioStart: 3, duration: 7 });
        expect(t.clips[0].buffer).toBe(original.buffer);
    });

    it('音声の無いクリップの印は、元に戻しても落ちない', () => {
        const t = engine.addTrack();
        t.clips.push(clip({ missing: true }));
        const before = captureProject(engine);
        engine.moveClip(t.id, 0, 4);
        const after = captureProject(engine, before);
        applyProject(engine, before, after);
        expect(t.clips[0]).toMatchObject({ offset: 2, missing: true });
    });
});

describe('波形の山の値', () => {
    it('決まった数のサンプルごとに、最小と最大を取る (全チャンネルを通して)', () => {
        const left = Float32Array.from([0.1, -0.2, 0.3, 0.4, -0.5, 0.6]);
        const right = Float32Array.from([0, 0.9, 0, 0, 0, -0.7]);
        const peaks = computePeaks([left, right], 100, 4);
        expect(Array.from(peaks.min).map((v) => Number(v.toFixed(2)))).toEqual([-0.2, -0.7]);
        expect(Array.from(peaks.max).map((v) => Number(v.toFixed(2)))).toEqual([0.9, 0.6]);
        expect(peaks.frames).toBe(6);
    });

    it('描く幅のぶんだけ引く。縮めたクリップは、音声の途中から。音声の外は 0', () => {
        // 1 秒 = 10 個の山 (100 Hz、10 サンプルごと)。山の値は、その番号
        const peaks = { bucket: 10, sampleRate: 100, frames: 400, min: Float32Array.from({ length: 40 }, (_, i) => -i), max: Float32Array.from({ length: 40 }, (_, i) => i) };
        // 音声の 2 秒目から、1 列 = 0.2 秒 (山 2 つぶん) で 4 列
        const cols = peakColumns(peaks, 2, 0.2, 4);
        expect(Array.from(cols.max)).toEqual([21, 23, 25, 27]);
        expect(Array.from(cols.min)).toEqual([-21, -23, -25, -27]);
        // 音声の終わりをまたぐ
        expect(Array.from(peakColumns(peaks, 3.8, 0.2, 3).max)).toEqual([39, 0, 0]);
    });

    it('音声ごとに 1 度だけ作って覚える (描き直しのたびに作り直さない)。同じ音声を指すクリップは共有する', () => {
        const data = new Float32Array(PEAK_BUCKET * 3).fill(0.5);
        let reads = 0;
        const buffer = { numberOfChannels: 1, sampleRate: 100, length: data.length, getChannelData: () => { reads += 1; return data; } } as unknown as AudioBuffer;
        const first = peaksOf(buffer)!;
        expect(first.max.length).toBe(3);
        expect(peaksOf(buffer)).toBe(first);
        expect(reads).toBe(1);
        // サンプルを読めない音声 (テストの偽物など) は、波形なし
        expect(peaksOf({ duration: 1 } as AudioBuffer)).toBeNull();
        expect(peaksOf(null)).toBeNull();
    });

    it('長い音声は、少しずつ作って、できたら知らせる (その場では止めない)', () => {
        vi.useFakeTimers();
        // 5 分ぶんのステレオに当たる長さではなく、その場で作る上限を超える長さで確かめる
        const data = new Float32Array((1 << 18) + 1000).fill(0.25);
        data[data.length - 1] = 0.75;
        const buffer = { numberOfChannels: 2, sampleRate: 44100, length: data.length, getChannelData: () => data } as unknown as AudioBuffer;
        const ready = vi.fn();
        const off = onPeaksReady(ready);
        expect(peaksOf(buffer)).toBeNull();
        // 作っている途中に何度呼んでも、作るのは 1 回
        expect(peaksOf(buffer)).toBeNull();
        vi.runAllTimers();
        expect(ready).toHaveBeenCalledTimes(1);
        const peaks = peaksOf(buffer)!;
        expect(peaks.max.length).toBe(Math.ceil(data.length / PEAK_BUCKET));
        expect(peaks.max[peaks.max.length - 1]).toBeCloseTo(0.75);
        expect(peaks.max[0]).toBeCloseTo(0.25);
        off();
    });
});
