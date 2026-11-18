/**
 * bunri DAW — アシスタントのツール: 時間のかかる処理（パート分離）・書き出し・保存・音声のクリップ・エフェクト。
 *
 * - `separate_parts`: パート分離と採譜を始める。数分かかるので、終わるのを待たずに返す（進み具合は `get_job` と、
 *   左のパネルの「曲とパート」）。前に分けたパートと練習のトラックは入れ替わるので、在るときは `replace_existing` を求める
 * - `export_wav` / `export_midi` / `save_project`: ヘッダのボタンと同じ処理。ファイルの行き先を選ぶ窓が出るときは、選ぶのは利用者
 * - `move_clip` / `delete_clip` / `duplicate_clip` / `apply_effect`: 音声のクリップの操作。どれも元に戻せる
 *
 * 曲のファイルを選ぶこと（取り込み）は、アシスタントにはできない（ファイルを選ぶ窓は、利用者の操作でしか開かない）。
 * 場所を示して（`show_in_app` の `import_song`）、利用者に押してもらう。
 */
import { barToSec, secToStep, stepToBar } from './grid';
import { FX_LABELS, FX_PARAMS } from './fx';
import {
    ArgError, ToolError, choice, fields, flag, integer, number, round, settle, trackOf,
    type ToolClip, type ToolEnv, type ToolJob, type ToolSpec, type ToolTrack,
} from './assistant-tool-kit';

/** 採譜の感度の既定の値（左のパネルの「採譜の感度」と同じ）。 */
export const DEFAULT_SENSITIVITY = 0.5;

/** エフェクトの種類（lib/fx.ts の `FX_PARAMS` のキー。台帳の `effect` の選択肢と同じ）。 */
export const EFFECT_NAMES = Object.keys(FX_PARAMS);

/** 経過の秒数を「1 分 20 秒」の形にする。 */
function elapsed(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
}

/** 動いている処理を、Claude に返す形にする。 */
function jobData(job: ToolJob): Record<string, unknown> {
    return {
        title: job.title, ...(job.filename ? { filename: job.filename } : {}),
        state: job.state, stage: job.stage,
        ...(job.progress !== null ? { progress_percent: Math.round(job.progress * 100) } : {}),
        elapsed_seconds: Math.round(job.elapsedSec),
        ...(job.cancelRequested ? { cancel_requested: true } : {}),
    };
}

/** 動いている処理の 1 行（「パート分離と採譜: パートに分けています（40%、1 分 20 秒）」）。 */
function jobLine(job: ToolJob): string {
    const progress = job.progress !== null ? `${Math.round(job.progress * 100)}%、` : '';
    return `${job.title}: ${job.stage}（${progress}${elapsed(job.elapsedSec)}）`;
}

/** トラックのクリップを引く。無ければ、いま在るクリップを添えて失敗させる。 */
function clipOf(args: Record<string, unknown>, track: ToolTrack, required = true): { clip: ToolClip; index: number } {
    if (track.clips.length === 0) throw new ToolError(`「${track.name}」には、音声のクリップがありません（get_project の clip_count が 1 以上のトラックを選んでください）`, `「${track.name}」には、音声のクリップがありません`);
    const index = integer(args, 'clip_index', { min: 0, required }) ?? 0;
    const clip = track.clips[index];
    if (!clip) {
        throw new ToolError(`「${track.name}」に、clip_index ${index} のクリップはありません。在るのは: ${track.clips.map((c, i) => `${i}（${c.name}）`).join('、')}`,
            `「${track.name}」に、そのクリップはありません`);
    }
    return { clip, index };
}

/** エフェクトのパラメータを読む（知らない名前と範囲の外は失敗。省いたものは既定の値）。 */
export function readEffectParams(effect: string, value: unknown): Record<string, number> {
    const defs = FX_PARAMS[effect] ?? [];
    const given = fields(value, defs.map((d) => d.id));
    const params: Record<string, number> = {};
    for (const def of defs) {
        params[def.id] = number(given, def.id, { min: def.min, max: def.max }) ?? def.def;
    }
    return params;
}

/** エフェクトのパラメータを、画面での名前で言う（「低域 3 dB」「部屋の広さ 0.5」。識別子の `room_size` などを出さない）。 */
function paramText(label: string, value: number): string {
    const unit = /^(.*?)\s*\((.+)\)$/.exec(label);
    return unit ? `${unit[1]} ${value} ${unit[2]}` : `${label} ${value}`;
}

/** アプリのツール。名前は台帳（`backend/assistant_tools.json`）と同じ。 */
export const APP_TOOLS: Record<string, ToolSpec> = {
    get_job: {
        label: '動いている処理を見る', running: '動いている処理を見ています…', access: 'read', keys: [],
        run: (_args, env) => {
            const job = env.job();
            if (!job) return { ok: true, summary: 'いま動いている、時間のかかる処理はありません', running: false };
            return { ok: true, summary: `動いている処理: ${jobLine(job)}`, running: true, ...jobData(job) };
        },
    },

    cancel_job: {
        label: '動いている処理を中止する', running: '動いている処理を中止しています…', access: 'write', keys: [],
        run: async (_args, env) => {
            const job = env.job();
            if (!job) return { ok: true, summary: '中止する処理はありません（いま動いている処理はありません）', running: false };
            await env.cancelJob(job.id);
            return {
                ok: true, summary: `「${job.title}」の中止を頼みました（区切りのよいところで止まります）`,
                running: true, title: job.title, cancel_requested: true,
            };
        },
    },

    separate_parts: {
        label: 'パートに分けて採譜する', running: 'パート分離を始めています…', access: 'write', keys: ['sensitivity', 'replace_existing'],
        run: async (args, env) => {
            const sensitivity = number(args, 'sensitivity', { min: 0.1, max: 1 }) ?? DEFAULT_SENSITIVITY;
            const replace = flag(args, 'replace_existing') === true;
            const busy = env.job();
            if (busy) {
                throw new ToolError(`いま、ほかの処理が動いています（${jobLine(busy)}）。終わるのを待つか、利用者に確かめてから cancel_job で中止してください`,
                    `いま、ほかの処理が動いています（${jobLine(busy)}）`);
            }
            if (!env.hasSongFile()) {
                throw new ToolError(env.learn().imported
                    ? 'この画面では、まだ原曲のファイルを取り込んでいません（プロジェクトを開き直すと、取り込み直しが要ります）。show_in_app の import_song で場所を示して、利用者に「曲を取り込む」を押してもらってください'
                    : 'まだ曲を取り込んでいません。曲のファイルを選ぶのは利用者です。show_in_app の import_song で場所を示して、「曲を取り込む」を押してもらってください',
                env.learn().imported
                    ? 'この画面では、まだ原曲のファイルを取り込んでいません（プロジェクトを開き直した後は、取り込み直しが要ります）'
                    : 'まだ曲を取り込んでいません');
            }
            const parts = env.tracks().filter((t) => t.role === 'part' && t.part !== 'midi');
            if (parts.length > 0 && !replace) {
                const practiced = env.tracks().filter((t) => t.role === 'practice' && t.pianoNotes.length > 0);
                const what = `すでにパートに分けてあります（${parts.map((t) => t.name).join('、')}）。分け直すと、いまのパートと練習のトラックは入れ替わります`
                    + (practiced.length > 0 ? `（打ち込んだノートが在ります: ${practiced.map((t) => `${t.name} ${t.pianoNotes.length} 個`).join('、')}）` : '');
                throw new ToolError(`${what}。利用者に確かめてから、replace_existing: true を付けて呼び直してください`, `${what}。分け直してよいかを、先に確かめます`);
            }
            const outcome = await env.startSeparation(sensitivity);
            if (!outcome.started) throw new ToolError(`パート分離を始められませんでした。${outcome.reason}`);
            return {
                ok: true,
                summary: 'パート分離と採譜を始めました（数分かかります。進み具合は、左のパネルの「曲とパート」に出ます）',
                started: true, sensitivity,
                note: '終わるのを待たずに返しています。終わると、パートごとのトラックとお手本ができます。進み具合は get_job で読めます。終わるまで何度も呼んで待たず、利用者に「数分かかる」と伝えて、ここで返事を終えてください',
            };
        },
    },

    export_wav: {
        label: 'WAV に書き出す', running: 'WAV に書き出しています…', access: 'write', keys: [],
        run: async (_args, env) => {
            const outcome = await env.exportWav();
            if (!outcome.ok) throw new ToolError(outcome.message);
            return { ok: true, summary: `WAV ファイルを書き出しました（${outcome.fileName}。「ダウンロード」フォルダに入ります）`, file_name: outcome.fileName };
        },
    },

    export_midi: {
        label: 'MIDI に書き出す', running: 'MIDI に書き出しています…', access: 'write', keys: [],
        run: (_args, env) => {
            const outcome = env.exportMidi();
            if (!outcome.ok) throw new ToolError(outcome.message);
            return { ok: true, summary: `MIDI ファイルを書き出しました（${outcome.fileName}。「ダウンロード」フォルダに入ります）`, file_name: outcome.fileName };
        },
    },

    save_project: {
        label: 'プロジェクトを保存する', running: 'プロジェクトを保存しています…', access: 'write', keys: [],
        run: async (_args, env) => {
            const before = env.project();
            const saved = await env.saveProject();
            if (!saved) {
                throw new ToolError(before.name === null
                    ? '保存しませんでした（保存先を選ぶ窓を閉じたか、保存に失敗しました）。理由は、画面の下のバーに出ています'
                    : '保存できませんでした。理由は、画面の下のバーに出ています');
            }
            // 初めての保存では、付いた名前が画面に届くまで、少しだけ待つ
            if (before.name === null) await settle(() => env.project().name !== null);
            const name = env.project().name;
            return { ok: true, summary: `プロジェクトを保存しました${name ? `（${name}）` : ''}`, name };
        },
    },

    move_clip: {
        label: 'クリップを動かす', running: 'クリップを動かしています…', access: 'write', keys: ['track_id', 'clip_index', 'to_bar', 'to_seconds'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const { clip, index } = clipOf(args, track);
            const grid = env.grid();
            const toBar = integer(args, 'to_bar', { min: 1 });
            const toSeconds = number(args, 'to_seconds', { min: 0, max: 36000 });
            if ((toBar === undefined) === (toSeconds === undefined)) {
                throw new ArgError('to_bar（小節の頭へ）か to_seconds（秒の位置へ）の、どちらか一方を指定してください');
            }
            const offset = toBar !== undefined ? Math.max(0, barToSec(toBar, grid)) : toSeconds!;
            const where = toBar !== undefined ? `${toBar} 小節目の頭` : `${round(offset, 2)} 秒`;
            if (Math.abs(offset - clip.offset) < 1e-6) return { ok: true, summary: `クリップ「${clip.name}」は、すでに ${where}に在ります`, track_id: track.id, clip_index: index };
            // 前の位置は、動かす前に控える (クリップは、動かすと中身が書き換わる)
            const name = clip.name, previous = clip.offset;
            env.moveClip(track.id, index, offset);
            return {
                ok: true, summary: `クリップ「${name}」を、${where}へ動かしました（${track.name}）`,
                track_id: track.id, clip_index: index, start_seconds: round(offset, 2), previous_start_seconds: round(previous, 2),
            };
        },
    },

    delete_clip: {
        label: 'クリップを削除する', running: 'クリップを削除しています…', access: 'write', keys: ['track_id', 'clip_index'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const { clip, index } = clipOf(args, track);
            // 残る数は、消す前に数える (トラックのクリップの並びは、消すと書き換わる)
            const name = clip.name, remaining = track.clips.length - 1;
            env.deleteClip(track.id, index);
            return { ok: true, summary: `クリップ「${name}」を削除しました（${track.name}）`, track_id: track.id, clip_count: remaining };
        },
    },

    duplicate_clip: {
        label: 'クリップを複製する', running: 'クリップを複製しています…', access: 'write', keys: ['track_id', 'clip_index'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const { clip, index } = clipOf(args, track);
            const name = clip.name, at = clip.offset + clip.duration;
            env.duplicateClip(track.id, index);
            return {
                ok: true, summary: `クリップ「${name}」を複製して、すぐ後ろ（${round(at, 1)} 秒から）に置きました（${track.name}）`,
                track_id: track.id, new_clip_index: index + 1, start_seconds: round(at, 2),
            };
        },
    },

    apply_effect: {
        label: 'エフェクトをかける', running: 'エフェクトをかけています…', access: 'write', keys: ['track_id', 'clip_index', 'effect', 'params'],
        run: async (args, env) => {
            const track = trackOf(args, env);
            const effect = choice(args, 'effect', EFFECT_NAMES, true)!;
            const { clip, index } = clipOf(args, track, false);
            if (clip.missing) throw new ToolError(`クリップ「${clip.name}」は、音声が見つかっていません。音声を読み込み直してから、かけてください`);
            const params = readEffectParams(effect, args.params);
            const label = FX_LABELS[effect] ?? effect;
            try {
                await env.applyEffect(track.id, index, effect, params, label);
            } catch (e) {
                if (e instanceof ToolError) throw e;
                throw new ToolError(`「${label}」をかけられませんでした。${String((e as Error)?.message ?? e)}`);
            }
            const shown = (FX_PARAMS[effect] ?? []).map((def) => paramText(def.label, params[def.id])).join('、');
            return {
                ok: true, summary: `「${label}」をかけました（${track.name} のクリップ「${clip.name}」${shown ? `。${shown}` : ''}）`,
                track_id: track.id, clip_index: index, effect, params,
            };
        },
    },
};

/** クリップを、Claude に返す形にする（`get_project` のトラックに入れる）。 */
export function describeClips(track: ToolTrack, env: ToolEnv, limit = 20): Record<string, unknown>[] {
    const grid = env.grid();
    return track.clips.slice(0, limit).map((clip, index) => ({
        index, name: clip.name,
        start_seconds: round(clip.offset, 2), duration_seconds: round(clip.duration, 2),
        start_bar: stepToBar(Math.max(0, Math.floor(secToStep(clip.offset, grid) + 1e-6)), grid),
        ...(clip.missing ? { missing: true } : {}),
    }));
}
