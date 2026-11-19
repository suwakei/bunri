/**
 * bunri DAW — ピアノロールの行に出す「キーの音」と「コードの音」の色分けの計算。
 *
 * カルテ（第1層。信号処理の事実）のキーとコード進行を、ピアノロールの行（音の高さ）と
 * 横の位置（ステップ）に直す。ここは計算だけで、描くのは `components/CenterArea.tsx` の
 * `PianoRollEngine`（`setPitchHints` と `_drawGrid`）、切り替えは `components/PitchHintBar.tsx`。
 * Claude は呼ばない。
 *
 * - キーの音: カルテのキー（主音と長調・短調）の音階に入る高さ。カルテが持つキーは曲全体で 1 つなので、
 *   1 つで塗る（途中でキーが変わる曲の、変わった後の区間には合わない）
 * - コードの音: コードの区間（始まり〜終わり）ごとの、構成音の高さ
 *
 * コードの種類と音程の対応（`CHORD_INTERVALS`）と、コード記号の後ろに付く文字（`CHORD_SUFFIX`）は、
 * `backend/music_theory.py` の `CHORD_TEMPLATES` / `CHORD_SUFFIX` と同じにする。
 * 両方を `test/fixtures/chord-qualities.json` と突き合わせるテストが在る
 * （`src/__tests__/pitch-hints.test.ts` と `test/back/test_music_theory.py`）。
 * 片方だけ変えると、どちらかのテストが落ちる。
 *
 * ステップは小数になりうる（コードの始まりは秒から換えるので、グリッドの刻みに乗るとは限らない）。
 * 整数だと決め打ちしない。
 */
import type { ChartChord, ChartKey, SongChart } from './chart';
import { confidenceTier, TIER_DISPLAY } from './chart';
import { isDrumTrack } from './drums';
import { secToStep, type ProjectGrid } from './grid';
import { readStored, writeStored } from './storage';

/** 音名（半音ごと。C = 0）。`backend/music_theory.py` の `NOTE_NAMES` と同じ並び。 */
export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** フラットで書いた音名（カルテは出さないが、読めるようにしておく）。 */
const FLAT_TO_SHARP: Record<string, string> = { DB: 'C#', EB: 'D#', GB: 'F#', AB: 'G#', BB: 'A#' };

/**
 * コードの種類 → ルートからの音程（半音）。`backend/music_theory.py` の `CHORD_TEMPLATES` と同じ。
 * 変えるときは、backend と `test/fixtures/chord-qualities.json` も一緒に変える。
 */
export const CHORD_INTERVALS: Readonly<Record<string, readonly number[]>> = {
    maj: [0, 4, 7],
    min: [0, 3, 7],
    dim: [0, 3, 6],
    aug: [0, 4, 8],
    sus4: [0, 5, 7],
    maj7: [0, 4, 7, 11],
    min7: [0, 3, 7, 10],
    '7': [0, 4, 7, 10],
    m7b5: [0, 3, 6, 10],
};

/**
 * コードの種類 → コード記号でルートの後ろに付く文字。`backend/music_theory.py` の `CHORD_SUFFIX` と同じ。
 * コード記号（`Cm7-5` など）から種類を引くのに使う。
 */
export const CHORD_SUFFIX: Readonly<Record<string, string>> = {
    maj: '', min: 'm', dim: 'dim', aug: 'aug', sus4: 'sus4',
    maj7: 'maj7', min7: 'm7', '7': '7', m7b5: 'm7-5',
};

/** 後ろに付く文字 → コードの種類（`CHORD_SUFFIX` の逆引き）。 */
const QUALITY_OF_SUFFIX: ReadonlyMap<string, string> = new Map(Object.entries(CHORD_SUFFIX).map(([quality, suffix]) => [suffix, quality]));

/**
 * 音階の音程（主音からの半音）。短調は自然短音階（backend のディグリー表記 `to_degree` と同じ基準）。
 */
export const SCALE_INTERVALS: Readonly<Record<'major' | 'minor', readonly number[]>> = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
};

/**
 * 音名を 0〜11 の番号にする（C = 0）。読めなければ null。
 *
 * @param name - 音名（`"C"`、`"F#"`、`"Bb"`）。大文字・小文字は区別しない
 */
export function pitchClassOf(name: string | null | undefined): number | null {
    if (typeof name !== 'string') return null;
    const upper = name.trim().toUpperCase();
    const index = PITCH_CLASS_NAMES.indexOf((FLAT_TO_SHARP[upper] ?? upper) as typeof PITCH_CLASS_NAMES[number]);
    return index >= 0 ? index : null;
}

/** 高さの集まり（0〜11）を、12 ビットの印にする（ビット n が、番号 n の高さ）。 */
export function maskOf(pitchClasses: readonly number[]): number {
    let mask = 0;
    for (const pc of pitchClasses) mask |= 1 << (((pc % 12) + 12) % 12);
    return mask;
}

/** 印に、その高さ（0〜11）が入っているか。 */
export function inMask(mask: number, pitchClass: number): boolean {
    return (mask & (1 << pitchClass)) !== 0;
}

/** コード記号を読んだ結果。 */
export interface ParsedChord {
    /** ルートの高さ（0〜11） */
    rootPc: number;
    /** コードの種類（`CHORD_INTERVALS` の名前） */
    quality: string;
}

/**
 * コード記号（`"C"`、`"F#m7"`、`"Bm7-5"`）を、ルートと種類に分ける。
 * backend が出す書き方（ルートの音名 + `CHORD_SUFFIX`）だけを読む。読めない記号と、コード無し（`"N"`）は null。
 */
export function parseChordSymbol(symbol: string | null | undefined): ParsedChord | null {
    if (typeof symbol !== 'string') return null;
    const match = /^([A-G][#b]?)(.*)$/.exec(symbol.trim());
    if (!match) return null;
    const rootPc = pitchClassOf(match[1]);
    const quality = QUALITY_OF_SUFFIX.get(match[2]);
    if (rootPc === null || quality === undefined) return null;
    return { rootPc, quality };
}

/** コードの構成音。 */
export interface ChordTones {
    /** ルートの高さ（0〜11） */
    rootPc: number;
    /** 構成音の高さ（0〜11。ルートを含む。低い音程から） */
    tones: number[];
}

/**
 * コードの構成音を出す。まずコード記号から引き、記号が読めないときだけ、カルテの `root` と `quality` から引く。
 * どちらも読めなければ null（色を付けない）。
 */
export function chordTones(chord: Partial<Pick<ChartChord, 'symbol' | 'root' | 'quality'>>): ChordTones | null {
    let parsed = parseChordSymbol(chord.symbol);
    if (!parsed) {
        const rootPc = pitchClassOf(chord.root);
        if (rootPc !== null && typeof chord.quality === 'string'
            && Object.prototype.hasOwnProperty.call(CHORD_INTERVALS, chord.quality)) {
            parsed = { rootPc, quality: chord.quality };
        }
    }
    if (!parsed) return null;
    const { rootPc, quality } = parsed;
    return { rootPc, tones: CHORD_INTERVALS[quality].map((interval) => (rootPc + interval) % 12) };
}

/** キーの音（音階）の色分けに要るもの。 */
export interface KeyHint {
    /** 主音の高さ（0〜11） */
    tonicPc: number;
    /** 主音の音名（カルテの書き方のまま） */
    tonic: string;
    mode: 'major' | 'minor';
    /** 音階に入る高さの印（12 ビット） */
    mask: number;
    /** 画面に出す名前（「C メジャー」） */
    label: string;
    /** カルテの確信度の段階の名前（「確実」「たぶん」「自信なし」） */
    confidenceLabel: string;
}

/**
 * カルテのキーから、音階に入る高さを出す。キーが取れていない（主音か長調・短調が null）ときは null。
 */
export function keyHint(key: ChartKey | null | undefined): KeyHint | null {
    if (!key || (key.mode !== 'major' && key.mode !== 'minor')) return null;
    const tonicPc = pitchClassOf(key.tonic);
    if (tonicPc === null || !key.tonic) return null;
    return {
        tonicPc, tonic: key.tonic, mode: key.mode,
        mask: maskOf(SCALE_INTERVALS[key.mode].map((interval) => tonicPc + interval)),
        label: `${key.tonic} ${key.mode === 'minor' ? 'マイナー' : 'メジャー'}`,
        confidenceLabel: TIER_DISPLAY[confidenceTier(key.confidence)].label,
    };
}

/** コードの区間（ピアノロールのステップ）。 */
export interface ChordRegion {
    /** 始まり（ステップ。小数になりうる） */
    start: number;
    /** 終わり（ステップ。含まない） */
    end: number;
    /** ルートの高さ（0〜11） */
    rootPc: number;
    /** 構成音の印（12 ビット。ルートを含む） */
    mask: number;
    /** コード記号（画面と確かめに使う） */
    symbol: string;
}

/**
 * カルテのコード進行を、ピアノロールのステップの区間にする。始まりの順に並べて返す。
 *
 * 区間は、そのコードの始まり〜終わり（`end_sec`）。次のコードが先に始まるなら、そこで切る（重ねない）。
 * `end_sec` が無い・始まりより前のときは、次のコードの始まりまで。コードが取れなかった時間（区間のあいだの空き）は、
 * 前のコードで埋めない。読めないコード記号と、1 小節目より前に終わる区間は入れない。
 *
 * 秒 → ステップはプロジェクトのグリッド（`lib/grid.ts`）で換える。練習画面の「コード」の段と同じ換え方なので、
 * 段のコードと、行の色の左端がそろう。
 *
 * @param chords - カルテのコード進行
 * @param grid - プロジェクトのグリッド
 */
export function chordRegions(chords: readonly ChartChord[] | null | undefined, grid: ProjectGrid): ChordRegion[] {
    if (!chords || chords.length === 0) return [];
    const sorted = chords
        .filter((c) => c && Number.isFinite(c.start_sec))
        .slice()
        .sort((a, b) => a.start_sec - b.start_sec);
    const regions: ChordRegion[] = [];
    sorted.forEach((chord, i) => {
        const tones = chordTones(chord);
        if (!tones) return;
        const nextStart = i + 1 < sorted.length ? sorted[i + 1].start_sec : null;
        let endSec = Number.isFinite(chord.end_sec) && chord.end_sec > chord.start_sec ? chord.end_sec : nextStart;
        if (endSec === null) return;
        if (nextStart !== null && nextStart > chord.start_sec) endSec = Math.min(endSec, nextStart);
        const start = Math.max(0, secToStep(chord.start_sec, grid));
        const end = secToStep(endSec, grid);
        if (!(end > start)) return;
        regions.push({ start, end, rootPc: tones.rootPc, mask: maskOf(tones.tones), symbol: chord.symbol });
    });
    return regions;
}

/**
 * 区間の並び（始まりの順で、重ならない）の中で、`step` より後ろに終わる最初の区間の番号を返す（二分探索）。
 * 見えている範囲の区間だけを描くのに使う。無ければ、並びの長さ。
 */
export function firstRegionEndingAfter(regions: readonly ChordRegion[], step: number): number {
    let low = 0, high = regions.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (regions[mid].end > step) high = mid; else low = mid + 1;
    }
    return low;
}

/** その位置（ステップ）のコードの区間。コードが無い位置では null。 */
export function regionAt(regions: readonly ChordRegion[], step: number): ChordRegion | null {
    const region = regions[firstRegionEndingAfter(regions, step)];
    return region && region.start <= step ? region : null;
}

/** ピアノロールに渡す色分け（`PianoRollEngine.setPitchHints`）。出さないものは null・空。 */
export interface PitchHints {
    key: KeyHint | null;
    chords: ChordRegion[];
}

/**
 * ピアノロールに渡す色分けを組み立てる。切り替えが OFF のもの、カルテに無いもの、ドラムのトラックでは出さない。
 *
 * @param chart - カルテ（無ければ null）
 * @param grid - プロジェクトのグリッド
 * @param prefs - 切り替えの状態
 * @param drums - 開いているトラックがドラムか
 */
export function buildPitchHints(chart: SongChart | null | undefined, grid: ProjectGrid, prefs: PitchHintPrefs, drums = false): PitchHints {
    if (!chart || drums) return { key: null, chords: [] };
    return {
        key: prefs.key ? keyHint(chart.key) : null,
        chords: prefs.chord ? chordRegions(chart.chords, grid) : [],
    };
}

/**
 * ドラムのトラックか（lib/drums.ts。見分け方は、鍵盤の列の種類の名前・ドラムの音と同じもの）。
 * ドラムは、種類ごとに決まった高さへ置いてあるだけで、高さが音階の意味を持たないので、キーの音・コードの音を出さない。
 * これまでの呼び手のために、ここからも出す。
 */
export { isDrumTrack };

// ---- 切り替えの覚え書き ----

/** 切り替えの種類。 */
export type PitchHintKind = 'key' | 'chord';

/** 切り替えの状態（true で出す）。 */
export interface PitchHintPrefs {
    key: boolean;
    chord: boolean;
}

/** 覚えておく場所の名前（localStorage）。「再生位置を追う」と同じく、`'0'` のときだけ OFF。 */
export const PITCH_HINT_STORAGE: Readonly<Record<PitchHintKind, string>> = {
    key: 'bunri-hint-key',
    chord: 'bunri-hint-chord',
};

/** 覚えている切り替えの状態を読む。覚えていなければ、どちらも ON。 */
export function readPitchHintPrefs(): PitchHintPrefs {
    return {
        key: readStored(PITCH_HINT_STORAGE.key) !== '0',
        chord: readStored(PITCH_HINT_STORAGE.chord) !== '0',
    };
}

/** 切り替えの状態を覚える。 */
export function writePitchHintPref(kind: PitchHintKind, on: boolean): void {
    writeStored(PITCH_HINT_STORAGE[kind], on ? '1' : '0');
}
