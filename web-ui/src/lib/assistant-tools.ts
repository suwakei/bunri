/**
 * bunri DAW — アシスタント（アプリの中のチャット）のツールの実行。
 *
 * Claude が呼ぶツール（台帳は `backend/assistant_tools.json`）を、画面の側で実行する。トラックもノートも再生も
 * 画面の中に在るため（docs/assistant-design.md）。台帳と同じ名前の実行する関数を `TOOLS` に持つ。
 * 名前・ラベル・引数の名前の過不足は、単体テストが台帳を読んで止める。
 *
 * - 引数は `unknown` として受け、ここで確かめる（台帳は `strict` を使わない）。だめなら、何を直せば通るかが分かる文で
 *   失敗させる（`ToolError`。呼ぶ側が `is_error` の結果にして Claude に返し、Claude は直して呼び直せる）
 * - 成功は `{ ok: true, summary: '<日本語の 1 行>', …データ }`。`summary` は、操作ログの行にそのまま出る
 * - 確かめと変換の部品（高さの読み取り、範囲の絞り込み、差し替え後の配列の計算）と、画面の入口の形（`ToolEnv`）は
 *   lib/assistant-tool-kit.ts。本物の入口は lib/assistant-env.ts が `useDaw()` などから作り、テストは偽物を渡す
 * - ツールは種類ごとにファイルを分けてある。ここ: プロジェクトを読む・再生・トラック・ノートを置く / 消す / 置き換える・
 *   練習画面の開閉・MIDI 入力。lib/assistant-tools-notes.ts: ノートの変形。lib/assistant-tools-learn.ts: 差分チェック・
 *   再現ガイド・練習の設定・場所を示す。lib/assistant-tools-app.ts: パート分離・書き出し・保存・クリップ・エフェクト
 *
 * 位置はステップ（16 分音符。0 が 1 小節目の頭。小数も可: 0.5 = 32 分音符、4/3 = 8 分の三連）、小節は 1 から、
 * 高さは `"C4"` の形。
 */
import { barToSec, inStepRange, secToStep, stepToBar, stepsPerBar, roundBpm } from './grid';
import { GAIN_MAX_DB, GAIN_MIN_DB, formatGainDb, formatPan } from './mix';
import type { RecordMode } from './midi-input';
import { midiModeGuidance } from './midi-guidance';
import {
    ArgError, BPM_MAX, BPM_MIN, MAX_NOTES_READ, ToolError, addNotes, barsLabel, barsOfNotes, byPosition, choice, describeNote, fields, flag,
    formatPitch, integer, meterLabel, number, parsePitch, readNotes, readRange, readTrackName, removeNotes, replaceNotes, roleOf,
    round, settle, stepOut, trackOf,
    NO_TURN, type ToolEnv, type ToolOutcome, type ToolSpec, type ToolTurn,
} from './assistant-tool-kit';

import { NOTE_TOOLS, pickNotes } from './assistant-tools-notes';
import { LEARN_TOOLS } from './assistant-tools-learn';
import { APP_TOOLS, describeClips } from './assistant-tools-app';

export * from './assistant-tool-kit';

const MODE_LABELS: Record<RecordMode, string> = { off: '録らない（音だけ）', step: 'ステップ入力', realtime: 'リアルタイム録音' };

// ---- ツール ----

/** ツールの表。名前は台帳（`backend/assistant_tools.json`）と同じ。 */
export const TOOLS: Record<string, ToolSpec> = {
    get_project: {
        label: 'プロジェクトの様子を見る', running: 'プロジェクトの様子を見ています…', access: 'read', keys: [],
        run: (_args, env) => {
            const grid = env.grid(), perBar = stepsPerBar(grid), tracks = env.tracks();
            const seconds = env.durationSec();
            const lengthSteps = Math.max(0, Math.ceil(secToStep(seconds, grid) - 1e-6));
            const positionStep = Math.max(0, Math.floor(secToStep(env.positionSec(), grid) + 1e-6));
            const practice = env.practice();
            const settings = practice.open ? env.practiceSettings() : null;
            const selection = env.selection();
            const selected = selection ? (tracks.find((t) => t.id === selection.trackId)?.pianoNotes ?? []).filter((_n, i) => selection.indices.includes(i)) : [];
            return {
                ok: true,
                summary: `プロジェクトの様子を見ました（トラック ${tracks.length} 本、${grid.bpm} BPM、${meterLabel(grid.beatsPerBar)}）`,
                bpm: grid.bpm,
                beats_per_bar: grid.beatsPerBar,
                time_signature: meterLabel(grid.beatsPerBar),
                steps_per_bar: perBar,
                song_length: { seconds: round(seconds, 2), steps: lengthSteps, bars: Math.ceil(lengthSteps / perBar) },
                tracks: tracks.map((t) => ({
                    id: t.id, name: t.name, role: roleOf(t),
                    ...(t.role === 'practice' && t.practiceOf !== undefined ? { practice_of: t.practiceOf } : {}),
                    mute: t.mute, solo: t.solo, gain_db: round(t.gain, 1), pan: round(t.pan, 2),
                    note_count: t.pianoNotes.length, clip_count: t.clips.length,
                    has_reference: (t.referenceNotes?.length ?? 0) > 0,
                    // 音声のクリップ (clip_index は、この並びの番号)
                    ...(t.clips.length > 0 ? { clips: describeClips(t, env) } : {}),
                })),
                open_track_id: env.activeTrackId(),
                playing: env.playing(),
                position: { seconds: round(env.positionSec(), 2), step: positionStep, bar: stepToBar(positionStep, grid) },
                metronome: env.metronome(),
                has_chart: env.chart() !== null,
                practice: {
                    open: practice.open, part_track_id: practice.open ? practice.partId : null, track_id: practice.open ? practice.trackId : null,
                    ...(settings ? {
                        loop: { start_bar: settings.loop.startBar, end_bar: settings.loop.endBar, enabled: settings.loop.enabled },
                        speed_percent: Math.round(settings.speed * 100), listen: settings.listen, show_reference: settings.showGhost,
                    } : {}),
                },
                // ピアノロールで選んでいるノート (利用者が「選んだところ」「ここ」と言ったら、これ)
                selection: selection && selected.length > 0 ? {
                    track_id: selection.trackId, count: selected.length,
                    start_step: stepOut(Math.min(...selected.map((n) => n.step))), end_step: stepOut(Math.max(...selected.map((n) => n.step + n.length))),
                    bars: barsOfNotes(selected, perBar),
                } : null,
                // 学ぶ流れの進み具合 (曲を取り込む → カルテ → パートに分ける → 打ち込む → 差分で直す)
                learn: (({ imported, hasChart, separated, practiced, diffed }) => ({ imported, has_chart: hasChart, separated, practiced, compared: diffed }))(env.learn()),
                project: (({ name, dirty }) => ({ name, unsaved_changes: dirty }))(env.project()),
                // 動いている、時間のかかる処理 (パート分離など)。詳しくは get_job
                job: (() => { const job = env.job(); return job ? { title: job.title, state: job.state, stage: job.stage } : null; })(),
            };
        },
    },

    get_notes: {
        label: 'ノートを読む', running: 'ノートを読んでいます…', access: 'read', keys: ['track_id', 'source', 'start_bar', 'end_bar', 'selected_only'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const source = choice(args, 'source', ['notes', 'reference'] as const) ?? 'notes';
            const startBar = integer(args, 'start_bar', { min: 1 });
            const endBar = integer(args, 'end_bar', { min: 1 });
            if (startBar !== undefined && endBar !== undefined && endBar < startBar) {
                throw new ArgError(`end_bar は start_bar 以上にしてください（いまは start_bar ${startBar}、end_bar ${endBar}）`);
            }
            if (source === 'reference' && !(track.referenceNotes && track.referenceNotes.length > 0)) {
                throw new ToolError(`「${track.name}」には、お手本がありません。お手本を持つのは、get_project で has_reference が true のトラックです`,
                    `「${track.name}」には、お手本がありません`);
            }
            const perBar = stepsPerBar(env.grid());
            const from = startBar !== undefined ? (startBar - 1) * perBar : 0;
            const to = endBar !== undefined ? endBar * perBar : Infinity;
            // ピアノロールで選んでいるノート (打ち込みのノートだけ。お手本は選べない)
            const selectedOnly = flag(args, 'selected_only') === true;
            const selection = source === 'notes' ? env.selection() : null;
            const chosen = new Set(selection && selection.trackId === track.id ? selection.indices.map((i) => track.pianoNotes[i]) : []);
            if (selectedOnly && source === 'reference') throw new ArgError('selected_only は、source が "notes" のときだけ使えます（お手本のノートは選べません）');
            if (selectedOnly && chosen.size === 0) {
                throw new ToolError(`「${track.name}」には、いま選んでいるノートがありません`
                    + (selection && selection.trackId !== track.id ? `（選んでいるのは track_id ${selection.trackId} のノートです）` : ''),
                    `「${track.name}」には、いま選んでいるノートがありません`);
            }
            const all = (source === 'reference' ? track.referenceNotes! : track.pianoNotes)
                .filter((n) => inStepRange(n.step, from, to) && (!selectedOnly || chosen.has(n))).slice().sort(byPosition);
            const notes = all.slice(0, MAX_NOTES_READ);
            const truncated = all.length > notes.length;
            const what = source === 'reference' ? 'お手本' : 'ノート';
            const first = startBar ?? 1;
            const where = startBar === undefined && endBar === undefined ? ''
                : endBar === undefined ? `（${first} 小節から）`
                    : first === endBar ? `（${endBar} 小節）` : `（${first}〜${endBar} 小節）`;
            return {
                ok: true,
                summary: truncated
                    ? `「${track.name}」の${what}を、${all.length} 個のうち ${notes.length} 個まで読みました${where}`
                    : `「${track.name}」の${what}を ${notes.length} 個読みました${where}`,
                track_id: track.id, source, steps_per_bar: perBar,
                total: all.length, returned: notes.length, truncated,
                notes: notes.map((n) => (chosen.has(n) && !selectedOnly ? { ...describeNote(n), selected: true } : describeNote(n))),
            };
        },
    },

    get_chart: {
        label: 'カルテを読む', running: 'カルテを読んでいます…', access: 'read', keys: [],
        run: (_args, env) => {
            const chart = env.chart();
            if (!chart) {
                throw new ToolError('まだカルテがありません。曲を取り込むと、カルテができます（曲の取り込みは、利用者が「曲を取り込む」から行います）',
                    'まだカルテがありません（曲を取り込むと、カルテができます）');
            }
            const key = chart.key.tonic ? `キー ${chart.key.tonic} ${chart.key.mode === 'minor' ? 'マイナー' : 'メジャー'}` : 'キー不明';
            const lastBar = Math.max(0, ...chart.sections.map((s) => s.end_bar), ...chart.chords.map((c) => c.bar));
            return {
                ok: true,
                summary: `カルテを読みました（${key}、${chart.chords.length} コード、構成 ${chart.sections.length} 区間）`,
                key: { tonic: chart.key.tonic, mode: chart.key.mode, confidence: round(chart.key.confidence, 2) },
                bpm: roundBpm(chart.grid.bpm),
                time_signature: `${chart.grid.time_signature[0]}/${chart.grid.time_signature[1]}`,
                bars: lastBar,
                sections: chart.sections.map((s) => ({
                    id: s.id, label: s.label ?? s.suggested_label, label_confirmed: s.label !== null,
                    start_bar: s.start_bar, end_bar: s.end_bar, repeat_group: s.repeat_group,
                })),
                chords: chart.chords.map((c) => ({
                    bar: c.bar, beat: c.beat, beats: c.beat_count, symbol: c.symbol, degree: c.degree,
                    ...(c.confidence < 0.5 ? { low_confidence: true } : {}),
                })),
                ...(Object.keys(chart.unavailable ?? {}).length > 0 ? { unavailable: chart.unavailable } : {}),
            };
        },
    },

    play: {
        label: '再生する', running: '再生しています…', access: 'write', keys: ['from_bar'],
        run: (args, env) => {
            const grid = env.grid();
            const fromBar = integer(args, 'from_bar', { min: 1, max: Math.floor(env.maxSteps() / stepsPerBar(grid)) });
            if (fromBar === undefined) {
                // 再生中にもう一度始めると、頭から鳴り直してしまう。そのままにする
                if (env.playing()) return { ok: true, summary: 'すでに再生中です', playing: true };
                env.play();
                return { ok: true, summary: 'いまの再生位置から再生しました', playing: true };
            }
            env.play(barToSec(fromBar, grid));
            return { ok: true, summary: `${fromBar} 小節目から再生しました`, playing: true, from_bar: fromBar };
        },
    },

    stop: {
        label: '停止する', running: '停止しています…', access: 'write', keys: [],
        run: (_args, env) => {
            env.stop();
            return { ok: true, summary: '停止しました（再生位置は曲の頭に戻りました）', playing: false };
        },
    },

    seek: {
        label: '小節へ移動する', running: '小節へ移動しています…', access: 'write', keys: ['bar'],
        run: (args, env) => {
            const perBar = stepsPerBar(env.grid());
            const bar = integer(args, 'bar', { min: 1, max: Math.floor(env.maxSteps() / perBar), required: true })!;
            env.seekStep((bar - 1) * perBar);
            return { ok: true, summary: `${bar} 小節目へ移動しました`, bar, step: (bar - 1) * perBar };
        },
    },

    set_tempo: {
        label: 'テンポを変える', running: 'テンポを変えています…', access: 'write', keys: ['bpm'],
        run: (args, env) => {
            const bpm = roundBpm(number(args, 'bpm', { min: BPM_MIN, max: BPM_MAX, required: true })!);
            const before = env.grid().bpm;
            if (bpm === before) return { ok: true, summary: `テンポは ${bpm} BPM のままです`, bpm };
            const tracks = env.tracks();
            env.setBpm(bpm);
            // 音声は伸び縮みしない。お手本と音声クリップは、変える前のテンポに合っている
            const warning = tracks.some((t) => t.role === 'part' || t.role === 'song')
                ? '原曲とパートの音声・お手本は、変える前のテンポに合っています（音声は伸び縮みしません）。ノートだけが新しいテンポで鳴ります'
                : tracks.some((t) => t.clips.length > 0) ? '音声のクリップは伸び縮みしません。ノートだけが新しいテンポで鳴ります' : undefined;
            return { ok: true, summary: `テンポを ${bpm} BPM にしました（前は ${before} BPM）`, bpm, previous_bpm: before, ...(warning ? { warning } : {}) };
        },
    },

    set_time_signature: {
        label: '拍子を変える', running: '拍子を変えています…', access: 'write', keys: ['beats_per_bar'],
        run: (args, env) => {
            const beats = integer(args, 'beats_per_bar', { required: true })!;
            if (![3, 4, 6].includes(beats)) throw new ArgError(`beats_per_bar は 3（3/4）・4（4/4）・6（6/8）のどれかにしてください（いまは ${beats}）`);
            const before = env.grid().beatsPerBar;
            if (beats !== before) env.setBeatsPerBar(beats);
            const perBar = stepsPerBar({ beatsPerBar: beats });
            return {
                ok: true,
                summary: beats === before ? `拍子は ${meterLabel(beats)} のままです` : `拍子を ${meterLabel(beats)} にしました（前は ${meterLabel(before)}）`,
                beats_per_bar: beats, time_signature: meterLabel(beats), steps_per_bar: perBar,
            };
        },
    },

    add_track: {
        label: 'トラックを追加する', running: 'トラックを追加しています…', access: 'write', keys: ['name'],
        run: (args, env) => {
            const name = args.name === undefined || args.name === null ? undefined : readTrackName(args.name);
            const track = env.addTrack(name);
            // 練習画面のあいだは、ピアノロールを練習のトラックから動かさない
            const opened = !env.practice().open;
            if (opened) env.selectTrack(track.id);
            return {
                ok: true,
                summary: `「${track.name}」を追加しました${opened ? '' : '（練習画面のあいだなので、ピアノロールでは開いていません）'}`,
                track_id: track.id, name: track.name, opened,
            };
        },
    },

    rename_track: {
        label: 'トラックの名前を変える', running: 'トラックの名前を変えています…', access: 'write', keys: ['track_id', 'name'],
        run: (args, env) => {
            const track = trackOf(args, env);
            if (args.name === undefined || args.name === null) throw new ArgError('name を指定してください（新しい名前。1〜40 文字）');
            const name = readTrackName(args.name);
            const before = track.name;
            if (name === before) return { ok: true, summary: `名前は「${before}」のままです`, track_id: track.id, name };
            env.renameTrack(track.id, name);
            return { ok: true, summary: `「${before}」の名前を「${name}」に変えました`, track_id: track.id, name, previous_name: before };
        },
    },

    delete_track: {
        label: 'トラックを削除する', running: 'トラックを削除しています…', access: 'write', keys: ['track_id'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const practice = env.practice();
            if (practice.open && (track.id === practice.partId || track.id === practice.trackId)) {
                throw new ToolError(`「${track.name}」は、いま練習画面で使っているトラックです。削除するなら、先に close_practice で練習画面を閉じてください`,
                    `「${track.name}」は、いま練習画面で使っているトラックです。練習画面を閉じてからでないと、削除できません`);
            }
            const name = track.name, notes = track.pianoNotes.length, clips = track.clips.length;
            env.deleteTrack(track.id);
            return { ok: true, summary: `「${name}」を削除しました（ノート ${notes} 個、クリップ ${clips} 個）`, track_id: track.id, name };
        },
    },

    select_track: {
        label: 'トラックを開く', running: 'トラックを開いています…', access: 'write', keys: ['track_id'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const practice = env.practice();
            if (practice.open && track.id !== practice.trackId) {
                throw new ToolError('練習画面のあいだは、ほかのトラックをピアノロールで開けません。先に close_practice で練習画面を閉じてください（ノートのツールは、開いていないトラックにも使えます）',
                    '練習画面のあいだは、ほかのトラックをピアノロールで開けません');
            }
            env.selectTrack(track.id);
            return { ok: true, summary: `「${track.name}」をピアノロールで開きました`, track_id: track.id, name: track.name };
        },
    },

    set_track_mix: {
        label: 'ミュート・ソロ・音量・パンを変える', running: 'ミュート・ソロ・音量・パンを変えています…', access: 'write',
        keys: ['track_id', 'mute', 'solo', 'gain_db', 'pan'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const mute = flag(args, 'mute'), solo = flag(args, 'solo');
            const gain = number(args, 'gain_db', { min: GAIN_MIN_DB, max: GAIN_MAX_DB });
            const pan = number(args, 'pan', { min: -1, max: 1 });
            if (mute === undefined && solo === undefined && gain === undefined && pan === undefined) {
                throw new ArgError('変える項目を 1 つ以上指定してください（mute / solo / gain_db / pan）');
            }
            // どれが変わるかは、変える前に決める (トラックは、変えると中身が書き換わる)
            const name = track.name;
            const muteTo = mute !== undefined && mute !== track.mute ? mute : undefined;
            const soloTo = solo !== undefined && solo !== track.solo ? solo : undefined;
            const gainTo = gain !== undefined && gain !== track.gain ? gain : undefined;
            const panTo = pan !== undefined && pan !== track.pan ? pan : undefined;
            const changes: string[] = [];
            if (muteTo !== undefined) { env.setMute(track.id, muteTo); changes.push(muteTo ? 'ミュート' : 'ミュートを解除'); }
            if (soloTo !== undefined) { env.setSolo(track.id, soloTo); changes.push(soloTo ? 'ソロ' : 'ソロを解除'); }
            if (gainTo !== undefined) { env.setGain(track.id, gainTo); changes.push(`音量 ${formatGainDb(gainTo)}`); }
            if (panTo !== undefined) { env.setPan(track.id, panTo); changes.push(`パン ${formatPan(panTo)}`); }
            const now = env.tracks().find((t) => t.id === track.id) ?? track;
            let summary: string;
            if (changes.length === 0) summary = `「${name}」は、すでにその設定です`;
            else if (changes.length > 1) summary = `「${name}」を変えました（${changes.join('、')}）`;
            else if (muteTo !== undefined) summary = muteTo ? `「${name}」をミュートしました` : `「${name}」のミュートを解除しました`;
            else if (soloTo !== undefined) summary = soloTo ? `「${name}」をソロにしました` : `「${name}」のソロを解除しました`;
            else if (gainTo !== undefined) summary = `「${name}」の音量を ${formatGainDb(gainTo)} にしました`;
            else summary = `「${name}」のパンを ${formatPan(panTo!)} にしました`;
            return {
                ok: true, summary, track_id: track.id,
                mute: now.mute, solo: now.solo, gain_db: round(now.gain, 1), pan: round(now.pan, 2),
                // 練習画面では「聴く」の設定が鳴らすトラックを決める (ミュートとソロは、アレンジに戻ってから効く)
                ...(env.practice().open && (mute !== undefined || solo !== undefined)
                    ? { note: '練習画面のあいだは、練習画面の「聴く」が鳴らすトラックを決めます。ミュートとソロは、アレンジに戻ってから効きます' } : {}),
            };
        },
    },

    add_notes: {
        label: 'ノートを置く', running: 'ノートを置いています…', access: 'write', keys: ['track_id', 'notes'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const incoming = readNotes(args.notes, env.maxSteps());
            const perBar = stepsPerBar(env.grid());
            const next = addNotes(track.pianoNotes, incoming);
            if (next.added.length === 0) {
                return {
                    ok: true, summary: `置くノートはありませんでした（${incoming.length} 個とも、同じ高さ・同じ位置にすでに在ります。${track.name}）`,
                    track_id: track.id, added: 0, skipped: next.skipped, note_count: track.pianoNotes.length,
                };
            }
            env.setTrackNotes(track.id, next.notes, next.added.length > 1 ? `${next.added.length} ノートを追加` : 'ノートを追加');
            const skipped = next.skipped > 0 ? `。同じ高さ・同じ位置にすでに在る ${next.skipped} 個は置いていません` : '';
            return {
                ok: true,
                summary: `ノートを ${next.added.length} 個置きました（${track.name}、${barsOfNotes(next.added, perBar)}${skipped}）`,
                track_id: track.id, added: next.added.length, skipped: next.skipped, note_count: next.notes.length,
            };
        },
    },

    remove_notes: {
        label: 'ノートを消す', running: 'ノートを消しています…', access: 'write', keys: ['track_id', 'start_step', 'end_step', 'pitches', 'selected_only'],
        run: (args, env) => {
            const track = trackOf(args, env);
            if (flag(args, 'selected_only') === true) {
                // 選んでいるノートを消す (範囲は省ける)
                const picked = pickNotes(args, track, env);
                const rest = track.pianoNotes.filter((_n, i) => !picked.indices.has(i));
                env.setTrackNotes(track.id, rest, picked.indices.size > 1 ? `${picked.indices.size} ノートを削除` : 'ノートを削除');
                return {
                    ok: true, summary: `ノートを ${picked.indices.size} 個消しました（${picked.where}）`,
                    track_id: track.id, removed: picked.indices.size, note_count: rest.length,
                };
            }
            const range = readRange(args);
            let pitches: Set<string> | undefined;
            if (args.pitches !== undefined && args.pitches !== null) {
                if (!Array.isArray(args.pitches) || args.pitches.length === 0) {
                    throw new ArgError('pitches は、高さの並びで指定してください（例: ["C4", "E4"]）。全部の高さを消すなら、pitches を省いてください');
                }
                pitches = new Set(args.pitches.map((p) => formatPitch(parsePitch(p))));
            }
            const perBar = stepsPerBar(env.grid());
            const where = `${track.name}、${barsLabel(range.start, range.end, perBar)}`;
            const next = removeNotes(track.pianoNotes, range.start, range.end, pitches);
            if (next.removed.length === 0) {
                return { ok: true, summary: `その範囲に、消すノートはありませんでした（${where}）`, track_id: track.id, removed: 0, note_count: track.pianoNotes.length };
            }
            env.setTrackNotes(track.id, next.notes, next.removed.length > 1 ? `${next.removed.length} ノートを削除` : 'ノートを削除');
            return {
                ok: true, summary: `ノートを ${next.removed.length} 個消しました（${where}）`,
                track_id: track.id, removed: next.removed.length, note_count: next.notes.length,
            };
        },
    },

    replace_notes: {
        label: 'ノートを置き換える', running: 'ノートを置き換えています…', access: 'write', keys: ['track_id', 'start_step', 'end_step', 'notes'],
        run: (args, env) => {
            const track = trackOf(args, env);
            const range = readRange(args);
            if (args.notes === undefined || args.notes === null) throw new ArgError('notes を指定してください（範囲に置くノートの並び。範囲を空にするなら []）');
            const incoming = readNotes(args.notes, env.maxSteps(), range, true);
            const perBar = stepsPerBar(env.grid());
            const where = `${track.name}、${barsLabel(range.start, range.end, perBar)}`;
            const next = replaceNotes(track.pianoNotes, range.start, range.end, incoming);
            if (next.removed.length === 0 && next.added.length === 0) {
                return { ok: true, summary: `その範囲には、もともとノートがありません（${where}）`, track_id: track.id, removed: 0, added: 0, note_count: track.pianoNotes.length };
            }
            env.setTrackNotes(track.id, next.notes, 'ノートを置き換え');
            return {
                ok: true,
                summary: `ノートを置き換えました（${where}。${next.removed.length} 個 → ${next.added.length} 個）`,
                track_id: track.id, removed: next.removed.length, added: next.added.length, note_count: next.notes.length,
            };
        },
    },

    open_practice: {
        label: '練習画面を開く', running: '練習画面を開いています…', access: 'write', keys: ['track_id'],
        run: async (args, env) => {
            const track = trackOf(args, env);
            if (track.role !== 'part') {
                const parts = env.tracks().filter((t) => t.role === 'part');
                throw new ToolError(parts.length === 0
                    ? `まだパートに分けていないので、練習画面を開けません。利用者が「学ぶ」タブの「パートに分けて採譜する」を行うと、パートのトラックができます（「${track.name}」はパートのトラックではありません）`
                    : `「${track.name}」はパートのトラックではありません。role が "part" のトラックを指定してください: ${parts.map((t) => `${t.id}（${t.name}）`).join('、')}`,
                parts.length === 0
                    ? 'まだパートに分けていないので、練習画面を開けません（「学ぶ」タブの「パートに分けて採譜する」を行うと、パートのトラックができます）'
                    : `「${track.name}」はパートのトラックではないので、練習画面を開けません`);
            }
            if (!(track.referenceNotes && track.referenceNotes.length > 0)) {
                throw new ToolError(`「${track.name}」にはお手本が無いので、練習画面を開けません（get_project で has_reference が true のパートを選んでください）`,
                    `「${track.name}」にはお手本が無いので、練習画面を開けません`);
            }
            env.openPractice(track.id);
            await settle(() => { const p = env.practice(); return p.open && p.partId === track.id; });
            const practice = env.practice();
            if (!practice.open || practice.partId !== track.id) throw new ToolError(`「${track.name}」の練習画面を開けませんでした`);
            const own = env.tracks().find((t) => t.id === practice.trackId);
            return {
                ok: true, summary: `「${track.name}」の練習画面を開きました${own ? `（打ち込むのは「${own.name}」）` : ''}`,
                part_track_id: track.id, practice_track_id: practice.trackId,
            };
        },
    },

    close_practice: {
        label: '練習画面を閉じる', running: '練習画面を閉じています…', access: 'write', keys: [],
        run: async (_args, env) => {
            if (!env.practice().open) return { ok: true, summary: '練習画面は開いていません', open: false };
            env.closePractice();
            await settle(() => !env.practice().open);
            return { ok: true, summary: '練習画面を閉じて、アレンジに戻りました', open: false };
        },
    },

    midi_input: {
        label: 'MIDI 入力を切り替える', running: 'MIDI 入力を切り替えています…', access: 'write', keys: ['action', 'mode'],
        run: async (args, env) => {
            const action = choice(args, 'action', ['connect', 'disconnect'] as const, true)!;
            const mode = choice(args, 'mode', ['off', 'step', 'realtime'] as const);
            const midi = env.midi();
            if (!midi || !midi.available) throw new ToolError('この環境では、MIDI 入力を使えません');
            if (action === 'disconnect') {
                if (mode !== undefined) throw new ArgError('mode は、action が "connect" のときだけ指定できます');
                if (!midi.connected) return { ok: true, summary: 'MIDI 入力は、つないでいません', connected: false, devices: [] };
                await midi.disconnect();
                await settle(() => env.midi()?.connected === false);
                return { ok: true, summary: 'MIDI 入力を止めました', connected: false, devices: [] };
            }
            if (!midi.connected) {
                if (!(await midi.connect())) {
                    throw new ToolError('MIDI 入力を開けませんでした。鍵盤がつながっているかを、利用者に確かめてもらってください',
                        'MIDI 入力を開けませんでした。鍵盤がつながっているかを確かめてください');
                }
                await settle(() => env.midi()?.connected === true);
            }
            if (mode !== undefined) {
                (env.midi() ?? midi).setMode(mode);
                await settle(() => env.midi()?.mode === mode);
            }
            const now = env.midi() ?? midi;
            const current = mode ?? now.mode;
            const keyboards = now.devices.length > 0 ? `鍵盤: ${now.devices.join(' / ')}` : '鍵盤は見つかっていません';
            return {
                ok: true, summary: `MIDI 入力をつなぎました（${keyboards}。録り方: ${MODE_LABELS[current]}）`,
                next_step: now.devices.length === 0
                    ? '鍵盤が見つかりません。鍵盤をつないで電源を入れてから、「再検出」を押してください'
                    : midiModeGuidance(current),
                connected: true, devices: now.devices.slice(), mode: current,
            };
        },
    },

    ...NOTE_TOOLS,
    ...LEARN_TOOLS,
    ...APP_TOOLS,
};

/** その名前のツールが在るか。 */
function has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(TOOLS, name);
}

/** ツールの、画面での名前（台帳の `label`）。知らない名前なら、その名前のまま。 */
export function toolLabel(name: string): string {
    return has(name) ? TOOLS[name].label : name;
}

/** ツールが「変える」操作か（台帳の `access` が `write`）。知らない名前は、変えない扱い（実行しないので）。 */
export function isWriteTool(name: string): boolean {
    return has(name) && TOOLS[name].access === 'write';
}

/**
 * ツールを 1 つ実行する。失敗は例外にせず、理由の文として返す（呼ぶ側が `is_error` の結果にする）。
 *
 * @param name - ツールの名前（台帳の `name`）
 * @param input - Claude が渡した引数（確かめていない値）
 * @param env - 画面の入口
 * @param turn - いまの依頼（選んだモデル・費用の合計・カード）。省くと、何もしない入口
 */
export async function runTool(name: string, input: unknown, env: ToolEnv, turn: ToolTurn = NO_TURN): Promise<ToolOutcome> {
    if (!has(name)) {
        return { ok: false, message: `「${name}」というツールはありません。使えるツール: ${Object.keys(TOOLS).join(', ')}`, shown: 'アシスタントが、このアプリに無い操作を頼みました' };
    }
    const spec = TOOLS[name];
    try {
        return { ok: true, result: await spec.run(fields(input, spec.keys), env, turn) };
    } catch (e) {
        if (e instanceof ToolError) return { ok: false, message: e.message, shown: e.shown };
        // ここに来るのは、画面の側の不具合。理由を添えて返す (Claude は別の手を選べる。利用者には操作ログに出る)
        const message = `${spec.label}の途中で問題が起きました（${String((e as Error)?.message ?? e)}）`;
        return { ok: false, message, shown: message };
    }
}
