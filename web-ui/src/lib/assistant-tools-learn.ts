/**
 * bunri DAW — アシスタントのツール: 学ぶ流れ（差分チェック・再現ガイド・練習画面の設定・メトロノーム・場所を示す）。
 *
 * - `check_diff`: お手本と打ち込みの差分を取る。差分は信号処理の側が出す事実で、Claude は呼ばない（backend/coach_diff.py）。
 *   アシスタントは、返ってきた事実を言葉にするだけ（「DSP が事実を出し、LLM は言語化だけ」）。言語化の API
 *   （`/api/coach/explain`）は呼ばない（Claude をもう 1 回呼ぶことになるため）
 * - `get_guide`: 保存済みの再現ガイドを読む。新しくは作らない（作るのは、利用者が「学ぶ」→「ガイド」で）
 * - `set_practice` / `set_metronome`: 練習の道具。プロジェクトのノートやトラックは変えない
 * - `show_in_app`: 画面の場所を示す（押すのは利用者）
 */
import { issueText, velocityFindingText, velocitySummaryText, type DiffIssue, type DiffResult } from './coach';
import { stepsPerBar } from './grid';
import type { PianoNote } from './engine';
import { MAX_LOOP_BARS, SPEEDS, speedLabel, type ListenMode } from './practice';
import { LANDMARKS } from './assistant-landmarks';
import {
    ArgError, ToolError, barsLabel, choice, flag, formatPitch, integer, settle, trackOf,
    type ToolEnv, type ToolPracticeSettings, type ToolSpec, type ToolTrack,
} from './assistant-tool-kit';

/** `check_diff` が 1 回で返す指摘の数の上限。 */
export const MAX_ISSUES = 80;

/** 聴く、の呼び名。 */
const LISTEN_LABELS: Record<ListenMode, string> = { part: 'パート', self: '自分', both: '両方' };

/** 選べる速度（%）。 */
const SPEED_PERCENTS = SPEEDS.map((s) => Math.round(s * 100));

/** ドラムのパートか（差分チェックの対象外。種類ごとに決まった高さへ置いた近似のため）。 */
function isDrum(track: ToolTrack): boolean {
    return !!track.part && track.part.includes('drum');
}

/** そのトラックの打ち込みと比べる、お手本を持つトラック。 */
function referenceFor(args: Record<string, unknown>, track: ToolTrack, env: ToolEnv): ToolTrack {
    const tracks = env.tracks();
    const explicit = integer(args, 'reference_track_id');
    let reference: ToolTrack | undefined;
    if (explicit !== undefined) {
        reference = tracks.find((t) => t.id === explicit);
        if (!reference) throw new ToolError(`reference_track_id ${explicit} のトラックはありません。get_project で id を確かめてください`, 'お手本のトラックが見つかりませんでした');
    } else if ((track.referenceNotes?.length ?? 0) > 0) {
        reference = track;
    } else if (track.role === 'practice' && track.practiceOf !== undefined) {
        reference = tracks.find((t) => t.id === track.practiceOf);
    }
    if (!reference || !(reference.referenceNotes && reference.referenceNotes.length > 0)) {
        const withReference = tracks.filter((t) => (t.referenceNotes?.length ?? 0) > 0);
        throw new ToolError(withReference.length === 0
            ? `「${track.name}」と比べるお手本がありません。お手本は、利用者が曲をパートに分けるか、MIDI ファイルをお手本として読み込むとできます`
            : `「${track.name}」と比べるお手本が分かりません。reference_track_id で、お手本を持つトラックを指定してください: ${withReference.map((t) => `${t.id}（${t.name}）`).join('、')}`,
        withReference.length === 0
            ? `「${track.name}」と比べるお手本がありません（お手本は、曲をパートに分けるか、MIDI ファイルをお手本として読み込むとできます）`
            : `「${track.name}」と比べるお手本が、どのトラックか分かりませんでした`);
    }
    if (isDrum(reference)) throw new ToolError(`「${reference.name}」はドラムのパートです。ドラムは差分チェックの対象外です（採譜したリズムを、決まった高さに置いた近似のため）`);
    return reference;
}

/** ノートを、Claude に返す形にする。 */
function noteData(n: PianoNote | null): Record<string, unknown> | null {
    return n ? { pitch: formatPitch(n), step: n.step, length: n.length } : null;
}

/** 指摘を、Claude に返す形にする（事実と、決まった型の 1 行の文）。 */
function issueData(issue: DiffIssue): Record<string, unknown> {
    return {
        kind: issue.kind, bar: issue.bar, beat: issue.beat, text: issueText(issue),
        ...(issue.expected ? { expected: noteData(issue.expected) } : {}),
        ...(issue.actual ? { actual: noteData(issue.actual) } : {}),
        ...(issue.offset_steps ? { offset_steps: issue.offset_steps } : {}),
        ...(issue.length_diff ? { length_diff: issue.length_diff } : {}),
    };
}

/** 差分の結果を、Claude に返すデータにする。 */
function diffData(result: DiffResult): Record<string, unknown> {
    const issues = result.bars.flatMap((b) => b.issues);
    const { reference_count, attempt_count, exact, accuracy, ...counts } = result.summary;
    return {
        match_percent: Math.round(accuracy * 100),
        reference_count, attempt_count, exact, counts,
        worst_bars: result.worst_bars,
        issue_count: issues.length,
        issues: issues.slice(0, MAX_ISSUES).map(issueData),
        ...(issues.length > MAX_ISSUES ? { issues_truncated: true } : {}),
        ...(result.velocity ? {
            velocity: {
                summary: velocitySummaryText(result.velocity),
                findings: result.velocity.findings.map((f) => velocityFindingText(f, result.velocity!)),
            },
        } : {}),
    };
}

/** 学ぶ流れのツール。名前は台帳（`backend/assistant_tools.json`）と同じ。 */
export const LEARN_TOOLS: Record<string, ToolSpec> = {
    check_diff: {
        label: 'お手本と比べる', running: 'お手本と比べています…', access: 'read', keys: ['track_id', 'reference_track_id', 'start_bar', 'end_bar'],
        run: async (args, env) => {
            const track = trackOf(args, env);
            const reference = referenceFor(args, track, env);
            const perBar = stepsPerBar(env.grid());
            const startBar = integer(args, 'start_bar', { min: 1 });
            const endBar = integer(args, 'end_bar', { min: 1 });
            if (startBar !== undefined && endBar !== undefined && endBar < startBar) {
                throw new ArgError(`end_bar は start_bar 以上にしてください（いまは start_bar ${startBar}、end_bar ${endBar}）`);
            }
            const practice = env.practice();
            const settings = env.practiceSettings();
            const onScreen = practice.open && practice.partId === reference.id && practice.trackId === track.id;
            // 練習画面が比べる範囲 (区間ループが入っていればその区間、無ければ全体)
            const screenRange = onScreen && settings?.loop.enabled
                ? { start: (settings.loop.startBar - 1) * perBar, end: settings.loop.endBar * perBar } : null;
            // 範囲の指定が無ければ、練習画面のあいだは画面と同じ範囲、ほかは全体
            const range = startBar === undefined && endBar === undefined
                ? screenRange
                : { start: ((startBar ?? 1) - 1) * perBar, end: endBar !== undefined ? endBar * perBar : Infinity };
            const inRange = (n: PianoNote) => !range || (n.step >= range.start && n.step < range.end);
            const referenceNotes = reference.referenceNotes!.filter(inRange);
            const attemptNotes = track.pianoNotes.filter(inRange);
            const lastStep = Math.max(...reference.referenceNotes!.map((n) => n.step + n.length), ...track.pianoNotes.map((n) => n.step + n.length), 1);
            // 終わりを省いた範囲は、ノートの在るところまでを言う
            const whereBars = range ? barsLabel(range.start, Number.isFinite(range.end) ? range.end : Math.max(lastStep, range.start + 1), perBar) : '曲全体';
            if (referenceNotes.length === 0) {
                throw new ToolError(`その範囲（${whereBars}）には、お手本のノートがありません。get_notes の source "reference" で、お手本の在る小節を確かめてください`,
                    `その範囲（${whereBars}）には、お手本のノートがありません`);
            }
            // 画面と同じ範囲なら、練習画面の「比べる」を通す (ノートに色が付き、学習の記録に残る)
            const sameAsScreen = onScreen && ((range === null && screenRange === null)
                || (range !== null && screenRange !== null && range.start === screenRange.start && range.end === screenRange.end));
            let result: DiffResult | null = null;
            let shown = false;
            if (sameAsScreen) {
                result = await env.practiceCompare();
                shown = result !== null;
            }
            result ??= await env.requestDiff(referenceNotes, attemptNotes, perBar, env.referenceSource(reference.id));
            const data = diffData(result);
            const issueCount = data.issue_count as number;
            return {
                ok: true,
                summary: `お手本と比べました（${track.name}、${whereBars}。一致 ${data.match_percent}%、違い ${issueCount} 件）`
                    + (shown ? '。違うノートに色を付けました' : ''),
                track_id: track.id, reference_track_id: reference.id, range: whereBars,
                ...data, shown_on_screen: shown,
            };
        },
    },

    get_guide: {
        label: '再現ガイドを読む', running: '再現ガイドを読んでいます…', access: 'read', keys: ['section_id'],
        run: async (args, env) => {
            const chart = env.chart(), chartId = env.chartId();
            if (!chart || !chartId) throw new ToolError('まだカルテがありません。再現ガイドは、曲を取り込んでカルテができてから作れます');
            let sectionId: string | null = null;
            if (args.section_id !== undefined && args.section_id !== null) {
                if (typeof args.section_id !== 'string' || !chart.sections.some((s) => s.id === args.section_id)) {
                    throw new ArgError(`section_id は、get_chart の sections の id のどれかにしてください: ${chart.sections.map((s) => s.id).join(', ')}。曲全体のガイドなら、省いてください`);
                }
                sectionId = args.section_id;
            }
            const saved = await env.savedGuide(chartId, sectionId);
            const target = sectionId ? `構成の区間 ${sectionId}` : '曲全体';
            if (!saved.saved) {
                return {
                    ok: true, saved: false,
                    summary: `保存済みの再現ガイドは、まだありません（${target}）`,
                    how_to_create: '再現ガイドは、利用者が左のパネルの「学ぶ」→「ガイド」で作ります（Claude を 1 回呼ぶので、費用がかかります）。アシスタントからは作れません',
                };
            }
            const guide = saved.guide;
            return {
                ok: true, saved: true,
                summary: `保存済みの再現ガイドを読みました（${target}、手順 ${guide.steps.length} 個）`,
                overview: guide.overview,
                steps: guide.steps.map((s) => ({ title: s.title, topic: s.topic, body: s.body, refs: s.refs })),
                cautions: guide.cautions,
                ...(saved.created_at ? { created_at: saved.created_at } : {}),
            };
        },
    },

    set_practice: {
        label: '練習の設定を変える', running: '練習の設定を変えています…', access: 'write',
        keys: ['loop', 'loop_start_bar', 'loop_end_bar', 'speed_percent', 'listen', 'show_reference'],
        run: async (args, env) => {
            const before = env.practiceSettings();
            if (!env.practice().open || !before) {
                throw new ToolError('練習画面を開いていません。区間ループ・速度・聴くは、練習画面の設定です。先に open_practice で、パートの練習画面を開いてください',
                    '練習画面を開いていません（区間ループ・速度・聴くは、練習画面の設定です）');
            }
            const loopOn = flag(args, 'loop');
            const startBar = integer(args, 'loop_start_bar', { min: 1 });
            const endBar = integer(args, 'loop_end_bar', { min: 1 });
            const speedPercent = integer(args, 'speed_percent');
            const listen = choice(args, 'listen', ['part', 'self', 'both'] as const);
            const showReference = flag(args, 'show_reference');
            if ([loopOn, startBar, endBar, speedPercent, listen, showReference].every((v) => v === undefined)) {
                throw new ArgError('変える項目を 1 つ以上指定してください（loop / loop_start_bar / loop_end_bar / speed_percent / listen / show_reference）');
            }
            if (speedPercent !== undefined && !SPEED_PERCENTS.includes(speedPercent)) {
                throw new ArgError(`speed_percent は ${SPEED_PERCENTS.join('・')} のどれかにしてください（いまは ${speedPercent}）`);
            }
            const patch: Partial<ToolPracticeSettings> = {};
            if (loopOn !== undefined || startBar !== undefined || endBar !== undefined) {
                const start = startBar ?? before.loop.startBar;
                // 始まりだけを動かしたら、長さは変えない
                const end = endBar ?? (startBar !== undefined ? start + (before.loop.endBar - before.loop.startBar) : before.loop.endBar);
                if (end < start) throw new ArgError(`loop_end_bar は loop_start_bar 以上にしてください（いまは ${start}〜${end} 小節）`);
                if (end - start + 1 > MAX_LOOP_BARS) throw new ToolError(`区間ループは ${MAX_LOOP_BARS} 小節までです（いまは ${start}〜${end} 小節で ${end - start + 1} 小節）`);
                // 範囲を指定したら、区間ループを入れる (止めたいときは loop: false)
                patch.loop = { startBar: start, endBar: end, enabled: loopOn ?? (startBar !== undefined || endBar !== undefined ? true : before.loop.enabled) };
            }
            if (speedPercent !== undefined) patch.speed = speedPercent / 100;
            if (listen !== undefined) patch.listen = listen;
            if (showReference !== undefined) patch.showGhost = showReference;
            const want = { ...before, ...patch };
            const same = (a: ToolPracticeSettings, b: ToolPracticeSettings) => a.loop.startBar === b.loop.startBar && a.loop.endBar === b.loop.endBar
                && a.loop.enabled === b.loop.enabled && a.speed === b.speed && a.listen === b.listen && a.showGhost === b.showGhost;
            if (!same(before, want)) {
                env.updatePractice(patch);
                await settle(() => { const now = env.practiceSettings(); return !!now && same(now, want); });
            }
            const now = env.practiceSettings() ?? want;
            const changes: string[] = [];
            if (now.loop.enabled !== before.loop.enabled || now.loop.startBar !== before.loop.startBar || now.loop.endBar !== before.loop.endBar) {
                changes.push(now.loop.enabled ? `区間ループ ${now.loop.startBar}〜${now.loop.endBar} 小節` : '区間ループを止める');
            }
            if (now.speed !== before.speed) changes.push(`速度 ${speedLabel(now.speed)}`);
            if (now.listen !== before.listen) changes.push(`聴く: ${LISTEN_LABELS[now.listen]}`);
            if (now.showGhost !== before.showGhost) changes.push(now.showGhost ? 'お手本を見せる' : 'お手本を隠す');
            return {
                ok: true,
                summary: changes.length ? `練習の設定を変えました（${changes.join('、')}）` : '練習の設定は、すでにそのとおりです',
                loop: { start_bar: now.loop.startBar, end_bar: now.loop.endBar, enabled: now.loop.enabled },
                speed_percent: Math.round(now.speed * 100), listen: now.listen, show_reference: now.showGhost,
                // 速度は、区間ループの中でだけ効く (練習画面の決まり)
                ...(now.speed !== 1 && !now.loop.enabled ? { note: '速度は、区間ループの中で効きます。区間ループを入れると（loop: true）、遅くなります' } : {}),
            };
        },
    },

    set_metronome: {
        label: 'メトロノームを切り替える', running: 'メトロノームを切り替えています…', access: 'write', keys: ['on'],
        run: (args, env) => {
            const on = flag(args, 'on');
            if (on === undefined) throw new ArgError('on を指定してください（true で鳴らす、false で止める）');
            if (env.metronome() === on) return { ok: true, summary: on ? 'メトロノームは、すでに入っています' : 'メトロノームは、すでに止まっています', on };
            env.setMetronome(on);
            return { ok: true, summary: on ? 'メトロノームを入れました（再生中、拍に合わせてクリック音が鳴ります）' : 'メトロノームを止めました', on };
        },
    },

    show_in_app: {
        label: '場所を示す', running: '場所を示しています…', access: 'read', keys: ['target'],
        run: async (args, env) => {
            const names = Object.keys(LANDMARKS);
            const target = choice(args, 'target', names, true)!;
            const landmark = LANDMARKS[target];
            const { shown } = await env.pointAt(target);
            return {
                ok: true,
                summary: shown ? `「${landmark.label}」の場所を示しました` : `「${landmark.label}」は、いまは画面に出ていません`,
                target, label: landmark.label, where: landmark.where, shown,
                // 左のパネルの場所は、練習画面のあいだは隠れている (その場所の出る条件より、こちらが先)
                ...(!shown ? {
                    when: landmark.open && env.practice().open
                        ? '練習画面のあいだは、左のパネルが隠れています。練習画面を閉じると出ます（close_practice）'
                        : landmark.when ?? 'いまの画面には出ていません',
                } : {}),
            };
        },
    },
};
