/**
 * bunri DAW — アシスタントのツール: ノートの変形（移調・ずらす・そろえる・くり返す・強さ）。
 *
 * どれも「対象のノートを選ぶ → 決まった計算で変える → トラックのノートを丸ごと差し替える」。Claude は範囲と量だけを
 * 渡し、ノートを 1 つずつ書き直さない（`replace_notes` で数百のノートを書かせると、遅く、高く、写し間違える）。
 * 計算は、画面に触らない純粋な関数（元の配列もノートも書き換えない）。
 *
 * 対象の選び方は、どのツールも同じ（`pickNotes`）:
 * - `start_step` / `end_step`: 範囲 `[start, end)` に「始まり」が入っているノート。省くと、トラックの全部
 * - `pitches`: 在れば、その高さのノートだけ
 * - `selected_only`: true なら、ピアノロールで選んでいるノートだけ（そのトラックを開いているとき）
 *
 * 変えたノートが、変えていないノートと同じ高さ・同じ位置に重なったら、変えた側を 1 つにまとめる（二重に置かない）。
 */
import { DEFAULT_VELOCITY, type PianoNote } from './engine';
import { inStepRange, normStep, sameStep, stepsPerBar, toTicks } from './grid';
import { quantize, spanLabel } from './snap';
import {
    ArgError, OCTAVE_MAX, OCTAVE_MIN, SHARP_NAMES, ToolError, barsLabel, copyNote, flag, formatPitch, integer, noteKey, number, parsePitch, pitchNumber,
    stepOut, stepValue, trackOf,
    type ToolEnv, type ToolSpec, type ToolTrack,
} from './assistant-tool-kit';

/** 移調の幅の上限（半音。4 オクターブ）。 */
export const TRANSPOSE_MAX = 48;
/** くり返す回数の上限。 */
export const REPEAT_MAX = 32;
/**
 * そろえる間隔（ステップ）に使える値と、その呼び名。0.5 = 32 分音符、2/3 = 16 分の三連、1 = 16 分音符、4/3 = 8 分の三連、
 * 2 = 8 分音符、4 = 4 分音符、8 = 2 分音符、16 = 全音符。三連は、`0.6667` `1.3333` のような小数で渡される
 * （`quantizeGrid` が、近い値に読む）。
 */
export const QUANTIZE_GRIDS: readonly { steps: number; label: string }[] = [
    { steps: 0.5, label: '32 分音符' },
    { steps: 2 / 3, label: '16 分の三連' },
    { steps: 1, label: '16 分音符' },
    { steps: 4 / 3, label: '8 分の三連' },
    { steps: 2, label: '8 分音符' },
    { steps: 4, label: '4 分音符' },
    { steps: 8, label: '2 分音符' },
    { steps: 16, label: '全音符' },
];

/** `grid_steps` の値から、そろえる間隔を引く（三連の小数は、0.01 ステップまでの違いを同じ値として読む）。無ければ undefined。 */
export function quantizeGrid(value: number): { steps: number; label: string } | undefined {
    return QUANTIZE_GRIDS.find((g) => Math.abs(g.steps - value) < 0.01);
}

/** 変形の結果。 */
export interface Transformed {
    /** 差し替えた後の並び */
    notes: PianoNote[];
    /** 実際に変わったノートの、`notes` の中の番号 */
    changed: number[];
    /** 対象だったが、もう合っていて変わらなかったノートの数 */
    unchanged: number;
    /** 変えた先が、ほかのノートと同じ高さ・同じ位置になったので、まとめたノートの数 */
    merged: number;
}

/** 高さの番号（C4 = 60）から、音名とオクターブへ。 */
function fromPitchNumber(midi: number): { note: string; octave: number } {
    return { note: SHARP_NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1 };
}

/** 2 つのノートが、高さ・位置・長さ・強さまで同じか（位置と長さは、1/60 ステップにそろえて比べる）。 */
function sameNote(a: PianoNote, b: PianoNote): boolean {
    return a.note === b.note && a.octave === b.octave && sameStep(a.step, b.step) && sameStep(a.length, b.length) && a.velocity === b.velocity;
}

/**
 * 対象のノートを、1 つずつ変える。変えた先が重なったら、まとめる。
 *
 * @param existing - いまの並び
 * @param picked - 対象のノートの番号
 * @param change - ノートを受けて、変えた後のノートを返す（受けたノートは書き換えない）
 */
export function transformNotes(existing: readonly PianoNote[], picked: ReadonlySet<number>, change: (note: PianoNote) => PianoNote): Transformed {
    // 変えないノートの鍵 (変えた先が、これと重なったら置かない)
    const seen = new Set(existing.filter((_n, i) => !picked.has(i)).map(noteKey));
    const notes: PianoNote[] = [];
    const changed: number[] = [];
    let unchanged = 0, merged = 0;
    existing.forEach((note, index) => {
        if (!picked.has(index)) { notes.push(note); return; }
        const next = change(copyNote(note));
        const key = noteKey(next);
        if (seen.has(key)) { merged += 1; return; }
        seen.add(key);
        if (sameNote(note, next)) { unchanged += 1; notes.push(note); return; }
        changed.push(notes.length);
        notes.push(next);
    });
    return { notes, changed, unchanged, merged };
}

/**
 * 半音の数だけ、高さを移す。
 *
 * @throws {ToolError} 移した先が、ピアノロールの範囲（C0〜B8）の外に出るノートが在る
 */
export function transposeNotes(existing: readonly PianoNote[], picked: ReadonlySet<number>, semitones: number): Transformed {
    const low = (OCTAVE_MIN + 1) * 12, high = (OCTAVE_MAX + 1) * 12 + 11;
    const out = existing.filter((n, i) => picked.has(i) && (pitchNumber(n) + semitones < low || pitchNumber(n) + semitones > high));
    if (out.length > 0) {
        const lowest = existing.filter((_n, i) => picked.has(i)).reduce((a, b) => (pitchNumber(a) <= pitchNumber(b) ? a : b));
        const highest = existing.filter((_n, i) => picked.has(i)).reduce((a, b) => (pitchNumber(a) >= pitchNumber(b) ? a : b));
        const what = `${out.length} 個のノートが、範囲（C${OCTAVE_MIN}〜B${OCTAVE_MAX}）の外に出ます（対象は ${formatPitch(lowest)}〜${formatPitch(highest)}）`;
        throw new ToolError(`${what}。semitones を小さくするか、対象を絞ってください`, what);
    }
    return transformNotes(existing, picked, (n) => ({ ...n, ...fromPitchNumber(pitchNumber(n) + semitones) }));
}

/**
 * ステップの数だけ、位置をずらす（正なら後ろへ）。
 *
 * @param maxSteps - ピアノロールの長さの上限（ステップ）
 * @throws {ToolError} 1 小節目の頭より前、または長さの上限より後ろに出るノートが在る
 */
export function shiftNotes(existing: readonly PianoNote[], picked: ReadonlySet<number>, steps: number, maxSteps: number): Transformed {
    const target = existing.filter((_n, i) => picked.has(i));
    const first = Math.min(...target.map((n) => n.step));
    const last = Math.max(...target.map((n) => n.step + n.length));
    if (normStep(first + steps) < 0) {
        throw new ToolError(`いちばん前のノート（step ${stepOut(first)}）が、1 小節目の頭より前に出ます。前へずらせるのは ${stepOut(first)} ステップまでです`,
            'いちばん前のノートが、1 小節目の頭より前に出ます');
    }
    if (normStep(last + steps) > maxSteps) {
        throw new ToolError(`いちばん後ろのノートが、ピアノロールの長さの上限（${maxSteps} ステップ）を超えます`);
    }
    return transformNotes(existing, picked, (n) => ({ ...n, step: normStep(n.step + steps) }));
}

/**
 * 位置を、間隔の倍数にそろえる（近いほうへ。ちょうど真ん中は後ろへ）。
 *
 * @param grid - 間隔（ステップ。小数も可: 0.5 = 32 分音符、4/3 = 8 分の三連）
 * @param lengths - true なら、長さも間隔の倍数にそろえる（間隔より短くはしない）
 */
export function quantizeNotes(existing: readonly PianoNote[], picked: ReadonlySet<number>, grid: number, lengths = false): Transformed {
    // 計算は 1/60 ステップの単位で行う (lib/snap.ts の quantize。三連の間隔でも、端数がたまらない)
    const cell = normStep(grid);
    return transformNotes(existing, picked, (n) => ({
        ...n, step: quantize(n.step, cell),
        ...(lengths ? { length: Math.max(cell, quantize(n.length, cell)) } : {}),
    }));
}

/**
 * 強さを変える。
 *
 * - `velocity` だけ: 全部をその強さにする
 * - `velocity` と `endVelocity`: 最初のノートの位置から最後のノートの位置へ、なだらかに変える（だんだん強く・弱く）
 * - `delta`: いまの強さに足す（強さを持たないノートは、既定の 96 から）
 *
 * 結果は 1〜127 に収める。
 */
export function setVelocity(
    existing: readonly PianoNote[], picked: ReadonlySet<number>,
    how: { velocity?: number; endVelocity?: number; delta?: number },
): Transformed & { clamped: number } {
    const target = existing.filter((_n, i) => picked.has(i));
    const first = Math.min(...target.map((n) => n.step));
    const last = Math.max(...target.map((n) => n.step));
    let clamped = 0;
    const clamp = (value: number) => {
        const v = Math.round(value);
        if (v < 1 || v > 127) clamped += 1;
        return Math.max(1, Math.min(127, v));
    };
    const result = transformNotes(existing, picked, (n) => {
        let next: number;
        if (how.delta !== undefined) next = clamp((n.velocity ?? DEFAULT_VELOCITY) + how.delta);
        else if (how.endVelocity !== undefined && last > first) {
            next = clamp(how.velocity! + (how.endVelocity - how.velocity!) * ((n.step - first) / (last - first)));
        } else next = clamp(how.velocity!);
        return { ...n, velocity: next };
    });
    return { ...result, clamped };
}

/**
 * 範囲 `[start, end)` の対象のノートを、後ろへ `times` 回くり返して置く。1 回目は `toStep` から、
 * 2 回目からは範囲の長さずつ後ろ。同じ高さ・同じ位置にすでに在るノートは、二重に置かない。
 *
 * @returns 足した後の並び、足したノートの番号、置かなかった（重なった）数
 * @throws {ToolError} 置く先が、ピアノロールの長さの上限を超える
 */
export function repeatNotes(
    existing: readonly PianoNote[], picked: ReadonlySet<number>, start: number, end: number, toStep: number, times: number, maxSteps: number,
): { notes: PianoNote[]; added: number[]; skipped: number } {
    const source = existing.filter((_n, i) => picked.has(i));
    const period = end - start;
    const reach = normStep(Math.max(...source.map((n) => n.step + n.length)) - start + toStep + (times - 1) * period);
    if (reach > maxSteps) {
        throw new ToolError(`くり返した先が、ピアノロールの長さの上限（${maxSteps} ステップ）を超えます。times を小さくしてください`,
            'くり返した先が、ピアノロールの長さの上限を超えます');
    }
    const seen = new Set(existing.map(noteKey));
    const notes = existing.slice();
    const added: number[] = [];
    let skipped = 0;
    for (let k = 0; k < times; k++) {
        for (const n of source) {
            const copy = { ...copyNote(n), step: normStep(n.step - start + toStep + k * period) };
            const key = noteKey(copy);
            if (seen.has(key)) { skipped += 1; continue; }
            seen.add(key);
            added.push(notes.length);
            notes.push(copy);
        }
    }
    return { notes, added, skipped };
}

// ---- 対象のノートを選ぶ ----

/** 対象のノート（番号）と、その言い方。 */
export interface Picked {
    indices: Set<number>;
    /** 範囲（指定が無ければ、対象のノートが在る範囲） */
    start: number;
    end: number;
    /** 「Track 1、1〜2 小節」「Track 1、選んでいるノート」 */
    where: string;
}

/** 対象を選ぶ引数の名前（どの変形のツールも持つ）。 */
export const PICK_KEYS = ['track_id', 'start_step', 'end_step', 'pitches', 'selected_only'] as const;

/**
 * 引数から、対象のノートを選ぶ。1 つも無ければ失敗させる（何も変わらない呼び出しを、成功として返さない）。
 *
 * @param requireRange - true なら、`start_step` と `end_step` を必ず求める（くり返し。範囲の長さが、くり返す間隔になる）
 * @throws {ToolError}
 */
export function pickNotes(args: Record<string, unknown>, track: ToolTrack, env: ToolEnv, requireRange = false): Picked {
    // 範囲の端は、小数も受ける (三連・32 分のノートを、範囲に入れたり外したりできるように)
    const start = stepValue(args, 'start_step', { min: 0, required: requireRange });
    const end = stepValue(args, 'end_step', { min: 0, required: requireRange });
    if (start !== undefined && end !== undefined && toTicks(end) <= toTicks(start)) {
        throw new ArgError(`end_step は start_step より大きくしてください（いまは start_step ${stepOut(start)}、end_step ${stepOut(end)}。end_step は範囲に含みません）`);
    }
    let pitches: Set<string> | undefined;
    if (args.pitches !== undefined && args.pitches !== null) {
        if (!Array.isArray(args.pitches) || args.pitches.length === 0) {
            throw new ArgError('pitches は、高さの並びで指定してください（例: ["C4", "E4"]）。全部の高さを対象にするなら、pitches を省いてください');
        }
        pitches = new Set(args.pitches.map((p) => formatPitch(parsePitch(p))));
    }
    const selectedOnly = flag(args, 'selected_only') === true;
    let selected: Set<number> | undefined;
    if (selectedOnly) {
        const selection = env.selection();
        if (!selection || selection.indices.length === 0) {
            throw new ToolError('いま、ピアノロールで選んでいるノートはありません。対象を start_step / end_step で指定するか、利用者にノートを選んでもらってください',
                'いま、ピアノロールで選んでいるノートはありません');
        }
        if (selection.trackId !== track.id) {
            throw new ToolError(`選んでいるノートは、別のトラック（track_id ${selection.trackId}）のものです。track_id を合わせてください`,
                '選んでいるノートは、別のトラックのものです');
        }
        selected = new Set(selection.indices);
    }
    const from = start ?? 0, to = end ?? Infinity;
    const indices = new Set<number>();
    track.pianoNotes.forEach((n, i) => {
        // 範囲に入るかは、刻みの数 (1/60 ステップの整数) で比べる
        if (!inStepRange(n.step, from, to)) return;
        if (pitches && !pitches.has(formatPitch(n))) return;
        if (selected && !selected.has(i)) return;
        indices.add(i);
    });
    const perBar = stepsPerBar(env.grid());
    const picked = track.pianoNotes.filter((_n, i) => indices.has(i));
    const spanStart = start ?? (picked.length ? Math.min(...picked.map((n) => n.step)) : 0);
    const spanEnd = end ?? (picked.length ? Math.max(...picked.map((n) => n.step + n.length)) : spanStart + 1);
    const range = start === undefined && end === undefined && !selectedOnly ? '全部' : barsLabel(spanStart, spanEnd, perBar);
    const where = `${track.name}、${selectedOnly ? `選んでいるノート（${barsLabel(spanStart, spanEnd, perBar)}）` : range}`;
    if (indices.size === 0) {
        const what = `対象のノートがありません（${where}${pitches ? `、高さ ${[...pitches].join(' ')}` : ''}）`;
        throw new ToolError(`${what}。get_notes で、範囲の中身を確かめてください`, what);
    }
    return { indices, start: spanStart, end: spanEnd, where };
}

/** 変えたノートを、開いているトラックなら選んで光らせる（どこが変わったかを見せる）。 */
function flash(env: ToolEnv, trackId: number, indices: number[]): void {
    if (indices.length > 0) env.flashNotes(trackId, indices);
}

/** 変形の結果の、言い足し（「。もう合っていた 3 個は、そのままです」など）。 */
function tail(result: { unchanged: number; merged: number }): string {
    const parts: string[] = [];
    if (result.unchanged > 0) parts.push(`もう合っていた ${result.unchanged} 個は、そのままです`);
    if (result.merged > 0) parts.push(`ほかのノートと同じ高さ・同じ位置になった ${result.merged} 個は、1 つにまとめました`);
    return parts.length ? `。${parts.join('。')}` : '';
}

/** 半音の数の言い方（「+12 半音（1 オクターブ上）」）。 */
function semitoneLabel(semitones: number): string {
    const sign = semitones > 0 ? '+' : '−';
    const abs = Math.abs(semitones);
    const octave = abs % 12 === 0 ? `（${abs / 12} オクターブ${semitones > 0 ? '上' : '下'}）` : '';
    return `${sign}${abs} 半音${octave}`;
}

/** 変形のツールが返すデータ（共通の項目）。 */
function data(track: ToolTrack, result: Transformed): Record<string, unknown> {
    return { track_id: track.id, changed: result.changed.length, unchanged: result.unchanged, merged: result.merged, note_count: result.notes.length };
}

/** ノートの変形のツール。名前は台帳（`backend/assistant_tools.json`）と同じ。 */
export const NOTE_TOOLS: Record<string, ToolSpec> = {
    transpose_notes: {
        label: 'ノートを移調する', running: 'ノートを移調しています…', access: 'write', keys: [...PICK_KEYS, 'semitones'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const semitones = integer(args, 'semitones', { min: -TRANSPOSE_MAX, max: TRANSPOSE_MAX, required: true })!;
            if (semitones === 0) throw new ArgError('semitones が 0 です。移す幅を、半音の数で指定してください（1 オクターブ上は 12、下は -12）');
            const picked = pickNotes(args, track, env);
            const result = transposeNotes(track.pianoNotes, picked.indices, semitones);
            if (result.changed.length > 0) env.setTrackNotes(track.id, result.notes, 'ノートを移調');
            flash(env, track.id, result.changed);
            return {
                ok: true,
                summary: `ノートを ${result.changed.length} 個、${semitoneLabel(semitones)}に移しました（${picked.where}${tail(result)}）`,
                ...data(track, result), semitones,
            };
        },
    },

    shift_notes: {
        label: 'ノートをずらす', running: 'ノートをずらしています…', access: 'write', keys: [...PICK_KEYS, 'steps'],
        run: (args, env) => {
            const track = trackOf(args, env);
            // ずらす幅は、小数も受ける (三連 1 つぶん = 4/3、32 分音符 1 つぶん = 0.5)
            const steps = stepValue(args, 'steps', { required: true })!;
            if (steps === 0) throw new ArgError('steps が 0 です。ずらす幅を、ステップの数で指定してください（後ろへは正、前へは負。1 拍は 4。小数も可: 8 分の三連 1 つぶんは 1.3333）');
            const picked = pickNotes(args, track, env);
            const result = shiftNotes(track.pianoNotes, picked.indices, steps, env.maxSteps());
            if (result.changed.length > 0) env.setTrackNotes(track.id, result.notes, 'ノートをずらす');
            flash(env, track.id, result.changed);
            // 整数のステップは、これまでどおり「1 拍」「3 ステップ」。小数は、音符の数で言う (「8 分の三連符 1 個」)
            const abs = Math.abs(steps);
            const amount = abs % 4 === 0 ? `${abs / 4} 拍` : Number.isInteger(abs) ? `${abs} ステップ` : `${spanLabel(abs)}ぶん`;
            return {
                ok: true,
                summary: `ノートを ${result.changed.length} 個、${amount}${steps > 0 ? '後ろ' : '前'}へずらしました（${picked.where}${tail(result)}）`,
                ...data(track, result), steps: stepOut(steps),
            };
        },
    },

    quantize_notes: {
        label: 'ノートの位置をそろえる', running: 'ノートの位置をそろえています…', access: 'write', keys: [...PICK_KEYS, 'grid_steps', 'lengths'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const raw = number(args, 'grid_steps', { min: 0, max: 16, required: true })!;
            const grid = quantizeGrid(raw);
            if (!grid) {
                throw new ArgError(`grid_steps は ${QUANTIZE_GRIDS.map((g) => `${stepOut(g.steps)}（${g.label}）`).join('・')} のどれかにしてください（いまは ${raw}）`);
            }
            const lengths = flag(args, 'lengths') === true;
            const picked = pickNotes(args, track, env);
            const result = quantizeNotes(track.pianoNotes, picked.indices, grid.steps, lengths);
            if (result.changed.length > 0 || result.merged > 0) env.setTrackNotes(track.id, result.notes, 'ノートの位置をそろえる');
            flash(env, track.id, result.changed);
            const what = `${grid.label}の位置${lengths ? 'と長さ' : ''}`;
            return {
                ok: true,
                summary: result.changed.length === 0 && result.merged === 0
                    ? `対象の ${result.unchanged} 個は、もう${what}に合っています（${picked.where}）`
                    : `ノートを ${result.changed.length} 個、${what}にそろえました（${picked.where}${tail(result)}）`,
                ...data(track, result), grid_steps: stepOut(grid.steps),
            };
        },
    },

    repeat_notes: {
        label: 'ノートをくり返して置く', running: 'ノートをくり返して置いています…', access: 'write', keys: [...PICK_KEYS, 'times', 'to_step'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const times = integer(args, 'times', { min: 1, max: REPEAT_MAX }) ?? 1;
            const picked = pickNotes(args, track, env, true);
            const toStep = stepValue(args, 'to_step', { min: 0 }) ?? picked.end;
            const result = repeatNotes(track.pianoNotes, picked.indices, picked.start, picked.end, toStep, times, env.maxSteps());
            const perBar = stepsPerBar(env.grid());
            const placed = barsLabel(toStep, toStep + times * (picked.end - picked.start), perBar);
            if (result.added.length === 0) {
                return {
                    ok: true, summary: `置くノートはありませんでした（置く先の ${placed} に、同じ高さ・同じ位置のノートがすでに在ります。${track.name}）`,
                    track_id: track.id, added: 0, skipped: result.skipped, note_count: track.pianoNotes.length,
                };
            }
            env.setTrackNotes(track.id, result.notes, 'ノートをくり返して置く');
            flash(env, track.id, result.added);
            const skipped = result.skipped > 0 ? `。同じ高さ・同じ位置にすでに在る ${result.skipped} 個は置いていません` : '';
            return {
                ok: true,
                summary: `${picked.where}のノート ${picked.indices.size} 個を、${times > 1 ? `${times} 回くり返して` : '写して'}置きました（置いた先は ${placed}、${result.added.length} 個${skipped}）`,
                track_id: track.id, added: result.added.length, skipped: result.skipped, note_count: result.notes.length,
                to_step: stepOut(toStep), end_step: stepOut(toStep + times * (picked.end - picked.start)),
            };
        },
    },

    set_velocity: {
        label: 'ノートの強さを変える', running: 'ノートの強さを変えています…', access: 'write',
        keys: [...PICK_KEYS, 'velocity', 'end_velocity', 'delta'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const velocity = integer(args, 'velocity', { min: 1, max: 127 });
            const endVelocity = integer(args, 'end_velocity', { min: 1, max: 127 });
            const delta = integer(args, 'delta', { min: -126, max: 126 });
            if (endVelocity !== undefined && velocity === undefined) throw new ArgError('end_velocity は、velocity と一緒に指定してください（velocity から end_velocity へ、なだらかに変えます）');
            if (velocity === undefined && delta === undefined) {
                throw new ArgError('velocity（1〜127。その強さにする）か、delta（いまの強さに足す数）のどちらかを指定してください');
            }
            if (velocity !== undefined && delta !== undefined) throw new ArgError('velocity と delta は、どちらか一方だけを指定してください');
            if (delta === 0) throw new ArgError('delta が 0 です。足す数を指定してください（強くするなら正、弱くするなら負）');
            const picked = pickNotes(args, track, env);
            const result = setVelocity(track.pianoNotes, picked.indices, { velocity, endVelocity, delta });
            if (result.changed.length > 0) env.setTrackNotes(track.id, result.notes, 'ノートの強さを変更');
            flash(env, track.id, result.changed);
            const how = delta !== undefined ? `${delta > 0 ? '+' : '−'}${Math.abs(delta)} しました`
                : endVelocity !== undefined && endVelocity !== velocity ? `${velocity} から ${endVelocity} へ、なだらかに変えました` : `${velocity} にしました`;
            const clamped = result.clamped > 0 ? `。${result.clamped} 個は、1〜127 に収めました` : '';
            return {
                ok: true,
                summary: result.changed.length === 0
                    ? `対象の ${result.unchanged} 個は、もうその強さです（${picked.where}）`
                    : `ノート ${result.changed.length} 個の強さを、${how}（${picked.where}${tail(result)}${clamped}）`,
                ...data(track, result),
            };
        },
    },
};
