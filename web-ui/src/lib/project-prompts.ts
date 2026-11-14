/**
 * bunri DAW — プロジェクトの操作が利用者に尋ねる窓（保存していない変更・名前・開くものの一覧）。
 *
 * 尋ねる側（lib/project-actions.ts）は `ask…()` を await し、窓（components/ProjectDialogs.tsx）は
 * `useProjectPrompt()` で今の問いを受け取って出す。窓は画面に 1 つだけ。
 */
import { useSyncExternalStore } from 'react';

/** 保存していない変更をどうするか。 */
export type UnsavedChoice = 'save' | 'discard' | 'cancel';

/** 開く一覧の 1 件。 */
export interface OpenEntry {
    /** 一覧の中で一意な鍵 */
    key: string;
    name: string;
    /** 場所などの補足（デスクトップ版はパス） */
    detail: string;
    /** bunri: .bunri / legacy: 以前の形式（JSON） */
    kind: 'bunri' | 'legacy';
    /** ファイルが在るか（無ければ「見つかりません」と出し、開けない） */
    exists: boolean;
    /** 一覧から外せるか（デスクトップ版の最近使ったプロジェクト） */
    removable: boolean;
    /** 最後に開いた・保存した時刻（UNIX 秒） */
    time: number | null;
}

/** いま出している問い。 */
export type ProjectPrompt =
    | { kind: 'unsaved'; action: string; resolve: (c: UnsavedChoice) => void }
    | { kind: 'name'; title: string; initial: string; resolve: (name: string | null) => void }
    | { kind: 'open'; entries: OpenEntry[]; canBrowse: boolean; resolve: (choice: OpenEntry | 'browse' | null) => void;
        onRemove: (entry: OpenEntry) => Promise<OpenEntry[]> };

let current: ProjectPrompt | null = null;
const listeners = new Set<() => void>();

function set(next: ProjectPrompt | null) {
    current = next;
    for (const l of listeners) l();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** いまの問い（窓が使う）。 */
export function useProjectPrompt(): ProjectPrompt | null {
    return useSyncExternalStore(subscribe, () => current, () => null);
}

/** 問いを閉じる（答えたあと、窓が呼ぶ）。 */
export function closePrompt(): void {
    set(null);
}

/**
 * 保存していない変更をどうするか尋ねる。
 * @param action - これからすること（「別のプロジェクトを開く」「アプリを終える」）
 */
export function askUnsaved(action: string): Promise<UnsavedChoice> {
    return new Promise(resolve => set({ kind: 'unsaved', action, resolve: (c) => { closePrompt(); resolve(c); } }));
}

/** 名前を尋ねる（開発用のブラウザ起動の保存）。取り消したら null。 */
export function askName(title: string, initial: string): Promise<string | null> {
    return new Promise(resolve => set({ kind: 'name', title, initial, resolve: (n) => { closePrompt(); resolve(n); } }));
}

/** 開くものを選ばせる。`'browse'` は「ほかのファイルを選ぶ…」（デスクトップ版のダイアログ）。 */
export function askOpen(
    entries: OpenEntry[], canBrowse: boolean, onRemove: (entry: OpenEntry) => Promise<OpenEntry[]>,
): Promise<OpenEntry | 'browse' | null> {
    return new Promise(resolve => set({ kind: 'open', entries, canBrowse, onRemove, resolve: (c) => { closePrompt(); resolve(c); } }));
}
