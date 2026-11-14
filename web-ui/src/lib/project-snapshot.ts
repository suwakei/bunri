/**
 * bunri DAW — 元に戻すための、プロジェクトの控え（スナップショット）。
 *
 * ## なぜ「命令」ではなく「控え」で持つか
 *
 * プロジェクトを書き換える場所は、再生エンジン（engine.ts）、ピアノロール（CenterArea.tsx の
 * PianoRollEngine。開いているトラックのノートを自分の手元に写して編集し、`_saveToEngine` で書き戻す）、
 * 学ぶ流れ（learn.ts）、左パネル、プロジェクトの読み込み、と散らばっている。
 * 操作ごとに「元に戻す命令」を書く作り（コマンドパターン）にすると、その全部に逆の操作を書くことになり、
 * 書き漏らしや、逆の操作の誤りがそのまま「元に戻らない」不具合になる。
 *
 * そこで、操作の前と後に、トラックの中身を控える。元に戻すときは、控えと控えの差のぶんだけを当てる
 * （`applyProject`）。どの場所の操作でも、`record` で囲めば元に戻せる。
 *
 * ## メモリ
 *
 * - 音声（AudioBuffer）は写さない。クリップの控えは、同じ AudioBuffer を指す
 * - トラックの再生のつなぎ（GainNode など）も写さない。控えは Track オブジェクトそのものを指すので、
 *   消したトラックを元に戻すと、同じ ID・同じつなぎのトラックが戻る
 * - ノートの並びは、直前の控えと中身が同じなら、同じ配列を共有する（`captureProject` の `prev`）。
 *   ノートを 1 つ足しても、写すのはそのトラックのぶんだけになる
 * - ノートの並びと、ノート 1 つ 1 つのオブジェクトは、書き換えずに丸ごと差し替える約束にしてある
 *   （ピアノロールは読み込むときに写し、書き戻すときに新しい配列を作る）。控えはそれを共有する
 *
 * ## 差のぶんだけ当てる
 *
 * 元に戻すときは「前の控え」を丸ごと当てるのではなく、前後の控えで違っているところだけを前に戻す。
 * 履歴に載らない変更（テンポを打ち直した、など）を、関係の無い操作の「元に戻す」で巻き戻さないため。
 * テンポ・拍子・1 小節目の位置も、その操作で変わったときだけ戻す。
 */
import type { Clip, PianoNote, Track } from './engine';
import type { ProjectGrid } from './grid';

/** 元に戻せる記録の数の上限。 */
export const HISTORY_LIMIT = 100;
/**
 * 履歴が抱えるノートとクリップの数の上限（記録の前後で共有していないぶん。`snapshotCost`）。
 * ノート 1 つは小さなオブジェクトなので、20 万でも数十 MB に収まる。音声は数えない（写さないため）
 */
export const HISTORY_BUDGET = 200_000;

/** クリップの控え。音声は同じ AudioBuffer を指す（写さない）。 */
export interface ClipSnapshot {
    buffer: AudioBuffer;
    offset: number;
    name: string;
    duration: number;
}

/** トラック 1 本の控え。 */
export interface TrackSnapshot {
    /** トラックそのもの（再生のつなぎを持つ）。消したトラックを戻すときは、これを並びに戻す */
    ref: Track;
    name: string;
    gain: number;
    pan: number;
    mute: boolean;
    solo: boolean;
    role: Track['role'];
    part: Track['part'];
    practiceOf: Track['practiceOf'];
    /** ノート（打ち込み）。書き換えない約束の配列 */
    notes: PianoNote[];
    /** お手本 */
    reference: PianoNote[] | undefined;
    /** クリップ */
    clips: ClipSnapshot[];
}

/** プロジェクトの控え（トラックの並びと、グリッド）。 */
export interface ProjectSnapshot {
    tracks: TrackSnapshot[];
    grid: ProjectGrid;
}

/** 控えを取る相手（再生エンジンのうち、ここで使うところだけ）。 */
export interface SnapshotSource {
    tracks: Track[];
    bpm: number;
    beatsPerBar: number;
    gridOffset: number;
    /**
     * トラックを書き換えたあとで、再生のつなぎの外（デスクトップ版の Rust の engine）にも伝える
     * （engine.ts の `syncNative`）。無ければ呼ばない
     */
    syncNative?: () => void;
}

/** ノートの並びが同じか（同じ配列なら中身を見ない）。 */
export function sameNotes(a: readonly PianoNote[] | undefined, b: readonly PianoNote[] | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (x !== y && (x.note !== y.note || x.octave !== y.octave || x.step !== y.step || x.length !== y.length
            || x.velocity !== y.velocity)) return false;
    }
    return true;
}

/** クリップの並びが同じか。音声は同じ AudioBuffer かで見る。 */
function sameClips(a: readonly (Clip | ClipSnapshot)[], b: readonly (Clip | ClipSnapshot)[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (x.buffer !== y.buffer || x.offset !== y.offset || x.name !== y.name || x.duration !== y.duration) return false;
    }
    return true;
}

/** グリッドが同じか。 */
function sameGrid(a: ProjectGrid, b: ProjectGrid): boolean {
    return a.bpm === b.bpm && a.beatsPerBar === b.beatsPerBar && a.offsetSec === b.offsetSec;
}

/**
 * いまのプロジェクトの控えを取る。
 *
 * @param source - 再生エンジン
 * @param prev - 直前の控え。中身が同じノートとクリップの並びは、そちらの配列を共有する（メモリを節約する）
 */
export function captureProject(source: SnapshotSource, prev?: ProjectSnapshot | null): ProjectSnapshot {
    const prevByRef = new Map<Track, TrackSnapshot>();
    for (const s of prev?.tracks ?? []) prevByRef.set(s.ref, s);
    const tracks = source.tracks.map((t): TrackSnapshot => {
        const old = prevByRef.get(t);
        const notes = t.pianoNotes || [];
        const clips = t.clips || [];
        return {
            ref: t,
            name: t.name, gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo,
            role: t.role, part: t.part, practiceOf: t.practiceOf,
            notes: old && sameNotes(old.notes, notes) ? old.notes : notes,
            reference: old && sameNotes(old.reference, t.referenceNotes) ? old.reference : t.referenceNotes,
            clips: old && sameClips(old.clips, clips)
                ? old.clips
                : clips.map(c => ({ buffer: c.buffer, offset: c.offset, name: c.name, duration: c.duration })),
        };
    });
    return { tracks, grid: { bpm: source.bpm, beatsPerBar: source.beatsPerBar, offsetSec: source.gridOffset } };
}

/** トラックの控えが同じか。 */
function sameTrack(a: TrackSnapshot, b: TrackSnapshot): boolean {
    return a.ref === b.ref && a.name === b.name && a.gain === b.gain && a.pan === b.pan
        && a.mute === b.mute && a.solo === b.solo && a.role === b.role && a.part === b.part
        && a.practiceOf === b.practiceOf && sameNotes(a.notes, b.notes) && sameNotes(a.reference, b.reference)
        && sameClips(a.clips, b.clips);
}

/** 控えが同じか（同じなら、その操作は何も変えなかった）。 */
export function projectsEqual(a: ProjectSnapshot, b: ProjectSnapshot): boolean {
    if (a === b) return true;
    if (a.tracks.length !== b.tracks.length || !sameGrid(a.grid, b.grid)) return false;
    return a.tracks.every((t, i) => sameTrack(t, b.tracks[i]));
}

/**
 * 記録が抱える量（前後で共有していないノートとクリップの数）。履歴の上限（budget）に使う。
 * 共有している配列は、ほかの記録が既に抱えているので数えない。
 */
export function snapshotCost(before: ProjectSnapshot, after: ProjectSnapshot): number {
    const seen = new Set<unknown>();
    for (const t of before.tracks) { seen.add(t.notes); seen.add(t.clips); seen.add(t.reference); }
    let cost = 1;
    for (const t of after.tracks) {
        if (!seen.has(t.notes)) cost += t.notes.length;
        if (!seen.has(t.clips)) cost += t.clips.length;
        if (t.reference && !seen.has(t.reference)) cost += t.reference.length;
    }
    return cost;
}

/**
 * 音量・パン・ミュートを、再生のつなぎに当てる（再生中でもすぐ効く）。
 * デスクトップ版で Rust の engine が鳴らしているときは、`applyProject` の最後の `syncNative` で伝える。
 */
function applyMix(track: Track): void {
    if (track.gainNode) track.gainNode.gain.value = track.mute ? 0 : Math.pow(10, track.gain / 20);
    if (track.panNode) track.panNode.pan.value = track.pan;
}

/** 控えの値をトラックに書く（`other` を渡すと、`other` と違っているところだけ）。 */
function writeTrack(track: Track, target: TrackSnapshot, other?: TrackSnapshot): void {
    const changed = <K extends keyof TrackSnapshot>(key: K) => !other || target[key] !== other[key];
    if (changed('name')) track.name = target.name;
    if (changed('gain')) track.gain = target.gain;
    if (changed('pan')) track.pan = target.pan;
    if (changed('mute')) track.mute = target.mute;
    if (changed('solo')) track.solo = target.solo;
    if (changed('role')) track.role = target.role;
    if (changed('part')) track.part = target.part;
    if (changed('practiceOf')) track.practiceOf = target.practiceOf;
    // 並びは写して渡す (控えの配列を、エンジンの側で書き換えられないように)
    if (!other || !sameNotes(target.notes, other.notes)) track.pianoNotes = target.notes.slice();
    if (!other || !sameNotes(target.reference, other.reference)) track.referenceNotes = target.reference?.slice();
    if (!other || !sameClips(target.clips, other.clips)) track.clips = target.clips.map(c => ({ ...c }));
    applyMix(track);
}

/**
 * 控えをエンジンに当てる。`other`（元に戻すなら操作の後、やり直すなら操作の前）と違っているところだけを、
 * `target` の値にする。
 *
 * - 操作で増えたトラック（`other` に在って `target` に無い）は外す
 * - 操作で消えたトラック（`target` に在って `other` に無い）は、同じオブジェクトを並びに戻す
 * - 並びが変わっていれば `target` の並びにする。履歴に載らずに増えたトラックは、後ろに残す
 *
 * @returns グリッドを変える必要があれば、その値（操作でグリッドが変わっていたとき）。無ければ null
 */
export function applyProject(engine: SnapshotSource, target: ProjectSnapshot, other: ProjectSnapshot): ProjectGrid | null {
    const otherByRef = new Map<Track, TrackSnapshot>();
    for (const s of other.tracks) otherByRef.set(s.ref, s);
    const targetRefs = new Set(target.tracks.map(s => s.ref));
    const removed = new Set(other.tracks.filter(s => !targetRefs.has(s.ref)).map(s => s.ref));
    const current = new Set(engine.tracks);

    let structural = removed.size > 0;
    for (const s of target.tracks) {
        const o = otherByRef.get(s.ref);
        if (!o) structural = true;
        // 操作の後に、履歴に載らずに消えたトラックは戻さない (その操作で消したものではない)
        if (o && !current.has(s.ref)) continue;
        writeTrack(s.ref, s, o);
    }
    const orderChanged = target.tracks.length !== other.tracks.length
        || target.tracks.some((s, i) => other.tracks[i].ref !== s.ref);
    if (structural || orderChanged) {
        const ordered = target.tracks.map(s => s.ref).filter(t => current.has(t) || !otherByRef.has(t));
        const orderedSet = new Set(ordered);
        const extras = engine.tracks.filter(t => !orderedSet.has(t) && !removed.has(t));
        engine.tracks = [...ordered, ...extras];
    }
    // 戻した音量・パン・ミュート・ソロとクリップを、Rust の engine にも伝える (再生中ならすぐ効く)
    engine.syncNative?.();
    return sameGrid(target.grid, other.grid) ? null : { ...target.grid };
}
