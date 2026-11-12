/**
 * bunri DAW — クリップの音声の「元のバイト列」を覚えておく。
 *
 * 再生エンジンが持つのはデコード済みの AudioBuffer だけ。プロジェクトを保存するとき、AudioBuffer を
 * 書き出し直すと（WAV に戻すと）元のファイルと同じにはならない（MP3 を WAV にすると大きくなる、
 * サンプルレートが AudioContext のものに変わる）。そこで、デコードしたときの元のバイト列を、
 * AudioBuffer ごとに覚えておき、保存ではそれを送る（sidecar が整数 PCM の WAV を FLAC にする）。
 * 開き直すと、同じバイト列をデコードするので、同じ AudioBuffer に戻る。
 *
 * - 覚えるのは WeakMap。AudioBuffer が要らなくなれば一緒に消える（元に戻すの履歴が持っている間は残る）
 * - 元のバイト列が無い音声（このファイルを通らずに作った AudioBuffer）は、保存のときに 32 bit 浮動小数の
 *   WAV に書き出す（サンプルは変わらない。FLAC にはならないので大きい）
 * - `hash` は、開いたプロジェクトから読んだ音声のとき、元のバイト列のハッシュ（sidecar が FLAC で持っていて、
 *   WAV に戻して渡したものは、手元のバイト列のハッシュと違う。保存し直すとき、同じ音声として扱うため）
 */

/** 音声の元のバイト列。 */
export interface AudioSource {
    /** 元のバイト列（ファイルそのもの、API の応答、録音） */
    blob: Blob;
    /** 元のファイル名（拡張子を、開き直したときのデコードの手がかりにする） */
    name: string;
    /** 元のバイト列のハッシュが分かっているとき（開いたプロジェクトから読んだ音声） */
    hash?: string;
}

const sources = new WeakMap<AudioBuffer, AudioSource>();

/** AudioBuffer の元のバイト列を覚える。 */
export function rememberSource(buffer: AudioBuffer, blob: Blob, name: string, hash?: string): void {
    sources.set(buffer, { blob, name, hash });
}

/** AudioBuffer の元のバイト列（覚えていなければ undefined）。 */
export function sourceOf(buffer: AudioBuffer): AudioSource | undefined {
    return sources.get(buffer);
}

/**
 * バイト列をデコードし、元のバイト列を覚えておく。`decodeAudioData` は渡した ArrayBuffer を使えなくするので、
 * 先に Blob に写してから渡す。
 *
 * @param ctx - デコードに使う AudioContext
 * @param bytes - 音声ファイルのバイト列
 * @param name - 元のファイル名
 * @param hash - 元のバイト列のハッシュが分かっていれば
 */
export async function decodeWithSource(ctx: BaseAudioContext, bytes: ArrayBuffer, name: string, hash?: string): Promise<AudioBuffer> {
    const blob = new Blob([bytes]);
    const buffer = await ctx.decodeAudioData(bytes);
    rememberSource(buffer, blob, name, hash);
    return buffer;
}

/**
 * 元のバイト列が無い AudioBuffer を、32 bit 浮動小数の WAV にする（サンプルは 1 つも変えない）。
 * @param buffer - 書き出す AudioBuffer
 */
export function audioBufferToFloatWav(buffer: AudioBuffer): Blob {
    const channels = buffer.numberOfChannels, length = buffer.length, rate = buffer.sampleRate;
    const bytesPerSample = 4;
    const dataLength = length * channels * bytesPerSample;
    const view = new DataView(new ArrayBuffer(44 + dataLength));
    const text = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true); // 3 = IEEE float
    view.setUint16(22, channels, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * channels * bytesPerSample, true); view.setUint16(32, channels * bytesPerSample, true);
    view.setUint16(34, 32, true); text(36, 'data'); view.setUint32(40, dataLength, true);
    const data: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch));
    let offset = 44;
    for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < channels; ch++) { view.setFloat32(offset, data[ch][i], true); offset += 4; }
    }
    return new Blob([view.buffer], { type: 'audio/wav' });
}

/** バイト列の SHA-256（64 桁の 16 進）。sidecar の `bunri_file.audio_hash` と同じ。 */
export async function sha256Hex(blob: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
