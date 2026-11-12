/**
 * bunri DAW — 元に戻す / やり直すの履歴（中身の形を問わない部品）。
 *
 * 1 つの記録 (`HistoryEntry`) は「操作の前の状態」と「操作の後の状態」の組と、操作の名前を持つ。
 * 元に戻すときは前の状態を、やり直すときは後の状態を当てる（当て方は使う側が決める。
 * プロジェクトでは lib/project-snapshot.ts の `applyProject`）。
 *
 * - **まとめる (coalesce):** 同じ `coalesceKey` の操作が `coalesceMs` 以内に続いたら、1 つの記録にまとめる
 *   （音量のつまみを動かしているあいだ、矢印キーでノートを動かし続けているあいだ）。
 *   元に戻す・やり直すを挟んだら、まとめない
 * - **何も変えなかった操作は残さない:** `equals` で前後が同じなら記録しない（ノートを押しただけ、など）
 * - **上限:** 記録の数（`limit`）と、記録が抱える量の合計（`budget`。`cost` で数える）の両方で、
 *   古いものから捨てる。低いスペックの PC で、履歴がメモリを食い続けないように
 * - 新しい操作を記録すると、やり直せる記録は消える
 */

/** 履歴の 1 つの記録。 */
export interface HistoryEntry<S> {
    /** 記録の番号（1 から増える。まとめても変わらない） */
    id: number;
    /** 操作の名前（「ノートを追加」など。ボタンの説明と、元に戻したときの知らせに出す） */
    label: string;
    /** 操作の前の状態 */
    before: S;
    /** 操作の後の状態 */
    after: S;
    /** まとめるための鍵 */
    key?: string;
    /** 最後にまとめた時刻（ミリ秒） */
    at: number;
    /** この記録が抱える量（`cost` の値） */
    cost: number;
}

/** 記録するときの指定。 */
export interface PushOptions {
    /** 同じ鍵の操作が続いたら 1 つにまとめる */
    coalesceKey?: string;
    /** まとめる間隔の上限（ミリ秒）。省略時は履歴の既定値 */
    coalesceMs?: number;
}

/** 履歴の設定。 */
export interface HistoryOptions<S> {
    /** 記録の数の上限（既定 100） */
    limit?: number;
    /** 記録が抱える量の合計の上限（既定は無制限） */
    budget?: number;
    /** 記録が抱える量を数える（既定は 1） */
    cost?: (before: S, after: S) => number;
    /** 前後が同じか（同じなら記録しない。既定は「同じ参照なら同じ」） */
    equals?: (a: S, b: S) => boolean;
    /** まとめる間隔の既定値（ミリ秒。既定 1000） */
    coalesceMs?: number;
    /** いまの時刻（テストで差し替える） */
    now?: () => number;
}

/** 元に戻す / やり直すの履歴。 */
export class UndoHistory<S> {
    private past: HistoryEntry<S>[] = [];
    private future: HistoryEntry<S>[] = [];
    private nextId = 1;
    /** 最後の記録に、次の操作をまとめてよいか（元に戻す・やり直すの後はまとめない） */
    private canCoalesce = false;
    private totalCost = 0;
    private readonly limit: number;
    private readonly budget: number;
    private readonly cost: (before: S, after: S) => number;
    private readonly equals: (a: S, b: S) => boolean;
    private readonly coalesceMs: number;
    private readonly now: () => number;

    constructor(options: HistoryOptions<S> = {}) {
        this.limit = Math.max(1, options.limit ?? 100);
        this.budget = options.budget ?? Infinity;
        this.cost = options.cost ?? (() => 1);
        this.equals = options.equals ?? ((a, b) => a === b);
        this.coalesceMs = options.coalesceMs ?? 1000;
        this.now = options.now ?? (() => Date.now());
    }

    /**
     * 操作を記録する。前後が同じなら記録しない。
     * @returns 記録（まとめた先の記録を含む）。記録しなかったら null
     */
    push(label: string, before: S, after: S, options: PushOptions = {}): HistoryEntry<S> | null {
        const at = this.now();
        const top = this.past[this.past.length - 1];
        const key = options.coalesceKey;
        const window = options.coalesceMs ?? this.coalesceMs;
        if (key !== undefined && top && this.canCoalesce && top.key === key && at - top.at <= window) {
            // 続けて同じものを動かしている。最初の「前」を残し、「後」だけ差し替える
            this.future = [];
            if (this.equals(top.before, after)) {
                // 動かして、元の値まで戻した。記録ごと消す
                this.past.pop();
                this.totalCost -= top.cost;
                this.canCoalesce = false;
                return null;
            }
            this.totalCost -= top.cost;
            top.after = after;
            top.label = label;
            top.at = at;
            top.cost = this.cost(top.before, after);
            this.totalCost += top.cost;
            this.trim();
            return top;
        }
        if (this.equals(before, after)) return null;
        const entry: HistoryEntry<S> = { id: this.nextId++, label, before, after, key, at, cost: this.cost(before, after) };
        this.past.push(entry);
        this.totalCost += entry.cost;
        this.future = [];
        this.canCoalesce = true;
        this.trim();
        return entry;
    }

    /** 上限を超えたぶんを、古いものから捨てる（いちばん新しい記録は残す）。 */
    private trim(): void {
        while (this.past.length > this.limit || (this.totalCost > this.budget && this.past.length > 1)) {
            const dropped = this.past.shift()!;
            this.totalCost -= dropped.cost;
        }
    }

    /**
     * 元に戻す記録を取り出す（やり直せる側へ移す）。状態を当てるのは呼ぶ側（`entry.before` を当てる）。
     * @returns 元に戻す記録。無ければ null
     */
    undo(): HistoryEntry<S> | null {
        const entry = this.past.pop();
        if (!entry) return null;
        this.totalCost -= entry.cost;
        this.future.push(entry);
        this.canCoalesce = false;
        return entry;
    }

    /**
     * やり直す記録を取り出す（元に戻せる側へ戻す）。状態を当てるのは呼ぶ側（`entry.after` を当てる）。
     * @returns やり直す記録。無ければ null
     */
    redo(): HistoryEntry<S> | null {
        const entry = this.future.pop();
        if (!entry) return null;
        this.past.push(entry);
        this.totalCost += entry.cost;
        this.canCoalesce = false;
        this.trim();
        return entry;
    }

    /** 次に元に戻す記録（取り出さない）。 */
    peekUndo(): HistoryEntry<S> | null {
        return this.past[this.past.length - 1] ?? null;
    }

    /** 次にやり直す記録（取り出さない）。 */
    peekRedo(): HistoryEntry<S> | null {
        return this.future[this.future.length - 1] ?? null;
    }

    /** 記録を全部消す。 */
    clear(): void {
        this.past = [];
        this.future = [];
        this.totalCost = 0;
        this.canCoalesce = false;
    }

    /** 元に戻せる記録の数。 */
    get undoCount(): number { return this.past.length; }

    /** やり直せる記録の数。 */
    get redoCount(): number { return this.future.length; }

    /** 元に戻せる記録が抱える量の合計。 */
    get size(): number { return this.totalCost; }
}
