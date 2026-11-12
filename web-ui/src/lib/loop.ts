/**
 * bunri DAW — 区間ループと速度の、時刻の計算（再生エンジンが使う。音は鳴らさない）。
 *
 * 曲の中の位置（秒。「曲の時刻」）と、AudioContext の時計（秒。「鳴らす時刻」）の対応を決める。
 *
 * - 区間ループ: 曲の時刻 `[start, end)` を繰り返す。1 周目は再生を始めた位置から `end` まで、
 *   2 周目からは `start` から `end` まで
 * - 速度 `rate`: 曲の時刻は、鳴らす時刻の `rate` 倍の速さで進む（0.5 なら半分の速さ）。
 *   音の高さを変えずに遅くした音声（lib/stretch.ts）と、遅くした間隔で鳴らすノート・メトロノームが、
 *   どちらもこの対応に従う
 *
 * 1 周ごとの開始時刻は、足し算を重ねずに式で出す（長く回しても誤差がたまらない）。
 */

/** 区間（曲の時刻、秒）。`end` は含まない。 */
export interface LoopRange {
    start: number;
    end: number;
}

/** 1 周ぶんの鳴らし方。 */
export interface LoopSegment {
    /** 何周目か（0 始まり） */
    index: number;
    /** 曲の時刻の始まり（秒） */
    from: number;
    /** 曲の時刻の終わり（秒。含まない） */
    to: number;
    /** 鳴らし始める時刻（AudioContext の時計） */
    when: number;
    /** 鳴らす長さ（実際の秒。速度で伸びる） */
    duration: number;
}

/** 区間の長さ（秒）。 */
export function loopLength(loop: LoopRange): number {
    return Math.max(0, loop.end - loop.start);
}

/** 再生を始める位置を、区間の中に収める（区間の外なら、区間の頭）。 */
export function clampToLoop(position: number, loop: LoopRange): number {
    return position >= loop.start && position < loop.end ? position : loop.start;
}

/**
 * `index` 周目の鳴らし方。
 *
 * @param loop - 区間
 * @param startPos - 再生を始めた曲の時刻（区間の中。`clampToLoop` 済み）
 * @param startWhen - 再生を始めた鳴らす時刻
 * @param rate - 速度（1 = そのまま）
 * @param index - 何周目か（0 始まり）
 */
export function loopSegment(loop: LoopRange, startPos: number, startWhen: number, rate: number, index: number): LoopSegment {
    const len = loopLength(loop);
    const first = loop.end - startPos;
    if (index === 0) return { index, from: startPos, to: loop.end, when: startWhen, duration: first / rate };
    return {
        index,
        from: loop.start,
        to: loop.end,
        when: startWhen + (first + (index - 1) * len) / rate,
        duration: len / rate,
    };
}

/**
 * 再生を始めてから `elapsed` 秒（実際の秒）たったときの、曲の時刻と、何周目か。
 *
 * @param loop - 区間。null ならループしない（曲の時刻はそのまま進む）
 */
export function loopPosition(loop: LoopRange | null, startPos: number, rate: number, elapsed: number): { position: number; pass: number } {
    const song = Math.max(0, elapsed) * rate;
    if (!loop || loopLength(loop) <= 0) return { position: startPos + song, pass: 0 };
    const first = loop.end - startPos;
    if (song < first) return { position: startPos + song, pass: 0 };
    const len = loopLength(loop);
    const rest = song - first;
    const pass = 1 + Math.floor(rest / len);
    return { position: loop.start + (rest - (pass - 1) * len), pass };
}

/**
 * ノート（曲の時刻 `[start, start + length)`）のうち、1 周ぶん `[from, to)` で鳴らすところ。
 * 頭がこの周より前のノートは、1 周目（再生を始めた位置で、鳴っている途中のもの）だけ鳴らす。
 *
 * @returns 鳴らし始める時刻と長さ（実際の秒）。この周では鳴らさないなら null
 */
export function noteInSegment(segment: LoopSegment, rate: number, start: number, length: number): { when: number; duration: number; partial: boolean } | null {
    const end = start + length;
    if (end <= segment.from || start >= segment.to) return null;
    if (start < segment.from && segment.index > 0) return null;
    const from = Math.max(start, segment.from);
    const to = Math.min(end, segment.to);
    if (to <= from) return null;
    return { when: segment.when + (from - segment.from) / rate, duration: (to - from) / rate, partial: start < segment.from };
}

/**
 * クリップ（曲の時刻 `[offset, offset + duration)`）のうち、1 周ぶんで鳴らすところ。速度 1 のときだけ使う
 * （速度を変えたときは、区間を伸ばした音声を使う）。
 *
 * @returns 鳴らし始める時刻、クリップの中の読み始め（秒）、長さ。重ならなければ null
 */
export function clipInSegment(segment: LoopSegment, offset: number, duration: number): { when: number; offset: number; duration: number } | null {
    const from = Math.max(offset, segment.from);
    const to = Math.min(offset + duration, segment.to);
    if (to <= from) return null;
    return { when: segment.when + (from - segment.from), offset: from - offset, duration: to - from };
}

/**
 * 1 周ぶんで鳴らすメトロノームの拍（曲の時刻）。拍は `origin`（1 小節目の位置）から `beatSec` おき。
 * @returns 拍の曲の時刻と、小節の頭か
 */
export function beatsInSegment(segment: LoopSegment, origin: number, beatSec: number, beatsPerBar: number): { at: number; downbeat: boolean }[] {
    const out: { at: number; downbeat: boolean }[] = [];
    const per = Math.max(1, beatsPerBar);
    let k = Math.ceil((segment.from - origin) / beatSec - 1e-9);
    for (; origin + k * beatSec < segment.to - 1e-9; k++) {
        out.push({ at: origin + k * beatSec, downbeat: ((k % per) + per) % per === 0 });
    }
    return out;
}
