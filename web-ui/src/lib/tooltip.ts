/**
 * ツールチップ（マウスを載せたときに、そばに出す短い説明）の置き場所の計算。
 *
 * 画面の部品とは切り離した純粋な関数にしてある（テストで位置を確かめるため）。
 * 表示そのものは `components/Tooltip.tsx`。
 *
 * 決まり:
 * - まず「出したい向き」（要素ごと・場所ごとに決める）に置いてみる
 * - 入らなければ反対側、それでも入らなければ横の 2 方向、の順に試す
 * - どの向きにも入らないときは、いちばん広い向きに置いて、画面の内側に押し込む
 * - 向きと直交する方向（上下に出すなら左右）は、要素の真ん中にそろえ、画面の端からは余白ぶん離す
 * - 「枠」（`data-tip-box` を持つ祖先）が在るときは、出したい向きの端を、要素ではなく枠の外側にそろえる。
 *   トラックの見出しのように小さなボタンが並ぶところで、隣のボタンを隠さないため。
 *   枠の外側に入らないときは、枠のことは忘れて要素の周りに置く
 */

/** ツールチップを出す向き（要素から見て、どちら側か）。 */
export type TipSide = 'top' | 'bottom' | 'left' | 'right';

export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface Size {
    width: number;
    height: number;
}

export interface TipPlacement {
    /** 実際に置いた向き */
    side: TipSide;
    /** ツールチップの左上（画面の座標） */
    x: number;
    y: number;
    /**
     * 矢印（要素を指す小さな三角）の位置。ツールチップの左端（上下に出すとき）か
     * 上端（左右に出すとき）からの距離。ツールチップを画面の内側へずらしても、矢印は要素を指したままにする
     */
    arrow: number;
}

/** 画面の端から離す余白 */
export const TIP_MARGIN = 8;
/** 要素とツールチップのあいだ */
export const TIP_GAP = 8;
/** 矢印を角に寄せすぎない（角の丸みに掛からない）ための余白 */
const ARROW_INSET = 10;

const OPPOSITE: Record<TipSide, TipSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const CROSS: Record<TipSide, TipSide[]> = {
    top: ['right', 'left'], bottom: ['right', 'left'],
    left: ['bottom', 'top'], right: ['bottom', 'top'],
};

/** その向きに使える広さ（要素の外側から画面の端まで。余白と間隔を引いたもの）。 */
function room(side: TipSide, a: Rect, view: Size): number {
    switch (side) {
        case 'top': return a.top - TIP_GAP - TIP_MARGIN;
        case 'bottom': return view.height - (a.top + a.height) - TIP_GAP - TIP_MARGIN;
        case 'left': return a.left - TIP_GAP - TIP_MARGIN;
        case 'right': return view.width - (a.left + a.width) - TIP_GAP - TIP_MARGIN;
    }
}

/** その向きに、ツールチップがはみ出さずに入るか。 */
function fits(side: TipSide, a: Rect, tip: Size, view: Size): boolean {
    const vertical = side === 'top' || side === 'bottom';
    // 向きの方向に入るか
    if (room(side, a, view) < (vertical ? tip.height : tip.width)) return false;
    // 直交する方向に、画面の幅（高さ）ごと入るか
    return vertical ? tip.width <= view.width - 2 * TIP_MARGIN : tip.height <= view.height - 2 * TIP_MARGIN;
}

function clamp(v: number, min: number, max: number): number {
    // 画面より大きいときは、頭（左・上）をそろえる
    return max < min ? min : Math.min(Math.max(v, min), max);
}

/**
 * ツールチップの置き場所を決める。
 *
 * @param anchor - 説明する要素の位置（`getBoundingClientRect()`）
 * @param tip - ツールチップの大きさ
 * @param view - 画面（窓）の大きさ
 * @param preferred - 出したい向き
 * @param box - 枠（省略できる）。出したい向きの端を、この外側にそろえる
 * @returns 置いた向きと、左上の座標と、矢印の位置
 */
export function placeTip(anchor: Rect, tip: Size, view: Size, preferred: TipSide, box?: Rect): TipPlacement {
    if (box && fits(preferred, box, tip, view)) {
        // 向きの方向は枠から、直交する方向は要素から決める
        const vertical = preferred === 'top' || preferred === 'bottom';
        const merged: Rect = vertical
            ? { left: anchor.left, width: anchor.width, top: box.top, height: box.height }
            : { left: box.left, width: box.width, top: anchor.top, height: anchor.height };
        return placeTip(merged, tip, view, preferred);
    }
    const order: TipSide[] = [preferred, OPPOSITE[preferred], ...CROSS[preferred]];
    const side = order.find(s => fits(s, anchor, tip, view))
        // どこにも入らない: いちばん広い向き（同じ広さなら、出したい向きに近いほう）
        ?? order.reduce((best, s) => (room(s, anchor, view) > room(best, anchor, view) ? s : best));

    const cx = anchor.left + anchor.width / 2;
    const cy = anchor.top + anchor.height / 2;
    let x: number;
    let y: number;
    if (side === 'top' || side === 'bottom') {
        x = clamp(cx - tip.width / 2, TIP_MARGIN, view.width - TIP_MARGIN - tip.width);
        y = side === 'top' ? anchor.top - TIP_GAP - tip.height : anchor.top + anchor.height + TIP_GAP;
        y = clamp(y, TIP_MARGIN, view.height - TIP_MARGIN - tip.height);
        const arrow = clamp(cx - x, ARROW_INSET, tip.width - ARROW_INSET);
        return { side, x, y, arrow };
    }
    y = clamp(cy - tip.height / 2, TIP_MARGIN, view.height - TIP_MARGIN - tip.height);
    x = side === 'left' ? anchor.left - TIP_GAP - tip.width : anchor.left + anchor.width + TIP_GAP;
    x = clamp(x, TIP_MARGIN, view.width - TIP_MARGIN - tip.width);
    const arrow = clamp(cy - y, ARROW_INSET, tip.height - ARROW_INSET);
    return { side, x, y, arrow };
}

/**
 * 要素に書く属性の名前。`data-tip` に説明、`data-tip-key` にキー操作。
 * 祖先に書く `data-tip-side` で向き、`data-tip-box` で枠を決める。
 */
export const TIP_ATTR = 'data-tip';

/**
 * 要素に付ける属性をまとめて返す（JSX に `{...tip('説明')}` と書くため）。
 *
 * @param text - 説明。押すと何が起きるかを、短く書く。`\n` で改行する
 * @param opts.key - キー操作（「Space」「⌘Z」など）。説明の後ろに、キーの形で出す
 * @param opts.side - 出したい向き。省略すると、置き場所（`data-tip-side` を持つ祖先）の向き
 * @param opts.overflow - true なら、要素の文字が切れて「…」になっているときだけ出す（名前の全文を見せるため）
 */
export function tip(text: string, opts: { key?: string; side?: TipSide; overflow?: boolean } = {}): Record<string, string> {
    const attrs: Record<string, string> = { [TIP_ATTR]: text };
    if (opts.key) attrs['data-tip-key'] = opts.key;
    if (opts.side) attrs['data-tip-side'] = opts.side;
    if (opts.overflow) attrs['data-tip-overflow'] = '';
    return attrs;
}
