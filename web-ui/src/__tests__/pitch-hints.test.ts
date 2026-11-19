/**
 * ピアノロールの「キーの音」「コードの音」の計算（lib/pitch-hints.ts）のテスト。
 *
 * いちばん大事なのは、コードの種類と音程の対応が backend（music_theory.py）と食い違わないこと。
 * 画面と backend で表が違うと、カルテが「Cm7-5」と言っている区間に、別の音が塗られる。
 * 共有の表（test/fixtures/chord-qualities.json）と、backend のソースそのものの両方と突き合わせる。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
    CHORD_INTERVALS, CHORD_SUFFIX, PITCH_CLASS_NAMES, PITCH_HINT_STORAGE, SCALE_INTERVALS,
    buildPitchHints, chordRegions, chordTones, firstRegionEndingAfter, inMask, isDrumTrack, keyHint, maskOf,
    parseChordSymbol, pitchClassOf, readPitchHintPrefs, regionAt, writePitchHintPref,
} from '../lib/pitch-hints';
import type { ChartChord, ChartKey, SongChart } from '../lib/chart';
import type { ProjectGrid } from '../lib/grid';

/** 印（12 ビット）に入っている高さを、音名の並びにする。 */
const namesOf = (mask: number) => PITCH_CLASS_NAMES.filter((_n, pc) => inMask(mask, pc));

/** カルテのコード（要るところだけ決めて、残りは埋める）。 */
function chord(symbol: string, start: number, end: number, extra: Partial<ChartChord> = {}): ChartChord {
    return {
        bar: 1, beat: 1, beat_index: 0, beat_count: 4, start_sec: start, end_sec: end,
        root: '', quality: '', symbol, degree: null, confidence: 0.9, ...extra,
    };
}

/** 120 BPM・4/4 で、1 小節目が 0.75 秒に在るグリッド（1 ステップ = 0.125 秒、1 小節 = 2 秒 = 16 ステップ）。 */
const GRID: ProjectGrid = { bpm: 120, beatsPerBar: 4, offsetSec: 0.75 };

describe('コードの種類の表が backend と一致する', () => {
    let fixture: Record<string, { intervals: number[]; suffix: string }> = {};
    let source = '';
    beforeAll(async () => {
        // 画面の tsconfig には node の型を入れていないので、ここで使うぶんの形だけ書く
        const fs = (await import('node:fs' as string)) as { readFileSync: (path: URL, encoding: 'utf8') => string };
        // 場所は、文字列をつないで作る。`new URL('…', import.meta.url)` に 1 つの文字列をそのまま書くと、Vite が
        // 画面の素材の URL に書き換えて、ファイルとして読めなくなった（この fixture で「The URL must be of scheme file」）
        const repoRoot = '../../../';
        const read = (path: string) => fs.readFileSync(new URL(repoRoot + path, import.meta.url), 'utf8');
        fixture = JSON.parse(read('test/fixtures/chord-qualities.json')).qualities;
        source = read('backend/music_theory.py');
    });

    it('共有の表（test/fixtures/chord-qualities.json）と、種類・音程・後ろに付く文字が一致する', () => {
        expect(Object.keys(fixture).length).toBeGreaterThan(0);
        expect(Object.keys(CHORD_INTERVALS).sort()).toEqual(Object.keys(fixture).sort());
        expect(Object.keys(CHORD_SUFFIX).sort()).toEqual(Object.keys(fixture).sort());
        for (const [quality, entry] of Object.entries(fixture)) {
            expect([...CHORD_INTERVALS[quality]], quality).toEqual(entry.intervals);
            expect(CHORD_SUFFIX[quality], quality).toBe(entry.suffix);
        }
    });

    it('backend のソース（music_theory.py の CHORD_TEMPLATES）と、種類・音程が一致する', () => {
        const block = /^CHORD_TEMPLATES = \{([\s\S]*?)^\}/m.exec(source);
        expect(block, 'music_theory.py に CHORD_TEMPLATES が見つからない（書き方が変わったら、この読み方も直す）').not.toBeNull();
        const parsed: Record<string, number[]> = {};
        for (const m of block![1].matchAll(/"([^"]+)":\s*\[([^\]]*)\]/g)) parsed[m[1]] = m[2].split(',').map((v) => Number(v.trim()));
        expect(Object.keys(parsed).length).toBeGreaterThan(0);
        expect(parsed).toEqual(Object.fromEntries(Object.entries(CHORD_INTERVALS).map(([q, v]) => [q, [...v]])));
    });

    it('backend のソース（music_theory.py の CHORD_SUFFIX）と、後ろに付く文字が一致する', () => {
        const block = /^CHORD_SUFFIX = \{([\s\S]*?)^\}/m.exec(source);
        expect(block, 'music_theory.py に CHORD_SUFFIX が見つからない（書き方が変わったら、この読み方も直す）').not.toBeNull();
        const parsed: Record<string, string> = {};
        for (const m of block![1].matchAll(/"([^"]+)":\s*"([^"]*)"/g)) parsed[m[1]] = m[2];
        expect(Object.keys(parsed).length).toBeGreaterThan(0);
        expect(parsed).toEqual({ ...CHORD_SUFFIX });
    });

    it('音名の並びが backend（NOTE_NAMES）と一致する', () => {
        const line = /^NOTE_NAMES = \[([^\]]*)\]/m.exec(source);
        expect(line).not.toBeNull();
        expect([...line![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...PITCH_CLASS_NAMES]);
    });
});

describe('コード記号 → 構成音', () => {
    it('backend が出しうる記号（12 のルート × 全部の種類）を、全部読める', () => {
        for (const [rootPc, root] of PITCH_CLASS_NAMES.entries()) {
            for (const [quality, suffix] of Object.entries(CHORD_SUFFIX)) {
                const symbol = root + suffix;
                expect(parseChordSymbol(symbol), symbol).toEqual({ rootPc, quality });
                expect(chordTones({ symbol }), symbol).toEqual({
                    rootPc, tones: CHORD_INTERVALS[quality].map((i) => (rootPc + i) % 12),
                });
            }
        }
    });

    it('構成音は、ルートから数えた高さになる', () => {
        expect(namesOf(maskOf(chordTones({ symbol: 'C' })!.tones))).toEqual(['C', 'E', 'G']);
        expect(namesOf(maskOf(chordTones({ symbol: 'Am' })!.tones))).toEqual(['C', 'E', 'A']);
        expect(namesOf(maskOf(chordTones({ symbol: 'G7' })!.tones))).toEqual(['D', 'F', 'G', 'B']);
        expect(namesOf(maskOf(chordTones({ symbol: 'F#m7' })!.tones))).toEqual(['C#', 'E', 'F#', 'A']);
        expect(namesOf(maskOf(chordTones({ symbol: 'Bm7-5' })!.tones))).toEqual(['D', 'F', 'A', 'B']);
        expect(namesOf(maskOf(chordTones({ symbol: 'Dsus4' })!.tones))).toEqual(['D', 'G', 'A']);
        expect(namesOf(maskOf(chordTones({ symbol: 'Caug' })!.tones))).toEqual(['C', 'E', 'G#']);
        expect(namesOf(maskOf(chordTones({ symbol: 'Bdim' })!.tones))).toEqual(['D', 'F', 'B']);
        expect(namesOf(maskOf(chordTones({ symbol: 'Fmaj7' })!.tones))).toEqual(['C', 'E', 'F', 'A']);
        expect(chordTones({ symbol: 'A#m' })!.rootPc).toBe(10);
    });

    it('読めない記号と、コード無し（N）は null', () => {
        for (const symbol of ['N', 'N.C.', '', '  ', 'H', 'Cadd9', 'C/E', 'Cm7b5', 'C6', 'maj7', '7']) {
            expect(parseChordSymbol(symbol), JSON.stringify(symbol)).toBeNull();
            expect(chordTones({ symbol }), JSON.stringify(symbol)).toBeNull();
        }
        expect(parseChordSymbol(null)).toBeNull();
        expect(parseChordSymbol(undefined)).toBeNull();
    });

    it('記号が読めないときだけ、カルテのルートと種類から引く', () => {
        expect(chordTones({ symbol: '?', root: 'D', quality: 'min7' })).toEqual({ rootPc: 2, tones: [2, 5, 9, 0] });
        // 記号が読めるなら、記号を使う
        expect(chordTones({ symbol: 'C', root: 'D', quality: 'min7' })!.rootPc).toBe(0);
        // 知らない種類・読めないルートは、塗らない
        expect(chordTones({ symbol: '?', root: 'D', quality: 'add9' })).toBeNull();
        expect(chordTones({ symbol: '?', root: 'X', quality: 'maj' })).toBeNull();
        expect(chordTones({ symbol: '?', root: 'D', quality: 'toString' })).toBeNull();
    });

    it('音名は、シャープでもフラットでも読める', () => {
        expect(pitchClassOf('C')).toBe(0);
        expect(pitchClassOf('f#')).toBe(6);
        expect(pitchClassOf('Bb')).toBe(10);
        expect(pitchClassOf('H')).toBeNull();
        expect(pitchClassOf(null)).toBeNull();
    });
});

describe('キー → 音階', () => {
    const key = (tonic: string | null, mode: ChartKey['mode'], confidence = 0.8): ChartKey => ({ tonic, mode, confidence, alternatives: [] });

    it('長調は、主音からの長音階', () => {
        const hint = keyHint(key('C', 'major'))!;
        expect(namesOf(hint.mask)).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B']);
        expect(hint.tonicPc).toBe(0);
        expect(hint.label).toBe('C メジャー');
        expect(namesOf(keyHint(key('D', 'major'))!.mask)).toEqual(['C#', 'D', 'E', 'F#', 'G', 'A', 'B']);
    });

    it('短調は、主音からの自然短音階', () => {
        const hint = keyHint(key('A', 'minor'))!;
        expect(namesOf(hint.mask)).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B']);
        expect(hint.tonicPc).toBe(9);
        expect(hint.label).toBe('A マイナー');
        expect(namesOf(keyHint(key('F#', 'minor'))!.mask)).toEqual(['C#', 'D', 'E', 'F#', 'G#', 'A', 'B']);
    });

    it('どの主音でも、音階は 7 つの高さで、主音を含む', () => {
        for (const mode of ['major', 'minor'] as const) {
            expect(SCALE_INTERVALS[mode]).toHaveLength(7);
            for (const [pc, tonic] of PITCH_CLASS_NAMES.entries()) {
                const hint = keyHint(key(tonic, mode))!;
                expect(namesOf(hint.mask)).toHaveLength(7);
                expect(inMask(hint.mask, pc)).toBe(true);
            }
        }
    });

    it('確信度は、カルテと同じ段階の名前で持つ', () => {
        expect(keyHint(key('C', 'major', 0.9))!.confidenceLabel).toBe('確実');
        expect(keyHint(key('C', 'major', 0.5))!.confidenceLabel).toBe('たぶん');
        expect(keyHint(key('C', 'major', 0.2))!.confidenceLabel).toBe('自信なし');
    });

    it('キーが取れていないときは null', () => {
        expect(keyHint(key(null, null, 0))).toBeNull();
        expect(keyHint(key('C', null))).toBeNull();
        expect(keyHint(key('X', 'major'))).toBeNull();
        expect(keyHint(null)).toBeNull();
        expect(keyHint(undefined)).toBeNull();
    });
});

describe('コードの区間（秒 → ステップ）', () => {
    it('プロジェクトのグリッドで換える。グリッドがカルテのものなら、左端は小節線に乗る', () => {
        const regions = chordRegions([chord('C', 0.75, 2.75), chord('Am', 2.75, 4.75), chord('F', 4.75, 5.75)], GRID);
        expect(regions.map((r) => [r.symbol, r.start, r.end])).toEqual([['C', 0, 16], ['Am', 16, 32], ['F', 32, 40]]);
        expect(regions[1].rootPc).toBe(9);
        expect(namesOf(regions[1].mask)).toEqual(['C', 'E', 'A']);
    });

    it('ステップは小数になりうる（グリッドの刻みに乗らない位置を、丸めない）', () => {
        const regions = chordRegions([chord('C', 0.8, 1.9)], GRID);
        expect(regions[0].start).toBeCloseTo(0.4, 6);
        expect(regions[0].end).toBeCloseTo(9.2, 6);
        // テンポが違えば、同じ秒でも別のステップになる
        const slow = chordRegions([chord('C', 0.75, 2.75)], { bpm: 100, beatsPerBar: 4, offsetSec: 0.75 });
        expect(slow[0].end).toBeCloseTo(2 / 0.15, 6);
    });

    it('コードが取れなかった時間は、前のコードで埋めない', () => {
        const regions = chordRegions([chord('C', 0.75, 2.75), chord('G', 4.75, 6.75)], GRID);
        expect(regions.map((r) => [r.start, r.end])).toEqual([[0, 16], [32, 48]]);
        expect(regionAt(regions, 20)).toBeNull();
    });

    it('読めないコード記号と N の区間は入れない（次のコードを前へ延ばしもしない）', () => {
        const regions = chordRegions([chord('C', 0.75, 2.75), chord('N', 2.75, 4.75), chord('Cadd9', 4.75, 6.75), chord('G', 6.75, 8.75)], GRID);
        expect(regions.map((r) => r.symbol)).toEqual(['C', 'G']);
        expect(regions[0].end).toBe(16);
        expect(regions[1].start).toBe(48);
    });

    it('終わりが無い・始まりより前のときは、次のコードの始まりまで。次が無ければ入れない', () => {
        const noEnd = [chord('C', 0.75, Number.NaN), chord('G', 2.75, 0), chord('F', 4.75, Number.NaN)];
        expect(chordRegions(noEnd, GRID).map((r) => [r.symbol, r.start, r.end])).toEqual([['C', 0, 16], ['G', 16, 32]]);
    });

    it('次のコードが先に始まるなら、そこで切る（重ねない）。並びが前後していても、始まりの順にする', () => {
        const regions = chordRegions([chord('G', 2.75, 4.75), chord('C', 0.75, 3.75)], GRID);
        expect(regions.map((r) => [r.symbol, r.start, r.end])).toEqual([['C', 0, 16], ['G', 16, 32]]);
    });

    it('1 小節目より前は切り、1 小節目より前に終わる区間は入れない', () => {
        const regions = chordRegions([chord('C', 0, 0.5), chord('G', 0.5, 1.75)], GRID);
        expect(regions.map((r) => [r.symbol, r.start, r.end])).toEqual([['G', 0, 8]]);
    });

    it('コードが無ければ空', () => {
        expect(chordRegions([], GRID)).toEqual([]);
        expect(chordRegions(null, GRID)).toEqual([]);
        expect(chordRegions(undefined, GRID)).toEqual([]);
    });

    it('見えている範囲の最初の区間を、二分探索で探す', () => {
        const regions = chordRegions(
            Array.from({ length: 200 }, (_, i) => chord(i % 2 ? 'G' : 'C', 0.75 + i * 2, 0.75 + (i + 1) * 2)), GRID,
        );
        expect(regions).toHaveLength(200);
        expect(firstRegionEndingAfter(regions, -5)).toBe(0);
        expect(firstRegionEndingAfter(regions, 0)).toBe(0);
        expect(firstRegionEndingAfter(regions, 15.9)).toBe(0);
        // 区間の終わりは含まない（ちょうど終わりの位置は、次の区間）
        expect(firstRegionEndingAfter(regions, 16)).toBe(1);
        expect(firstRegionEndingAfter(regions, 16 * 150 + 0.5)).toBe(150);
        expect(firstRegionEndingAfter(regions, 16 * 200)).toBe(200);
        expect(regionAt(regions, 16 * 150 + 0.5)?.symbol).toBe('C');
        expect(regionAt(regions, 16 * 151.5)?.symbol).toBe('G');
        expect(regionAt(regions, 16 * 200 + 1)).toBeNull();
        expect(firstRegionEndingAfter([], 3)).toBe(0);
    });
});

describe('ピアノロールに渡す色分け', () => {
    const chart = {
        key: { tonic: 'C', mode: 'major', confidence: 0.8, alternatives: [] },
        chords: [chord('C', 0.75, 2.75), chord('G', 2.75, 4.75)],
    } as unknown as SongChart;

    it('切り替えが ON のものだけを出す', () => {
        const both = buildPitchHints(chart, GRID, { key: true, chord: true });
        expect(both.key?.label).toBe('C メジャー');
        expect(both.chords).toHaveLength(2);
        const keyOnly = buildPitchHints(chart, GRID, { key: true, chord: false });
        expect(keyOnly.key).not.toBeNull();
        expect(keyOnly.chords).toEqual([]);
        const chordOnly = buildPitchHints(chart, GRID, { key: false, chord: true });
        expect(chordOnly.key).toBeNull();
        expect(chordOnly.chords).toHaveLength(2);
    });

    it('カルテが無いとき・ドラムのトラックでは、何も出さない', () => {
        expect(buildPitchHints(null, GRID, { key: true, chord: true })).toEqual({ key: null, chords: [] });
        expect(buildPitchHints(chart, GRID, { key: true, chord: true }, true)).toEqual({ key: null, chords: [] });
    });

    it('ドラムのトラックは、パートの名前で見分ける。練習のトラックは、練習の相手のパートで決める', () => {
        expect(isDrumTrack({ part: 'drums' })).toBe(true);
        expect(isDrumTrack({ part: 'drum_kick' })).toBe(true);
        expect(isDrumTrack({ part: 'bass' })).toBe(false);
        expect(isDrumTrack({})).toBe(false);
        expect(isDrumTrack(null)).toBe(false);
        const trackOf = (id: number) => (id === 7 ? { part: 'drums' } : id === 8 ? { part: 'bass' } : undefined);
        expect(isDrumTrack({ practiceOf: 7 }, trackOf)).toBe(true);
        expect(isDrumTrack({ practiceOf: 8 }, trackOf)).toBe(false);
        expect(isDrumTrack({ practiceOf: 99 }, trackOf)).toBe(false);
    });
});

describe('切り替えの覚え書き', () => {
    beforeEach(() => localStorage.clear());

    it('覚えていなければ、どちらも ON', () => {
        expect(readPitchHintPrefs()).toEqual({ key: true, chord: true });
    });

    it('切り替えた状態を、種類ごとに覚える', () => {
        writePitchHintPref('key', false);
        expect(localStorage.getItem(PITCH_HINT_STORAGE.key)).toBe('0');
        expect(readPitchHintPrefs()).toEqual({ key: false, chord: true });
        writePitchHintPref('chord', false);
        expect(readPitchHintPrefs()).toEqual({ key: false, chord: false });
        writePitchHintPref('key', true);
        expect(localStorage.getItem(PITCH_HINT_STORAGE.key)).toBe('1');
        expect(readPitchHintPrefs()).toEqual({ key: true, chord: false });
    });
});
