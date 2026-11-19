/**
 * bunri DAW — 刻み（ノートを置く・動かすときに吸い付く間隔）。三連・32 分・スウィング。
 *
 * ピアノロールでノートを置く・動かす・伸ばす・貼る・複製する・矢印キーで動かすときと、MIDI 鍵盤の入力は、
 * ここで選んだ刻みに従う。選べる刻みは 4 分 / 8 分 / 16 分 / 32 分 / 8 分の三連 / 16 分の三連。
 *
 * - 位置と長さの単位は、変わらず 16 分音符のステップ（lib/grid.ts）。刻みが細かいとき・三連のときは、小数のステップになる
 *   （32 分 = 0.5、8 分の三連 = 4/3、16 分の三連 = 2/3）
 * - 計算は、1/60 ステップの単位（整数）で行う（`STEP_UNITS`）。どの刻みも整数の単位になるので、何度動かしても
 *   端数がたまらない（4 分 = 240、8 分 = 120、16 分 = 60、32 分 = 30、8 分の三連 = 80、16 分の三連 = 40）
 * - スウィング: 刻みが 8 分か 16 分のとき、裏の位置（刻みの奇数番目）を後ろへずらす。割合は 50%（ずらさない）〜 75% で、
 *   「刻み 2 つぶんの中の、裏の位置」を表す（67% = 2/3 が、三連と同じ位置）。ずらすのは吸い付く位置とグリッドの線で、
 *   ノートは、ずらした位置（小数のステップ）のまま持つ。再生は、その位置で鳴らすだけ
 * - 選んだ刻みは、利用者ごとに覚える（localStorage。ふつうのトラックとドラムのトラックで別々）。
 *   スウィングは曲の性質なので、プロジェクトのグリッドに入れる（`ProjectGrid.swing`）
 */
import { STEP_UNITS, SWING_NONE, normSwing, stepUnits } from './grid';
import { readStored, writeStored } from './storage';

/** 刻みの名前（保存する値）。 */
export type SnapId = '1/4' | '1/8' | '1/16' | '1/32' | '1/8T' | '1/16T';

/** 刻み 1 つ。 */
export interface SnapDef {
    id: SnapId;
    /** 画面での呼び名（「8 分の三連」） */
    label: string;
    /** 刻み 1 つぶんの長さ（1/60 ステップの単位） */
    units: number;
    /** 三連か */
    triplet: boolean;
    /** 選択肢に載せたときの説明 */
    tip: string;
}

/** 選べる刻み（選択肢の順）。 */
export const SNAPS: readonly SnapDef[] = [
    { id: '1/4', label: '4 分', units: 240, triplet: false, tip: 'ノートを、1 拍ごとの位置に置きます（置くノートの長さも 1 拍）' },
    { id: '1/8', label: '8 分', units: 120, triplet: false, tip: 'ノートを、1 拍を 2 つに分けた位置に置きます' },
    { id: '1/16', label: '16 分', units: 60, triplet: false, tip: 'ノートを、1 拍を 4 つに分けた位置に置きます' },
    { id: '1/32', label: '32 分', units: 30, triplet: false, tip: 'ノートを、1 拍を 8 つに分けた位置に置きます。横に広げると置きやすくなります' },
    { id: '1/8T', label: '8 分の三連', units: 80, triplet: true, tip: 'ノートを、1 拍を 3 つに分けた位置に置きます（シャッフルや三連の曲に）' },
    { id: '1/16T', label: '16 分の三連', units: 40, triplet: true, tip: 'ノートを、1 拍を 6 つに分けた位置に置きます' },
];

/** 刻みの種類（覚える置き場が別）。`normal`: ふつうのトラック / `drums`: ドラムのトラック。 */
export type SnapKind = 'normal' | 'drums';

/** 既定の刻み。これまでの動きと同じ（ふつうのトラックは 1 拍、ドラムのトラックは 16 分音符）。 */
export const DEFAULT_SNAP: Record<SnapKind, SnapId> = { normal: '1/4', drums: '1/16' };

/** 覚える置き場（ブラウザの保存領域）。 */
export const SNAP_STORAGE: Record<SnapKind, string> = { normal: 'bunri-snap', drums: 'bunri-snap-drums' };

/** 刻みの名前か。 */
export function isSnapId(value: unknown): value is SnapId {
    return typeof value === 'string' && SNAPS.some((s) => s.id === value);
}

/** 刻みを引く（知らない名前なら、4 分）。 */
export function snapDef(id: SnapId): SnapDef {
    return SNAPS.find((s) => s.id === id) ?? SNAPS[0];
}

/** 覚えている刻みを読む。覚えていなければ、既定。 */
export function readSnapPrefs(): Record<SnapKind, SnapId> {
    const read = (kind: SnapKind): SnapId => {
        const stored = readStored(SNAP_STORAGE[kind]);
        return isSnapId(stored) ? stored : DEFAULT_SNAP[kind];
    };
    return { normal: read('normal'), drums: read('drums') };
}

/** 選んだ刻みを覚える。 */
export function writeSnapPref(kind: SnapKind, id: SnapId): void {
    writeStored(SNAP_STORAGE[kind], id);
}

// ---- スウィング ----

/** スウィングの選択肢（値と呼び名）。67% は、ちょうど 2/3（三連と同じ位置）。 */
export const SWING_OPTIONS: readonly { value: number; label: string }[] = [
    { value: SWING_NONE, label: '50%（なし）' },
    { value: 0.54, label: '54%' },
    { value: 0.58, label: '58%' },
    { value: 0.62, label: '62%' },
    { value: 2 / 3, label: '67%（三連）' },
    { value: 0.71, label: '71%' },
    { value: 0.75, label: '75%' },
];

/** その刻みで、スウィングが効くか（8 分と 16 分だけ）。 */
export function swingApplies(id: SnapId): boolean {
    return id === '1/8' || id === '1/16';
}

/** スウィングの値を、画面の「67%」の形にする。 */
export function swingLabel(swing: number): string {
    return `${Math.round(normSwing(swing) * 100)}%`;
}

/** 選択肢のうち、いちばん近い値（プロジェクトの値が選択肢に無いときに、選択欄に出す値）。 */
export function nearestSwingOption(swing: number): number {
    const v = normSwing(swing);
    return SWING_OPTIONS.reduce((best, o) => (Math.abs(o.value - v) < Math.abs(best - v) ? o.value : best), SWING_NONE);
}

// ---- 吸い付く位置の計算 ----

/**
 * 吸い付く位置の並び。位置は 2 つで 1 組（表・裏）になっていて、組の長さは刻み 2 つぶん。
 * k 番目の位置は `floor(k / 2) * 2 * cell + (k が奇数なら off)`（1/60 ステップの単位）。
 * スウィングが無ければ `off = cell` で、等間隔になる。
 */
export interface SnapGrid {
    id: SnapId;
    /** 刻み 1 つぶん（1/60 ステップの単位） */
    cell: number;
    /** 組の中の、裏の位置（1/60 ステップの単位）。スウィングが無ければ `cell` */
    off: number;
}

/**
 * 刻みとスウィングから、吸い付く位置の並びを作る。
 * @param id - 刻み
 * @param swing - スウィング（0.5〜0.75）。8 分と 16 分のときだけ効く
 */
export function snapGrid(id: SnapId, swing: number = SWING_NONE): SnapGrid {
    const cell = snapDef(id).units;
    const ratio = swingApplies(id) ? normSwing(swing) : SWING_NONE;
    return { id: snapDef(id).id, cell, off: Math.round(ratio * 2 * cell) };
}

/** スウィングで、裏の位置がずれているか。 */
export function isSwung(grid: SnapGrid): boolean {
    return grid.off !== grid.cell;
}

/** 刻み 1 つぶんの長さ（ステップ。スウィングでずらす前の値）。 */
export function snapSteps(grid: SnapGrid): number {
    return grid.cell / STEP_UNITS;
}

/** k 番目の位置（1/60 ステップの単位）。 */
function posUnits(grid: SnapGrid, k: number): number {
    return Math.floor(k / 2) * 2 * grid.cell + (k % 2 !== 0 ? grid.off : 0);
}

/** ステップ（小数）を、単位の値（小数のまま）にする。 */
const rawUnits = (step: number) => step * STEP_UNITS;
/** 浮動小数の誤差ぶんの余裕（1/60 ステップの 100 万分の 1）。 */
const EPS = 1e-6;

/** k 番目の位置（ステップ）。 */
export function snapPos(grid: SnapGrid, k: number): number {
    return posUnits(grid, k) / STEP_UNITS;
}

/** その位置か、それより前でいちばん近い位置の番号。 */
export function snapIndexFloor(grid: SnapGrid, step: number): number {
    const u = Math.floor(rawUnits(step) + EPS);
    const pair = Math.floor(u / (2 * grid.cell));
    return pair * 2 + (u - pair * 2 * grid.cell >= grid.off ? 1 : 0);
}

/** いちばん近い位置の番号（ちょうど真ん中は、後ろ）。 */
export function snapIndexRound(grid: SnapGrid, step: number): number {
    const x = rawUnits(step), k = snapIndexFloor(grid, step);
    return x - posUnits(grid, k) < posUnits(grid, k + 1) - x - EPS ? k : k + 1;
}

/** その位置か、それより後ろでいちばん近い位置の番号。 */
export function snapIndexCeil(grid: SnapGrid, step: number): number {
    const k = snapIndexFloor(grid, step);
    return posUnits(grid, k) >= rawUnits(step) - EPS ? k : k + 1;
}

/** 前の位置へ吸い付ける（クリックした位置にノートを置く・再生位置に貼る）。 */
export function snapFloor(grid: SnapGrid, step: number): number {
    return snapPos(grid, snapIndexFloor(grid, Math.max(0, step)));
}

/** いちばん近い位置へ吸い付ける（ドラッグで動かす）。 */
export function snapRound(grid: SnapGrid, step: number): number {
    return snapPos(grid, snapIndexRound(grid, Math.max(0, step)));
}

/** 後ろの位置へ吸い付ける。 */
export function snapCeil(grid: SnapGrid, step: number): number {
    return snapPos(grid, snapIndexCeil(grid, Math.max(0, step)));
}

/** k 番目の位置から、次の位置までの長さ（ステップ）。スウィングのときは、表と裏で長さが違う。 */
export function cellLength(grid: SnapGrid, k: number): number {
    return (posUnits(grid, k + 1) - posUnits(grid, k)) / STEP_UNITS;
}

/**
 * 長さを、刻みの倍数にそろえる（刻み 1 つぶんより短くはしない）。ちょうど真ん中は、長いほう。
 * スウィングのときも、ずらす前の刻みの倍数（スウィングのときの伸ばし方は `snapEnd`）。
 */
export function snapLength(grid: SnapGrid, length: number): number {
    const cells = Math.max(1, Math.floor(rawUnits(length) / grid.cell + 0.5 + EPS));
    return cells * grid.cell / STEP_UNITS;
}

/**
 * 長さを、刻みの倍数に切り上げる（刻み 1 つぶんより短くはしない）。複製の置き場所に使う。
 */
export function snapLengthCeil(grid: SnapGrid, length: number): number {
    const cells = Math.max(1, Math.ceil(rawUnits(length) / grid.cell - EPS));
    return cells * grid.cell / STEP_UNITS;
}

/**
 * ノートの終わりを、吸い付く位置にそろえたときの長さ（スウィングのときの伸ばし方）。
 * 始まりの次の位置より手前には縮めない。
 *
 * @param start - ノートの始まり（ステップ）
 * @param end - そろえたい終わり（ステップ）
 */
export function snapEnd(grid: SnapGrid, start: number, end: number): number {
    const first = snapIndexFloor(grid, start) + 1;
    const k = Math.max(first, snapIndexRound(grid, end));
    return (posUnits(grid, k) - stepUnits(start)) / STEP_UNITS;
}

/**
 * 矢印キーで動かす幅（ステップ）。スウィングが無ければ、刻み 1 つぶん。
 * スウィングのときは、いちばん近い位置から、その隣の位置までの幅（表から裏へ、裏から表へで、幅が違う）。
 *
 * @param anchor - 動かすノートのうち、いちばん前のノートの位置（ステップ）
 * @param dir - 1 で後ろへ、-1 で前へ
 */
export function nudgeSteps(grid: SnapGrid, anchor: number, dir: 1 | -1): number {
    if (!isSwung(grid)) return dir * grid.cell / STEP_UNITS;
    const k = snapIndexRound(grid, Math.max(0, anchor));
    return (posUnits(grid, k + dir) - posUnits(grid, k)) / STEP_UNITS;
}

/**
 * ステップ入力の 1 歩。カーソルの位置（刻みの上に無ければ、次の位置）に置き、長さはその刻み 1 つぶん、
 * 次のカーソルは隣の位置。
 */
export function stepCell(grid: SnapGrid, cursor: number): { step: number; length: number; next: number } {
    const k = snapIndexCeil(grid, Math.max(0, cursor));
    return { step: snapPos(grid, k), length: cellLength(grid, k), next: snapPos(grid, k + 1) };
}

/**
 * リアルタイム録音で、位置と長さをそろえる間隔（ステップ）。
 * 選んだ刻みが 16 分より細かいか、三連のときは、その刻み。そうでなければ、これまでどおり 16 分音符。
 */
export function realtimeQuantum(id: SnapId): number {
    const def = snapDef(id);
    return (def.triplet || def.units < STEP_UNITS ? def.units : STEP_UNITS) / STEP_UNITS;
}

/** 値を、間隔の倍数にそろえる（近いほうへ。ちょうど真ん中は後ろへ）。位置にも長さにも使う。 */
export function quantize(value: number, quantum: number): number {
    const q = Math.max(1, stepUnits(quantum));
    return Math.floor(rawUnits(value) / q + 0.5 + EPS) * q / STEP_UNITS;
}

// ---- グリッドの線 ----

/** グリッドの線を引く間隔（px）の下限。これより詰まるなら、間引く。 */
export const MIN_LINE_PX = 8;

/**
 * グリッドに引く線の並び（拍と小節の線は、別に必ず引く）。横の拡大が足りずに潰れるときは、粗い並びに落とし、
 * それでも潰れるなら null（拍と小節の線だけ）。
 *
 * - 4 分・8 分・16 分（スウィングなし）: 16 分音符の線（これまでと同じ）
 * - 32 分: 32 分の線。潰れるなら 16 分の線
 * - 8 分の三連: 三連の位置の線。16 分の三連: その線。潰れるなら 8 分の三連の線
 * - スウィング: ずらした位置の線。16 分で潰れるなら、表の位置（8 分）の線だけ
 *
 * @param stepWidth - 1 ステップの幅（px）
 */
export function gridLines(grid: SnapGrid, stepWidth: number): SnapGrid | null {
    const px = (units: number) => units / STEP_UNITS * stepWidth;
    const fits = (g: SnapGrid) => px(Math.min(g.off, 2 * g.cell - g.off)) >= MIN_LINE_PX;
    const straight = (id: SnapId): SnapGrid => snapGrid(id);
    const candidates: SnapGrid[] = isSwung(grid) ? [grid, ...(grid.id === '1/16' ? [straight('1/8')] : [])]
        : grid.id === '1/32' ? [grid, straight('1/16')]
            : grid.id === '1/16T' ? [grid, straight('1/8T')]
                : grid.id === '1/8T' ? [grid]
                    : [straight('1/16')];
    return candidates.find(fits) ?? null;
}

// ---- お手本のグリッドの見分け ----

/**
 * ノートの並びが、三連のグリッドに載っているか。お手本が三連の曲のとき、練習を始めるときに刻みを三連に合わせるのに使う。
 *
 * 三連の位置にしか無いノート（16 分の三連の位置で、32 分の位置ではないもの）が 2 つ以上在り、
 * ストレートの位置にしか無いノート（16 分・32 分の裏）の 3 倍以上で、どちらの位置でもないノート（人が弾いた MIDI の揺れ）
 * より多いとき、三連とみなす。処理を担当する部分が三連のグリッドで採譜したお手本は、全部のノートが三連の位置に在る。
 */
export function gridFeelOf(notes: readonly { step: number }[] | null | undefined): 'straight' | 'triplet' {
    let triplet = 0, straight = 0, other = 0;
    for (const n of notes ?? []) {
        const u = stepUnits(n.step);
        const onTriplet = u % 40 === 0, onStraight = u % 30 === 0;
        if (onTriplet && !onStraight) triplet += 1;
        else if (onStraight && !onTriplet) straight += 1;
        else if (!onTriplet && !onStraight) other += 1;
    }
    return triplet >= 2 && triplet >= straight * 3 && triplet > other ? 'triplet' : 'straight';
}

// ---- 長さの言い方 ----

/** 数を、小数 1 桁までの短い形にする（「1.5」「2」）。 */
const short = (value: number) => String(Math.round(value * 10) / 10);

/**
 * ステップの幅（位置のずれ・長さの違い・ずらす幅）を、読める言い方にする。符号は見ない。
 * 小数のステップを、そのまま「16 分音符 0.67 個」とは言わない。
 *
 * - 1 拍の倍数: 「2 拍」
 * - 16 分音符の倍数: 「16 分音符 3 個」
 * - 8 分の三連の倍数: 「8 分の三連符 1 個」
 * - 32 分音符の倍数: 「32 分音符 3 個」
 * - 16 分の三連の倍数: 「16 分の三連符 5 個」
 * - どれでもない（人が弾いた MIDI の細かな揺れ）: 「16 分音符でおよそ 0.8 個」
 */
export function spanLabel(steps: number): string {
    const u = Math.abs(stepUnits(steps));
    if (u % 240 === 0) return `${u / 240} 拍`;
    if (u % 60 === 0) return `16 分音符 ${u / 60} 個`;
    if (u % 80 === 0) return `8 分の三連符 ${u / 80} 個`;
    if (u % 30 === 0) return `32 分音符 ${u / 30} 個`;
    if (u % 40 === 0) return `16 分の三連符 ${u / 40} 個`;
    return `16 分音符でおよそ ${short(u / 60)} 個`;
}

/** ステップの値を、文に出す短い形にする（整数はそのまま、小数は 2 桁まで。「1.33」）。 */
export function stepText(step: number): string {
    return String(Math.round(step * 100) / 100);
}
