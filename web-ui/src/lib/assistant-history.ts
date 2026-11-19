/**
 * bunri DAW — アシスタントの会話の、保存と、長くなったときのまとめ（純粋な関数だけ）。
 *
 * ## 保存
 *
 * 画面に並ぶもの（利用者の文・アシスタントの文・操作ログの行・知らせ）を、プロジェクト（`.bunri`）の状態の節
 * `assistant` に入れる（登録は lib/assistant-project.ts）。**Claude に送る会話（Messages API の形）は保存しない**。
 * 思考のブロックは、作った会話の中でしか通らず、トラックの ID も開き直すたびに変わるため。
 *
 * ## まとめ（記録）
 *
 * Claude に送る会話は、依頼の途中では足すだけにする（書き換えない・間引かない。lib/assistant.ts の約束）。
 * 縮めるのは **依頼の境目だけ** で、縮めるときは、送る会話を丸ごと捨てて、画面に並んでいるものから作った
 * 「これまでの記録」1 つで始め直す（`conversationDigest`）。途中のメッセージだけを抜くことはしない
 * （抜くと、後ろの思考のブロックが通らなくなる）。記録を作るのに Claude は呼ばない（費用がかからない）。
 *
 * 記録で始め直すのは、次の 2 つのとき:
 * - 会話が長くなった（`needsCompaction`）
 * - プロジェクトを開き直した（保存してあった会話が画面に戻るが、送る会話は空）
 */
import type { ApiMessage, ChatItem } from './assistant';

/** 状態の節 `assistant` の版。形を変えたら上げ、`itemsFromSection` で古い版を読めるようにする。 */
export const ASSISTANT_SECTION_VERSION = 1;

/** 保存する並びの上限（新しいほうから）。 */
export const MAX_SAVED_ITEMS = 300;
/** 保存する文 1 つの長さの上限（文字）。 */
export const MAX_SAVED_TEXT = 4000;

/** 送る会話がこの件数を超えたら、次の依頼の前にまとめる（処理を担当する部分の上限は 200 件）。 */
export const COMPACT_MESSAGES = 100;
/** 送る会話がこの大きさ（JSON にした文字数）を超えたら、次の依頼の前にまとめる（処理を担当する部分の上限は 600,000）。 */
export const COMPACT_CHARS = 200_000;

/** 記録の長さの上限（文字）。超えるぶんは、古いほうから省く。 */
export const DIGEST_CHARS = 8000;
/** 記録に入れる、利用者の文・アシスタントの文 1 つの長さの上限（文字）。 */
const DIGEST_TEXT = 600;
/** 記録に入れる、操作ログの行 1 つの長さの上限（文字）。 */
const DIGEST_TOOL = 200;

/** 保存する 1 つぶん（画面に並ぶもののうち、文だけ。番号と、操作のあいだの動きの記録は持たない）。 */
export type SavedItem =
    | { kind: 'user'; text: string }
    | { kind: 'assistant'; text: string }
    | { kind: 'tool'; name: string; state: 'ok' | 'error' | 'cancelled'; text: string }
    | { kind: 'notice'; tone: 'info' | 'error'; text: string }
    | { kind: 'turn'; calls: number; costUsd: number | null };

/** 文を、上限の長さで切る（切ったら「…」を付ける）。 */
function clip(text: string, max: number): string {
    const chars = [...text];
    return chars.length > max ? chars.slice(0, max).join('') + '…' : text;
}

/**
 * 画面に並んでいるものを、保存する形にする。流れている途中の文と、実行中の行は入れない。
 * 新しいほうから `MAX_SAVED_ITEMS` 個まで。
 */
export function itemsToSaved(items: readonly ChatItem[]): SavedItem[] {
    const out: SavedItem[] = [];
    for (const item of items) {
        if (item.kind === 'user') out.push({ kind: 'user', text: clip(item.text, MAX_SAVED_TEXT) });
        else if (item.kind === 'assistant') { if (!item.streaming) out.push({ kind: 'assistant', text: clip(item.text, MAX_SAVED_TEXT) }); }
        else if (item.kind === 'tool') { if (item.state !== 'running') out.push({ kind: 'tool', name: item.name, state: item.state, text: clip(item.text, MAX_SAVED_TEXT) }); }
        else if (item.kind === 'notice') out.push({ kind: 'notice', tone: item.tone, text: clip(item.text, MAX_SAVED_TEXT) });
        else out.push({ kind: 'turn', calls: item.calls, costUsd: item.costUsd });
    }
    return out.slice(-MAX_SAVED_ITEMS);
}

/**
 * プロジェクトの節から、保存してあった並びを読む。おかしな値は読み飛ばす（1 つ壊れていても、ほかは戻す）。
 *
 * @param value - 節の値（節が無ければ null）
 */
export function itemsFromSection(value: unknown): SavedItem[] {
    if (!value || typeof value !== 'object') return [];
    const list = (value as { items?: unknown }).items;
    if (!Array.isArray(list)) return [];
    const out: SavedItem[] = [];
    const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? clip(v, MAX_SAVED_TEXT) : null);
    for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const body = text(item.text);
        if (item.kind === 'user' && body) out.push({ kind: 'user', text: body });
        else if (item.kind === 'assistant' && body) out.push({ kind: 'assistant', text: body });
        else if (item.kind === 'tool' && body && typeof item.name === 'string' && (item.state === 'ok' || item.state === 'error' || item.state === 'cancelled')) {
            out.push({ kind: 'tool', name: item.name, state: item.state, text: body });
        } else if (item.kind === 'notice' && body) out.push({ kind: 'notice', tone: item.tone === 'error' ? 'error' : 'info', text: body });
        else if (item.kind === 'turn') {
            out.push({
                kind: 'turn', calls: typeof item.calls === 'number' && item.calls >= 0 ? Math.floor(item.calls) : 0,
                costUsd: typeof item.costUsd === 'number' && Number.isFinite(item.costUsd) ? item.costUsd : null,
            });
        }
    }
    return out.slice(-MAX_SAVED_ITEMS);
}

/**
 * 保存してあった並びを、画面に並べる形にする。「元に戻す」は出さない（開き直したら、元に戻す履歴は無い）。
 *
 * @param saved - 保存してあった並び
 * @param nextId - 番号を振る関数
 */
export function savedToItems(saved: readonly SavedItem[], nextId: () => number): ChatItem[] {
    return saved.map((item): ChatItem => {
        switch (item.kind) {
            case 'user': return { kind: 'user', id: nextId(), text: item.text };
            case 'assistant': return { kind: 'assistant', id: nextId(), text: item.text };
            case 'tool': return { kind: 'tool', id: nextId(), name: item.name, state: item.state, text: item.text, activity: [] };
            case 'notice': return { kind: 'notice', id: nextId(), tone: item.tone, text: item.text };
            case 'turn': return { kind: 'turn', id: nextId(), calls: item.calls, costUsd: item.costUsd, changed: false, undoEntryId: null };
        }
    });
}

/** 送る会話の大きさ（JSON にした文字数）。 */
export function conversationChars(messages: readonly ApiMessage[]): number {
    try { return JSON.stringify(messages).length; } catch { return Infinity; }
}

/** 送る会話が長くなったか（次の依頼の前に、まとめる）。 */
export function needsCompaction(messages: readonly ApiMessage[]): boolean {
    return messages.length > COMPACT_MESSAGES || conversationChars(messages) > COMPACT_CHARS;
}

/**
 * 画面に並んでいるものから、「これまでの記録」を作る。Claude に送る会話の、最初のメッセージになる。
 * 新しいものを優先して、`maxChars` に収まるぶんだけ入れる（古いほうから省く）。
 *
 * 入れるのは、利用者の文・アシスタントの文・操作ログの行（成功と失敗）。ツールの結果の中身（ノートの並びなど）は
 * 入れない（古くなっているかもしれないので、読み直させる。指示文の「Earlier conversation」）。
 *
 * @returns 記録の文。入れるものが 1 つも無ければ null
 */
export function conversationDigest(items: readonly ChatItem[], maxChars = DIGEST_CHARS): string | null {
    const lines: string[] = [];
    for (const item of items) {
        if (item.kind === 'user') lines.push(`User: ${clip(item.text.replace(/\s+/g, ' ').trim(), DIGEST_TEXT)}`);
        else if (item.kind === 'assistant' && !item.streaming) lines.push(`Assistant: ${clip(item.text.replace(/\s+/g, ' ').trim(), DIGEST_TEXT)}`);
        else if (item.kind === 'tool' && item.state === 'ok') lines.push(`Tool ok: ${clip(item.text, DIGEST_TOOL)}`);
        else if (item.kind === 'tool' && item.state === 'error') lines.push(`Tool failed: ${clip(item.text, DIGEST_TOOL)}`);
    }
    if (lines.length === 0) return null;
    const kept: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (size + lines[i].length + 1 > maxChars && kept.length > 0) break;
        kept.unshift(lines[i]);
        size += lines[i].length + 1;
    }
    const omitted = lines.length - kept.length;
    return [
        '<earlier_conversation>',
        'Record of the earlier conversation in this project, written by the app. Oldest first. Tool results are left out.',
        ...(omitted > 0 ? [`(${omitted} earlier entries omitted)`] : []),
        ...kept,
        '</earlier_conversation>',
    ].join('\n');
}
