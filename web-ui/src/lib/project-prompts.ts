/**
 * bunri DAW — プロジェクトの操作が利用者に尋ねる窓（保存していない変更・名前・開くものの一覧・前回の続き）。
 *
 * 尋ねる側（lib/project-actions.ts）は `ask…()` を await し、窓（components/ProjectDialogs.tsx）は
 * `useProjectPrompt()` で今の問いを受け取って出す。窓は画面に 1 つだけ。
 *
 * 問いは置き換えずに順番に出す（前の問いに答えが出てから、次を出す）。置き換えると、前の問いを待っている
 * 操作が決まらないまま残る（起動したときの「続きを開きますか」に答えが出ず、自動保存が始まらない、など）。
 * ただし、窓を閉じる前の確かめ（`askUnsaved(…, { urgent: true })`）は先に出す。待たせると窓が閉じられない。
 * そのとき出ていた問いは、取り下げずに後ろへ回し、確かめに答えが出たら（閉じなかったら）もう一度出す。
 */
import { useSyncExternalStore } from 'react';

/** 保存していない変更をどうするか。 */
export type UnsavedChoice = 'save' | 'discard' | 'cancel';

/** 前回の続き（落ちたときの復旧用の写し）をどうするか。 */
export type RecoveryChoice = 'open' | 'discard';

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
        onRemove: (entry: OpenEntry) => Promise<OpenEntry[]> }
    | { kind: 'recovery'; name: string | null; savedAt: number; replaces: boolean; resolve: (c: RecoveryChoice) => void };

/** 出している問い・待っている問い（先に出すもの = 窓を閉じる前の確かめ、か）。 */
interface Entry { prompt: ProjectPrompt; urgent: boolean }

let current: Entry | null = null;
/** 答えを待っている、まだ出していない問い（出す順） */
let waiting: Entry[] = [];
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

/** 問いを出す。ほかの問いが出ていれば、その答えを待つ（先に出すものは、出ている問いを後ろへ回して出す）。 */
function enqueue(entry: Entry) {
    if (current === null) {
        current = entry;
    } else if (entry.urgent && !current.urgent) {
        // 出ていた問いは取り下げない。確かめに答えが出たら、もう一度出す
        waiting.unshift(current);
        current = entry;
    } else {
        // 先に出すものは、先に出すもの同士の後ろ・ふつうの問いの前に並べる
        const at = entry.urgent ? waiting.findIndex((e) => !e.urgent) : -1;
        if (at < 0) waiting.push(entry); else waiting.splice(at, 0, entry);
    }
    emit();
}

/** 問いに答えが出た。窓から下げて、次の問いを出す。 */
function finish(prompt: ProjectPrompt) {
    if (current?.prompt === prompt) current = waiting.shift() ?? null;
    else waiting = waiting.filter((e) => e.prompt !== prompt);
    emit();
}

/**
 * 問いを作って出し、答えを返す。答えは 1 度だけ返す（窓が 2 度呼んでも、2 度目は何もしない）。
 * @param make - 答えを受け取る関数から、問いを作る
 */
function ask<T>(make: (resolve: (answer: T) => void) => ProjectPrompt, urgent = false): Promise<T> {
    return new Promise<T>((resolve) => {
        let done = false;
        const prompt = make((answer) => {
            if (done) return;
            done = true;
            finish(prompt);
            resolve(answer);
        });
        enqueue({ prompt, urgent });
    });
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** いまの問い（窓が使う）。 */
export function useProjectPrompt(): ProjectPrompt | null {
    return useSyncExternalStore(subscribe, () => current?.prompt ?? null, () => null);
}

/**
 * 保存していない変更をどうするか尋ねる。
 * @param action - これからすること（「別のプロジェクトを開く」「アプリを終える」）
 * @param options.urgent - 窓を閉じる前の確かめ。ほかの問いより先に出す（出ていた問いは、答えが出たあとにもう一度出す）
 */
export function askUnsaved(action: string, options: { urgent?: boolean } = {}): Promise<UnsavedChoice> {
    return ask<UnsavedChoice>((resolve) => ({ kind: 'unsaved', action, resolve }), !!options.urgent);
}

/** 名前を尋ねる（開発用のブラウザ起動の保存）。取り消したら null。 */
export function askName(title: string, initial: string): Promise<string | null> {
    return ask<string | null>((resolve) => ({ kind: 'name', title, initial, resolve }));
}

/** 開くものを選ばせる。`'browse'` は「ほかのファイルを選ぶ…」（デスクトップ版のダイアログ）。 */
export function askOpen(
    entries: OpenEntry[], canBrowse: boolean, onRemove: (entry: OpenEntry) => Promise<OpenEntry[]>,
): Promise<OpenEntry | 'browse' | null> {
    return ask<OpenEntry | 'browse' | null>((resolve) => ({ kind: 'open', entries, canBrowse, onRemove, resolve }));
}

/**
 * 前回、保存する前に終わったときの続きを開くか尋ねる（起動したとき。lib/autosave.ts）。答えるまで閉じない。
 * @param name - プロジェクトの名前（まだ無ければ null）
 * @param savedAt - 続きを書いた時刻（UNIX 秒）
 * @param replaces - 続きを開くと、いまの画面の変更が消えるか（尋ねる前に、もう何か変えていた）
 */
export function askRecovery(name: string | null, savedAt: number, replaces: boolean): Promise<RecoveryChoice> {
    return ask<RecoveryChoice>((resolve) => ({ kind: 'recovery', name, savedAt, replaces, resolve }));
}

/** テスト用: 出している問い・待っている問いを、答えずに忘れる。 */
export function resetPromptsForTest(): void {
    current = null;
    waiting = [];
    emit();
}
