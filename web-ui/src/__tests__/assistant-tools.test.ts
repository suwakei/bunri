/**
 * アシスタントのツールの実行（lib/assistant-tools.ts）: 高さの読み取り、ノートの並びの計算、引数の確かめ、
 * 各ツールの結果（偽の入口で）、台帳（backend/assistant_tools.json）との一致。
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { PianoNote } from '../lib/engine';
import type { SongChart } from '../lib/chart';
import {
    ARG_SHOWN, MAX_NOTES_PER_CALL, MAX_NOTES_READ, TOOLS, ToolError, addNotes, barsLabel, formatPitch, isWriteTool, meterLabel, parsePitch,
    readNotes, readTrackName, removeNotes, replaceNotes, runTool, toolLabel,
    type ToolClip, type ToolEnv, type ToolJob, type ToolMidi, type ToolPracticeSettings, type ToolResult, type ToolSelection, type ToolTrack,
} from '../lib/assistant-tools';
import { QUANTIZE_GRIDS, quantizeGrid, quantizeNotes, repeatNotes, setVelocity, shiftNotes, transformNotes, transposeNotes } from '../lib/assistant-tools-notes';
import { MAX_ISSUES } from '../lib/assistant-tools-learn';
import { EFFECT_NAMES, readEffectParams } from '../lib/assistant-tools-app';
import { setClipFades, setClipRange, splitClip } from '../lib/clip';
import { LANDMARKS } from '../lib/assistant-landmarks';
import type { DiffIssue, DiffResult } from '../lib/coach';
import type { SavedGuideResponse } from '../lib/guide';

const note = (name: string, octave: number, step: number, length = 4, velocity?: number): PianoNote =>
    (velocity === undefined ? { note: name, octave, step, length } : { note: name, octave, step, length, velocity });

const track = (id: number, name: string, extra: Partial<ToolTrack> = {}): ToolTrack =>
    ({ id, name, mute: false, solo: false, gain: 0, pan: 0, pianoNotes: [], clips: [], ...extra });

/** 音声のクリップ（偽物。長さと位置だけ）。`extra` で、音声の長さ（`buffer`）・縮めた範囲・フェードを足せる。 */
const clip = (name: string, offset = 0, duration = 8, extra: Partial<ToolClip> = {}): ToolClip => ({ name, offset, duration, ...extra });

/** 差分の結果（偽物）。指摘を小節ごとにまとめ、まとめの数を合わせる。 */
function diffResult(issues: DiffIssue[], extra: Partial<DiffResult['summary']> = {}): DiffResult {
    const bars = [...new Set(issues.map((i) => i.bar))].sort((a, b) => a - b).map((bar) => ({ bar, issues: issues.filter((i) => i.bar === bar) }));
    const count = (kind: string) => issues.filter((i) => i.kind === kind).length;
    return {
        summary: {
            reference_count: 8, attempt_count: 7, exact: 5, accuracy: 0.75,
            missing: count('missing'), pitch: count('pitch'), octave: count('octave'), extra: count('extra'), timing: count('timing'), length: count('length'),
            ...extra,
        },
        bars, worst_bars: bars.map((b) => b.bar).slice(0, 5),
    };
}

/** 偽の入口。状態を手元に持ち、呼ばれた入口を順に控える。 */
function makeEnv(init: {
    tracks?: ToolTrack[]; bpm?: number; beatsPerBar?: number; chart?: SongChart | null; midi?: Partial<ToolMidi> | null;
    selection?: ToolSelection | null; chartId?: string | null; guide?: SavedGuideResponse; diff?: DiffResult; job?: ToolJob | null;
    songFile?: boolean; shown?: boolean;
} = {}) {
    const state = {
        bpm: init.bpm ?? 120, beatsPerBar: init.beatsPerBar ?? 4, tracks: init.tracks ?? [track(1, 'Track 1'), track(2, 'Track 2')],
        active: null as number | null, playing: false, positionSec: 0, nextId: 10,
        practice: { open: false, partId: null as number | null, trackId: null as number | null },
        settings: null as ToolPracticeSettings | null,
        selection: init.selection ?? null, metronome: false, job: init.job ?? null,
        project: { name: null as string | null, dirty: true },
        /** 練習画面の「比べる」が返す結果（null なら、比べられなかった） */
        screenDiff: null as DiffResult | null,
        /** 保存の窓で、利用者が保存したか */
        saves: true,
        /** パート分離を始められるか（断られるなら、理由） */
        separation: { started: true } as { started: true } | { started: false; reason: string },
        /** エフェクトの失敗（在れば、その理由で失敗する） */
        effectError: null as string | null,
        diffCalls: [] as { reference: PianoNote[]; attempt: PianoNote[]; perBar: number; source: string; mode?: string }[],
    };
    const calls: string[] = [];
    const find = (id: number) => state.tracks.find((t) => t.id === id)!;
    const midi: ToolMidi | null = init.midi === null ? null : {
        available: true, connected: false, devices: [], mode: 'step',
        connect: async () => { calls.push('midi.connect'); midi!.connected = true; midi!.devices = ['Keystation 49']; return true; },
        disconnect: async () => { calls.push('midi.disconnect'); midi!.connected = false; midi!.devices = []; },
        setMode: (mode) => { calls.push(`midi.setMode ${mode}`); midi!.mode = mode; },
        ...init.midi,
    };
    const env: ToolEnv = {
        grid: () => ({ bpm: state.bpm, beatsPerBar: state.beatsPerBar, offsetSec: 0 }),
        tracks: () => state.tracks,
        activeTrackId: () => state.active,
        maxSteps: () => 16 * 999,
        playing: () => state.playing,
        positionSec: () => state.positionSec,
        durationSec: () => 8,
        chart: () => init.chart ?? null,
        practice: () => state.practice,
        play: (fromSec) => { calls.push(`play ${fromSec ?? 'here'}`); state.playing = true; },
        stop: () => { calls.push('stop'); state.playing = false; },
        seekStep: (step) => { calls.push(`seek ${step}`); },
        setBpm: (bpm) => { calls.push(`bpm ${bpm}`); state.bpm = bpm; },
        setBeatsPerBar: (beats) => { calls.push(`beats ${beats}`); state.beatsPerBar = beats; },
        addTrack: (name) => {
            const added = track(state.nextId++, name ?? `Track ${state.tracks.length + 1}`);
            state.tracks = [...state.tracks, added];
            calls.push(`addTrack ${added.name}`);
            return { id: added.id, name: added.name };
        },
        renameTrack: (id, name) => { calls.push(`rename ${id} ${name}`); find(id).name = name; },
        deleteTrack: (id) => { calls.push(`delete ${id}`); state.tracks = state.tracks.filter((t) => t.id !== id); },
        selectTrack: (id) => { calls.push(`select ${id}`); state.active = id; },
        setMute: (id, on) => { calls.push(`mute ${id} ${on}`); find(id).mute = on; },
        setSolo: (id, on) => { calls.push(`solo ${id} ${on}`); find(id).solo = on; },
        setGain: (id, db) => { calls.push(`gain ${id} ${db}`); find(id).gain = db; },
        setPan: (id, pan) => { calls.push(`pan ${id} ${pan}`); find(id).pan = pan; },
        setTrackNotes: (id, notes, label) => { calls.push(`notes ${id} ${label}`); find(id).pianoNotes = notes; },
        openPractice: (partId) => {
            calls.push(`practice ${partId}`);
            const own = track(state.nextId++, `${find(partId).name}の練習`, { role: 'practice', practiceOf: partId });
            state.tracks = [...state.tracks, own];
            state.practice = { open: true, partId, trackId: own.id };
            state.settings = { loop: { startBar: 1, endBar: 4, enabled: true }, speed: 1, listen: 'both', showGhost: true };
        },
        closePractice: () => { calls.push('closePractice'); state.practice = { ...state.practice, open: false }; state.settings = null; },
        midi: () => midi,
        practiceSettings: () => (state.practice.open ? state.settings : null),
        updatePractice: (patch) => { calls.push(`practice ${JSON.stringify(patch)}`); if (state.settings) state.settings = { ...state.settings, ...patch }; },
        selection: () => state.selection,
        flashNotes: (id, indices) => { calls.push(`flash ${id} ${indices.join(',')}`); },
        metronome: () => state.metronome,
        setMetronome: (on) => { calls.push(`metronome ${on}`); state.metronome = on; },
        chartId: () => (init.chartId === undefined ? (init.chart ? 'chart-1' : null) : init.chartId),
        learn: () => ({
            imported: state.tracks.some((t) => t.role === 'song'), hasChart: !!init.chart, separated: state.tracks.some((t) => t.role === 'part'),
            practiced: state.tracks.some((t) => t.role === 'practice' && t.pianoNotes.length > 0), diffed: false,
        }),
        referenceSource: (id) => (find(id).part === 'midi' ? 'midi' : 'transcription'),
        requestDiff: async (reference, attempt, perBar, source, mode) => {
            calls.push('diff');
            state.diffCalls.push({ reference, attempt, perBar, source, mode });
            return init.diff ?? diffResult([]);
        },
        practiceCompare: async () => { calls.push('practiceCompare'); return state.screenDiff; },
        savedGuide: async (chartId, sectionId) => {
            calls.push(`guide ${chartId} ${sectionId}`);
            return init.guide ?? { saved: false, chart_id: chartId, focus: sectionId };
        },
        pointAt: async (key) => { calls.push(`point ${key}`); return { shown: init.shown ?? true }; },
        job: () => state.job,
        cancelJob: async (id) => { calls.push(`cancelJob ${id}`); if (state.job) state.job = { ...state.job, cancelRequested: true }; },
        hasSongFile: () => init.songFile ?? false,
        startSeparation: async (sensitivity) => { calls.push(`separate ${sensitivity}`); return state.separation; },
        exportWav: async () => {
            calls.push('exportWav');
            return state.tracks.some((t) => t.clips.length > 0 || t.pianoNotes.length > 0)
                ? { ok: true, fileName: 'bunri_mix.wav' } : { ok: false, message: '書き出すものがありません。クリップかノートを置いてください' };
        },
        exportMidi: () => {
            calls.push('exportMidi');
            return state.tracks.some((t) => t.pianoNotes.length > 0)
                ? { ok: true, fileName: 'bunri.mid' } : { ok: false, message: '書き出すノートがありません。ピアノロールにノートを置いてください' };
        },
        project: () => state.project,
        saveProject: async () => {
            calls.push('save');
            if (state.saves) state.project = { name: state.project.name ?? '無題のプロジェクト', dirty: false };
            return state.saves;
        },
        // 本物 (再生エンジン) と同じく、クリップとその並びを、その場で書き換える
        moveClip: (id, index, sec) => { calls.push(`moveClip ${id} ${index} ${sec}`); (find(id).clips as ToolClip[])[index].offset = sec; },
        deleteClip: (id, index) => { calls.push(`deleteClip ${id} ${index}`); (find(id).clips as ToolClip[]).splice(index, 1); },
        duplicateClip: (id, index) => {
            calls.push(`duplicateClip ${id} ${index}`);
            const source = find(id).clips[index];
            (find(id).clips as ToolClip[]).splice(index + 1, 0, { ...source, offset: source.offset + source.duration });
        },
        // 本物 (タイムライン) と同じ計算 (lib/clip.ts) で、新しいクリップに差し替える
        trimClip: (id, index, range) => {
            calls.push(`trimClip ${id} ${index} ${JSON.stringify(range)}`);
            const clips = find(id).clips as ToolClip[];
            clips[index] = setClipRange(clips[index], range);
        },
        splitClip: (id, index, at) => {
            calls.push(`splitClip ${id} ${index} ${at}`);
            const clips = find(id).clips as ToolClip[];
            clips.splice(index, 1, ...splitClip(clips[index], at)!);
        },
        fadeClip: (id, index, fades) => {
            calls.push(`fadeClip ${id} ${index} ${JSON.stringify(fades)}`);
            const clips = find(id).clips as ToolClip[];
            clips[index] = setClipFades(clips[index], fades);
        },
        applyEffect: async (id, index, effect, params, label) => {
            calls.push(`effect ${id} ${index} ${effect} ${JSON.stringify(params)} ${label}`);
            if (state.effectError) throw new Error(state.effectError);
        },
    };
    return { env, state, calls, midi };
}

/**
 * 操作ログに出す文（利用者向け）に、入っていてはいけないもの: ツールや引数の名前（`track_id` `get_project` など、
 * 下線でつないだ名前）、「利用者」（Claude への頼みの言い方）、API の値の書き方（`true` / `false` / `"…"`）。
 */
const INTERNAL = /[a-z]+_[a-z]+|利用者|\btrue\b|\bfalse\b|"[a-z]+"/;
/** 書き出したファイルの名前（`bunri_mix.wav`）は、内部の名前ではないので、見る前に外す。 */
const plain = (text: string) => text.replace(/[\w-]+\.(wav|mid)/g, '');

/** 成功するはずのツールを実行して、結果を返す。操作ログの行（`summary`）に、内部の名前が無いことも確かめる。 */
async function ok(name: string, input: unknown, env: ToolEnv): Promise<ToolResult> {
    const outcome = await runTool(name, input, env);
    if (!outcome.ok) throw new Error(`失敗しました: ${outcome.message}`);
    expect(plain(outcome.result.summary), `${name} の summary`).not.toMatch(INTERNAL);
    return outcome.result;
}

/**
 * 失敗するはずのツールを実行して、Claude に返す理由の文を返す。
 * 操作ログに出す文（`shown`）に、内部の名前が無いことも確かめる（どの失敗のテストも、これを通る）。
 */
async function fail(name: string, input: unknown, env: ToolEnv): Promise<string> {
    const outcome = await runTool(name, input, env);
    if (outcome.ok) throw new Error(`成功してしまいました: ${outcome.result.summary}`);
    expect(plain(outcome.shown), `${name} の shown（Claude に返す文: ${outcome.message}）`).not.toMatch(INTERNAL);
    return outcome.message;
}

/** 失敗するはずのツールを実行して、操作ログに出す文（利用者向け）を返す。 */
async function shown(name: string, input: unknown, env: ToolEnv): Promise<string> {
    const outcome = await runTool(name, input, env);
    if (outcome.ok) throw new Error(`成功してしまいました: ${outcome.result.summary}`);
    return outcome.shown;
}

describe('parsePitch（高さの読み取り）', () => {
    it('音名とオクターブを読む', () => {
        expect(parsePitch('C4')).toEqual({ note: 'C', octave: 4 });
        expect(parsePitch('F#3')).toEqual({ note: 'F#', octave: 3 });
        expect(parsePitch(' a0 ')).toEqual({ note: 'A', octave: 0 });
        expect(parsePitch('B8')).toEqual({ note: 'B', octave: 8 });
    });

    it('フラットは、シャープに直す（ピアノロールはシャープしか描けない）', () => {
        expect(formatPitch(parsePitch('Bb3'))).toBe('A#3');
        expect(formatPitch(parsePitch('Db4'))).toBe('C#4');
        expect(formatPitch(parsePitch('E♭2'))).toBe('D#2');
        expect(formatPitch(parsePitch('F♯2'))).toBe('F#2');
        // オクターブをまたぐもの
        expect(formatPitch(parsePitch('Cb4'))).toBe('B3');
        expect(formatPitch(parsePitch('B#3'))).toBe('C4');
        expect(formatPitch(parsePitch('E#4'))).toBe('F4');
        expect(formatPitch(parsePitch('Fb4'))).toBe('E4');
    });

    it('範囲の外と、読めない形は、直し方の分かる文で失敗する', () => {
        expect(() => parsePitch('C9')).toThrow(/範囲の外です。C0〜B8/);
        expect(() => parsePitch('C-1')).toThrow(/範囲の外/);
        // Cb0 は B-1 になるので、範囲の外
        expect(() => parsePitch('Cb0')).toThrow(/範囲の外/);
        expect(() => parsePitch('B#8')).toThrow(/範囲の外/);
        expect(() => parsePitch('H4')).toThrow(/読めません.*"C4"/);
        expect(() => parsePitch('C')).toThrow(ToolError);
        expect(() => parsePitch('C##4')).toThrow(ToolError);
        expect(() => parsePitch(60)).toThrow(/"C4" や "F#3" のような文字/);
    });
});

describe('ノートの並びの計算', () => {
    const existing = [note('C', 4, 0), note('E', 4, 4), note('G', 4, 16), note('C', 5, 30, 8)];

    it('addNotes: 同じ高さ・同じ位置のノートは二重に置かない（足すものどうしも）', () => {
        const next = addNotes(existing, [note('C', 4, 0, 2), note('D', 4, 0), note('D', 4, 0, 8), note('C', 4, 4)]);
        expect(next.added).toEqual([note('D', 4, 0), note('C', 4, 4)]);
        expect(next.skipped).toBe(2);
        expect(next.notes).toHaveLength(6);
        // 元の並びは書き換えない (丸ごと差し替える約束)
        expect(existing).toHaveLength(4);
        expect(next.notes).not.toBe(existing);
    });

    it('removeNotes: 範囲 [start, end) に「始まり」が入っているノートが対象', () => {
        // 16 は入る、32 の手前で始まって範囲の外まで伸びる 30 も入る。範囲の前から伸びてくるノートは入らない
        const next = removeNotes(existing, 16, 32);
        expect(next.removed).toEqual([note('G', 4, 16), note('C', 5, 30, 8)]);
        expect(next.notes).toEqual([note('C', 4, 0), note('E', 4, 4)]);
        // end は含まない
        expect(removeNotes(existing, 0, 4).removed).toEqual([note('C', 4, 0)]);
        expect(removeNotes(existing, 1, 4).removed).toEqual([]);
        expect(existing).toHaveLength(4);
    });

    it('removeNotes: 高さを絞れる', () => {
        expect(removeNotes(existing, 0, 64, new Set(['C4', 'C5'])).notes).toEqual([note('E', 4, 4), note('G', 4, 16)]);
    });

    it('replaceNotes: 範囲の中を入れ替え、外はそのまま', () => {
        const next = replaceNotes(existing, 0, 16, [note('D', 4, 0, 8, 100), note('F', 4, 8, 8)]);
        expect(next.removed).toHaveLength(2);
        expect(next.added).toHaveLength(2);
        expect(next.notes).toEqual([note('G', 4, 16), note('C', 5, 30, 8), note('D', 4, 0, 8, 100), note('F', 4, 8, 8)]);
    });

    it('barsLabel: ステップの範囲を小節にする', () => {
        expect(barsLabel(0, 32, 16)).toBe('1〜2 小節');
        expect(barsLabel(0, 16, 16)).toBe('1 小節');
        expect(barsLabel(32, 64, 16)).toBe('3〜4 小節');
        expect(barsLabel(12, 24, 12)).toBe('2 小節');
        expect(meterLabel(6)).toBe('6/8');
        expect(meterLabel(3)).toBe('3/4');
    });
});

describe('引数の確かめ', () => {
    it('readNotes: 高さ・位置・長さ・強さを読み、強さは在るときだけ持たせる', () => {
        expect(readNotes([{ pitch: 'Bb2', step: 0, length: 4 }, { pitch: 'C3', step: 4, length: 2, velocity: 80 }], 128))
            .toEqual([note('A#', 2, 0), note('C', 3, 4, 2, 80)]);
    });

    it('readNotes: 小数の位置と長さ（32 分音符・三連）を受けて、1/60 ステップの倍数にそろえる', () => {
        const notes = readNotes([
            { pitch: 'C4', step: 0.5, length: 0.5 },          // 32 分音符
            { pitch: 'D4', step: 1.3333, length: 1.3333 },    // 8 分の三連（4 桁で書かれても、ちょうど 4/3 になる）
            { pitch: 'E4', step: 2.6667, length: 0.6667 },    // 16 分の三連の長さ
            { pitch: 'F4', step: 4.0000001, length: 4 },      // 端数の付いた整数は、整数に戻す
        ], 128);
        expect(notes).toEqual([note('C', 4, 0.5, 0.5), note('D', 4, 4 / 3, 4 / 3), note('E', 4, 8 / 3, 2 / 3), note('F', 4, 4, 4)]);
        expect(Number.isInteger(notes[3].step)).toBe(true);
        // 範囲の端も、そろえた値で比べる（範囲の終わりちょうどで始まるノートは、範囲の外）
        expect(() => readNotes([{ pitch: 'C4', step: 1.3333, length: 1 }], 128, { start: 0, end: 4 / 3 })).toThrow(/step 1\.3333 は範囲 \[0, 1\.3333\) の外/);
        expect(readNotes([{ pitch: 'C4', step: 1.3333, length: 1 }], 128, { start: 4 / 3, end: 4 })).toHaveLength(1);
    });

    it('readNotes: だめなノートは、どのノートの何を直すかを並べる', () => {
        const run = (value: unknown, range?: { start: number; end: number }) => {
            try { readNotes(value, 128, range); } catch (e) { return (e as Error).message; }
            return '';
        };
        expect(run('C4')).toMatch(/配列/);
        expect(run([])).toMatch(/空です/);
        expect(run([{ pitch: 'C4', step: -1, length: 4 }])).toMatch(/notes\[0\]: step は 0 以上/);
        expect(run([{ pitch: 'C4', step: 0, length: 4 }, { pitch: 'C4', step: '1.5', length: 4 }])).toMatch(/notes\[1\]: step は数で指定.*小数も可/);
        expect(run([{ pitch: 'C4', step: 0, length: 0 }])).toMatch(/length は 0\.25 以上/);
        expect(run([{ pitch: 'C4', step: 0, length: 0.1 }])).toMatch(/length は 0\.25 以上/);
        expect(run([{ pitch: 'C4', step: NaN, length: 4 }])).toMatch(/step は数で指定/);
        expect(run([{ pitch: 'C4', step: 0 }])).toMatch(/length を指定/);
        expect(run([{ step: 0, length: 4 }])).toMatch(/pitch を指定/);
        expect(run([{ pitch: 'C4', step: 0, length: 4, velocity: 0 }])).toMatch(/velocity は 1 以上/);
        expect(run([{ pitch: 'C4', step: 0, length: 4, velocity: 128 }])).toMatch(/velocity は 127 以下/);
        expect(run([{ pitch: 'C9', step: 0, length: 4 }])).toMatch(/notes\[0\]: 高さ「C9」は範囲の外/);
        expect(run([{ pitch: 'C4', step: 126, length: 4 }])).toMatch(/step \+ length が 128 を超えて/);
        expect(run([{ pitch: 'C4', step: 0, length: 4, note: 'x' }])).toMatch(/「note」という項目はありません/);
        expect(run([null])).toMatch(/notes\[0\]: ノートは \{"pitch"/);
        expect(run([{ pitch: 'C4', step: 40, length: 4 }], { start: 0, end: 32 })).toMatch(/step 40 は範囲 \[0, 32\) の外/);
        expect(run(Array.from({ length: MAX_NOTES_PER_CALL + 1 }, (_, i) => ({ pitch: 'C4', step: i, length: 1 })))).toMatch(/512 個まで/);
    });

    it('readNotes: 上限ちょうどは通る。だめなノートが多いときは 5 個まで並べる', () => {
        expect(readNotes(Array.from({ length: MAX_NOTES_PER_CALL }, (_, i) => ({ pitch: 'C4', step: i, length: 1 })), 16 * 999)).toHaveLength(512);
        const bad = Array.from({ length: 8 }, () => ({ pitch: 'X', step: 0, length: 1 }));
        expect(() => readNotes(bad, 128)).toThrow(/notes\[4\].*ほかに 3 個/);
    });

    it('readTrackName: 前後の空白を除いて 1〜40 文字', () => {
        expect(readTrackName('  Bass  ')).toBe('Bass');
        expect(readTrackName('あ'.repeat(40))).toHaveLength(40);
        expect(() => readTrackName('あ'.repeat(41))).toThrow(/1〜40 文字にしてください（いまは 41 文字）/);
        expect(() => readTrackName('   ')).toThrow(/1〜40 文字/);
        expect(() => readTrackName(3)).toThrow(/文字で指定/);
    });
});

describe('読むツール', () => {
    it('get_project: 台帳の説明に書いてあるものを全部返す', async () => {
        const { env, state } = makeEnv({
            tracks: [
                track(1, '原曲', { role: 'song', clips: [clip('song.wav', 2.5, 30)] }),
                track(2, 'ベース', { role: 'part', mute: true, gain: -3.04, referenceNotes: [note('C', 2, 0)] }),
                track(3, 'ベースの練習', { role: 'practice', practiceOf: 2, pianoNotes: [note('C', 2, 0), note('E', 2, 4)], pan: -0.3 }),
                track(4, 'Track 1'),
            ],
            bpm: 96,
        });
        state.active = 3;
        state.positionSec = 2.5;
        const result = await ok('get_project', {}, env);
        expect(result).toMatchObject({
            ok: true, bpm: 96, beats_per_bar: 4, time_signature: '4/4', steps_per_bar: 16,
            open_track_id: 3, playing: false, has_chart: false, metronome: false,
            practice: { open: false, part_track_id: null, track_id: null },
            selection: null, job: null,
            learn: { imported: true, has_chart: false, separated: true, practiced: true, compared: false },
            project: { name: null, unsaved_changes: true },
        });
        // 96 BPM の 1 ステップは 0.15625 秒。8 秒 = 51.2 ステップ → 切り上げて 52 ステップ、4 小節
        expect(result.song_length).toEqual({ seconds: 8, steps: 52, bars: 4 });
        expect(result.position).toEqual({ seconds: 2.5, step: 16, bar: 2 });
        expect(result.tracks).toEqual([
            {
                id: 1, name: '原曲', role: 'song', mute: false, solo: false, gain_db: 0, pan: 0, note_count: 0, clip_count: 1, has_reference: false,
                // 96 BPM の 1 小節は 2.5 秒。2.5 秒から始まるクリップは、2 小節目の頭
                clips: [{ index: 0, name: 'song.wav', start_seconds: 2.5, duration_seconds: 30, start_bar: 2 }],
            },
            { id: 2, name: 'ベース', role: 'part', mute: true, solo: false, gain_db: -3, pan: 0, note_count: 0, clip_count: 0, has_reference: true },
            { id: 3, name: 'ベースの練習', role: 'practice', practice_of: 2, mute: false, solo: false, gain_db: 0, pan: -0.3, note_count: 2, clip_count: 0, has_reference: false },
            { id: 4, name: 'Track 1', role: 'free', mute: false, solo: false, gain_db: 0, pan: 0, note_count: 0, clip_count: 0, has_reference: false },
        ]);
        expect(result.summary).toBe('プロジェクトの様子を見ました（トラック 4 本、96 BPM、4/4）');
    });

    it('get_project: 選んでいるノート・練習の設定・メトロノーム・動いている処理も返す', async () => {
        const { env, state } = makeEnv({
            tracks: [
                track(2, 'ベース', { role: 'part', part: 'bass', referenceNotes: [note('C', 2, 0)] }),
                track(3, 'ベースの練習', { role: 'practice', practiceOf: 2, pianoNotes: [note('C', 2, 0), note('E', 2, 20), note('G', 2, 36, 8)] }),
            ],
            selection: { trackId: 3, indices: [1, 2] },
            job: { id: 'j1', title: 'パート分離と採譜', filename: 'song.wav', state: 'running', stage: 'パートに分けています', progress: 0.4, elapsedSec: 80, cancelRequested: false },
        });
        state.practice = { open: true, partId: 2, trackId: 3 };
        state.settings = { loop: { startBar: 5, endBar: 8, enabled: true }, speed: 0.75, listen: 'part', showGhost: false };
        state.metronome = true;
        const result = await ok('get_project', {}, env);
        expect(result.metronome).toBe(true);
        expect(result.practice).toEqual({
            open: true, part_track_id: 2, track_id: 3,
            loop: { start_bar: 5, end_bar: 8, enabled: true }, speed_percent: 75, listen: 'part', show_reference: false,
        });
        // 選んでいるのは 2〜3 小節のノート 2 個 (始まり 20、終わり 36 + 8)
        expect(result.selection).toEqual({ track_id: 3, count: 2, start_step: 20, end_step: 44, bars: '2〜3 小節' });
        expect(result.job).toEqual({ title: 'パート分離と採譜', state: 'running', stage: 'パートに分けています' });
    });

    it('get_notes: 選んでいるノートには selected を付ける。selected_only で、選んでいるノートだけを読む', async () => {
        const notes = [note('C', 4, 0), note('E', 4, 4), note('G', 4, 8)];
        const { env } = makeEnv({ tracks: [track(1, 'Track 1', { pianoNotes: notes }), track(2, 'Track 2', { referenceNotes: [note('C', 2, 0)] })], selection: { trackId: 1, indices: [1] } });
        expect((await ok('get_notes', { track_id: 1 }, env)).notes).toEqual([
            { pitch: 'C4', step: 0, length: 4 }, { pitch: 'E4', step: 4, length: 4, selected: true }, { pitch: 'G4', step: 8, length: 4 },
        ]);
        const only = await ok('get_notes', { track_id: 1, selected_only: true }, env);
        expect(only.notes).toEqual([{ pitch: 'E4', step: 4, length: 4 }]);
        expect(only.total).toBe(1);
        expect(await fail('get_notes', { track_id: 2, selected_only: true }, env)).toMatch(/選んでいるノートがありません（選んでいるのは track_id 1/);
        expect(await fail('get_notes', { track_id: 2, source: 'reference', selected_only: true }, env)).toMatch(/source が "notes" のときだけ/);
    });

    it('get_project: 拍子が変わると、1 小節のステップ数も変わる', async () => {
        expect((await ok('get_project', {}, makeEnv({ beatsPerBar: 3 }).env)).steps_per_bar).toBe(12);
        expect((await ok('get_project', undefined, makeEnv({ beatsPerBar: 6 }).env)).time_signature).toBe('6/8');
    });

    it('get_notes: 位置の順に、高さは "C4" の形で返す。強さを持たないノートには付けない', async () => {
        const { env } = makeEnv({ tracks: [track(1, 'Track 1', { pianoNotes: [note('E', 4, 16, 4, 90), note('C', 4, 0), note('A#', 3, 0, 2)] })] });
        const result = await ok('get_notes', { track_id: 1 }, env);
        expect(result.notes).toEqual([
            { pitch: 'A#3', step: 0, length: 2 }, { pitch: 'C4', step: 0, length: 4 }, { pitch: 'E4', step: 16, length: 4, velocity: 90 },
        ]);
        expect(result).toMatchObject({ total: 3, returned: 3, truncated: false, source: 'notes', steps_per_bar: 16 });
        expect(result.summary).toBe('「Track 1」のノートを 3 個読みました');
    });

    it('get_notes: 小節で絞れる（1 始まり。終わりの小節を含む）', async () => {
        const { env } = makeEnv({ tracks: [track(1, 'Track 1', { pianoNotes: [note('C', 4, 0), note('D', 4, 16), note('E', 4, 31), note('F', 4, 32)] })] });
        const result = await ok('get_notes', { track_id: 1, start_bar: 2, end_bar: 2 }, env);
        expect((result.notes as { pitch: string }[]).map((n) => n.pitch)).toEqual(['D4', 'E4']);
        expect(result.summary).toBe('「Track 1」のノートを 2 個読みました（2 小節）');
        expect((await ok('get_notes', { track_id: 1, start_bar: 2 }, env)).returned).toBe(3);
        expect(await fail('get_notes', { track_id: 1, start_bar: 3, end_bar: 2 }, env)).toMatch(/end_bar は start_bar 以上/);
        expect(await fail('get_notes', { track_id: 1, start_bar: 0 }, env)).toMatch(/start_bar は 1 以上/);
    });

    it('get_notes: お手本を読める。無いトラックでは、どのトラックなら在るかを言う', async () => {
        const { env } = makeEnv({ tracks: [track(1, 'ベース', { role: 'part', referenceNotes: [note('C', 2, 0)] }), track(2, 'Track 1')] });
        const result = await ok('get_notes', { track_id: 1, source: 'reference' }, env);
        expect(result.notes).toEqual([{ pitch: 'C2', step: 0, length: 4 }]);
        expect(result.summary).toBe('「ベース」のお手本を 1 個読みました');
        expect(await fail('get_notes', { track_id: 2, source: 'reference' }, env)).toMatch(/お手本がありません.*has_reference/);
        expect(await fail('get_notes', { track_id: 2, source: 'ghost' }, env)).toMatch(/source は "notes" \/ "reference" のどれか/);
    });

    it('get_notes: 400 個までで切り、切ったことを知らせる', async () => {
        const many = Array.from({ length: MAX_NOTES_READ + 50 }, (_, i) => note('C', 4, i, 1));
        const result = await ok('get_notes', { track_id: 1 }, makeEnv({ tracks: [track(1, 'Track 1', { pianoNotes: many })] }).env);
        expect(result).toMatchObject({ total: 450, returned: 400, truncated: true });
        expect(result.notes).toHaveLength(400);
        expect(result.summary).toBe('「Track 1」のノートを、450 個のうち 400 個まで読みました');
    });

    it('get_chart: カルテが無ければ失敗、在ればキー・コード・構成を返す', async () => {
        expect(await fail('get_chart', {}, makeEnv().env)).toMatch(/まだカルテがありません/);
        const chart = {
            version: 1, source: { filename: 'song.mp3', duration_sec: 16 },
            grid: { bpm: 119.468, bpm_confidence: 0.9, bpm_source: 'auto', downbeat_offset_sec: 0, time_signature: [4, 4], beat_times_sec: [], user_confirmed: false },
            key: { tonic: 'A', mode: 'minor', confidence: 0.812, alternatives: [] },
            sections: [{ id: 'S1', label: null, suggested_label: 'verse', suggested_confidence: 0.5, start_bar: 1, end_bar: 4, start_sec: 0, end_sec: 8, repeat_group: 'A', features: { rms_db: -12, onset_density: 2 } }],
            chords: [
                { bar: 1, beat: 1, beat_index: 0, beat_count: 4, start_sec: 0, end_sec: 2, root: 'A', quality: 'min', symbol: 'Am', degree: 'i', confidence: 0.9 },
                { bar: 2, beat: 1, beat_index: 4, beat_count: 4, start_sec: 2, end_sec: 4, root: 'F', quality: 'maj', symbol: 'F', degree: 'VI', confidence: 0.3 },
            ],
            mix: null, unavailable: {},
        } as unknown as SongChart;
        const result = await ok('get_chart', {}, makeEnv({ chart }).env);
        expect(result.summary).toBe('カルテを読みました（キー A マイナー、2 コード、構成 1 区間）');
        expect(result).toMatchObject({ key: { tonic: 'A', mode: 'minor', confidence: 0.81 }, bpm: 119.47, time_signature: '4/4', bars: 4 });
        expect(result.sections).toEqual([{ id: 'S1', label: 'verse', label_confirmed: false, start_bar: 1, end_bar: 4, repeat_group: 'A' }]);
        expect(result.chords).toEqual([
            { bar: 1, beat: 1, beats: 4, symbol: 'Am', degree: 'i' },
            { bar: 2, beat: 1, beats: 4, symbol: 'F', degree: 'VI', low_confidence: true },
        ]);
        // ファイルの名前は返さない
        expect(JSON.stringify(result)).not.toContain('song.mp3');
    });
});

describe('再生・テンポ・拍子', () => {
    it('play: 小節を指定すると、その小節の頭から。指定が無ければ、いまの位置から', async () => {
        const { env, calls } = makeEnv();
        expect((await ok('play', { from_bar: 3 }, env)).summary).toBe('3 小節目から再生しました');
        // 120 BPM・4/4 の 3 小節目は 4 秒
        expect(calls).toEqual(['play 4']);
        // 再生中に小節なしで呼んでも、鳴らし直さない (頭に戻ってしまうため)
        expect((await ok('play', {}, env)).summary).toBe('すでに再生中です');
        expect(calls).toEqual(['play 4']);
        expect(await fail('play', { from_bar: 0 }, env)).toMatch(/from_bar は 1 以上/);
        expect(await fail('play', { bar: 2 }, env)).toMatch(/「bar」という項目はありません。使える項目: from_bar/);
    });

    it('stop と seek', async () => {
        const { env, calls } = makeEnv({ beatsPerBar: 3 });
        expect((await ok('stop', {}, env)).playing).toBe(false);
        expect(await ok('seek', { bar: 5 }, env)).toMatchObject({ summary: '5 小節目へ移動しました', step: 48 });
        expect(calls).toEqual(['stop', 'seek 48']);
        expect(await fail('seek', {}, env)).toMatch(/bar を指定/);
        // ピアノロールの長さの上限 (999 小節ぶんのステップ。3/4 では 1332 小節) を超える小節
        expect(await fail('seek', { bar: 1333 }, env)).toMatch(/bar は 1332 以下にしてください/);
        expect(await fail('stop', { now: true }, env)).toMatch(/このツールに引数はありません/);
    });

    it('set_tempo: 20〜300 だけを受ける', async () => {
        const { env, calls } = makeEnv();
        expect((await ok('set_tempo', { bpm: 96.456 }, env)).summary).toBe('テンポを 96.46 BPM にしました（前は 120 BPM）');
        expect(calls).toEqual(['bpm 96.46']);
        expect((await ok('set_tempo', { bpm: 96.46 }, env)).summary).toBe('テンポは 96.46 BPM のままです');
        expect(calls).toHaveLength(1);
        expect(await fail('set_tempo', { bpm: 19 }, env)).toMatch(/bpm は 20〜300 の範囲/);
        expect(await fail('set_tempo', { bpm: 301 }, env)).toMatch(/20〜300/);
        expect(await fail('set_tempo', { bpm: '96' }, env)).toMatch(/bpm は数で指定/);
        expect(await fail('set_tempo', {}, env)).toMatch(/bpm を指定/);
    });

    it('set_tempo: 音声やお手本が在るときは、ずれることを結果に添える', async () => {
        const { env } = makeEnv({ tracks: [track(1, 'ベース', { role: 'part', referenceNotes: [note('C', 2, 0)] })] });
        expect((await ok('set_tempo', { bpm: 100 }, env)).warning).toMatch(/変える前のテンポに合っています/);
        expect((await ok('set_tempo', { bpm: 100 }, makeEnv().env)).warning).toBeUndefined();
    });

    it('set_time_signature: 3 / 4 / 6 だけを受け、1 小節のステップ数を返す', async () => {
        const { env, calls } = makeEnv();
        expect(await ok('set_time_signature', { beats_per_bar: 3 }, env)).toMatchObject({ summary: '拍子を 3/4 にしました（前は 4/4）', steps_per_bar: 12 });
        expect(calls).toEqual(['beats 3']);
        expect(await fail('set_time_signature', { beats_per_bar: 5 }, env)).toMatch(/3（3\/4）・4（4\/4）・6（6\/8）のどれか/);
    });
});

describe('トラック', () => {
    it('add_track: 足して、ピアノロールで開く。新しい id を返す', async () => {
        const { env, calls, state } = makeEnv();
        const result = await ok('add_track', { name: ' Bass ' }, env);
        expect(result).toMatchObject({ summary: '「Bass」を追加しました', track_id: 10, name: 'Bass', opened: true });
        expect(calls).toEqual(['addTrack Bass', 'select 10']);
        expect((await ok('add_track', {}, env)).name).toBe('Track 4');
        expect(await fail('add_track', { name: 'あ'.repeat(41) }, env)).toMatch(/1〜40 文字/);
        expect(await fail('add_track', { name: '' }, env)).toMatch(/1〜40 文字/);
        expect(state.tracks).toHaveLength(4);
    });

    it('add_track: 練習画面のあいだは、ピアノロールを動かさない', async () => {
        const { env, calls, state } = makeEnv();
        state.practice = { open: true, partId: 1, trackId: 2 };
        expect(await ok('add_track', {}, env)).toMatchObject({ opened: false });
        expect(calls).toEqual(['addTrack Track 3']);
    });

    it('在りえない track_id は、いま在る id を添えて失敗する', async () => {
        const { env, calls } = makeEnv();
        const message = await fail('rename_track', { track_id: 99, name: 'x' }, env);
        expect(message).toMatch(/track_id 99 のトラックはありません。get_project で id を確かめてください/);
        expect(message).toContain('1（Track 1）、2（Track 2）');
        expect(await fail('rename_track', { track_id: '1', name: 'x' }, env)).toMatch(/track_id は整数で指定/);
        expect(await fail('delete_track', {}, env)).toMatch(/track_id を指定/);
        expect(await fail('select_track', { track_id: 1 }, makeEnv({ tracks: [] }).env)).toMatch(/いまはトラックが 1 本もありません/);
        expect(calls).toEqual([]);
    });

    it('rename_track / delete_track / select_track', async () => {
        const { env, calls, state } = makeEnv({ tracks: [track(1, 'Track 1', { pianoNotes: [note('C', 4, 0)] }), track(2, 'Track 2')] });
        expect((await ok('rename_track', { track_id: 1, name: 'Lead' }, env)).summary).toBe('「Track 1」の名前を「Lead」に変えました');
        expect((await ok('rename_track', { track_id: 1, name: 'Lead' }, env)).summary).toBe('名前は「Lead」のままです');
        expect(await fail('rename_track', { track_id: 1 }, env)).toMatch(/name を指定/);
        expect((await ok('select_track', { track_id: 2 }, env)).summary).toBe('「Track 2」をピアノロールで開きました');
        expect((await ok('delete_track', { track_id: 1 }, env)).summary).toBe('「Lead」を削除しました（ノート 1 個、クリップ 0 個）');
        expect(calls).toEqual(['rename 1 Lead', 'select 2', 'delete 1']);
        expect(state.tracks.map((t) => t.id)).toEqual([2]);
    });

    it('練習画面で使っているトラックは、消せない・ほかのトラックは開けない', async () => {
        const { env, calls, state } = makeEnv();
        state.practice = { open: true, partId: 1, trackId: 2 };
        expect(await fail('delete_track', { track_id: 2 }, env)).toMatch(/練習画面で使っているトラック.*close_practice/);
        expect(await fail('select_track', { track_id: 1 }, env)).toMatch(/練習画面のあいだは.*close_practice/);
        expect(calls).toEqual([]);
    });

    it('set_track_mix: 指定した項目だけを変える', async () => {
        const { env, calls } = makeEnv();
        expect((await ok('set_track_mix', { track_id: 2, mute: true }, env)).summary).toBe('「Track 2」をミュートしました');
        expect((await ok('set_track_mix', { track_id: 2, mute: false }, env)).summary).toBe('「Track 2」のミュートを解除しました');
        expect((await ok('set_track_mix', { track_id: 2, solo: true }, env)).summary).toBe('「Track 2」をソロにしました');
        expect((await ok('set_track_mix', { track_id: 2, gain_db: -6 }, env)).summary).toBe('「Track 2」の音量を −6.0 dB にしました');
        expect((await ok('set_track_mix', { track_id: 2, pan: -0.3 }, env)).summary).toBe('「Track 2」のパンを 左 30 にしました');
        expect(calls).toEqual(['mute 2 true', 'mute 2 false', 'solo 2 true', 'gain 2 -6', 'pan 2 -0.3']);
        const many = await ok('set_track_mix', { track_id: 1, mute: true, gain_db: 3, pan: 1 }, env);
        expect(many.summary).toBe('「Track 1」を変えました（ミュート、音量 +3.0 dB、パン 右 100）');
        expect(many).toMatchObject({ mute: true, solo: false, gain_db: 3, pan: 1 });
        // すでにその設定なら、何も呼ばない
        calls.length = 0;
        expect((await ok('set_track_mix', { track_id: 1, mute: true, gain_db: 3 }, env)).summary).toBe('「Track 1」は、すでにその設定です');
        expect(calls).toEqual([]);
    });

    it('set_track_mix: 範囲の外と、項目なしは失敗する', async () => {
        const { env, calls } = makeEnv();
        expect(await fail('set_track_mix', { track_id: 1 }, env)).toMatch(/変える項目を 1 つ以上/);
        expect(await fail('set_track_mix', { track_id: 1, gain_db: 7 }, env)).toMatch(/gain_db は -60〜6 の範囲/);
        expect(await fail('set_track_mix', { track_id: 1, gain_db: -61 }, env)).toMatch(/-60〜6/);
        expect(await fail('set_track_mix', { track_id: 1, pan: 1.5 }, env)).toMatch(/pan は -1〜1 の範囲/);
        expect(await fail('set_track_mix', { track_id: 1, mute: 'yes' }, env)).toMatch(/mute は true か false/);
        expect(calls).toEqual([]);
    });
});

describe('ノート', () => {
    const eight = [0, 4, 8, 12, 16, 20, 24, 28].map((step) => ({ pitch: 'C2', step, length: 4 }));

    it('add_notes: 置いた数と小節を 1 行で返す。開いていないトラックにも置ける', async () => {
        const { env, calls, state } = makeEnv();
        state.active = 2;
        const result = await ok('add_notes', { track_id: 1, notes: eight }, env);
        expect(result.summary).toBe('ノートを 8 個置きました（Track 1、1〜2 小節）');
        expect(result).toMatchObject({ added: 8, skipped: 0, note_count: 8 });
        expect(calls).toEqual(['notes 1 8 ノートを追加']);
        expect(state.tracks[0].pianoNotes).toHaveLength(8);
    });

    it('add_notes: フラットはシャープに直し、同じ高さ・同じ位置は二重に置かない', async () => {
        const before = [note('A#', 3, 0)];
        const { env, calls, state } = makeEnv({ tracks: [track(1, 'Track 1', { pianoNotes: before })] });
        const result = await ok('add_notes', { track_id: 1, notes: [{ pitch: 'Bb3', step: 0, length: 4 }, { pitch: 'Bb3', step: 4, length: 4, velocity: 70 }] }, env);
        expect(result.summary).toBe('ノートを 1 個置きました（Track 1、1 小節。同じ高さ・同じ位置にすでに在る 1 個は置いていません）');
        expect(state.tracks[0].pianoNotes).toEqual([note('A#', 3, 0), note('A#', 3, 4, 4, 70)]);
        // 元の並びは書き換えず、丸ごと差し替える
        expect(before).toHaveLength(1);
        expect(state.tracks[0].pianoNotes).not.toBe(before);
        // 全部が重なっていたら、何も変えない
        calls.length = 0;
        const again = await ok('add_notes', { track_id: 1, notes: [{ pitch: 'A#3', step: 0, length: 8 }] }, env);
        expect(again).toMatchObject({ added: 0, skipped: 1 });
        expect(again.summary).toMatch(/置くノートはありませんでした/);
        expect(calls).toEqual([]);
    });

    it('add_notes: だめな引数では、何も変えない', async () => {
        const { env, calls } = makeEnv();
        expect(await fail('add_notes', { track_id: 1, notes: [{ pitch: 'C4', step: 0, length: 4 }, { pitch: 'C4', step: -4, length: 4 }] }, env)).toMatch(/notes\[1\]/);
        expect(await fail('add_notes', { track_id: 1 }, env)).toMatch(/notes は、ノートの並び/);
        expect(await fail('add_notes', { track_id: 9, notes: eight }, env)).toMatch(/track_id 9/);
        expect(calls).toEqual([]);
    });

    it('remove_notes: 範囲に始まりが入っているノートを消す', async () => {
        const { env, calls, state } = makeEnv({ tracks: [track(1, 'Track 1', { pianoNotes: [note('C', 4, 0), note('E', 4, 32), note('G', 4, 40), note('C', 5, 64)] })] });
        const result = await ok('remove_notes', { track_id: 1, start_step: 32, end_step: 64 }, env);
        expect(result.summary).toBe('ノートを 2 個消しました（Track 1、3〜4 小節）');
        expect(state.tracks[0].pianoNotes).toEqual([note('C', 4, 0), note('C', 5, 64)]);
        expect(calls).toEqual(['notes 1 2 ノートを削除']);
        // 高さを絞る (フラットで来ても同じ高さとして扱う)
        expect((await ok('remove_notes', { track_id: 1, start_step: 0, end_step: 128, pitches: ['B#3'] }, env)).removed).toBe(1);
        calls.length = 0;
        expect((await ok('remove_notes', { track_id: 1, start_step: 16, end_step: 32 }, env)).summary).toBe('その範囲に、消すノートはありませんでした（Track 1、2 小節）');
        expect(calls).toEqual([]);
        expect(await fail('remove_notes', { track_id: 1, start_step: 16, end_step: 16 }, env)).toMatch(/end_step は start_step より大きく/);
        expect(await fail('remove_notes', { track_id: 1, start_step: 0, end_step: 16, pitches: [] }, env)).toMatch(/pitches を省いてください/);
        expect(await fail('remove_notes', { track_id: 1, start_step: 0, end_step: 16, pitches: ['Z1'] }, env)).toMatch(/読めません/);
    });

    it('replace_notes: 範囲の中を入れ替える。新しいノートは範囲の中で始める', async () => {
        const { env, calls, state } = makeEnv({ tracks: [track(1, 'Track 1', { pianoNotes: [note('C', 4, 0), note('E', 4, 4), note('G', 4, 16)] })] });
        const result = await ok('replace_notes', { track_id: 1, start_step: 0, end_step: 16, notes: [{ pitch: 'D4', step: 0, length: 4 }, { pitch: 'F#4', step: 4, length: 4 }, { pitch: 'A4', step: 12, length: 8 }] }, env);
        expect(result.summary).toBe('ノートを置き換えました（Track 1、1 小節。2 個 → 3 個）');
        expect(state.tracks[0].pianoNotes).toEqual([note('G', 4, 16), note('D', 4, 0), note('F#', 4, 4), note('A', 4, 12, 8)]);
        expect(calls).toEqual(['notes 1 ノートを置き換え']);
        expect(await fail('replace_notes', { track_id: 1, start_step: 0, end_step: 16, notes: [{ pitch: 'D4', step: 16, length: 4 }] }, env)).toMatch(/step 16 は範囲 \[0, 16\) の外/);
        expect(await fail('replace_notes', { track_id: 1, start_step: 0, end_step: 16 }, env)).toMatch(/notes を指定/);
        // 空の並びで、範囲を空にできる
        expect((await ok('replace_notes', { track_id: 1, start_step: 16, end_step: 32, notes: [] }, env)).summary).toBe('ノートを置き換えました（Track 1、2 小節。1 個 → 0 個）');
    });
});

describe('練習画面と MIDI 入力', () => {
    it('open_practice: パートのトラックだけ。開いたら、練習のトラックを返す', async () => {
        const { env, calls } = makeEnv({ tracks: [track(1, 'ベース', { role: 'part', referenceNotes: [note('C', 2, 0)] }), track(2, 'ドラム', { role: 'part' }), track(3, 'Track 1')] });
        expect(await fail('open_practice', { track_id: 3 }, env)).toMatch(/パートのトラックではありません。role が "part" のトラック.*1（ベース）/);
        expect(await fail('open_practice', { track_id: 2 }, env)).toMatch(/お手本が無い/);
        const result = await ok('open_practice', { track_id: 1 }, env);
        expect(result).toMatchObject({ summary: '「ベース」の練習画面を開きました（打ち込むのは「ベースの練習」）', part_track_id: 1, practice_track_id: 10 });
        expect(calls).toEqual(['practice 1']);
        expect((await ok('close_practice', {}, env)).summary).toBe('練習画面を閉じて、アレンジに戻りました');
        expect((await ok('close_practice', {}, env)).summary).toBe('練習画面は開いていません');
        expect(calls).toEqual(['practice 1', 'closePractice']);
    });

    it('open_practice: まだパートに分けていなければ、利用者が行うことを言う', async () => {
        expect(await fail('open_practice', { track_id: 1 }, makeEnv().env)).toMatch(/まだパートに分けていない.*パートに分けて採譜する/);
    });

    it('midi_input: つないで録り方を決め、見つかった鍵盤を返す', async () => {
        const { env, calls } = makeEnv();
        const result = await ok('midi_input', { action: 'connect', mode: 'realtime' }, env);
        expect(result).toMatchObject({ connected: true, devices: ['Keystation 49'], mode: 'realtime' });
        expect(result.summary).toBe('MIDI 入力をつなぎました（鍵盤: Keystation 49。録り方: リアルタイム録音）');
        // つないである間は、つなぎ直さない
        expect((await ok('midi_input', { action: 'connect' }, env)).mode).toBe('realtime');
        expect(calls).toEqual(['midi.connect', 'midi.setMode realtime']);
        expect((await ok('midi_input', { action: 'disconnect' }, env)).summary).toBe('MIDI 入力を止めました');
        expect((await ok('midi_input', { action: 'disconnect' }, env)).summary).toBe('MIDI 入力は、つないでいません');
    });

    it('midi_input: 使えない環境、開けなかったとき、だめな引数', async () => {
        expect(await fail('midi_input', { action: 'connect' }, makeEnv({ midi: null }).env)).toMatch(/MIDI 入力を使えません/);
        expect(await fail('midi_input', { action: 'connect' }, makeEnv({ midi: { available: false } }).env)).toMatch(/MIDI 入力を使えません/);
        expect(await fail('midi_input', { action: 'connect' }, makeEnv({ midi: { connect: async () => false } }).env)).toMatch(/開けませんでした/);
        const { env } = makeEnv();
        expect(await fail('midi_input', {}, env)).toMatch(/action を指定/);
        expect(await fail('midi_input', { action: 'open' }, env)).toMatch(/"connect" \/ "disconnect" のどれか/);
        expect(await fail('midi_input', { action: 'connect', mode: 'loop' }, env)).toMatch(/"off" \/ "step" \/ "realtime"/);
        expect(await fail('midi_input', { action: 'disconnect', mode: 'step' }, env)).toMatch(/action が "connect" のときだけ/);
    });
});

describe('runTool', () => {
    it('知らないツール・項目の表でない引数・途中の例外は、失敗の文にする（例外を外へ出さない）', async () => {
        const { env } = makeEnv();
        expect(await fail('make_song', {}, env)).toMatch(/「make_song」というツールはありません。使えるツール: get_project/);
        expect(await fail('seek', [3], env)).toMatch(/項目の名前と値の組/);
        expect(await fail('seek', 'bar 3', env)).toMatch(/項目の名前と値の組/);
        const broken = { ...env, stop: () => { throw new Error('壊れています'); } };
        expect(await fail('stop', {}, broken)).toBe('停止するの途中で問題が起きました（壊れています）');
        // 継承した名前 (toString など) を、ツールとして引かない
        expect(await fail('toString', {}, env)).toMatch(/というツールはありません/);
    });
});

describe('ノートの変形の計算', () => {
    const existing = [note('C', 4, 0), note('E', 4, 4, 4, 80), note('G', 4, 8), note('C', 5, 16)];
    const all = new Set([0, 1, 2, 3]);

    it('transposeNotes: 半音の数だけ移す。オクターブをまたぐ。強さと長さは変えない。元の並びは書き換えない', () => {
        const next = transposeNotes(existing, new Set([1, 2]), 12);
        expect(next.notes).toEqual([note('C', 4, 0), note('E', 5, 4, 4, 80), note('G', 5, 8), note('C', 5, 16)]);
        expect(next.changed).toEqual([1, 2]);
        expect(existing[1]).toEqual(note('E', 4, 4, 4, 80));
        expect(transposeNotes(existing, all, -1).notes.map((n) => `${n.note}${n.octave}`)).toEqual(['B3', 'D#4', 'F#4', 'B4']);
    });

    it('transposeNotes: 範囲（C0〜B8）の外に出るなら、変えずに失敗する', () => {
        expect(() => transposeNotes([note('C', 0, 0), note('C', 4, 4)], new Set([0, 1]), -1)).toThrow(/1 個のノートが、範囲（C0〜B8）の外に出ます（対象は C0〜C4）/);
        expect(() => transposeNotes([note('B', 8, 0)], new Set([0]), 1)).toThrow(ToolError);
        // 対象でないノートは、範囲の端に在ってもよい
        expect(transposeNotes([note('B', 8, 0), note('C', 4, 4)], new Set([1]), 12).changed).toEqual([1]);
    });

    it('shiftNotes: 後ろへ・前へずらす。1 小節目の頭より前と、長さの上限より後ろには出さない', () => {
        expect(shiftNotes(existing, new Set([2, 3]), 4, 128).notes.map((n) => n.step)).toEqual([0, 4, 12, 20]);
        expect(shiftNotes(existing, new Set([1, 2, 3]), -4, 128).changed).toEqual([1, 2, 3]);
        expect(() => shiftNotes(existing, new Set([1]), -5, 128)).toThrow(/前へずらせるのは 4 ステップまで/);
        expect(() => shiftNotes(existing, new Set([3]), 110, 128)).toThrow(/長さの上限（128 ステップ）/);
    });

    it('transformNotes: 変えた先が、変えないノートと同じ高さ・同じ位置になったら、まとめる', () => {
        // E4@4 を 4 つ前へ → C4@0 とは高さが違うので残る。C4@4 を 4 つ前へ → C4@0 と重なるので、まとめる
        const next = shiftNotes([note('C', 4, 0), note('C', 4, 4), note('E', 4, 4)], new Set([1, 2]), -4, 128);
        expect(next.notes).toEqual([note('C', 4, 0), note('E', 4, 0)]);
        expect(next.merged).toBe(1);
        expect(next.changed).toEqual([1]);
        // 変えても同じだったノートは、数えるだけ
        const same = transformNotes(existing, all, (n) => n);
        expect(same).toMatchObject({ changed: [], unchanged: 4, merged: 0 });
        expect(same.notes).toEqual(existing);
    });

    it('quantizeNotes: 位置を間隔の倍数にそろえる（近いほうへ。真ん中は後ろへ）。長さは、頼まれたときだけ', () => {
        const loose = [note('C', 4, 1), note('D', 4, 2), note('E', 4, 3), note('F', 4, 7, 3), note('G', 4, 8, 1)];
        const next = quantizeNotes(loose, new Set([0, 1, 2, 3, 4]), 4);
        expect(next.notes.map((n) => n.step)).toEqual([0, 4, 4, 8, 8]);
        expect(next.notes.map((n) => n.length)).toEqual([4, 4, 4, 3, 1]);
        expect(next.unchanged).toBe(1);
        expect(quantizeNotes(loose, new Set([3, 4]), 4, true).notes.slice(3).map((n) => n.length)).toEqual([4, 4]);
        // 2 つのノートが同じ位置に寄ったら、1 つにまとめる
        expect(quantizeNotes([note('C', 4, 3), note('C', 4, 5)], new Set([0, 1]), 4)).toMatchObject({ merged: 1, notes: [note('C', 4, 4)] });
    });

    it('setVelocity: その強さにする・足す・なだらかに変える。1〜127 に収める', () => {
        expect(setVelocity(existing, new Set([0, 1]), { velocity: 100 }).notes.slice(0, 2).map((n) => n.velocity)).toEqual([100, 100]);
        // 強さを持たないノートは、既定の 96 から
        const louder = setVelocity(existing, all, { delta: 40 });
        expect(louder.notes.map((n) => n.velocity)).toEqual([127, 120, 127, 127]);
        expect(louder.clamped).toBe(3);
        // 位置 0 → 16 へ、60 から 124 へ (位置 4 は 76、位置 8 は 92)
        expect(setVelocity(existing, all, { velocity: 60, endVelocity: 124 }).notes.map((n) => n.velocity)).toEqual([60, 76, 92, 124]);
        // もうその強さのノートは、変わらない
        expect(setVelocity(existing, new Set([1]), { velocity: 80 })).toMatchObject({ changed: [], unchanged: 1 });
    });

    it('repeatNotes: 範囲のノートを、後ろへくり返して置く。同じ高さ・同じ位置には重ねない', () => {
        const phrase = [note('C', 2, 0), note('G', 2, 8, 8)];
        const next = repeatNotes(phrase, new Set([0, 1]), 0, 16, 16, 2, 128);
        expect(next.notes.map((n) => n.step)).toEqual([0, 8, 16, 24, 32, 40]);
        expect(next.added).toEqual([2, 3, 4, 5]);
        // もう一度同じことをしても、増えない
        expect(repeatNotes(next.notes, new Set([0, 1]), 0, 16, 16, 2, 128)).toMatchObject({ added: [], skipped: 4 });
        expect(() => repeatNotes(phrase, new Set([0, 1]), 0, 16, 16, 8, 128)).toThrow(/長さの上限/);
    });
});

describe('ノートの変形のツール', () => {
    const bass = () => track(1, 'ベース', { pianoNotes: [note('C', 2, 0), note('E', 2, 4), note('G', 2, 16), note('C', 3, 20)] });

    it('transpose_notes: 範囲のノートだけを移し、変えたノートを光らせる', async () => {
        const { env, state, calls } = makeEnv({ tracks: [bass()] });
        const result = await ok('transpose_notes', { track_id: 1, start_step: 0, end_step: 16, semitones: 12 }, env);
        expect(result.summary).toBe('ノートを 2 個、+12 半音（1 オクターブ上）に移しました（ベース、1 小節）');
        expect(result).toMatchObject({ changed: 2, unchanged: 0, merged: 0, note_count: 4 });
        expect(state.tracks[0].pianoNotes.map((n) => `${n.note}${n.octave}`)).toEqual(['C3', 'E3', 'G2', 'C3']);
        expect(calls).toEqual(['notes 1 ノートを移調', 'flash 1 0,1']);
    });

    it('範囲を省くと、トラックの全部。pitches で高さを絞れる', async () => {
        const { env, state } = makeEnv({ tracks: [bass()] });
        expect((await ok('transpose_notes', { track_id: 1, semitones: -5 }, env)).summary).toMatch(/4 個、−5 半音に移しました（ベース、全部）/);
        expect((await ok('shift_notes', { track_id: 1, pitches: ['G1', 'G2'], steps: 4 }, env)).summary).toBe('ノートを 2 個、1 拍後ろへずらしました（ベース、全部）');
        expect(state.tracks[0].pianoNotes.map((n) => n.step)).toEqual([4, 4, 16, 24]);
    });

    it('selected_only: ピアノロールで選んでいるノートだけを変える', async () => {
        const { env, state } = makeEnv({ tracks: [bass(), track(2, 'Track 2', { pianoNotes: [note('C', 4, 0)] })], selection: { trackId: 1, indices: [1, 3] } });
        const result = await ok('set_velocity', { track_id: 1, selected_only: true, velocity: 110 }, env);
        expect(result.summary).toBe('ノート 2 個の強さを、110 にしました（ベース、選んでいるノート（1〜2 小節））');
        expect(state.tracks[0].pianoNotes.map((n) => n.velocity)).toEqual([undefined, 110, undefined, 110]);
        // 選んでいるのは別のトラック
        expect(await fail('transpose_notes', { track_id: 2, selected_only: true, semitones: 1 }, env)).toMatch(/別のトラック（track_id 1）/);
        // 何も選んでいない
        expect(await fail('shift_notes', { track_id: 1, selected_only: true, steps: 1 }, makeEnv({ tracks: [bass()] }).env)).toMatch(/選んでいるノートはありません/);
    });

    it('remove_notes: selected_only なら、範囲を省いて、選んでいるノートを消す', async () => {
        const { env, state, calls } = makeEnv({ tracks: [bass()], selection: { trackId: 1, indices: [0, 2] } });
        const result = await ok('remove_notes', { track_id: 1, selected_only: true }, env);
        expect(result).toMatchObject({ removed: 2, note_count: 2 });
        expect(state.tracks[0].pianoNotes.map((n) => n.step)).toEqual([4, 20]);
        expect(calls).toEqual(['notes 1 2 ノートを削除']);
    });

    it('対象のノートが無ければ、何も変えずに失敗する（成功として返さない）', async () => {
        const { env, calls } = makeEnv({ tracks: [bass()] });
        expect(await fail('transpose_notes', { track_id: 1, start_step: 64, end_step: 80, semitones: 2 }, env)).toMatch(/対象のノートがありません（ベース、5 小節）/);
        expect(await fail('quantize_notes', { track_id: 1, pitches: ['A4'], grid_steps: 4 }, env)).toMatch(/高さ A4/);
        expect(calls).toEqual([]);
    });

    it('量の確かめ: 0・範囲の外・使えない間隔は、直し方の分かる文で失敗する', async () => {
        const { env, calls } = makeEnv({ tracks: [bass()] });
        expect(await fail('transpose_notes', { track_id: 1, semitones: 0 }, env)).toMatch(/semitones が 0 です/);
        expect(await fail('transpose_notes', { track_id: 1, semitones: 60 }, env)).toMatch(/48 以下/);
        expect(await fail('shift_notes', { track_id: 1, steps: -1 }, env)).toMatch(/前へずらせるのは 0 ステップまで/);
        expect(await fail('quantize_notes', { track_id: 1, grid_steps: 3 }, env))
            .toMatch(/0\.5（32 分音符）・0\.6667（16 分の三連）・1（16 分音符）・1\.3333（8 分の三連）・2（8 分音符）・4（4 分音符）・8（2 分音符）・16（全音符） のどれか/);
        expect(await fail('quantize_notes', { track_id: 1, grid_steps: '4' }, env)).toMatch(/grid_steps は数で指定/);
        expect(await fail('shift_notes', { track_id: 1, steps: '1' }, env)).toMatch(/steps は数で指定/);
        expect(await fail('set_velocity', { track_id: 1 }, env)).toMatch(/velocity（1〜127。その強さにする）か、delta/);
        expect(await fail('set_velocity', { track_id: 1, velocity: 90, delta: 5 }, env)).toMatch(/どちらか一方/);
        expect(await fail('set_velocity', { track_id: 1, end_velocity: 90 }, env)).toMatch(/velocity と一緒に/);
        expect(await fail('repeat_notes', { track_id: 1, start_step: 0, end_step: 16, times: 99 }, env)).toMatch(/32 以下/);
        expect(calls).toEqual([]);
    });

    it('quantize_notes: もう合っていれば、何も変えずにそう言う', async () => {
        const { env, calls } = makeEnv({ tracks: [bass()] });
        const result = await ok('quantize_notes', { track_id: 1, grid_steps: 4 }, env);
        expect(result.summary).toBe('対象の 4 個は、もう4 分音符の位置に合っています（ベース、全部）');
        expect(calls).toEqual([]);
    });

    it('quantize_notes: 16 分・32 分・三連にそろえられる（三連は、小数で渡された間隔を読む）', async () => {
        // 16 分音符の裏と、32 分音符の位置に在るノート
        const loose = () => track(1, 'ベース', { pianoNotes: [note('C', 2, 0), note('E', 2, 1.4), note('G', 2, 2.5), note('C', 3, 4.1)] });
        const sixteenth = makeEnv({ tracks: [loose()] });
        expect((await ok('quantize_notes', { track_id: 1, grid_steps: 1 }, sixteenth.env)).summary)
            .toBe('ノートを 3 個、16 分音符の位置にそろえました（ベース、全部。もう合っていた 1 個は、そのままです）');
        expect(sixteenth.state.tracks[0].pianoNotes.map((n) => n.step)).toEqual([0, 1, 3, 4]);

        const thirtySecond = makeEnv({ tracks: [loose()] });
        expect(await ok('quantize_notes', { track_id: 1, grid_steps: 0.5 }, thirtySecond.env)).toMatchObject({ changed: 2, unchanged: 2, grid_steps: 0.5 });
        expect(thirtySecond.state.tracks[0].pianoNotes.map((n) => n.step)).toEqual([0, 1.5, 2.5, 4]);

        // 8 分の三連: ストレートの 8 分（0・2・4…）を、三連の位置（0・1.33・2.67・4…）へ
        const triplet = makeEnv({ tracks: [track(1, 'ベース', { pianoNotes: [note('C', 2, 0, 2), note('E', 2, 2, 2), note('G', 2, 4, 2), note('C', 3, 6, 2)] })] });
        const result = await ok('quantize_notes', { track_id: 1, grid_steps: 1.3333, lengths: true }, triplet.env);
        expect(result.summary).toBe('ノートを 4 個、8 分の三連の位置と長さにそろえました（ベース、全部）');
        expect(result.grid_steps).toBe(1.3333);
        // 位置 2 は、1.33 と 2.67 のちょうど真ん中なので後ろ（2.67）へ。6 → 6.67。長さ 2 も、三連 1 つぶんと 2 つぶんの真ん中なので 2 つぶん（2.67）
        expect(triplet.state.tracks[0].pianoNotes).toEqual([
            note('C', 2, 0, 8 / 3), note('E', 2, 8 / 3, 8 / 3), note('G', 2, 4, 8 / 3), note('C', 3, 20 / 3, 8 / 3),
        ]);
        // 16 分の三連（0.6667）
        const fine = makeEnv({ tracks: [track(1, 'ベース', { pianoNotes: [note('C', 2, 0.6), note('E', 2, 1.4)] })] });
        expect((await ok('quantize_notes', { track_id: 1, grid_steps: 0.6667 }, fine.env)).summary).toMatch(/16 分の三連の位置にそろえました/);
        expect(fine.state.tracks[0].pianoNotes.map((n) => n.step)).toEqual([2 / 3, 4 / 3]);
    });

    it('小数のステップ: 三連のノートを置き、範囲に入れ、ずらし、くり返し、読める', async () => {
        const { env, state } = makeEnv({ tracks: [track(1, 'ベース')] });
        // 1 拍目に、8 分の三連を 3 つ（4 桁の小数で渡される）
        const placed = await ok('add_notes', { track_id: 1, notes: [
            { pitch: 'C2', step: 0, length: 1.3333 }, { pitch: 'E2', step: 1.3333, length: 1.3333 }, { pitch: 'G2', step: 2.6667, length: 1.3333 },
        ] }, env);
        expect(placed.summary).toBe('ノートを 3 個置きました（ベース、1 小節）');
        expect(state.tracks[0].pianoNotes.map((n) => n.step)).toEqual([0, 4 / 3, 8 / 3]);
        // 同じ位置を、桁の違う小数で渡されても、二重に置かない
        expect(await ok('add_notes', { track_id: 1, notes: [{ pitch: 'E2', step: 1.33333, length: 1 }] }, env)).toMatchObject({ added: 0, skipped: 1 });

        // 読むと、4 桁の小数で返る
        expect((await ok('get_notes', { track_id: 1 }, env)).notes).toEqual([
            { pitch: 'C2', step: 0, length: 1.3333 }, { pitch: 'E2', step: 1.3333, length: 1.3333 }, { pitch: 'G2', step: 2.6667, length: 1.3333 },
        ]);

        // 範囲 [1.3333, 2.6667) には、2 つ目だけが入る（終わりちょうどで始まる 3 つ目は入らない）
        expect(await ok('transpose_notes', { track_id: 1, start_step: 1.3333, end_step: 2.6667, semitones: 12 }, env)).toMatchObject({ changed: 1 });
        expect(state.tracks[0].pianoNotes.map((n) => `${n.note}${n.octave}`)).toEqual(['C2', 'E3', 'G2']);

        // 三連 1 つぶん、後ろへ
        const shifted = await ok('shift_notes', { track_id: 1, steps: 1.3333 }, env);
        expect(shifted.summary).toBe('ノートを 3 個、8 分の三連符 1 個ぶん後ろへずらしました（ベース、全部）');
        expect(shifted.steps).toBe(1.3333);
        expect(state.tracks[0].pianoNotes.map((n) => n.step)).toEqual([4 / 3, 8 / 3, 4]);
        // 32 分音符 1 つぶん、前へ。整数のステップは、これまでどおりの言い方
        expect((await ok('shift_notes', { track_id: 1, steps: -0.5 }, env)).summary).toMatch(/32 分音符 1 個ぶん前へずらしました/);
        expect((await ok('shift_notes', { track_id: 1, steps: 0.5 }, env)).summary).toMatch(/32 分音符 1 個ぶん後ろへ/);
        expect((await ok('shift_notes', { track_id: 1, steps: 3 }, env)).summary).toMatch(/3 ステップ後ろへ/);
        expect(await fail('shift_notes', { track_id: 1, steps: -9 }, env)).toMatch(/前へずらせるのは 4\.3333 ステップまで/);

        // 1 拍ぶん（4 ステップ）を、すぐ後ろへくり返す。置いた先も、三連の位置
        const repeated = await ok('repeat_notes', { track_id: 1, start_step: 4, end_step: 8, times: 1 }, env);
        expect(repeated).toMatchObject({ added: 3, to_step: 8, end_step: 12 });
        expect(state.tracks[0].pianoNotes.map((n) => n.step)).toEqual([13 / 3, 17 / 3, 7, 25 / 3, 29 / 3, 11]);
        // どの値も、1/60 ステップの倍数（端数がたまっていない）
        for (const n of state.tracks[0].pianoNotes) expect(Math.round(n.step * 60) / 60).toBe(n.step);

        // 範囲で消す・置き換える
        expect(await ok('remove_notes', { track_id: 1, start_step: 8.3333, end_step: 9.6667 }, env)).toMatchObject({ removed: 1, note_count: 5 });
        const replaced = await ok('replace_notes', { track_id: 1, start_step: 4, end_step: 8, notes: [{ pitch: 'A2', step: 4.5, length: 0.5 }] }, env);
        expect(replaced.summary).toBe('ノートを置き換えました（ベース、1 小節。3 個 → 1 個）');
        expect(state.tracks[0].pianoNotes.map((n) => n.step)).toEqual([29 / 3, 11, 4.5]);
        expect(await fail('remove_notes', { track_id: 1, start_step: 4, end_step: 4 }, env)).toMatch(/end_step は start_step より大きく/);
    });

    it('repeat_notes: 1〜1 小節のフレーズを、後ろへ 3 回くり返す', async () => {
        const { env, state, calls } = makeEnv({ tracks: [bass()] });
        const result = await ok('repeat_notes', { track_id: 1, start_step: 0, end_step: 16, times: 3 }, env);
        // 2 小節目の頭 (16) には、高さの違う G2 が在るので、重ならない
        expect(result).toMatchObject({ added: 6, skipped: 0, note_count: 10, to_step: 16, end_step: 64 });
        expect(result.summary).toBe('ベース、1 小節のノート 2 個を、3 回くり返して置きました（置いた先は 2〜4 小節、6 個）');
        expect(state.tracks[0].pianoNotes).toHaveLength(10);
        expect(calls).toEqual(['notes 1 ノートをくり返して置く', 'flash 1 4,5,6,7,8,9']);
        // 範囲は必須 (範囲の長さが、くり返す間隔になる)
        expect(await fail('repeat_notes', { track_id: 1 }, env)).toMatch(/start_step を指定してください/);
    });
});

describe('差分チェック（check_diff）', () => {
    const issue = (kind: DiffIssue['kind'], bar: number, beat: number, expected: PianoNote | null, actual: PianoNote | null, extra: Partial<DiffIssue> = {}): DiffIssue =>
        ({ kind, bar, beat, expected, actual, offset_steps: null, length_diff: null, ...extra });
    const tracks = () => [
        track(2, 'ベース', { role: 'part', part: 'bass', referenceNotes: [note('C', 2, 0), note('E', 2, 4), note('G', 2, 16), note('C', 3, 36)] }),
        track(3, 'ベースの練習', { role: 'practice', practiceOf: 2, pianoNotes: [note('C', 2, 0), note('F', 2, 4), note('G', 2, 18)] }),
        track(4, 'ドラム', { role: 'part', part: 'drums', referenceNotes: [note('C', 2, 0)] }),
        track(5, 'Track 1', { pianoNotes: [note('C', 4, 0)] }),
    ];
    const found = diffResult([
        issue('pitch', 1, 2, note('E', 2, 4), note('F', 2, 4)),
        issue('timing', 2, 1, note('G', 2, 16), note('G', 2, 18), { offset_steps: 2 }),
        issue('missing', 3, 2, note('C', 3, 36), null),
    ]);

    it('練習のトラックを渡すと、そのパートのお手本と比べる。事実を、決まった型の文と一緒に返す', async () => {
        const { env, state } = makeEnv({ tracks: tracks(), diff: found });
        const result = await ok('check_diff', { track_id: 3 }, env);
        expect(result.summary).toBe('お手本と比べました（ベースの練習、曲全体。一致 75%、違い 3 件）');
        expect(result).toMatchObject({
            track_id: 3, reference_track_id: 2, range: '曲全体', match_percent: 75, reference_count: 8, attempt_count: 7, exact: 5,
            counts: { missing: 1, pitch: 1, octave: 0, extra: 0, timing: 1, length: 0 },
            worst_bars: [1, 2, 3], issue_count: 3, shown_on_screen: false,
        });
        expect(result.issues).toEqual([
            { kind: 'pitch', bar: 1, beat: 2, text: '1 小節 2 拍目: F2 → お手本は E2', expected: { pitch: 'E2', step: 4, length: 4 }, actual: { pitch: 'F2', step: 4, length: 4 } },
            { kind: 'timing', bar: 2, beat: 1, text: '2 小節 1 拍目: G2 が16 分音符 2 個ぶん遅い', expected: { pitch: 'G2', step: 16, length: 4 }, actual: { pitch: 'G2', step: 18, length: 4 }, offset_steps: 2 },
            { kind: 'missing', bar: 3, beat: 2, text: '3 小節 2 拍目: C3 が抜けています', expected: { pitch: 'C3', step: 36, length: 4 } },
        ]);
        // お手本の全部と、打ち込みの全部を送る。採譜したお手本なので、強さは比べない
        expect(state.diffCalls).toHaveLength(1);
        expect(state.diffCalls[0]).toMatchObject({ perBar: 16, source: 'transcription' });
        // ドラムのパートでなければ、比べ方は指定しない (ふつうの比べ方)
        expect(state.diffCalls[0].mode).toBeUndefined();
        expect(result.comparison).toBeUndefined();
        expect(state.diffCalls[0].reference).toHaveLength(4);
        expect(state.diffCalls[0].attempt).toHaveLength(3);
    });

    it('ドラムのパートは、ドラムの比べ方で比べる。指摘は、種類の名前で返す', async () => {
        const drumDiff = diffResult([
            issue('missing', 1, 1, note('C', 2, 0, 1), null),
            issue('timing', 1, 2, note('D', 2, 4, 1), note('D', 2, 5, 4), { offset_steps: 1 }),
            issue('extra', 1, 3, null, note('E', 2, 8, 4)),
        ]);
        const { env, state } = makeEnv({
            tracks: [
                track(4, 'ドラム', { role: 'part', part: 'drums', referenceNotes: [note('C', 2, 0, 1), note('D', 2, 4, 1), note('F#', 2, 0, 1)] }),
                track(6, 'ドラムの練習', { role: 'practice', part: 'drums', practiceOf: 4, pianoNotes: [note('D', 2, 5), note('E', 2, 8), note('F#', 2, 0)] }),
            ],
            diff: drumDiff,
        });
        const result = await ok('check_diff', { track_id: 6 }, env);
        expect(result.reference_track_id).toBe(4);
        expect(state.diffCalls[0]).toMatchObject({ source: 'transcription', mode: 'drums' });
        // 比べ方の説明を添える (Claude が、高さを音の高さとして読まないように)
        expect(result.comparison).toMatch(/only where each kind of drum is hit is compared/);
        expect(result.comparison).toMatch(/C2 = キック, D2 = スネア, F#2 = ハイハット・シンバル, A2 = タム/);
        expect(result.issues).toEqual([
            { kind: 'missing', bar: 1, beat: 1, text: '1 小節 1 拍目: キック が抜けています', expected: { pitch: 'C2', drum: 'キック', step: 0, length: 1 } },
            { kind: 'timing', bar: 1, beat: 2, text: '1 小節 2 拍目: スネア が16 分音符 1 個ぶん遅い', expected: { pitch: 'D2', drum: 'スネア', step: 4, length: 1 }, actual: { pitch: 'D2', drum: 'スネア', step: 5, length: 4 }, offset_steps: 1 },
            // ドラムの行でない高さは、音名のまま
            { kind: 'extra', bar: 1, beat: 3, text: '1 小節 3 拍目: E2 はお手本にありません', actual: { pitch: 'E2', step: 8, length: 4 } },
        ]);
    });

    it('小節の範囲を渡すと、その中で始まるノートだけを比べる', async () => {
        const { env, state } = makeEnv({ tracks: tracks(), diff: found });
        const result = await ok('check_diff', { track_id: 3, start_bar: 2, end_bar: 3 }, env);
        expect(result.range).toBe('2〜3 小節');
        expect(state.diffCalls[0].reference.map((n) => n.step)).toEqual([16, 36]);
        expect(state.diffCalls[0].attempt.map((n) => n.step)).toEqual([18]);
        // お手本の無い範囲
        expect(await fail('check_diff', { track_id: 3, start_bar: 9, end_bar: 12 }, env)).toMatch(/9〜12 小節）には、お手本のノートがありません/);
        expect(await fail('check_diff', { track_id: 3, start_bar: 4, end_bar: 2 }, env)).toMatch(/end_bar は start_bar 以上/);
    });

    it('練習画面と同じ範囲なら、画面の「比べる」を通す（ノートに色が付く）。違う範囲なら、通さない', async () => {
        const { env, state, calls } = makeEnv({ tracks: tracks(), diff: found });
        state.practice = { open: true, partId: 2, trackId: 3 };
        state.settings = { loop: { startBar: 1, endBar: 2, enabled: true }, speed: 1, listen: 'both', showGhost: true };
        state.screenDiff = diffResult([issue('pitch', 1, 2, note('E', 2, 4), note('F', 2, 4))], { accuracy: 0.5 });
        // 範囲を省くと、画面と同じ範囲 (区間ループ)
        const onScreen = await ok('check_diff', { track_id: 3 }, env);
        expect(onScreen.summary).toBe('お手本と比べました（ベースの練習、1〜2 小節。一致 50%、違い 1 件）。違うノートに色を付けました');
        expect(onScreen.shown_on_screen).toBe(true);
        expect(calls).toEqual(['practiceCompare']);
        // 違う範囲は、画面を通さずに計算だけする
        calls.length = 0;
        const other = await ok('check_diff', { track_id: 3, start_bar: 3, end_bar: 3 }, env);
        expect(other.shown_on_screen).toBe(false);
        expect(calls).toEqual(['diff']);
        // 画面が比べられなかったら、計算に回す
        calls.length = 0;
        state.screenDiff = null;
        expect((await ok('check_diff', { track_id: 3, start_bar: 1, end_bar: 2 }, env)).shown_on_screen).toBe(false);
        expect(calls).toEqual(['practiceCompare', 'diff']);
    });

    it('お手本が無い・分からない・以前の分け方のドラムのときは、次にどうすればよいかを返す', async () => {
        const { env, calls } = makeEnv({ tracks: [...tracks(), track(7, '古いドラム', { role: 'part', part: 'drums', pianoNotes: [note('C', 2, 0, 1)] })] });
        expect(await fail('check_diff', { track_id: 5 }, env)).toMatch(/比べるお手本が分かりません。reference_track_id で.*2（ベース）、4（ドラム）/);
        // 以前の分け方のドラム (お手本を持たない) は、分け直すと比べられる、と返す
        expect(await fail('check_diff', { track_id: 7 }, env)).toMatch(/以前の分け方で作ったドラムのパートで、お手本を持っていません.*separate_parts/);
        expect(await fail('check_diff', { track_id: 5, reference_track_id: 7 }, env)).toMatch(/以前の分け方で作ったドラム/);
        expect(await fail('check_diff', { track_id: 5, reference_track_id: 99 }, env)).toMatch(/reference_track_id 99 のトラックはありません/);
        expect(await fail('check_diff', { track_id: 1 }, makeEnv().env)).toMatch(/お手本は、利用者が曲をパートに分けるか/);
        expect(calls).toEqual([]);
        // お手本を指定すれば、自由に作ったトラックとも比べられる
        expect((await ok('check_diff', { track_id: 5, reference_track_id: 2 }, env)).reference_track_id).toBe(2);
    });

    it('MIDI ファイルから読み込んだお手本なら、強さの違いも返す。指摘が多すぎれば、頭から決まった数まで', async () => {
        const many = Array.from({ length: MAX_ISSUES + 5 }, (_v, i) => issue('extra', 1 + Math.floor(i / 4), 1, null, note('C', 4, i)));
        const withVelocity: DiffResult = {
            ...diffResult(many),
            velocity: {
                tolerance: 20, default_velocity: 96, compared: 24, weaker: 6, stronger: 0, attempt_unset: 0, median_diff: -30,
                reference: { min: 60, max: 120, median: 100 }, attempt: { min: 60, max: 70, median: 64 },
                findings: [{ kind: 'overall', direction: 'weaker', start_bar: 1, end_bar: 4, count: 6, compared: 24, median_diff: -30, notes: [] }],
                notes: [],
            },
        };
        const midiTracks = [track(2, 'お手本', { role: 'part', part: 'midi', referenceNotes: [note('C', 4, 0)], pianoNotes: [note('C', 4, 0)] })];
        const { env, state } = makeEnv({ tracks: midiTracks, diff: withVelocity });
        const result = await ok('check_diff', { track_id: 2 }, env);
        expect(state.diffCalls[0].source).toBe('midi');
        expect(result.issues).toHaveLength(MAX_ISSUES);
        expect(result).toMatchObject({ issue_count: MAX_ISSUES + 5, issues_truncated: true });
        expect(result.velocity).toEqual({
            summary: '合った 24 ノートの強さを比べました（お手本より弱い 6）',
            findings: ['全体に弱い: 合った 24 ノートのうち 6 ノートが、お手本より弱くなっています（強さの差は 30 ほど）'],
        });
    });
});

describe('学ぶ流れのツール', () => {
    const chart = { key: { tonic: 'C', mode: 'major', confidence: 0.9 }, grid: { bpm: 120, time_signature: [4, 4] }, sections: [{ id: 's1', label: 'A', suggested_label: null, start_bar: 1, end_bar: 8, repeat_group: 'A' }], chords: [] } as unknown as SongChart;

    it('get_guide: 保存済みのガイドを読む。無ければ、作り方を返す（アシスタントからは作らない）', async () => {
        const none = makeEnv({ chart });
        const missing = await ok('get_guide', {}, none.env);
        expect(missing).toMatchObject({ saved: false, summary: '保存済みの再現ガイドは、まだありません（曲全体）' });
        expect(missing.how_to_create).toMatch(/「学ぶ」→「ガイド」/);
        expect(none.calls).toEqual(['guide chart-1 null']);

        const guide = { overview: '全体の流れ', steps: [{ title: 'テンポ', topic: 'grid', body: '120 に合わせます', refs: [{ section_id: 's1', bar: 1, beat: 1 }] }], cautions: ['キーの確信度が低め'], dropped_refs: 0, unverified_terms: [] };
        const saved = makeEnv({ chart, guide: { saved: true, chart_id: 'chart-1', focus: 's1', guide, model: 'claude-opus-5-5', usage: {} } as SavedGuideResponse });
        const result = await ok('get_guide', { section_id: 's1' }, saved.env);
        expect(result).toMatchObject({ saved: true, summary: '保存済みの再現ガイドを読みました（構成の区間 s1、手順 1 個）', overview: '全体の流れ', cautions: ['キーの確信度が低め'] });
        expect(result.steps).toEqual([{ title: 'テンポ', topic: 'grid', body: '120 に合わせます', refs: [{ section_id: 's1', bar: 1, beat: 1 }] }]);
        expect(saved.calls).toEqual(['guide chart-1 s1']);
    });

    it('get_guide: カルテが無い・知らない区間は失敗する', async () => {
        expect(await fail('get_guide', {}, makeEnv().env)).toMatch(/まだカルテがありません/);
        expect(await fail('get_guide', { section_id: 'zz' }, makeEnv({ chart }).env)).toMatch(/get_chart の sections の id のどれか.*s1/);
    });

    it('set_practice: 区間・速度・聴くを変える。範囲を渡すと、区間ループが入る', async () => {
        const { env, state, calls } = makeEnv({ tracks: [track(2, 'ベース', { role: 'part', referenceNotes: [note('C', 2, 0)] })] });
        await ok('open_practice', { track_id: 2 }, env);
        state.settings = { loop: { startBar: 1, endBar: 4, enabled: false }, speed: 1, listen: 'both', showGhost: true };
        calls.length = 0;
        const result = await ok('set_practice', { loop_start_bar: 5, loop_end_bar: 8, speed_percent: 75, listen: 'part' }, env);
        expect(result.summary).toBe('練習の設定を変えました（区間ループ 5〜8 小節、速度 75%、聴く: パート）');
        expect(result).toMatchObject({ loop: { start_bar: 5, end_bar: 8, enabled: true }, speed_percent: 75, listen: 'part', show_reference: true });
        expect(result.note).toBeUndefined();
        expect(calls).toEqual(['practice {"loop":{"startBar":5,"endBar":8,"enabled":true},"speed":0.75,"listen":"part"}']);
        // 始まりだけを動かしたら、長さは変えない
        expect((await ok('set_practice', { loop_start_bar: 9 }, env)).loop).toEqual({ start_bar: 9, end_bar: 12, enabled: true });
        // 区間ループを止めると、速度は効かない (その旨を添える)
        const off = await ok('set_practice', { loop: false }, env);
        expect(off.summary).toBe('練習の設定を変えました（区間ループを止める）');
        expect(off.note).toMatch(/速度は、区間ループの中で効きます/);
        // 同じ設定なら、何もしない
        calls.length = 0;
        expect((await ok('set_practice', { listen: 'part', show_reference: true }, env)).summary).toBe('練習の設定は、すでにそのとおりです');
        expect(calls).toEqual([]);
    });

    it('set_practice: 練習画面を開いていない・範囲がおかしい・使えない速度は失敗する', async () => {
        const closed = makeEnv();
        expect(await fail('set_practice', { speed_percent: 75 }, closed.env)).toMatch(/練習画面を開いていません.*open_practice/);
        const { env, calls } = makeEnv({ tracks: [track(2, 'ベース', { role: 'part', referenceNotes: [note('C', 2, 0)] })] });
        await ok('open_practice', { track_id: 2 }, env);
        calls.length = 0;
        expect(await fail('set_practice', {}, env)).toMatch(/変える項目を 1 つ以上/);
        expect(await fail('set_practice', { speed_percent: 80 }, env)).toMatch(/50・60・75・90・100 のどれか/);
        expect(await fail('set_practice', { loop_start_bar: 8, loop_end_bar: 5 }, env)).toMatch(/loop_end_bar は loop_start_bar 以上/);
        expect(await fail('set_practice', { loop_start_bar: 1, loop_end_bar: 40 }, env)).toMatch(/32 小節までです/);
        expect(calls).toEqual([]);
    });

    it('set_metronome: 入れる・止める。すでにそうなら、何もしない', async () => {
        const { env, calls } = makeEnv();
        expect((await ok('set_metronome', { on: true }, env)).summary).toMatch(/^メトロノームを入れました/);
        expect((await ok('set_metronome', { on: true }, env)).summary).toBe('メトロノームは、すでに入っています');
        expect((await ok('set_metronome', { on: false }, env)).summary).toBe('メトロノームを止めました');
        expect(calls).toEqual(['metronome true', 'metronome false']);
        expect(await fail('set_metronome', { on: 'yes' }, env)).toMatch(/true か false/);
    });

    it('show_in_app: 場所を示し、どこに在るかの文を返す。出ていなければ、出る条件を返す', async () => {
        const { env, calls } = makeEnv();
        const result = await ok('show_in_app', { target: 'import_song' }, env);
        expect(result).toMatchObject({ summary: '「曲を取り込む」の場所を示しました', target: 'import_song', label: '曲を取り込む', shown: true });
        expect(result.where).toMatch(/「学ぶ」→「曲とパート」/);
        expect(result.when).toBeUndefined();
        expect(calls).toEqual(['point import_song']);
        const hidden = await ok('show_in_app', { target: 'practice_speed' }, makeEnv({ shown: false }).env);
        expect(hidden).toMatchObject({ summary: '「速度」は、いまは画面に出ていません', shown: false, when: '練習画面を開いているあいだだけ出ます' });
        // 練習画面のあいだは、左のパネルの場所が隠れている (その場所の出る条件より、こちらを先に言う)
        const inPractice = makeEnv({ shown: false, tracks: [track(2, 'ベース', { role: 'part', referenceNotes: [note('C', 2, 0)] })] });
        await ok('open_practice', { track_id: 2 }, inPractice.env);
        expect((await ok('show_in_app', { target: 'practice_part' }, inPractice.env)).when).toMatch(/練習画面のあいだは、左のパネルが隠れています/);
        expect((await ok('show_in_app', { target: 'add_track' }, inPractice.env)).when).toBe('トラックが 1 本も無いあいだと、練習画面のあいだは出ません');
        expect((await ok('show_in_app', { target: 'play' }, makeEnv({ shown: false }).env)).when).toBe('いまの画面には出ていません');
        expect(await fail('show_in_app', { target: 'nowhere' }, env)).toMatch(/target は .*"import_song".* のどれか/);
    });
});

describe('アプリのツール（処理・書き出し・保存・クリップ・エフェクト）', () => {
    const running: ToolJob = { id: 'j1', title: 'パート分離と採譜', filename: 'song.wav', state: 'running', stage: 'パートに分けています', progress: 0.4, elapsedSec: 80, cancelRequested: false };
    const song = () => track(1, '原曲', { role: 'song', clips: [clip('song.wav', 0, 60)] });

    it('get_job / cancel_job: 動いている処理を読む・中止を頼む', async () => {
        const idle = makeEnv();
        expect(await ok('get_job', {}, idle.env)).toMatchObject({ running: false, summary: 'いま動いている、時間のかかる処理はありません' });
        expect((await ok('cancel_job', {}, idle.env)).summary).toMatch(/中止する処理はありません/);
        expect(idle.calls).toEqual([]);
        const busy = makeEnv({ job: running });
        expect(await ok('get_job', {}, busy.env)).toMatchObject({
            running: true, summary: '動いている処理: パート分離と採譜: パートに分けています（40%、1 分 20 秒）',
            title: 'パート分離と採譜', filename: 'song.wav', state: 'running', stage: 'パートに分けています', progress_percent: 40, elapsed_seconds: 80,
        });
        expect((await ok('cancel_job', {}, busy.env)).summary).toBe('「パート分離と採譜」の中止を頼みました（区切りのよいところで止まります）');
        expect(busy.calls).toEqual(['cancelJob j1']);
    });

    it('separate_parts: 取り込んだ曲が在れば始めて、待たずに返す', async () => {
        const { env, calls } = makeEnv({ tracks: [song()], songFile: true });
        const result = await ok('separate_parts', {}, env);
        expect(result).toMatchObject({ started: true, sensitivity: 0.5 });
        expect(result.summary).toMatch(/パート分離と採譜を始めました（数分かかります/);
        expect(result.note).toMatch(/終わるのを待たずに/);
        expect(calls).toEqual(['separate 0.5']);
        await ok('separate_parts', { sensitivity: 0.8 }, env);
        expect(calls[1]).toBe('separate 0.8');
    });

    it('separate_parts: 曲が無い・ほかの処理が動いている・すでに分けてある・断られたときは、始めない', async () => {
        const none = makeEnv();
        expect(await fail('separate_parts', {}, none.env)).toMatch(/まだ曲を取り込んでいません.*import_song/);
        const reopened = makeEnv({ tracks: [song()] });
        expect(await fail('separate_parts', {}, reopened.env)).toMatch(/この画面では、まだ原曲のファイルを取り込んでいません/);
        const busy = makeEnv({ tracks: [song()], songFile: true, job: running });
        expect(await fail('separate_parts', {}, busy.env)).toMatch(/ほかの処理が動いています（パート分離と採譜: パートに分けています/);
        const split = makeEnv({
            tracks: [song(), track(2, 'ベース', { role: 'part', part: 'bass' }), track(3, 'ベースの練習', { role: 'practice', practiceOf: 2, pianoNotes: [note('C', 2, 0)] })],
            songFile: true,
        });
        expect(await fail('separate_parts', {}, split.env)).toMatch(/すでにパートに分けてあります（ベース）.*打ち込んだノートが在ります: ベースの練習 1 個.*replace_existing: true/);
        expect([...none.calls, ...reopened.calls, ...busy.calls, ...split.calls]).toEqual([]);
        // 利用者に確かめた後
        await ok('separate_parts', { replace_existing: true }, split.env);
        expect(split.calls).toEqual(['separate 0.5']);
        split.state.separation = { started: false, reason: '「a.wav」のカルテの作成を実行中です。終わるか、中止してから始めてください' };
        expect(await fail('separate_parts', { replace_existing: true }, split.env)).toMatch(/パート分離を始められませんでした。「a.wav」のカルテの作成を実行中/);
        expect(await fail('separate_parts', { sensitivity: 2 }, split.env)).toMatch(/0.1〜1 の範囲/);
    });

    it('export_wav / export_midi: 書き出す。書き出すものが無ければ、理由つきで失敗する', async () => {
        const { env, calls } = makeEnv({ tracks: [track(1, 'Track 1', { pianoNotes: [note('C', 4, 0)] })] });
        expect(await ok('export_wav', {}, env)).toMatchObject({ file_name: 'bunri_mix.wav', summary: 'WAV ファイルを書き出しました（bunri_mix.wav。「ダウンロード」フォルダに入ります）' });
        expect(await ok('export_midi', {}, env)).toMatchObject({ file_name: 'bunri.mid' });
        expect(calls).toEqual(['exportWav', 'exportMidi']);
        const empty = makeEnv();
        expect(await fail('export_wav', {}, empty.env)).toBe('書き出すものがありません。クリップかノートを置いてください');
        expect(await fail('export_midi', {}, empty.env)).toMatch(/書き出すノートがありません/);
    });

    it('save_project: 保存する。保存先の窓を閉じたら、保存しなかったと返す', async () => {
        const { env, state } = makeEnv();
        expect(await ok('save_project', {}, env)).toMatchObject({ summary: 'プロジェクトを保存しました（無題のプロジェクト）', name: '無題のプロジェクト' });
        const cancelled = makeEnv();
        cancelled.state.saves = false;
        expect(await fail('save_project', {}, cancelled.env)).toMatch(/保存しませんでした（保存先を選ぶ窓を閉じたか/);
        state.saves = false;
        expect(await fail('save_project', {}, env)).toMatch(/^保存できませんでした/);
    });

    it('move_clip / delete_clip / duplicate_clip: クリップを番号で指して操作する', async () => {
        const { env, calls } = makeEnv({ tracks: [track(1, 'ボーカル', { clips: [clip('take1.wav', 0, 4), clip('take2.wav', 8, 4)] }), track(2, 'Track 2')], bpm: 120 });
        // 120 BPM の 1 小節は 2 秒。3 小節目の頭は 4 秒
        const moved = await ok('move_clip', { track_id: 1, clip_index: 1, to_bar: 3 }, env);
        expect(moved).toMatchObject({ summary: 'クリップ「take2.wav」を、3 小節目の頭へ動かしました（ボーカル）', start_seconds: 4, previous_start_seconds: 8 });
        expect((await ok('move_clip', { track_id: 1, clip_index: 0, to_seconds: 1.5 }, env)).summary).toBe('クリップ「take1.wav」を、1.5 秒へ動かしました（ボーカル）');
        expect((await ok('move_clip', { track_id: 1, clip_index: 0, to_seconds: 1.5 }, env)).summary).toBe('クリップ「take1.wav」は、すでに 1.5 秒に在ります');
        // 複製は、すぐ後ろの番号に入る (take1 の複製が 1 番、take2 は 2 番へ)
        expect(await ok('duplicate_clip', { track_id: 1, clip_index: 0 }, env)).toMatchObject({
            summary: 'クリップ「take1.wav」を複製して、すぐ後ろ（5.5 秒から）に置きました（ボーカル）', new_clip_index: 1, start_seconds: 5.5,
        });
        // 消した後の数は、消す前に数えたもの (3 個から 1 個消して 2 個)
        expect(await ok('delete_clip', { track_id: 1, clip_index: 2 }, env)).toMatchObject({ summary: 'クリップ「take2.wav」を削除しました（ボーカル）', clip_count: 2 });
        expect(calls).toEqual(['moveClip 1 1 4', 'moveClip 1 0 1.5', 'duplicateClip 1 0', 'deleteClip 1 2']);
        calls.length = 0;
        expect(await fail('move_clip', { track_id: 1, clip_index: 0 }, env)).toMatch(/to_bar（小節の頭へ）か to_seconds（秒の位置へ）の、どちらか一方/);
        expect(await fail('move_clip', { track_id: 1, clip_index: 0, to_bar: 2, to_seconds: 3 }, env)).toMatch(/どちらか一方/);
        expect(await fail('delete_clip', { track_id: 1, clip_index: 5 }, env)).toMatch(/clip_index 5 のクリップはありません。在るのは: 0（take1.wav）、1（take1.wav）/);
        expect(await fail('delete_clip', { track_id: 2, clip_index: 0 }, env)).toMatch(/音声のクリップがありません/);
        expect(calls).toEqual([]);
    });

    it('get_project: 縮めた・フェードを付けたクリップには、音声の中の位置と全体の長さ、フェードの長さを添える', async () => {
        const { env } = makeEnv({
            tracks: [track(1, 'ボーカル', { clips: [
                clip('take1.wav', 4, 2, { buffer: { duration: 10 }, audioStart: 3, fadeIn: 0.5 }),
                clip('take2.wav', 8, 4, { buffer: { duration: 4 }, fadeOut: 1 }),
                clip('take3.wav', 12, 4, { buffer: { duration: 4 } }),
            ] })],
        });
        const result = await ok('get_project', {}, env);
        expect((result.tracks as { clips: unknown[] }[])[0].clips).toEqual([
            { index: 0, name: 'take1.wav', start_seconds: 4, duration_seconds: 2, start_bar: 3, audio_start_seconds: 3, audio_duration_seconds: 10, fade_in_seconds: 0.5 },
            { index: 1, name: 'take2.wav', start_seconds: 8, duration_seconds: 4, start_bar: 5, fade_out_seconds: 1 },
            { index: 2, name: 'take3.wav', start_seconds: 12, duration_seconds: 4, start_bar: 7 },
        ]);
    });

    it('trim_clip: 端の位置を秒か小節で指して、縮める・伸ばす。音声の端より外へは伸びない', async () => {
        // 10 秒の音声を、4 秒の位置に置いたクリップ (4〜14 秒)。120 BPM の 1 小節は 2 秒
        const { env, state, calls } = makeEnv({ tracks: [track(1, 'ボーカル', { clips: [clip('take1.wav', 4, 10, { buffer: { duration: 10 }, fadeOut: 3 })] }), track(2, 'Track 2')], bpm: 120 });
        const first = () => state.tracks[0].clips[0];
        // 左の端を 6 秒へ: 音の位置は動かず、音声の 2 秒目から鳴る
        expect(await ok('trim_clip', { track_id: 1, clip_index: 0, start_seconds: 6 }, env)).toMatchObject({
            summary: 'クリップ「take1.wav」を縮めました（6〜14 秒。ボーカル）',
            start_seconds: 6, end_seconds: 14, duration_seconds: 8, audio_start_seconds: 2, previous_start_seconds: 4, previous_end_seconds: 14,
        });
        expect(first()).toMatchObject({ offset: 6, duration: 8, audioStart: 2 });
        // 小節で: 4 小節目の頭 (6 秒) から 5 小節目の終わり (10 秒) まで
        expect((await ok('trim_clip', { track_id: 1, clip_index: 0, start_bar: 4, end_bar: 5 }, env)).summary).toBe('クリップ「take1.wav」を縮めました（6〜10 秒。ボーカル）');
        // フェードは、新しい長さに収まる (3 秒のまま、4 秒のクリップに入る)
        expect(first()).toMatchObject({ offset: 6, duration: 4, fadeOut: 3 });
        expect((await ok('trim_clip', { track_id: 1, clip_index: 0, end_seconds: 10 }, env)).summary).toBe('クリップ「take1.wav」は、すでにその範囲です（6〜10 秒）');
        // 音声の全体に戻す: 端は音声の端で止まり、そのことを返す
        const restored = await ok('trim_clip', { track_id: 1, clip_index: 0, start_seconds: 0, end_seconds: 60 }, env);
        expect(restored).toMatchObject({ summary: 'クリップ「take1.wav」を伸ばしました（4〜14 秒。ボーカル）。音声の端より外へは伸ばせないので、端で止めました', stopped_at_audio_edge: true, audio_start_seconds: 0 });
        expect(first().audioStart).toBeUndefined();
        expect(calls).toEqual(['trimClip 1 0 {"start":6}', 'trimClip 1 0 {"start":6,"end":10}', 'trimClip 1 0 {"start":0,"end":60}']);
        calls.length = 0;
        // 指定の誤り
        expect(await fail('trim_clip', { track_id: 1, clip_index: 0 }, env)).toMatch(/動かす端を指定してください/);
        expect(await fail('trim_clip', { track_id: 1, clip_index: 0, start_seconds: 5, start_bar: 3 }, env)).toMatch(/start_seconds か start_bar の、どちらか一方/);
        expect(await fail('trim_clip', { track_id: 1, clip_index: 0, end_seconds: 5, end_bar: 3 }, env)).toMatch(/end_seconds か end_bar の、どちらか一方/);
        expect(await shown('trim_clip', { track_id: 1, clip_index: 0 }, env)).toBe('指定が合わず、行っていません');
        // 状態による失敗: 終わりが頭より手前、音声の無い範囲
        expect(await fail('trim_clip', { track_id: 1, clip_index: 0, start_seconds: 14 }, env)).toMatch(/右の端（14 秒）は、左の端（14 秒）より後ろに/);
        expect(await fail('trim_clip', { track_id: 1, clip_index: 0, end_seconds: 3 }, env)).toMatch(/いまのクリップは 4〜14 秒/);
        expect(await fail('trim_clip', { track_id: 1, clip_index: 0, start_seconds: 20, end_seconds: 30 }, env)).toMatch(/音声が在るのは 4〜14 秒.*move_clip/);
        expect(await shown('trim_clip', { track_id: 1, clip_index: 0, start_seconds: 20, end_seconds: 30 }, env)).toBe('その範囲には、クリップ「take1.wav」の音声がありません（音声が在るのは 4〜14 秒）');
        expect(await fail('trim_clip', { track_id: 2, clip_index: 0, start_seconds: 1 }, env)).toMatch(/音声のクリップがありません/);
        expect(calls).toEqual([]);
    });

    it('trim_clip: 最短の長さで止まったときは、音声の端ではなく、最短の長さで止めたと返す', async () => {
        // 10 秒の音声を、4 秒の位置に置いたクリップ (4〜14 秒)
        const { env } = makeEnv({ tracks: [track(1, 'ボーカル', { clips: [clip('take1.wav', 4, 10, { buffer: { duration: 10 } })] })], bpm: 120 });
        const short = await ok('trim_clip', { track_id: 1, clip_index: 0, start_seconds: 9, end_seconds: 9.01 }, env);
        expect(short.summary).toBe('クリップ「take1.wav」を縮めました（8.96〜9.01 秒。ボーカル）。クリップは 0.05 秒より短くできないので、0.05 秒で止めました');
        expect(short.stopped_at_min_length).toBe(true);
        expect(short.stopped_at_audio_edge).toBeUndefined();
        // 音声の端と、最短の長さの両方で止まったときは、両方を返す
        const both = await ok('trim_clip', { track_id: 1, clip_index: 0, start_seconds: 0, end_seconds: 4.01 }, env);
        expect(both).toMatchObject({ stopped_at_audio_edge: true, stopped_at_min_length: true, start_seconds: 4, end_seconds: 4.05 });
        expect(both.summary).toMatch(/音声の端より外へは伸ばせないので、端で止めました。クリップは 0\.05 秒より短くできないので、0\.05 秒で止めました$/);
    });

    it('split_clip: 秒・小節・再生位置で 2 つに分ける。クリップの外では分けない', async () => {
        const { env, state, calls } = makeEnv({ tracks: [track(1, 'ボーカル', { clips: [clip('take1.wav', 0, 8, { buffer: { duration: 8 }, fadeIn: 1, fadeOut: 1 }), clip('take2.wav', 10, 4)] })], bpm: 120 });
        expect(await ok('split_clip', { track_id: 1, clip_index: 0, at_seconds: 3 }, env)).toMatchObject({
            summary: 'クリップ「take1.wav」を、3 秒で 2 つに分けました（ボーカル）', clip_index: 0, new_clip_index: 1, at_seconds: 3, clip_count: 3,
        });
        // 左がフェードインを、右がフェードアウトを引き継ぐ。後ろのクリップは 1 つずれる
        expect(state.tracks[0].clips.map((c) => [c.name, c.offset, c.duration, c.audioStart ?? 0, c.fadeIn ?? 0, c.fadeOut ?? 0])).toEqual([
            ['take1.wav', 0, 3, 0, 1, 0], ['take1.wav', 3, 5, 3, 0, 1], ['take2.wav', 10, 4, 0, 0, 0],
        ]);
        // 小節で: 3 小節目の頭 (4 秒)
        expect((await ok('split_clip', { track_id: 1, clip_index: 1, at_bar: 3 }, env)).summary).toBe('クリップ「take1.wav」を、3 小節目の頭で 2 つに分けました（ボーカル）');
        // どちらも省くと、再生位置で
        state.positionSec = 11.5;
        expect((await ok('split_clip', { track_id: 1, clip_index: 3 }, env)).summary).toBe('クリップ「take2.wav」を、再生位置（11.5 秒）で 2 つに分けました（ボーカル）');
        expect(calls).toEqual(['splitClip 1 0 3', 'splitClip 1 1 4', 'splitClip 1 3 11.5']);
        calls.length = 0;
        // クリップの外 (再生位置が、指したクリップの中に無い)
        expect(await fail('split_clip', { track_id: 1, clip_index: 0 }, env)).toMatch(/再生位置（11.5 秒）は、クリップ「take1.wav」の中に在りません（クリップは 0〜3 秒）。at_seconds か at_bar/);
        expect(await shown('split_clip', { track_id: 1, clip_index: 0 }, env)).toBe('再生位置（11.5 秒）は、クリップ「take1.wav」の中に在りません（クリップは 0〜3 秒）');
        // 端そのものでは分けない
        expect(await fail('split_clip', { track_id: 1, clip_index: 0, at_seconds: 3 }, env)).toMatch(/3 秒は、クリップ「take1.wav」の中に在りません/);
        expect(await fail('split_clip', { track_id: 1, clip_index: 0, at_seconds: 1, at_bar: 1 }, env)).toMatch(/at_seconds か at_bar の、どちらか一方/);
        expect(calls).toEqual([]);
    });

    it('fade_clip: フェードの長さを決める。0 で外す。合計がクリップの長さを超えたら失敗する', async () => {
        const { env, state, calls } = makeEnv({ tracks: [track(1, 'ボーカル', { clips: [clip('take1.wav', 0, 4)] })] });
        const first = () => state.tracks[0].clips[0];
        expect(await ok('fade_clip', { track_id: 1, clip_index: 0, fade_in_seconds: 0.5 }, env)).toMatchObject({
            summary: 'クリップ「take1.wav」にフェードを付けました（フェードイン 0.5 秒、フェードアウト 0 秒。ボーカル）', fade_in_seconds: 0.5, fade_out_seconds: 0,
        });
        // 指定しなかったほうは、そのまま
        expect(await ok('fade_clip', { track_id: 1, clip_index: 0, fade_out_seconds: 2 }, env)).toMatchObject({ fade_in_seconds: 0.5, fade_out_seconds: 2 });
        expect(first()).toMatchObject({ fadeIn: 0.5, fadeOut: 2 });
        expect((await ok('fade_clip', { track_id: 1, clip_index: 0, fade_out_seconds: 2 }, env)).summary).toBe('クリップ「take1.wav」のフェードは、すでにその長さです（フェードイン 0.5 秒、フェードアウト 2 秒）');
        // 合計が長さを超える (フェードインはいまの 0.5 秒のまま)
        expect(await fail('fade_clip', { track_id: 1, clip_index: 0, fade_out_seconds: 3.8 }, env))
            .toBe('フェードイン 0.5 秒とフェードアウト 3.8 秒の合計が、クリップ「take1.wav」の長さ（4 秒）を超えています。合計を 4 秒以内にしてください');
        expect(await shown('fade_clip', { track_id: 1, clip_index: 0, fade_out_seconds: 3.8 }, env)).toBe('フェードイン 0.5 秒とフェードアウト 3.8 秒の合計が、クリップ「take1.wav」の長さ（4 秒）を超えています');
        expect(first()).toMatchObject({ fadeIn: 0.5, fadeOut: 2 });
        // 0 で外す
        expect((await ok('fade_clip', { track_id: 1, clip_index: 0, fade_in_seconds: 0, fade_out_seconds: 0 }, env)).summary).toBe('クリップ「take1.wav」のフェードを外しました（ボーカル）');
        expect('fadeIn' in first() || 'fadeOut' in first()).toBe(false);
        expect(calls).toEqual(['fadeClip 1 0 {"fadeIn":0.5,"fadeOut":0}', 'fadeClip 1 0 {"fadeIn":0.5,"fadeOut":2}', 'fadeClip 1 0 {"fadeIn":0,"fadeOut":0}']);
        calls.length = 0;
        expect(await fail('fade_clip', { track_id: 1, clip_index: 0 }, env)).toMatch(/fade_in_seconds か fade_out_seconds の、少なくとも一方/);
        expect(await fail('fade_clip', { track_id: 1, clip_index: 0, fade_in_seconds: -1 }, env)).toMatch(/fade_in_seconds は 0〜3600 の範囲/);
        expect(calls).toEqual([]);
    });

    it('apply_effect: 省いたパラメータは既定の値。知らない名前と範囲の外は失敗する', async () => {
        const { env, state, calls } = makeEnv({ tracks: [track(1, 'ボーカル', { clips: [clip('take1.wav')] })] });
        const result = await ok('apply_effect', { track_id: 1, effect: 'reverb', params: { wet: 0.5 } }, env);
        expect(result).toMatchObject({ effect: 'reverb', clip_index: 0, params: { room_size: 0.5, wet: 0.5 } });
        // パラメータは、画面での名前で言う (識別子の room_size などを出さない)
        expect(result.summary).toBe('「リバーブ」をかけました（ボーカル のクリップ「take1.wav」。部屋の広さ 0.5、エフェクト音の量 0.5）');
        expect((await ok('apply_effect', { track_id: 1, effect: 'eq', params: { low: 3 } }, env)).summary).toMatch(/低域 3 dB、中域 0 dB、高域 0 dB/);
        expect(calls.slice(0, 1)).toEqual(['effect 1 0 reverb {"room_size":0.5,"wet":0.5} リバーブ']);
        expect((await ok('apply_effect', { track_id: 1, effect: 'normalize' }, env)).summary).toBe('「ノーマライズ」をかけました（ボーカル のクリップ「take1.wav」）');
        calls.length = 0;
        expect(await fail('apply_effect', { track_id: 1, effect: 'chorus' }, env)).toMatch(/effect は .*"eq".* のどれか/);
        expect(await fail('apply_effect', { track_id: 1, effect: 'eq', params: { bass: 3 } }, env)).toMatch(/「bass」という項目はありません。使える項目: low, mid, high/);
        expect(await fail('apply_effect', { track_id: 1, effect: 'eq', params: { low: 30 } }, env)).toMatch(/low は -12〜12 の範囲/);
        expect(calls).toEqual([]);
        // かける処理の失敗は、理由を添えて返す
        state.effectError = '音声を読めませんでした';
        expect(await fail('apply_effect', { track_id: 1, effect: 'eq' }, env)).toBe('「EQ（3 バンド）」をかけられませんでした。音声を読めませんでした');
    });

    it('readEffectParams: 種類ごとの既定の値', () => {
        expect(readEffectParams('compressor', undefined)).toEqual({ threshold: -20, ratio: 4 });
        expect(readEffectParams('normalize', {})).toEqual({});
        expect(readEffectParams('delay', { delay_ms: 500 })).toEqual({ delay_ms: 500, feedback: 0.4, wet: 0.3 });
    });
});

describe('失敗の文: Claude に返す文と、操作ログに出す文', () => {
    it('引数の指定が合わなかった失敗は、操作ログには決まった文だけを出す（何を直すかは、Claude にだけ返す）', async () => {
        const { env } = makeEnv();
        expect(await shown('add_notes', { track_id: 1, notes: [{ pitch: 'H4', step: 0, length: 4 }] }, env)).toBe(ARG_SHOWN);
        expect(await shown('set_tempo', { bpm: 999 }, env)).toBe(ARG_SHOWN);
        expect(await shown('add_track', { nmae: 'Bass' }, env)).toBe(ARG_SHOWN);
        expect(await shown('transpose_notes', { track_id: 1, semitones: 0 }, env)).toBe(ARG_SHOWN);
        expect(await fail('set_tempo', { bpm: 999 }, env)).toMatch(/bpm は 20〜300 の範囲/);
    });

    it('対象が無い・いまはできない失敗は、利用者に分かる理由を出す（ツールや引数の名前を入れない）', async () => {
        const { env } = makeEnv({ tracks: [track(1, 'Track 1'), track(2, 'ベース', { role: 'part' })] });
        expect(await shown('add_notes', { track_id: 99, notes: [{ pitch: 'C4', step: 0, length: 4 }] }, env)).toBe('そのトラックが見つかりませんでした');
        expect(await fail('add_notes', { track_id: 99, notes: [{ pitch: 'C4', step: 0, length: 4 }] }, env)).toMatch(/track_id 99 のトラックはありません。get_project で/);
        expect(await shown('get_notes', { track_id: 1, source: 'reference' }, env)).toBe('「Track 1」には、お手本がありません');
        expect(await shown('open_practice', { track_id: 1 }, env)).toBe('「Track 1」はパートのトラックではないので、練習画面を開けません');
        expect(await shown('open_practice', { track_id: 2 }, env)).toBe('「ベース」にはお手本が無いので、練習画面を開けません');
        expect(await shown('set_practice', { speed_percent: 75 }, env)).toBe('練習画面を開いていません（区間ループ・速度・聴くは、練習画面の設定です）');
        expect(await shown('transpose_notes', { track_id: 1, semitones: 12 }, env)).toBe('対象のノートがありません（Track 1、全部）');
        expect(await shown('delete_clip', { track_id: 1, clip_index: 0 }, env)).toBe('「Track 1」には、音声のクリップがありません');
        expect(await shown('separate_parts', {}, env)).toBe('まだ曲を取り込んでいません');
        expect(await shown('make_song', {}, env)).toBe('アシスタントが、このアプリに無い操作を頼みました');
    });
});

describe('台帳（backend/assistant_tools.json）との一致', () => {
    interface LedgerTool { name: string; access: string; label: string; input_schema: { properties: Record<string, unknown>; required?: string[] } }
    let ledger: { tools: LedgerTool[] } = { tools: [] };
    beforeAll(async () => {
        // 台帳は、ファイルから読む (写しを持たない)。画面の tsconfig には node の型を入れていないので、ここで使うぶんの形だけ書く
        const fs = (await import('node:fs' as string)) as { readFileSync: (path: URL, encoding: 'utf8') => string };
        ledger = JSON.parse(fs.readFileSync(new URL('../../../backend/assistant_tools.json', import.meta.url), 'utf8'));
    });

    it('ツールの名前が、過不足なく一致する', () => {
        expect(ledger.tools).toHaveLength(42);
        expect(Object.keys(TOOLS).sort()).toEqual(ledger.tools.map((t) => t.name).sort());
    });

    it('ラベル・読む / 変える・引数の名前が一致する', () => {
        for (const tool of ledger.tools) {
            const spec = TOOLS[tool.name];
            expect(spec.label, tool.name).toBe(tool.label);
            expect(toolLabel(tool.name), tool.name).toBe(tool.label);
            expect(spec.access, tool.name).toBe(tool.access);
            expect(isWriteTool(tool.name), tool.name).toBe(tool.access === 'write');
            expect([...spec.keys].sort(), tool.name).toEqual(Object.keys(tool.input_schema.properties).sort());
            // 実行中の文は「〜しています…」
            expect(spec.running, tool.name).toMatch(/(て|で)います…$/);
        }
    });

    it('台帳で必須の引数を省くと、どのツールも失敗する（画面の側でも確かめている）', async () => {
        const { env, calls } = makeEnv();
        for (const tool of ledger.tools) {
            if (!tool.input_schema.required?.length) continue;
            expect(await fail(tool.name, {}, env), tool.name).toMatch(/を指定してください|notes は/);
        }
        expect(calls).toEqual([]);
    });

    it('show_in_app の target の選択肢が、示せる場所の一覧（lib/assistant-landmarks.ts）と一致する', () => {
        const target = ledger.tools.find((t) => t.name === 'show_in_app')!.input_schema.properties.target as { enum: string[] };
        expect([...target.enum].sort()).toEqual(Object.keys(LANDMARKS).sort());
        for (const [key, landmark] of Object.entries(LANDMARKS)) {
            expect(landmark.label, key).not.toBe('');
            expect(landmark.where, key).not.toBe('');
            expect(landmark.selector, key).not.toBe('');
        }
    });

    it('apply_effect の effect の選択肢が、エフェクトの定義（lib/fx.ts）と一致する', () => {
        const effect = ledger.tools.find((t) => t.name === 'apply_effect')!.input_schema.properties.effect as { enum: string[] };
        expect([...effect.enum].sort()).toEqual([...EFFECT_NAMES].sort());
        // パラメータの名前も、定義に在るものと過不足なく一致する
        const params = ledger.tools.find((t) => t.name === 'apply_effect')!.input_schema.properties.params as { properties: Record<string, unknown> };
        expect(Object.keys(params.properties).sort()).toEqual([...new Set(EFFECT_NAMES.flatMap((name) => Object.keys(readEffectParams(name, {}))))].sort());
    });

    it('ノートの位置・長さ・範囲・ずらす幅は、小数を受ける型（number）。そろえる間隔の説明に、画面が受ける値が全部在る', () => {
        const props = (name: string) => ledger.tools.find((t) => t.name === name)!.input_schema.properties as Record<string, { type: string; description?: string; items?: { properties: Record<string, { type: string }> } }>;
        for (const name of ['add_notes', 'replace_notes']) {
            const item = props(name).notes.items!.properties;
            expect([item.step.type, item.length.type], name).toEqual(['number', 'number']);
        }
        for (const name of ['remove_notes', 'replace_notes', 'transpose_notes', 'shift_notes', 'quantize_notes', 'repeat_notes', 'set_velocity']) {
            expect([props(name).start_step.type, props(name).end_step.type], name).toEqual(['number', 'number']);
        }
        expect(props('shift_notes').steps.type).toBe('number');
        expect(props('repeat_notes').to_step.type).toBe('number');
        // そろえる間隔: 台帳の説明に書いた値を、画面がどれも受ける。画面が受ける値は、どれも説明に在る
        const grid = props('quantize_notes').grid_steps;
        expect(grid.type).toBe('number');
        for (const g of QUANTIZE_GRIDS) expect(grid.description, g.label).toContain(String(Math.round(g.steps * 10000) / 10000));
        const written = [...grid.description!.matchAll(/(\d+(?:\.\d+)?) \(/g)].map((m) => Number(m[1]));
        expect(written).toHaveLength(QUANTIZE_GRIDS.length);
        for (const value of written) expect(quantizeGrid(value), String(value)).toBeDefined();
    });

    it('set_practice の速度の選択肢が、練習画面の速度と一致する', () => {
        const speed = ledger.tools.find((t) => t.name === 'set_practice')!.input_schema.properties.speed_percent as { enum: number[] };
        expect(speed.enum).toEqual([50, 60, 75, 90, 100]);
    });

    it('知らないツールは、名前のまま出し、変える操作として扱わない', () => {
        expect(toolLabel('make_song')).toBe('make_song');
        expect(isWriteTool('make_song')).toBe(false);
    });
});
