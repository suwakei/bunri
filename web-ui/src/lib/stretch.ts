/**
 * bunri DAW — 音の高さを変えずに速さを変える（練習画面の「速度」）。
 *
 * ## やり方: WSOLA（波形の似た所を探して重ねる）
 *
 * 音声を短い窓（約 46 ミリ秒）に切り、窓をずらす幅を、読む側と書く側で変えて重ね直す。
 * 50% なら、読む側は半分ずつしか進まないので、長さが 2 倍になる。窓の中の波形はそのままなので、
 * 音の高さは変わらない（`playbackRate` で遅くすると、高さも下がる。耳で音を取る練習では使えない）。
 * 重ねる位置は、前の窓の続きと波形がいちばん似ている所を ±12 ミリ秒の中から探して選ぶ。
 * 探さずに重ねる（ただの OLA）と、波の山と谷が打ち消し合って、音がうなる。
 *
 * ## なぜこれを選んだか（CPU の低い PC で動かす前提）
 *
 * | 案 | 重さ | 選ばなかった理由 |
 * |---|---|---|
 * | `playbackRate` | ほぼ 0 | 高さが下がる。聴き取りの練習にならない（高さを黙って変えない） |
 * | 位相ボコーダー（backend/pitch_time.py） | sidecar で numpy。音声を送り返す往復が要る | パート分離など長い処理と CPU を取り合う。打楽器の立ち上がりがにじむ |
 * | 再生しながら伸ばす（AudioWorklet） | 再生中ずっと CPU を使う | 低スペックの PC で音が途切れる心配。CSP に worklet の読み込みを足す必要もある |
 * | **区間だけを 1 回伸ばして取っておく（これ）** | 区間の長さに比例して 1 回だけ。数秒〜数十秒の区間なら一瞬 | — |
 *
 * 伸ばすのは区間ループの範囲だけ（曲全体を伸ばすと、50% で曲の 2 倍ぶんの音声をメモリに持つ）。
 * 計算は Web Worker で行い（`stretch.worker.ts`）、画面を止めない。結果は速度ごとに取っておく
 * （`lib/practice-audio.ts`）。ベースのような単音のパートは WSOLA が得意とする音で、
 * 和音の多い音でも、聴き取りに使える品質になる。
 *
 * 相関（似ている度合い）は、まず 4 サンプルおきの位置を 8 サンプルおきの和で粗く探し、
 * 見つけた位置の前後だけを細かく探す。全部の位置を全部のサンプルで比べるより 30 倍ほど軽い。
 */

/** 窓の長さ（秒）。ベースの低い音（E1 = 41 Hz、1 周期 24 ミリ秒）が 2 周期入る長さ。 */
const FRAME_SEC = 0.046;
/** 重ねる位置を探す範囲（± 秒）。 */
const SEARCH_SEC = 0.012;

/** 伸ばした後の長さ（サンプル）。速度 0.5 なら 2 倍。 */
export function stretchedLength(inputLength: number, rate: number): number {
    return Math.max(0, Math.round(inputLength / rate));
}

/** 周期的なハン窓（半分ずつ重ねると、足して 1 になる）。 */
function hann(n: number): Float32Array {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
}

/**
 * 候補の位置 `p` の波形が、`target` の位置の波形にどれだけ似ているか（正規化した相関）。
 * @param stride - 和を取るサンプルの間隔（粗く探すときは大きくする）
 */
function similarity(guide: Float32Array, p: number, target: number, n: number, stride: number): number {
    let dot = 0, energy = 1e-9;
    for (let i = 0; i < n; i += stride) {
        const c = guide[p + i];
        dot += c * guide[target + i];
        energy += c * c;
    }
    return dot / Math.sqrt(energy);
}

/**
 * 音の高さを変えずに、速さを `rate` 倍にする（0.5 なら半分の速さで、長さは 2 倍）。
 *
 * @param channels - チャンネルごとのサンプル（どれも同じ長さ）
 * @param rate - 速さ（0.25〜1）。1 ならそのまま写す
 * @param sampleRate - サンプルレート
 * @returns 伸ばしたサンプル（チャンネルごと。長さは `stretchedLength`）
 */
export function wsolaStretch(channels: Float32Array[], rate: number, sampleRate: number): Float32Array[] {
    if (channels.length === 0) return [];
    const inLen = channels[0].length;
    if (!(rate > 0) || rate === 1 || inLen === 0) return channels.map((c) => c.slice());
    const outLen = stretchedLength(inLen, rate);
    const n = 2 * Math.max(16, Math.round((sampleRate * FRAME_SEC) / 2));
    const hop = n / 2;
    const search = Math.max(4, Math.round(sampleRate * SEARCH_SEC));
    const window = hann(n);

    // 似ている所を探すための波形 (全チャンネルの平均)。後ろに窓 1 つぶんの無音を足して、端でも読めるようにする
    const pad = n + search + hop;
    const guide = new Float32Array(inLen + pad);
    for (const ch of channels) for (let i = 0; i < inLen; i++) guide[i] += ch[i] / channels.length;
    const maxPos = inLen + pad - n - hop - 1;

    const out = channels.map(() => new Float32Array(outLen + n));
    let prev = 0;
    for (let k = 0; k * hop < outLen; k++) {
        const ideal = Math.round(k * hop * rate);
        let pos = 0;
        if (k > 0) {
            // 前の窓の続き (prev + hop) と、いちばん似ている位置を、理想の位置の前後から選ぶ
            const target = Math.min(maxPos, prev + hop);
            const lo = Math.max(0, ideal - search), hi = Math.min(maxPos, ideal + search);
            let best = Math.min(Math.max(ideal, lo), hi), bestScore = -Infinity;
            for (let p = lo; p <= hi; p += 4) {
                const score = similarity(guide, p, target, n, 8);
                if (score > bestScore) { bestScore = score; best = p; }
            }
            const fineLo = Math.max(lo, best - 3), fineHi = Math.min(hi, best + 3);
            bestScore = -Infinity;
            for (let p = fineLo; p <= fineHi; p++) {
                const score = similarity(guide, p, target, n, 2);
                if (score > bestScore) { bestScore = score; pos = p; }
            }
        }
        const at = k * hop;
        for (let c = 0; c < channels.length; c++) {
            const src = channels[c], dst = out[c];
            const end = Math.min(n, inLen - pos);
            for (let i = 0; i < end; i++) dst[at + i] += src[pos + i] * window[i];
        }
        prev = pos;
    }
    return out.map((ch) => ch.subarray(0, outLen).slice());
}

/** 区間を切り出すときに使う、クリップのうち必要なところ（AudioBuffer と同じ形）。 */
export interface RegionClip {
    /** タイムライン上の開始位置（秒） */
    offset: number;
    buffer: Pick<AudioBuffer, 'numberOfChannels' | 'sampleRate' | 'length' | 'getChannelData'>;
}

/**
 * トラックのクリップから、`[startSec, endSec)` の音声を切り出して 1 本にまとめる（重なるクリップは足す）。
 * サンプルレートは最初のクリップのものに合わせる（違うレートのクリップは、いちばん近いサンプルを取る）。
 *
 * @returns チャンネルごとのサンプルとサンプルレート。クリップが無ければ null
 */
export function extractRegion(clips: RegionClip[], startSec: number, endSec: number): { channels: Float32Array[]; sampleRate: number } | null {
    if (clips.length === 0 || !(endSec > startSec)) return null;
    const sampleRate = clips[0].buffer.sampleRate;
    const numChannels = Math.max(...clips.map((c) => c.buffer.numberOfChannels));
    const length = Math.max(1, Math.round((endSec - startSec) * sampleRate));
    const channels = Array.from({ length: numChannels }, () => new Float32Array(length));
    for (const clip of clips) {
        const { buffer } = clip;
        const ratio = buffer.sampleRate / sampleRate;
        for (let c = 0; c < numChannels; c++) {
            // モノラルのクリップは、全部のチャンネルに同じ音を入れる
            const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
            const dst = channels[c];
            for (let i = 0; i < length; i++) {
                const j = Math.round((startSec - clip.offset + i / sampleRate) * sampleRate * ratio);
                if (j >= 0 && j < buffer.length) dst[i] += src[j];
            }
        }
    }
    return { channels, sampleRate };
}
