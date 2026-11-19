/**
 * bunri DAW — ドラムの音（種類ごとの簡単な合成音）。
 *
 * ドラムのトラックのノートを、三角波の代わりに、種類ごとの音で鳴らす。再生・区間ループ・書き出し・
 * 鍵盤の試聴が、どれもこの 1 つの関数を使う（聴く音と書き出す音を食い違わせない）。
 * `BaseAudioContext` を受け取るので、書き出しの `OfflineAudioContext` でも同じ音になる。
 *
 * - キック: 下がるサイン波
 * - スネア: ノイズ + 短い音
 * - ハイハット・シンバル: 高域のノイズ
 * - タム: 下がるサイン波（キックより高く、長い）
 *
 * 打ち込み用の音源を Rust のエンジンに移す（docs/instrument-engine-design.md）までのつなぎなので、小さく作ってある。
 * サンプルは使わない（同梱物も、読み込みの待ちも増やさない）。
 */
import type { DrumVoice } from './drums';

/** 種類ごとの音量（三角波のノートの山の高さに対する倍率）と、鳴る長さ（秒）。 */
const VOICES: Readonly<Record<DrumVoice, { gain: number; duration: number }>> = {
    kick: { gain: 2.4, duration: 0.28 },
    snare: { gain: 1.6, duration: 0.18 },
    hat: { gain: 0.9, duration: 0.06 },
    tom: { gain: 2.0, duration: 0.32 },
};

/** 減衰の行き先（指数で下げるので、0 にはできない）。 */
const SILENT = 0.0001;

/** ノイズのバッファ（サンプルレートごとに 1 つ。1 度だけ作る）。 */
const noiseBuffers = new Map<number, AudioBuffer>();

/**
 * ノイズのバッファを返す。同じサンプルレートなら、前に作ったものを使い回す。
 * 中身は決まった数列（種の決まった擬似乱数）なので、書き出すたびに同じ音になる。
 */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
    const cached = noiseBuffers.get(ctx.sampleRate);
    if (cached) return cached;
    // 0.25 秒ぶん。いちばん長く使うスネアより長い
    const buffer = ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * 0.25)), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x2f6e2b1;
    for (let i = 0; i < data.length; i++) {
        // xorshift32
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        data[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
    noiseBuffers.set(ctx.sampleRate, buffer);
    return buffer;
}

/** 音量の山を作る（すぐ上がって、指数で下がる）。 */
function envelope(ctx: BaseAudioContext, when: number, peak: number, duration: number): GainNode {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(SILENT, when);
    gain.gain.linearRampToValueAtTime(Math.max(SILENT, peak), when + 0.002);
    gain.gain.exponentialRampToValueAtTime(SILENT, when + duration);
    return gain;
}

/** 下がるサイン波（キック・タム）。 */
function sweep(ctx: BaseAudioContext, destination: AudioNode, when: number, from: number, to: number, fall: number, peak: number, duration: number): OscillatorNode {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = from;
    osc.frequency.setValueAtTime(from, when);
    osc.frequency.exponentialRampToValueAtTime(to, when + fall);
    const gain = envelope(ctx, when, peak, duration);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(when);
    osc.stop(when + duration + 0.01);
    return osc;
}

/** フィルタを通したノイズ（スネア・ハイハット）。 */
function noise(ctx: BaseAudioContext, destination: AudioNode, when: number, type: BiquadFilterType, frequency: number, peak: number, duration: number): AudioBufferSourceNode {
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    const gain = envelope(ctx, when, peak, duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    source.start(when, 0, duration + 0.01);
    return source;
}

/**
 * ドラムの音を 1 つ鳴らす。
 *
 * @param ctx - 鳴らす先の AudioContext（再生なら本物の、書き出しなら `OfflineAudioContext`）
 * @param destination - つなぐ先（トラックのパンのノードなど）
 * @param voice - 種類
 * @param when - 鳴らし始める時刻（その AudioContext の時計）
 * @param level - 音量の基準（三角波のノートの山の高さ。強さから `noteLevel` で出したものを渡す）
 * @returns 鳴らした音源（止めるときに `stop()` する。鳴り終われば自分で止まる）
 */
export function playDrum(ctx: BaseAudioContext, destination: AudioNode, voice: DrumVoice, when: number, level: number): (OscillatorNode | AudioBufferSourceNode)[] {
    const { gain, duration } = VOICES[voice];
    const peak = level * gain;
    switch (voice) {
        case 'kick':
            return [sweep(ctx, destination, when, 150, 48, 0.09, peak, duration)];
        case 'tom':
            return [sweep(ctx, destination, when, 210, 110, 0.16, peak, duration)];
        case 'snare':
            return [
                noise(ctx, destination, when, 'highpass', 1200, peak, duration),
                sweep(ctx, destination, when, 240, 170, 0.05, peak * 0.6, 0.09),
            ];
        case 'hat':
            return [noise(ctx, destination, when, 'highpass', 7000, peak, duration)];
    }
}
