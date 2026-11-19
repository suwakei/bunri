/**
 * bunri DAW — クリップに描く波形のための、山の値（ピーク）。
 *
 * 音声（AudioBuffer）ごとに 1 度だけ、`PEAK_BUCKET` サンプルごとの最小・最大を作って覚える（`WeakMap`。
 * 音声が要らなくなれば、一緒に消える）。タイムラインの描き直し・スクロール・再生中の描画では作り直さず、
 * 覚えた値から、見えている幅のぶんだけを引く（`peakColumns`）。分割・複製したクリップは同じ音声を指すので、
 * 山の値も 1 つを共有する。
 *
 * 長い音声（5 分のステレオで 1,300 万サンプル × 2）を一度に読むと、数十ミリ秒のあいだ画面が止まり、プロジェクトを
 * 開いた直後は、それがトラックの数だけ続く。そこで、短い音声はその場で作り、長い音声は少しずつ（1 回に
 * `SLICE_FRAMES` サンプル）作って、できたら知らせる（`onPeaksReady`。タイムラインは、波形だけを描き足す）。
 *
 * 計算は画面の糸で行う（Web Worker へ送ると、サンプルの写しが要る）。`blob:` もインラインのスクリプトも使わない。
 */

/** 山の値 1 つぶんのサンプルの数。80px/秒・44.1 kHz で、1px は 551 サンプル（2 つぶん強）。 */
export const PEAK_BUCKET = 256;
/** その場で作る音声の長さの上限（サンプル）。これより長い音声は、少しずつ作る */
const SYNC_FRAMES = 1 << 18;
/** 少しずつ作るときの、1 回ぶんのサンプルの数（数ミリ秒で終わる量） */
const SLICE_FRAMES = 1 << 20;

/** 山の値。`min[i]`・`max[i]` は、`i * bucket` サンプル目からの `bucket` サンプルの最小と最大（全チャンネルを通して）。 */
export interface WavePeaks {
    bucket: number;
    sampleRate: number;
    /** 音声のサンプルの数 */
    frames: number;
    min: Float32Array;
    max: Float32Array;
}

/** 山の値を作る相手（AudioBuffer のうち、使うところだけ）。 */
type PeakSource = Pick<AudioBuffer, 'numberOfChannels' | 'sampleRate' | 'length' | 'getChannelData'>;

const cache = new WeakMap<object, WavePeaks>();
const queued = new WeakSet<object>();
const queue: PeakSource[] = [];
const listeners = new Set<() => void>();
let working = false;

/** `[from, to)` 番目の山の値を埋める。 */
function fill(peaks: WavePeaks, channels: Float32Array[], from: number, to: number): void {
    const { bucket, frames, min, max } = peaks;
    for (let b = from; b < to; b++) {
        const start = b * bucket, end = Math.min(frames, start + bucket);
        let lo = Infinity, hi = -Infinity;
        for (const data of channels) {
            for (let i = start; i < end; i++) {
                const v = data[i];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
        }
        min[b] = lo === Infinity ? 0 : lo;
        max[b] = hi === -Infinity ? 0 : hi;
    }
}

/** 空の山の値を用意する。 */
function emptyPeaks(frames: number, sampleRate: number, bucket: number): WavePeaks {
    const count = Math.ceil(frames / bucket);
    return { bucket, sampleRate, frames, min: new Float32Array(count), max: new Float32Array(count) };
}

/**
 * サンプルから、山の値をその場で作る。
 * @param channels - チャンネルごとのサンプル（長さは同じ）
 * @param sampleRate - サンプルレート
 * @param bucket - 山の値 1 つぶんのサンプルの数
 */
export function computePeaks(channels: Float32Array[], sampleRate: number, bucket = PEAK_BUCKET): WavePeaks {
    const frames = channels.reduce((n, c) => Math.max(n, c.length), 0);
    const peaks = emptyPeaks(frames, sampleRate, bucket);
    fill(peaks, channels, 0, peaks.min.length);
    return peaks;
}

/** 音声のサンプルを読めるか（テストの偽物や、まだ中身の無い音声では読めない）。 */
function readable(buffer: PeakSource | null | undefined): buffer is PeakSource {
    return !!buffer && typeof buffer.getChannelData === 'function' && buffer.length > 0 && buffer.numberOfChannels > 0;
}

function channelsOf(buffer: PeakSource): Float32Array[] {
    return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

/** 順番待ちの音声を、少しずつ作る。1 つ終わるたびに知らせる。 */
function work(): void {
    const buffer = queue[0];
    if (!buffer) { working = false; return; }
    working = true;
    const peaks = emptyPeaks(buffer.length, buffer.sampleRate, PEAK_BUCKET);
    const channels = channelsOf(buffer);
    const perSlice = Math.max(1, Math.floor(SLICE_FRAMES / PEAK_BUCKET));
    let next = 0;
    const step = () => {
        const to = Math.min(peaks.min.length, next + perSlice);
        fill(peaks, channels, next, to);
        next = to;
        if (next < peaks.min.length) { setTimeout(step, 0); return; }
        cache.set(buffer, peaks);
        queue.shift();
        for (const listener of [...listeners]) listener();
        setTimeout(work, 0);
    };
    step();
}

/**
 * その音声の山の値。覚えていれば、それを返す。
 * 短い音声は、その場で作って返す。長い音声は、作り始めて null を返す（できたら `onPeaksReady` で知らせる）。
 * サンプルを読めない音声（音声の無いクリップの置き場所ではなく、テストの偽物など）は null。
 */
export function peaksOf(buffer: PeakSource | null | undefined): WavePeaks | null {
    if (!readable(buffer)) return null;
    const hit = cache.get(buffer);
    if (hit) return hit;
    if (buffer.length <= SYNC_FRAMES) {
        const peaks = computePeaks(channelsOf(buffer), buffer.sampleRate);
        cache.set(buffer, peaks);
        return peaks;
    }
    if (!queued.has(buffer)) {
        queued.add(buffer);
        queue.push(buffer);
        if (!working) { working = true; setTimeout(work, 0); }
    }
    return null;
}

/** 少しずつ作っていた山の値ができたときに呼ぶ関数を登録する。返す関数で外す。 */
export function onPeaksReady(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * 描く幅のぶんだけ、山の値を引く。
 *
 * @param peaks - 音声の山の値
 * @param startSec - 左端に当たる、音声の中の位置（秒）
 * @param secPerColumn - 1 列（描く 1px）ぶんの秒数
 * @param columns - 列の数
 * @returns 列ごとの最小と最大。音声の外の列は 0
 */
export function peakColumns(peaks: WavePeaks, startSec: number, secPerColumn: number, columns: number): { min: Float32Array; max: Float32Array } {
    const count = Math.max(0, Math.floor(columns));
    const min = new Float32Array(count), max = new Float32Array(count);
    const perSec = peaks.sampleRate / peaks.bucket, total = peaks.min.length;
    for (let x = 0; x < count; x++) {
        const from = Math.floor((startSec + x * secPerColumn) * perSec + 1e-9);
        const to = Math.max(from + 1, Math.ceil((startSec + (x + 1) * secPerColumn) * perSec - 1e-9));
        let lo = Infinity, hi = -Infinity;
        for (let b = Math.max(0, from); b < Math.min(total, to); b++) {
            if (peaks.min[b] < lo) lo = peaks.min[b];
            if (peaks.max[b] > hi) hi = peaks.max[b];
        }
        if (lo !== Infinity) { min[x] = lo; max[x] = hi; }
    }
    return { min, max };
}
