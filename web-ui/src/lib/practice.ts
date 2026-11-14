/**
 * bunri DAW — 練習画面（「入力 → 比べる → 直す」を 1 つの画面で回す）の状態と計算。
 *
 * 画面（components/PracticeView.tsx）から切り離して、ここに純粋な計算だけを置く。
 *
 * ## 状態（`PracticeState`）
 *
 * 小さく、そのまま JSON にできる形にしてある。プロジェクト（`.bunri`）の状態の節 `practice` に入る
 * （`practiceToSection` / `practiceFromSection`。登録は lib/practice-project.ts）。
 * トラックは ID で持つ。保存するときは、プロジェクトの保存と同じく並びの番号に直す（ID は読み込むたびに変わる）。
 * 一致の結果（差分）は保存しない（ノートから作り直せる。比べた記録は学習の記録 — lib/learn-history.ts — に残る）。
 *
 * ## 指摘とノートの色（`markNotes`）
 *
 * 差分（backend/coach_diff.py）の指摘は、お手本のノート（expected）と打ち込みのノート（actual）を持つ。
 * 同じ形のノート（音名・オクターブ・位置・長さ）を探して、ノート 1 つ 1 つに印を付ける。
 *
 * | 印 | 付けるノート | 指摘の種類 | 見せ方 |
 * |---|---|---|---|
 * | `ok` | 打ち込み・お手本 | （指摘なし。位置と高さが合っている） | 緑の薄い縁 |
 * | `pitch` | 打ち込み | 高さの違い・オクターブ違い | 黄色の塗りと斜線 |
 * | `rhythm` | 打ち込み | 位置のずれ・長さの違い（高さは合っている） | 黄色の点線の縁と、ずれの向きの印 |
 * | `extra` | 打ち込み | 余分なノート | 赤の塗りと × |
 * | `missing` | お手本 | 抜け | 赤の破線の縁 |
 * | `pitch`（お手本） | お手本 | 高さの違いの相手 | ふだんのお手本のまま（指摘を結ぶだけ） |
 *
 * 色だけに頼らない（模様・縁・凡例・読み上げの名前を付ける）。
 *
 * ## 一致（`matchRate`）
 *
 * 比べた範囲のお手本のうち、高さが同じで、位置が 16 分音符 2 個以内のノートの割合（差分の `accuracy`）。
 * 長さの違いと小さな位置のずれは、合っている側に数える（差分チェックの「〜% が合っています」と同じ数）。
 */
import type { PianoNote, Track } from './engine';
import type { SongChart } from './chart';
import type { DiffIssue, DiffResult, IssueKind } from './coach';
import { issueText, noteName } from './coach';
import { secToStep, stepToBar, stepToSec, stepsPerBar, type ProjectGrid } from './grid';

/** 聴く: パート（パートの音声）/ 自分（自分のノート）/ 両方 */
export type ListenMode = 'part' | 'self' | 'both';

/** 入力: マウス / MIDI ステップ入力 / MIDI リアルタイム録音 */
export type InputMode = 'mouse' | 'midi-step' | 'midi-realtime';

/** 選べる速度（1 = そのまま）。 */
export const SPEEDS = [0.5, 0.6, 0.75, 0.9, 1] as const;

/** 区間ループの長さの上限（小節）。長すぎると速度を変えた音声のメモリが増える */
export const MAX_LOOP_BARS = 32;

/** 区間ループ（小節。どちらも含む）。 */
export interface PracticeLoop {
    startBar: number;
    endBar: number;
    /** 区間を繰り返すか（L キー） */
    enabled: boolean;
}

/** 練習画面の状態。 */
export interface PracticeState {
    /** お手本を持つパートのトラック */
    partId: number;
    /** 打ち込む練習のトラック */
    trackId: number;
    loop: PracticeLoop;
    /** 速度（SPEEDS のどれか） */
    speed: number;
    listen: ListenMode;
    /** お手本を見せるか */
    showGhost: boolean;
    input: InputMode;
}

/** 区間（ステップ。`end` は含まない）。 */
export interface StepRange {
    start: number;
    end: number;
}

/** 区間を、収まる形に直す（1 小節目から、長さは 1〜MAX_LOOP_BARS 小節）。 */
export function clampLoop(loop: PracticeLoop): PracticeLoop {
    const start = Math.max(1, Math.round(loop.startBar) || 1);
    let end = Math.max(start, Math.round(loop.endBar) || start);
    end = Math.min(end, start + MAX_LOOP_BARS - 1);
    return { ...loop, startBar: start, endBar: end };
}

/** 区間を `delta` 小節ずらす（長さは変えない。1 小節目より前には出さない）。 */
export function shiftLoop(loop: PracticeLoop, delta: number): PracticeLoop {
    const length = loop.endBar - loop.startBar;
    const start = Math.max(1, loop.startBar + delta);
    return { ...loop, startBar: start, endBar: start + length };
}

/** 区間のステップの範囲。 */
export function loopSteps(loop: PracticeLoop, grid: Pick<ProjectGrid, 'beatsPerBar'>): StepRange {
    const per = stepsPerBar(grid);
    return { start: (loop.startBar - 1) * per, end: loop.endBar * per };
}

/** 区間の秒の範囲（再生エンジンに渡す）。 */
export function loopSeconds(loop: PracticeLoop, grid: ProjectGrid): { start: number; end: number } {
    const steps = loopSteps(loop, grid);
    return { start: stepToSec(steps.start, grid), end: stepToSec(steps.end, grid) };
}

/** 秒の範囲（構成の区間など）を、それを覆う小節の区間にする。 */
export function secondsToLoop(startSec: number, endSec: number, grid: ProjectGrid, enabled = true): PracticeLoop {
    const per = stepsPerBar(grid);
    const startStep = Math.max(0, Math.round(secToStep(startSec, grid)));
    const endStep = Math.max(startStep + 1, Math.round(secToStep(endSec, grid)));
    return clampLoop({ startBar: Math.floor(startStep / per) + 1, endBar: Math.ceil(endStep / per), enabled });
}

/**
 * 練習画面を開いたときの区間。お手本の最初のノートが在る構成の区間（8 小節まで）。
 * カルテが無ければ、最初のノートの小節から 4 小節。
 */
export function defaultLoop(reference: PianoNote[], grid: ProjectGrid, chart: SongChart | null): PracticeLoop {
    const first = reference.length ? Math.min(...reference.map((n) => n.step)) : 0;
    const firstBar = stepToBar(first, grid);
    const sec = stepToSec(first, grid);
    const section = chart?.sections.find((s) => s.start_sec <= sec + 1e-6 && sec < s.end_sec);
    if (section) {
        const loop = secondsToLoop(section.start_sec, section.end_sec, grid);
        if (loop.startBar <= firstBar && loop.endBar >= firstBar) {
            return { ...loop, endBar: Math.min(loop.endBar, loop.startBar + 7) };
        }
    }
    return { startBar: firstBar, endBar: firstBar + 3, enabled: true };
}

/** 練習画面を開いたときの状態。 */
export function defaultPracticeState(partId: number, trackId: number, reference: PianoNote[], grid: ProjectGrid, chart: SongChart | null): PracticeState {
    return {
        partId, trackId,
        loop: defaultLoop(reference, grid, chart),
        speed: 1, listen: 'both', showGhost: true, input: 'mouse',
    };
}

// ---- プロジェクトへの保存（状態の節 `practice`） ----

/** 状態の節 `practice` の版。形を変えたら上げ、`practiceFromSection` で古い版を読めるようにする。 */
export const PRACTICE_SECTION_VERSION = 1;

const LISTEN_MODES: readonly ListenMode[] = ['part', 'self', 'both'];
const INPUT_MODES: readonly InputMode[] = ['mouse', 'midi-step', 'midi-realtime'];

/** 保存に使う設定が同じか（区間・速度・聴く・お手本・入力と、どのトラックか）。 */
export function samePracticeSettings(a: PracticeState, b: PracticeState): boolean {
    return a.partId === b.partId && a.trackId === b.trackId
        && a.loop.startBar === b.loop.startBar && a.loop.endBar === b.loop.endBar && a.loop.enabled === b.loop.enabled
        && a.speed === b.speed && a.listen === b.listen && a.showGhost === b.showGhost && a.input === b.input;
}

/**
 * 練習画面の状態を、プロジェクトに入れる形にする。トラックは並びの番号で持つ（ID は開き直すたびに変わる）。
 * パートか練習のトラックがもう無ければ null（入れない）。
 *
 * @param state - 練習画面の状態
 * @param tracks - いまのトラック（並び順。保存する文書のトラックと同じ順）
 */
export function practiceToSection(state: PracticeState, tracks: readonly Pick<Track, 'id'>[]): Record<string, unknown> | null {
    const part = tracks.findIndex((t) => t.id === state.partId);
    const track = tracks.findIndex((t) => t.id === state.trackId);
    if (part < 0 || track < 0) return null;
    return {
        part, track,
        loop: { startBar: state.loop.startBar, endBar: state.loop.endBar, enabled: state.loop.enabled },
        speed: state.speed, listen: state.listen, showGhost: state.showGhost, input: state.input,
    };
}

/**
 * プロジェクトの節から、練習画面の状態に戻す。おかしな値は既定に直し、トラックが見つからなければ null。
 *
 * - パート（お手本を持つトラック）か練習のトラックの番号が無い・範囲の外・お手本が無い → null（状態を持たない）
 * - 区間は `clampLoop` で収める。速度・聴く・入力は、知らない値なら既定（100% / 両方 / マウス）
 *
 * @param value - 節の値（`load` に渡されたもの。節が無ければ null）
 * @param tracks - 開いたプロジェクトのトラック（並び順。文書のトラックと同じ順）
 */
export function practiceFromSection(value: unknown, tracks: readonly Pick<Track, 'id' | 'referenceNotes'>[]): PracticeState | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    const at = (index: unknown) => (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < tracks.length ? tracks[index] : undefined);
    const part = at(v.part);
    const track = at(v.track);
    if (!part || !track || !part.referenceNotes?.length) return null;
    const loop = (v.loop && typeof v.loop === 'object' ? v.loop : {}) as Record<string, unknown>;
    const num = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
    const startBar = num(loop.startBar, 1);
    return {
        partId: part.id,
        trackId: track.id,
        loop: clampLoop({ startBar, endBar: num(loop.endBar, startBar + 3), enabled: typeof loop.enabled === 'boolean' ? loop.enabled : true }),
        speed: (SPEEDS as readonly number[]).includes(v.speed as number) ? (v.speed as number) : 1,
        listen: LISTEN_MODES.includes(v.listen as ListenMode) ? (v.listen as ListenMode) : 'both',
        showGhost: typeof v.showGhost === 'boolean' ? v.showGhost : true,
        input: INPUT_MODES.includes(v.input as InputMode) ? (v.input as InputMode) : 'mouse',
    };
}

/** 「聴く」で鳴らすトラック。 */
export function listenTrackIds(state: Pick<PracticeState, 'partId' | 'trackId' | 'listen'>): number[] {
    if (state.listen === 'part') return [state.partId];
    if (state.listen === 'self') return [state.trackId];
    return [state.partId, state.trackId];
}

/** 速度の表示（「75%」）。 */
export function speedLabel(speed: number): string {
    return `${Math.round(speed * 100)}%`;
}

/** 範囲の中で始まるノート（範囲が無ければ全部）。 */
export function notesInRange<T extends Pick<PianoNote, 'step'>>(notes: readonly T[], range: StepRange | null): T[] {
    if (!range) return notes.slice();
    return notes.filter((n) => n.step >= range.start && n.step < range.end);
}

// ---- 指摘とノートの色 ----

/** ノートの印の種類。 */
export type NoteMarkKind = 'ok' | 'pitch' | 'rhythm' | 'extra' | 'missing';

/** ノート 1 つの印。どの指摘から来たかも持つ（押したときに、その指摘を見せる）。 */
export interface NoteMark {
    kind: NoteMarkKind;
    issues: DiffIssue[];
}

/** 印の呼び名（凡例と読み上げ）。 */
export const MARK_LABEL: Record<NoteMarkKind, string> = {
    ok: '合っている',
    pitch: '高さが違う',
    rhythm: '位置か長さがずれている',
    extra: 'お手本にないノート',
    missing: 'お手本の抜け',
};

/** 指摘の種類から、打ち込みのノートの印へ。 */
const OWN_KIND: Partial<Record<IssueKind, NoteMarkKind>> = {
    pitch: 'pitch', octave: 'pitch', timing: 'rhythm', length: 'rhythm', extra: 'extra',
};

/** 印の重さ（1 つのノートに 2 つの指摘が付いたとき、重いほうを見せる）。 */
const MARK_WEIGHT: Record<NoteMarkKind, number> = { ok: 0, rhythm: 1, pitch: 2, extra: 3, missing: 3 };

const keyOf = (n: Pick<PianoNote, 'note' | 'octave' | 'step' | 'length'>) => `${n.note}${n.octave}@${n.step}+${n.length}`;

/** 同じ形のノートの番号を、使った順に取り出せるようにする（同じノートが 2 つ在っても、別々に印を付ける）。 */
function indexer(notes: readonly PianoNote[], inRange: (n: PianoNote) => boolean) {
    const queues = new Map<string, number[]>();
    notes.forEach((n, i) => {
        if (!inRange(n)) return;
        const key = keyOf(n);
        const q = queues.get(key);
        if (q) q.push(i); else queues.set(key, [i]);
    });
    return (n: PianoNote | null): number | null => {
        if (!n) return null;
        const q = queues.get(keyOf(n));
        return q && q.length ? q.shift()! : null;
    };
}

/**
 * 差分の結果から、打ち込みとお手本のノート 1 つ 1 つに印を付ける。
 *
 * @param result - 差分の結果（`range` の中のノートだけで比べたもの）
 * @param attempt - 打ち込みのノート（全部。印は同じ並びで返す）
 * @param reference - お手本のノート（全部）
 * @param range - 比べた範囲（無ければ全部）。外のノートには印を付けない
 * @returns `own[i]` が `attempt[i]` の印、`ghost[i]` が `reference[i]` の印（付けないノートは null）
 */
export function markNotes(result: DiffResult, attempt: readonly PianoNote[], reference: readonly PianoNote[], range: StepRange | null = null): { own: (NoteMark | null)[]; ghost: (NoteMark | null)[] } {
    const inRange = (n: PianoNote) => !range || (n.step >= range.start && n.step < range.end);
    const own: (NoteMark | null)[] = attempt.map(() => null);
    const ghost: (NoteMark | null)[] = reference.map(() => null);
    const takeOwn = indexer(attempt, inRange);
    const takeGhost = indexer(reference, inRange);
    // 位置のずれと長さの違いは、同じ組に 2 件付くことがある。組ごとに、同じノートへ印を付ける
    const pairs = new Map<string, { own: number | null; ghost: number | null }>();
    const put = (list: (NoteMark | null)[], index: number | null, kind: NoteMarkKind, issue: DiffIssue) => {
        if (index === null) return;
        const current = list[index];
        if (!current) { list[index] = { kind, issues: [issue] }; return; }
        current.issues.push(issue);
        if (MARK_WEIGHT[kind] > MARK_WEIGHT[current.kind]) current.kind = kind;
    };
    for (const bar of result.bars) {
        for (const issue of bar.issues) {
            const pairKey = `${issue.expected ? keyOf(issue.expected) : '-'}|${issue.actual ? keyOf(issue.actual) : '-'}`;
            let pair = issue.kind === 'timing' || issue.kind === 'length' ? pairs.get(pairKey) : undefined;
            if (!pair) {
                pair = { own: takeOwn(issue.actual), ghost: takeGhost(issue.expected) };
                if (issue.kind === 'timing' || issue.kind === 'length') pairs.set(pairKey, pair);
            }
            if (issue.kind === 'missing') put(ghost, pair.ghost, 'missing', issue);
            // 高さが違う組のお手本にも、同じ指摘を結んでおく (一覧から押したとき、比べる相手も光らせる)。
            // 見た目はふだんのお手本のまま (色は打ち込みの側に付ける)
            if (issue.kind === 'pitch' || issue.kind === 'octave') put(ghost, pair.ghost, 'pitch', issue);
            const ownKind = OWN_KIND[issue.kind];
            if (ownKind) put(own, pair.own, ownKind, issue);
            // 位置か長さだけがずれたお手本は、高さと位置が合っている側に数える (一致に入る)
            if (issue.kind === 'timing' || issue.kind === 'length') put(ghost, pair.ghost, 'ok', issue);
        }
    }
    // 指摘の無いノートは、合っている
    attempt.forEach((n, i) => { if (!own[i] && inRange(n)) own[i] = { kind: 'ok', issues: [] }; });
    reference.forEach((n, i) => { if (!ghost[i] && inRange(n)) ghost[i] = { kind: 'ok', issues: [] }; });
    return { own, ghost };
}

/** ノートの読み上げの名前（「E2: 高さが違う。2 小節 1 拍目: E2 → お手本は F2」）。 */
export function noteMarkLabel(note: PianoNote, mark: NoteMark, ghost = false): string {
    const head = `${ghost ? 'お手本 ' : ''}${noteName(note)}: ${MARK_LABEL[mark.kind]}`;
    return mark.issues.length ? `${head}。${mark.issues.map(issueText).join('。')}` : head;
}

/**
 * 一致（%）。比べた範囲のお手本のうち、高さが同じで位置が許容内だったノートの割合。
 * まだ比べていなければ null。
 */
export function matchRate(result: DiffResult | null): number | null {
    if (!result) return null;
    return Math.round(result.summary.accuracy * 100);
}

/** 区間の指摘を、時間の順に並べる（練習画面の右の一覧）。同じ拍では重い種類から。 */
export function issuesInOrder(result: DiffResult): DiffIssue[] {
    const order: IssueKind[] = ['missing', 'pitch', 'octave', 'extra', 'timing', 'length'];
    const at = (i: DiffIssue) => (i.expected ?? i.actual)?.step ?? 0;
    return result.bars.flatMap((b) => b.issues).slice()
        .sort((a, b) => at(a) - at(b) || order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** 指摘に結び付くノートの番号（打ち込み・お手本）。一覧の指摘を押したとき、そのノートを選んで光らせる。 */
export function notesOfIssue(issue: DiffIssue, marks: { own: (NoteMark | null)[]; ghost: (NoteMark | null)[] }): { own: number[]; ghost: number[] } {
    const pick = (list: (NoteMark | null)[]) => list.flatMap((m, i) => (m && m.issues.includes(issue) ? [i] : []));
    return { own: pick(marks.own), ghost: pick(marks.ghost) };
}
