/**
 * bunri DAW — クリップの「鳴らす範囲」と「フェード」の計算、縮める・分割・フェードの操作。
 *
 * クリップは音声（`buffer`）を書き換えずに、その中のどこからどこまでを鳴らすかと、頭と終わりの音量の
 * 上げ下げを持つ（非破壊。engine.ts の `Clip`）:
 *
 * - `audioStart`: 音声の中の、鳴らし始める位置（秒。無ければ 0）
 * - `duration`: 鳴らす長さ（秒）。`audioStart` から数えて、音声の残りを超えない
 * - `fadeIn` / `fadeOut`: 頭から上げていく長さ・終わりへ下げていく長さ（秒。無ければ 0）。まっすぐ（直線）に上げ下げする。
 *   2 つは重ならない（`fadeIn + fadeOut <= duration`）
 *
 * 項目が無いクリップ（以前のプロジェクト、足したばかりのクリップ）は、音声の全体をそのまま鳴らす。
 *
 * ここの計算を、ふだんの再生・区間ループ・WAV の書き出し・練習画面の速度（lib/stretch.ts）・タイムラインの描画が
 * 共通で使う（聴く音と書き出す音と見えている形を食い違わせない）。操作（`trimClipStart` など）は、元のクリップを
 * 書き換えずに新しいクリップを返す。トラックへ入れるのは呼ぶ側で、元に戻す履歴に載せて行う
 * （components/CenterArea.tsx の `TimelineEngine`。画面の操作も、アシスタントのツールも、そこを通る）。
 *
 * このファイルは、再生エンジンを読み込まない（型だけ）。lib/stretch.ts 経由で Web Worker にも入るため。
 */
import type { Clip } from './engine';

/** クリップの長さの下限（秒）。縮める・分割するとき、これより短いクリップは作らない。 */
export const MIN_CLIP_SEC = 0.05;

/**
 * 終わりが音声の終わりからこの秒数の中に在れば、音声の終わりまで鳴らす（`fitClipToBuffer`）。
 * 保存したときと開いたときで、音声の長さが数十ミリ秒違うことが在る（MP3 のデコードは環境で端の扱いが違う）。
 * 縮めていないクリップの終わりが、そのぶん欠けないようにする。
 */
export const END_SNAP_SEC = 0.05;

/** 範囲とフェードの計算に要る、クリップの項目。 */
export type ClipRange = Pick<Clip, 'duration'> & Partial<Pick<Clip, 'audioStart' | 'fadeIn' | 'fadeOut'>> & {
    /** 音声（長さだけを見る）。無ければ、鳴らす範囲がそのまま音声の全体だとみなす */
    buffer?: { duration: number } | null;
};

/** 位置も持つクリップ（操作の対象）。 */
export type ClipPlacement = ClipRange & Pick<Clip, 'offset'>;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** 音声の中の、鳴らし始める位置（秒）。項目が無ければ 0。 */
export function audioStartOf(clip: ClipRange): number {
    return Math.max(0, num(clip.audioStart));
}

/** 音声そのものの長さ（秒）。音声の長さが分からなければ、いまの範囲の終わりまで。 */
export function sourceDuration(clip: ClipRange): number {
    const total = clip.buffer ? Number(clip.buffer.duration) : NaN;
    return Number.isFinite(total) && total > 0 ? total : audioStartOf(clip) + Math.max(0, num(clip.duration));
}

/** 鳴らす長さ（秒）。`duration` を、音声の残りに収めたもの。 */
export function playLength(clip: ClipRange): number {
    return Math.max(0, Math.min(num(clip.duration), sourceDuration(clip) - audioStartOf(clip)));
}

/** フェードインの長さ（秒）。鳴らす長さに収める。 */
export function fadeInOf(clip: ClipRange): number {
    return Math.max(0, Math.min(num(clip.fadeIn), playLength(clip)));
}

/** フェードアウトの長さ（秒）。フェードインと重ならないところまで。 */
export function fadeOutOf(clip: ClipRange): number {
    return Math.max(0, Math.min(num(clip.fadeOut), playLength(clip) - fadeInOf(clip)));
}

/** フェードが付いているか。 */
export function hasFades(clip: ClipRange): boolean {
    return fadeInOf(clip) > 0 || fadeOutOf(clip) > 0;
}

/**
 * フェードの音量（0〜1）。
 * @param t - クリップの頭から数えた位置（秒）
 * @param length - 鳴らす長さ（秒）
 * @param fadeIn - フェードインの長さ（秒）
 * @param fadeOut - フェードアウトの長さ（秒）
 */
export function fadeGain(t: number, length: number, fadeIn: number, fadeOut: number): number {
    let gain = 1;
    if (fadeIn > 0 && t < fadeIn) gain = Math.max(0, t / fadeIn);
    if (fadeOut > 0 && t > length - fadeOut) gain = Math.min(gain, Math.max(0, (length - t) / fadeOut));
    return gain;
}

/** クリップの頭から `t` 秒の位置の音量（0〜1）。フェードが無ければ 1。 */
export function clipGainAt(clip: ClipRange, t: number): number {
    return fadeGain(t, playLength(clip), fadeInOf(clip), fadeOutOf(clip));
}

/** 音量の折れ線の 1 点。`at` は、鳴らし始めから数えた秒。 */
export interface EnvelopePoint {
    at: number;
    gain: number;
}

/**
 * クリップの `[from, to)`（クリップの頭から数えた秒）を鳴らすときの、音量の折れ線。
 * 点と点のあいだは、まっすぐにつなぐ（AudioParam の `linearRampToValueAtTime`）。再生の途中から鳴らすとき・
 * 区間ループで切れるときも、フェードの途中の音量から始まる。
 *
 * @returns 折れ線の点（最初の点は `at: 0`）。フェードが掛からない範囲なら null（音量を挟まずに鳴らしてよい）
 */
export function fadeEnvelope(clip: ClipRange, from: number, to: number): EnvelopePoint[] | null {
    const length = playLength(clip), fadeIn = fadeInOf(clip), fadeOut = fadeOutOf(clip);
    if (!(to > from)) return null;
    const fadeOutStart = length - fadeOut;
    const inRange = fadeIn > 0 && from < fadeIn;
    const outRange = fadeOut > 0 && to > fadeOutStart;
    if (!inRange && !outRange) return null;
    const points: EnvelopePoint[] = [{ at: 0, gain: fadeGain(from, length, fadeIn, fadeOut) }];
    // 折れ目 (フェードインの終わり・フェードアウトの始まり) が範囲の中に在れば、そこに点を置く
    for (const knee of [fadeIn, fadeOutStart]) {
        if (knee > from && knee < to && knee - from > points[points.length - 1].at) points.push({ at: knee - from, gain: 1 });
    }
    points.push({ at: to - from, gain: fadeGain(to, length, fadeIn, fadeOut) });
    return points;
}

/** クリップのうち、鳴らすところ。 */
export interface ClipPortion {
    /** 鳴らし始める曲の時刻（秒） */
    at: number;
    /** クリップの頭から数えた、鳴らし始めの位置（秒）。フェードの計算に使う */
    into: number;
    /** 音声の中の読み始め（秒）。`audioStart + into` */
    bufferOffset: number;
    /** 鳴らす長さ（秒） */
    length: number;
}

/**
 * クリップ（曲の時刻 `[offset, offset + 鳴らす長さ)`）のうち、曲の時刻 `[from, to)` に掛かるところ。
 * ふだんの再生（`from` = 再生位置）と書き出し（`from` = 0）が使う。
 *
 * @returns 重ならなければ null
 */
export function clipPortion(clip: ClipPlacement, from: number, to: number = Infinity): ClipPortion | null {
    const length = playLength(clip);
    const start = Math.max(clip.offset, from);
    const end = Math.min(clip.offset + length, to);
    if (!(end > start)) return null;
    const into = start - clip.offset;
    return { at: start, into, bufferOffset: audioStartOf(clip) + into, length: end - start };
}

/** 範囲とフェードを書き換えたクリップを作る。0 の項目は付けない（以前のクリップと、項目の有無まで同じにする）。 */
function withRange<T extends ClipPlacement>(clip: T, next: { offset: number; audioStart: number; duration: number; fadeIn: number; fadeOut: number }): T {
    const out: T = { ...clip, offset: next.offset, duration: next.duration };
    const fadeIn = Math.max(0, Math.min(next.fadeIn, next.duration));
    const fadeOut = Math.max(0, Math.min(next.fadeOut, next.duration - fadeIn));
    const set = (key: 'audioStart' | 'fadeIn' | 'fadeOut', value: number) => {
        if (value > 0) out[key] = value; else delete out[key];
    };
    set('audioStart', Math.max(0, next.audioStart));
    set('fadeIn', fadeIn);
    set('fadeOut', fadeOut);
    return out;
}

const rangeOf = (clip: ClipPlacement) => ({
    offset: clip.offset, audioStart: audioStartOf(clip), duration: playLength(clip), fadeIn: fadeInOf(clip), fadeOut: fadeOutOf(clip),
});

/** 左の端を置ける範囲（曲の時刻）。音声の頭より前・0 秒より前・右の端の手前 `MIN_CLIP_SEC` より後ろへは行かない。 */
export function startLimits(clip: ClipPlacement): { min: number; max: number } {
    const min = Math.max(0, clip.offset - audioStartOf(clip));
    return { min, max: Math.max(min, clip.offset + playLength(clip) - MIN_CLIP_SEC) };
}

/** 右の端を置ける範囲（曲の時刻）。音声の終わりより後ろ・左の端から `MIN_CLIP_SEC` より手前へは行かない。 */
export function endLimits(clip: ClipPlacement): { min: number; max: number } {
    const max = clip.offset + sourceDuration(clip) - audioStartOf(clip);
    return { min: Math.min(max, clip.offset + MIN_CLIP_SEC), max };
}

/**
 * 端を動かす（縮める・伸ばす）。音の位置は動かず、見えている範囲だけが変わる。
 *
 * - `start`: 新しい左の端（曲の時刻、秒）。音声の頭より前・0 秒より前・右の端の手前 `MIN_CLIP_SEC` より後ろへは行かない
 * - `end`: 新しい右の端（曲の時刻、秒）。音声の終わりより後ろ・左の端から `MIN_CLIP_SEC` より手前へは行かない
 *
 * 指定しなかった端は動かさない。フェードは、新しい長さに収める。
 */
export function setClipRange<T extends ClipPlacement>(clip: T, next: { start?: number; end?: number }): T {
    const range = rangeOf(clip);
    const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
    const startMin = startLimits(clip).min, endMax = endLimits(clip).max;
    const oldEnd = clip.offset + range.duration;
    // 右の端を先に決める (左の端も動かすなら、音声の頭から MIN_CLIP_SEC より後ろ。動かさないなら、いまの左の端より後ろ)
    const end = next.end === undefined ? oldEnd : clamp(next.end, (next.start === undefined ? clip.offset : startMin) + MIN_CLIP_SEC, endMax);
    const start = next.start === undefined ? clip.offset : clamp(next.start, startMin, Math.max(startMin, end - MIN_CLIP_SEC));
    const delta = start - clip.offset;
    return withRange(clip, { ...range, offset: start, audioStart: range.audioStart + delta, duration: Math.max(0, end - start) });
}

/**
 * 左の端を動かす（縮める・伸ばす）。右の端はそのまま。
 * @param start - 新しい左の端（曲の時刻、秒）。置ける範囲（`startLimits`）に収める
 */
export function trimClipStart<T extends ClipPlacement>(clip: T, start: number): T {
    return setClipRange(clip, { start });
}

/**
 * 右の端を動かす（縮める・伸ばす）。
 * @param end - 新しい右の端（曲の時刻、秒）。置ける範囲（`endLimits`）に収める
 */
export function trimClipEnd<T extends ClipPlacement>(clip: T, end: number): T {
    return setClipRange(clip, { end });
}

/** 分割できる範囲（曲の時刻）。両側に `MIN_CLIP_SEC` 以上が残る位置。分割できる長さが無ければ null。 */
export function splitLimits(clip: ClipPlacement): { min: number; max: number } | null {
    const min = clip.offset + MIN_CLIP_SEC, max = clip.offset + playLength(clip) - MIN_CLIP_SEC;
    return max >= min ? { min, max } : null;
}

/**
 * クリップを、曲の時刻 `at` で 2 つに分ける。2 つは同じ音声（`buffer`）を指す（音声は写さない）。
 * 音は変わらない: 左はフェードインを、右はフェードアウトを引き継ぎ、分けた境目にはフェードを付けない。
 *
 * @returns 左と右のクリップ。`at` がクリップの外（か、端に近すぎる）なら null
 */
export function splitClip<T extends ClipPlacement>(clip: T, at: number): [T, T] | null {
    const limits = splitLimits(clip);
    if (!limits || !(at >= limits.min && at <= limits.max)) return null;
    const range = rangeOf(clip);
    const head = at - clip.offset;
    return [
        withRange(clip, { ...range, duration: head, fadeOut: 0 }),
        withRange(clip, { ...range, offset: at, audioStart: range.audioStart + head, duration: range.duration - head, fadeIn: 0 }),
    ];
}

/**
 * フェードの長さを決める。指定したほうだけを変える。もう一方と重なるぶんは、指定したほうを短くする
 * （両方を指定して合計が長さを超えるときは、フェードインを先に取る）。
 */
export function setClipFades<T extends ClipPlacement>(clip: T, fades: { fadeIn?: number; fadeOut?: number }): T {
    const range = rangeOf(clip);
    const length = range.duration;
    let fadeIn = range.fadeIn, fadeOut = range.fadeOut;
    if (fades.fadeIn !== undefined && fades.fadeOut !== undefined) {
        fadeIn = Math.max(0, Math.min(num(fades.fadeIn), length));
        fadeOut = Math.max(0, Math.min(num(fades.fadeOut), length - fadeIn));
    } else if (fades.fadeIn !== undefined) {
        fadeIn = Math.max(0, Math.min(num(fades.fadeIn), length - fadeOut));
    } else if (fades.fadeOut !== undefined) {
        fadeOut = Math.max(0, Math.min(num(fades.fadeOut), length - fadeIn));
    }
    return withRange(clip, { ...range, fadeIn, fadeOut });
}

/**
 * クリップを、別の音声（読み込み直した音声・開いたプロジェクトの音声）に合わせる。範囲が音声の長さを超えないようにする。
 *
 * - 鳴らし始め（`audioStart`）は、音声の中に収める
 * - 長さは、音声の残りに収める。長さを持たないクリップ（0）は、音声の残りの全部にする
 * - 終わりが音声の終わりのすぐ手前（`END_SNAP_SEC` の中）なら、音声の終わりまでにする
 */
export function fitClipToBuffer<T extends ClipPlacement>(clip: T, buffer: { duration: number }): T {
    const total = Math.max(0, num(buffer.duration));
    const audioStart = Math.min(audioStartOf(clip), Math.max(0, total - MIN_CLIP_SEC));
    const available = Math.max(0, total - audioStart);
    let duration = num(clip.duration) > 0 ? Math.min(num(clip.duration), available) : available;
    if (available - duration < END_SNAP_SEC) duration = available;
    return withRange({ ...clip, buffer }, { offset: clip.offset, audioStart, duration, fadeIn: num(clip.fadeIn), fadeOut: num(clip.fadeOut) });
}

/** 秒数を、画面の文に出す形にする（「1.5 秒」の数字のところ。小数 2 桁まで、後ろの 0 は付けない）。 */
export function formatSeconds(sec: number): string {
    return String(Math.round(sec * 100) / 100);
}
