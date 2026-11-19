/**
 * bunri DAW — アシスタント（アプリの中のチャット）の会話と、繰り返し。
 *
 * 利用者の依頼を Claude に送り（`POST /api/assistant/step`）、Claude がツールを呼んだら画面の側で実行して
 * （lib/assistant-tools.ts）、結果を返してもう一度呼ぶ。これを、Claude が答え終わるまで繰り返す。
 * 繰り返しを回すのは画面で、処理を担当する部分は 1 回の呼び出しごとに完結する（docs/assistant-design.md）。
 *
 * 応答は少しずつ届く（`"stream": true` を付けて送り、`application/x-ndjson` の本文を 1 行ずつ読む）。
 * 流れてきた文は、アシスタントの吹き出し 1 つに足していき（`streaming: true`）、最後の行（`done`）で確定する。
 * 行の形は `StepLine`、行の読み取りは `readJsonLines`。古い形（JSON 1 つ）の応答も、そのまま読める。
 *
 * 約束:
 * - 会話は Messages API の形のまま持つ。**応答の `content` は変えずに足し、前のメッセージを書き換えない**
 *   （応答には思考のブロックが入っていて、変えると次の呼び出しが通らない。プロンプトキャッシュも頭からの一致で効く）
 * - 流れてきた差分は、画面に見せるためだけに使う。**会話に足すのは、最後の行（`done`）の `content` だけ**
 *   （差分から組み立て直さない）。確定しないまま終わった吹き出し（中止・失敗）は消す。会話に入っていない文を、
 *   画面に残さない
 * - 1 つの応答に `tool_use` が複数在れば、全部の結果を 1 つの user のメッセージにまとめて返す
 * - `tool_use` には必ず `tool_result` が要る。中止や失敗で終わるときも、実行しなかったツールに「中止しました」の
 *   結果を入れて、形を閉じておく（開いたままだと、次の依頼が通らない）
 * - 1 回の依頼で変えたことは、元に戻す履歴の 1 つの記録にまとめる。最初に「変える」ツールを実行する前に記録を開き、
 *   依頼が終わったとき（答え終わった・中止した・失敗した）に必ず閉じる
 * - 利用者がチャットに打った文と、Claude の文（流れている途中の文も）は、動きの記録（lib/activity.ts）に渡さない
 *   （入力欄に打った文字は記録しない決まり）。残すのは、ツールの結果の 1 行だけ
 *
 * - 縮めるのは、依頼の境目だけ。会話が長くなったら、次の依頼の前に、送る会話を丸ごと「これまでの記録」1 つに
 *   置き換える（lib/assistant-history.ts。途中のメッセージだけを抜くことはしない。画面に並んでいるものは、そのまま残る）
 *
 * 会話と操作ログは、ドックを閉じても、練習画面に出入りしても残るよう、部品の外（このファイルの `assistantSession`）に置く。
 * 画面に並んでいるもの（文と操作ログの行）は、プロジェクトにも入る（lib/assistant-project.ts）。Claude に送る会話は
 * 入れない。開き直した後の最初の依頼は、戻した並びから作った「これまでの記録」で始める。React には依存しない。
 */
import { apiFetch, describeError } from './api';
import { activityEntries, recordActivity, type ActivityEntry } from './activity';
import { GuideRequestError, fetchGuideSettings, toError, type GuideToday, type GuideUsage } from './guide';
import { TOOLS, isWriteTool, runTool, toolLabel, type ToolEnv } from './assistant-tools';
import { MAX_ARCHIVED, archiveTitle, conversationDigest, itemsToSaved, needsCompaction, savedToItems, type ArchivedConversation, type SavedItem } from './assistant-history';
import type { SuggestionFacts } from './assistant-suggestions';

/** 1 回の依頼で Claude を呼べる回数の上限（処理を担当する部分の `MAX_STEPS` と同じ）。 */
export const MAX_STEPS = 12;

/** 記録の名前に入れる、依頼の頭の文字数。 */
const LABEL_HEAD = 20;

/** Messages API の content のブロック（中身は変えずに持つ）。 */
export type ContentBlock = { type: string } & Record<string, unknown>;

/** Messages API のメッセージ。 */
export interface ApiMessage {
    role: 'user' | 'assistant';
    content: ContentBlock[];
}

/** `POST /api/assistant/step` の応答。 */
export interface StepResponse {
    /** Claude の応答の `content`。変えずに assistant のメッセージとして足す */
    content: ContentBlock[];
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
    model?: string;
    usage?: GuideUsage;
    /** この 1 回の概算の費用（単価の表に無いモデルなら null） */
    cost_usd?: number | null;
    today?: GuideToday;
}

/**
 * 少しずつ届く応答（`application/x-ndjson`）の 1 行。
 *
 * - `text`: 見える文の差分
 * - `tool`: Claude がツールの呼び出しを書き始めた
 * - `done`: 最後の行。`StepResponse` と同じ項目を持つ
 * - `error`: 途中の失敗（最後の行）
 */
export type StepLine =
    | { type: 'text'; text: string }
    | { type: 'tool'; name: string }
    | ({ type: 'done' } & StepResponse)
    | { type: 'error'; detail?: { message?: string; code?: string } | string; today?: GuideToday };

/** 少しずつ届く応答の `Content-Type`。 */
const NDJSON = 'application/x-ndjson';

/** 操作ログの 1 行（ツールの呼び出し 1 つ）。 */
export interface ToolRow {
    kind: 'tool';
    id: number;
    /** ツールの名前（台帳の `name`） */
    name: string;
    /** running: 実行中 / ok: 成功 / error: 失敗 / cancelled: 中止したので実行していない */
    state: 'running' | 'ok' | 'error' | 'cancelled';
    /** 行に出す文（成功は `summary`、失敗は理由、実行中は「〜しています…」） */
    text: string;
    /** この操作のあいだに、動きの記録に増えた行 */
    activity: readonly ActivityEntry[];
}

/** 依頼の終わりの行（変えたことが在れば「元に戻す」、Claude を呼んだ回数と概算の費用）。 */
export interface TurnRow {
    kind: 'turn';
    id: number;
    /** この依頼で Claude を呼んだ回数 */
    calls: number;
    /** 概算の費用の合計（USD）。分からない呼び出しが在れば null */
    costUsd: number | null;
    /** この依頼で、プロジェクトが変わったか */
    changed: boolean;
    /** この依頼の記録の番号（元に戻す履歴）。変わっていなければ null */
    undoEntryId: number | null;
}

/** チャットに並ぶ 1 つぶん。 */
export type ChatItem =
    | { kind: 'user'; id: number; text: string }
    /** `streaming` が true のあいだは、流れている途中の文（まだ確定していない。会話にも入っていない） */
    | { kind: 'assistant'; id: number; text: string; streaming?: boolean }
    | ToolRow
    /** 中止・失敗・途中で止めたことの知らせ。`code` は、失敗の種類（`daily_limit` など。画面が、同じ知らせを 2 つ出さないために見る） */
    | { kind: 'notice'; id: number; tone: 'info' | 'error'; text: string; code?: string }
    | TurnRow;

/** 画面に出す状態（変わるたびに、新しいオブジェクトになる）。 */
export interface AssistantState {
    items: readonly ChatItem[];
    /** 依頼を処理しているあいだ true（このあいだは、次の依頼を送れない） */
    running: boolean;
    /** 待っているあいだの 1 行（「考えています…」「中止しています…」）。待っていなければ null */
    waiting: string | null;
    /** 今日の使用量（応答に付いてきたもの）。まだ分からなければ null */
    today: GuideToday | null;
    /** API キーを入れれば直る失敗が起きた（キーの欄を出す） */
    needsKey: boolean;
    /** 頭から何個が、前に保存してあった会話か（その後ろに、区切りを出す）。無ければ 0 */
    restored: number;
    /** 戻した会話が、どこから来たか（project: プロジェクトを開いた / history: 履歴から開き直した）。区切りの文を変える */
    restoredFrom: 'project' | 'history';
    /** 前の会話（履歴）。新しい順。「新しい会話」を押すと、それまでの会話がここの頭に入る */
    archive: readonly ArchivedConversation[];
}

/**
 * 編集の記録を閉じる関数（store の `CommitEdit` と同じ形）。変わっていたら true。
 * `discard` を付けると、記録を作らずに閉じる（依頼の途中で、プロジェクトが入れ替わったとき）。
 */
type CommitEdit = (options?: { discard?: boolean }) => boolean;

/** 繰り返しが、画面の側から受け取るもの（本物は lib/assistant-env.ts）。 */
export interface AssistantDeps {
    /** ツールが画面を読み書きする入口 */
    env: ToolEnv;
    /** 元に戻す履歴の記録を開く。返す関数で閉じる（中の `record` は、この記録にまとまる） */
    beginEdit: (label: string) => CommitEdit;
    /** 元に戻す履歴の、いちばん上の記録の番号（閉じた直後に、この依頼の記録の番号を知る） */
    topUndoId: () => number | null;
    /** 頼み方の例を選ぶ材料（いまの状況）。ドックが描くたびに呼ぶので、読むだけにする（画面の状態を変えない） */
    suggestionFacts: () => SuggestionFacts;
}

/** 依頼の識別子（英数字とハイフン、64 文字まで）。使用量の記録で、同じ依頼の呼び出しを束ねる。 */
function makeTurnId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 依頼の頭の 20 文字（記録の名前に入れる）。改行や続く空白は 1 つの空白にする。 */
export function requestHead(text: string): string {
    const chars = [...text.replace(/\s+/g, ' ').trim()];
    return chars.length > LABEL_HEAD ? chars.slice(0, LABEL_HEAD).join('') + '…' : chars.join('');
}

/** 応答の中の文（text のブロック）をつなぐ。 */
function textOf(content: readonly ContentBlock[]): string {
    return content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n\n').trim();
}

/** 応答の中の、ツールの呼び出し。 */
function toolUses(content: readonly ContentBlock[]): { id: string; name: string; input: unknown }[] {
    return content.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), input: b.input }));
}

/** 実行しなかったツールの結果（形を閉じるために入れる）。 */
function unrunResult(id: string, reason: string): ContentBlock {
    return { type: 'tool_result', tool_use_id: id, content: reason, is_error: true };
}

/** 中止したことを表す失敗か（`AbortController` で止めた fetch）。 */
function isAbort(e: unknown): boolean {
    return e instanceof Error && e.name === 'AbortError';
}

/** 画面に描く間を空ける（実行中の行を、実行の前に見せる）。 */
function nextFrame(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 中止したことを表す失敗を作る（`isAbort` が見分ける）。 */
function abortError(): DOMException {
    return new DOMException('中止', 'AbortError');
}

/**
 * 1 行に JSON 1 つの本文（NDJSON）を、届いたぶんから 1 行ずつ読む。
 *
 * 本文は、行の途中で切れて届くことも（文字の途中のこともある）、複数の行がまとめて届くことも、最後の行に改行が
 * 無いことも在る。空の行と、JSON のオブジェクトとして読めない行は飛ばす（呼び出し側は、最後の行が来たかで
 * 失敗を見分ける）。
 *
 * 読み終えたとき・途中で読むのをやめたとき・中止したときは、本文の読み取りを閉じる（接続を残さない）。
 *
 * @param body - 応答の本文（`Response.body`）
 * @param signal - 中止の合図。中止されたら、待っている読み取りを止めて `AbortError` を投げる
 * @throws {DOMException} 中止された場合（`AbortError`）
 */
export async function* readJsonLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    /** 閉じる。待っている read() は、終わり (done) として返る */
    const close = () => { void reader.cancel().catch(() => { /* すでに閉じている・壊れている本文は、そのまま */ }); };
    signal?.addEventListener('abort', close, { once: true });
    /** まだ改行が来ていない、行の途中 */
    let rest = '';
    try {
        for (;;) {
            if (signal?.aborted) throw abortError();
            const { done, value } = await reader.read();
            if (signal?.aborted) throw abortError();
            // stream: true で、文字の途中で切れたバイトを次のぶんまで持ち越す。終わりでは、持ち越しを出し切る
            rest += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = rest.split('\n');
            // 終わりでなければ、最後の 1 つは行の途中 (改行で終わっていれば空)
            rest = done ? '' : lines.pop() ?? '';
            for (const line of lines) {
                const parsed = parseLine(line);
                if (!parsed) continue;
                yield parsed;
                // 行を渡しているあいだに中止されたら、同じまとまりで届いていた残りの行は渡さない
                if (signal?.aborted) throw abortError();
            }
            if (done) return;
        }
    } finally {
        signal?.removeEventListener('abort', close);
        close();
    }
}

/** 1 行を JSON のオブジェクトとして読む。空の行・読めない行・オブジェクトでない値は null。 */
function parseLine(line: string): Record<string, unknown> | null {
    const text = line.trim();
    if (!text) return null;
    try {
        const value: unknown = JSON.parse(text);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/**
 * アシスタントの会話 1 つ。会話（Messages API の形）と、画面に出す並び（文・操作ログ・知らせ）を持つ。
 */
export class AssistantSession {
    /** Claude に送る会話。足すだけで、書き換えない */
    private messages: ApiMessage[] = [];
    private state: AssistantState = {
        items: [], running: false, waiting: null, today: null, needsKey: false, restored: 0, restoredFrom: 'project', archive: [],
    };
    private listeners = new Set<() => void>();
    private nextId = 1;
    private controller: AbortController | null = null;
    /** 動いているあいだに届いた、戻す会話と履歴（プロジェクトが入れ替わった）。依頼が終わったところで戻す */
    private pendingRestore: { saved: readonly SavedItem[]; archive: readonly ArchivedConversation[] } | null = null;

    /** 状態が変わったときに呼ばれる関数を登録する。戻り値を呼ぶと、登録を外す。 */
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    /** いまの状態。 */
    getState = (): AssistantState => this.state;

    /** Claude に送る会話（テストと、確かめのため）。 */
    conversation(): readonly ApiMessage[] {
        return this.messages;
    }

    private update(patch: Partial<AssistantState>): void {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
    }

    private push(item: ChatItem): void {
        this.update({ items: [...this.state.items, item] });
    }

    private replace(id: number, next: ChatItem): void {
        this.update({ items: this.state.items.map((item) => (item.id === id ? next : item)) });
    }

    private id(): number {
        return this.nextId++;
    }

    /**
     * 1 回の呼び出しの応答を読む。少しずつ届く応答（NDJSON）なら、流れてきた文を吹き出しに足していき、
     * 最後の行（`done`）を返す。JSON 1 つの応答（古い形）なら、そのまま返す。
     *
     * 流れている吹き出しは、ここでは確定しない（返した `content` で `settleStreaming` が確定する。
     * 失敗・中止で抜けたぶんは、`send` の終わりで消す）。
     *
     * @throws {GuideRequestError} 途中の失敗の行（`error`）が来た場合、最後の行が来ないまま本文が終わった場合
     * @throws {DOMException} 中止された場合（`AbortError`）
     */
    private async readStep(resp: Response, signal: AbortSignal): Promise<StepResponse> {
        if (!(resp.headers.get('Content-Type') ?? '').includes(NDJSON)) return (await resp.json()) as StepResponse;
        /** ここまでに流れてきた文（差分をつないだもの） */
        let flowed = '';
        let bubbleId: number | null = null;
        if (resp.body) {
            for await (const raw of readJsonLines(resp.body, signal)) {
                const line = raw as StepLine;
                if (line.type === 'text') {
                    if (typeof line.text !== 'string') continue;
                    flowed += line.text;
                    // 頭の空白や改行だけのあいだは、まだ吹き出しを出さない (確定した文も、前後の空白を落とす)
                    const shown = flowed.trimStart();
                    if (!shown) continue;
                    if (bubbleId === null) {
                        bubbleId = this.id();
                        this.push({ kind: 'assistant', id: bubbleId, text: shown, streaming: true });
                    } else {
                        this.replace(bubbleId, { kind: 'assistant', id: bubbleId, text: shown, streaming: true });
                    }
                } else if (line.type === 'tool') {
                    if (typeof line.name === 'string') this.update({ waiting: `${toolLabel(line.name)}準備をしています…` });
                } else if (line.type === 'done') {
                    // for await を抜けると、本文の読み取りは閉じる (この後ろに行が在っても読まない)
                    return line;
                } else if (line.type === 'error') {
                    if (line.today) this.update({ today: line.today });
                    const detail = line.detail;
                    if (typeof detail === 'string') throw new GuideRequestError(detail, 'api');
                    throw new GuideRequestError(String(detail?.message ?? 'アシスタントを呼べませんでした。もう一度試してください'), String(detail?.code ?? 'api'));
                }
                // 知らない種類の行は、読み飛ばす
            }
        }
        throw new GuideRequestError('応答が途中で切れました。もう一度試してください', 'truncated');
    }

    /**
     * 流れていた吹き出しを、確定した文にする（文が空なら、吹き出しを消す）。流れていなければ、文が在るときだけ足す。
     * 吹き出しの番号は変えない（画面の同じ要素のまま、確定した文になる）。
     */
    private settleStreaming(text: string): void {
        const flowing = this.state.items.find((item) => item.kind === 'assistant' && item.streaming);
        if (!flowing) {
            if (text) this.push({ kind: 'assistant', id: this.id(), text });
            return;
        }
        this.update({
            items: text
                ? this.state.items.map((item) => (item.id === flowing.id ? { kind: 'assistant' as const, id: flowing.id, text } : item))
                : this.state.items.filter((item) => item.id !== flowing.id),
        });
    }

    /** 今日の使用量を入れる（ドックを開いたときに読んだもの、上限を変えたときのもの）。 */
    setToday(today: GuideToday | null): void {
        this.update({ today });
    }

    /** API キーの欄を出す・しまう（キーを設定できたら、しまう）。 */
    setNeedsKey(needsKey: boolean): void {
        if (this.state.needsKey !== needsKey) this.update({ needsKey });
    }

    /**
     * 新しい会話にする。それまでの会話は消さずに、履歴の頭へ移す（空の会話は移さない）。動いているあいだは、何もしない。
     * 履歴が `MAX_ARCHIVED` を超えたら、いちばん古い会話から消える。
     */
    reset(): boolean {
        if (this.state.running) return false;
        const archive = this.archiveCurrent();
        this.messages = [];
        this.update({ items: [], waiting: null, needsKey: false, restored: 0, archive });
        return true;
    }

    /** いまの会話を履歴の頭に入れた、新しい履歴を返す（いまの会話が空なら、そのまま）。 */
    private archiveCurrent(): ArchivedConversation[] {
        const items = this.saved();
        if (items.length === 0) return [...this.state.archive];
        const entry: ArchivedConversation = { id: this.id(), title: archiveTitle(items), archivedAt: new Date().toISOString(), items };
        return [entry, ...this.state.archive].slice(0, MAX_ARCHIVED);
    }

    /**
     * 履歴の会話を開き直す。いまの会話（空でなければ）は、履歴の頭へ移す。Claude に送る会話は空にし、次の依頼は、
     * 開き直した並びから作った「これまでの記録」で始まる（プロジェクトを開き直したときと同じ）。
     *
     * @returns 開いたら true（動いているあいだ・その番号が無いときは false で、何もしない）
     */
    openArchived(id: number): boolean {
        if (this.state.running) return false;
        const target = this.state.archive.find((entry) => entry.id === id);
        if (!target) return false;
        const archive = this.archiveCurrent().filter((entry) => entry.id !== id);
        this.messages = [];
        const items = savedToItems(target.items, () => this.id());
        this.update({ items, waiting: null, needsKey: false, restored: items.length, restoredFrom: 'history', archive });
        return true;
    }

    /** 履歴の会話を 1 つ消す（次の保存で、プロジェクトからも消える）。消したら true。 */
    deleteArchived(id: number): boolean {
        if (!this.state.archive.some((entry) => entry.id === id)) return false;
        this.update({ archive: this.state.archive.filter((entry) => entry.id !== id) });
        return true;
    }

    /** 画面に並んでいるものを、プロジェクトに保存する形にする（Claude に送る会話は入れない）。 */
    saved(): SavedItem[] {
        return itemsToSaved(this.state.items);
    }

    /** 履歴（プロジェクトに保存する。新しい順）。 */
    archived(): readonly ArchivedConversation[] {
        return this.state.archive;
    }

    /**
     * プロジェクトに保存してあった会話と履歴を戻す（プロジェクトを開いたとき。空なら、空にする）。
     * Claude に送る会話は空にする。次の依頼は、戻した並びから作った「これまでの記録」で始まる。
     *
     * 動いているあいだに呼ばれたら（依頼の途中で、プロジェクトを開いた・新しくした）、中止を頼み、依頼が
     * 終わったところで戻す。前のプロジェクトの会話を、新しいプロジェクトに残さない（保存で、別のプロジェクトの
     * ファイルに入ってしまう）。その依頼の、元に戻す履歴の記録は作らない（前と後で、別のプロジェクトになるため）。
     *
     * @param saved - いまの会話
     * @param archive - 履歴（新しい順）。省くと空
     * @returns すぐ戻したら true（動いていて、後で戻すなら false）
     */
    restore(saved: readonly SavedItem[], archive: readonly ArchivedConversation[] = []): boolean {
        if (this.state.running) {
            this.pendingRestore = { saved, archive };
            this.cancel();
            return false;
        }
        this.messages = [];
        const items = savedToItems(saved, () => this.id());
        this.update({ items, waiting: null, needsKey: false, restored: items.length, restoredFrom: 'project', archive: archive.slice(0, MAX_ARCHIVED) });
        return true;
    }

    /** 履歴の番号を振る関数（プロジェクトから履歴を読むときに使う。会話の並びと同じ番号の列）。 */
    nextItemId = (): number => this.id();

    /**
     * 中止する。待っている呼び出しを止め、次のツール・次の呼び出しを始めない。すでに行った操作は残る。
     */
    cancel(): void {
        if (!this.state.running || !this.controller || this.controller.signal.aborted) return;
        this.controller.abort();
        this.update({ waiting: '中止しています…' });
    }

    /**
     * 依頼を送り、Claude が答え終わるまで（または、止まるまで）繰り返す。
     *
     * @param text - 利用者の文
     * @param deps - 画面の側の入口
     * @returns 送ったら true（空の文、動いているあいだは false で、何もしない）
     */
    async send(text: string, deps: AssistantDeps): Promise<boolean> {
        const request = text.trim();
        if (!request || this.state.running) return false;

        const controller = new AbortController();
        this.controller = controller;
        const turnId = makeTurnId();
        const before = [...this.state.items];
        // 縮めるのは、依頼の境目 (ここ) だけ。長くなっていたら、送る会話を丸ごと捨てて、記録で始め直す
        if (this.messages.length > 0 && needsCompaction(this.messages)) {
            this.messages = [];
            before.push({ kind: 'notice', id: this.id(), tone: 'info', text: '会話が長くなったので、ここまでを短い記録にまとめて Claude に渡します（ここに並んでいるものは、そのまま残ります）' });
        }
        // 送る会話が空で、画面に前の会話が並んでいるなら (まとめた直後・プロジェクトを開き直した後)、記録から始める
        if (this.messages.length === 0) {
            const digest = conversationDigest(before);
            if (digest) this.messages.push({ role: 'user', content: [{ type: 'text', text: digest }] });
        }
        this.messages.push({ role: 'user', content: [{ type: 'text', text: request }] });
        this.update({ items: [...before, { kind: 'user', id: this.id(), text: request }], running: true, waiting: '考えています…' });

        /** 依頼ごとの記録。最初の「変える」ツールの前に開く */
        let commit: CommitEdit | null = null;
        let calls = 0;
        let cost: number | null = 0;
        /** 終わりに出す知らせ（中止・失敗・途中で止めた） */
        let ending: { tone: 'info' | 'error'; text: string; code?: string } | null = null;
        /** 実行したツールの結果（形を閉じるときに使う） */
        const done = new Map<string, ContentBlock>();

        try {
            for (let step = 0; ; step++) {
                if (controller.signal.aborted) throw abortError();
                if (step >= MAX_STEPS) {
                    ending = { tone: 'info', text: `Claude を ${MAX_STEPS} 回呼んだので、ここで止めました（1 回の依頼で呼べる上限です）。続きは、もう一度頼んでください` };
                    break;
                }
                this.update({ waiting: '考えています…' });
                const resp = await apiFetch('/api/assistant/step', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: this.messages, turn_id: turnId, step, stream: true }),
                    signal: controller.signal,
                });
                if (!resp.ok) throw await toError(resp, 'アシスタントを呼べませんでした。');
                // 少しずつ届く応答は、流れてきた文を吹き出しに足しながら、最後の行まで読む
                const data = await this.readStep(resp, controller.signal);
                calls += 1;
                cost = cost !== null && typeof data.cost_usd === 'number' ? cost + data.cost_usd : null;
                const content = Array.isArray(data.content) ? data.content : [];
                // 応答の content は、変えずに足す (空の応答は足さない。空のメッセージは、次の呼び出しで断られる)
                if (content.length > 0) this.messages.push({ role: 'assistant', content });
                this.update({ ...(data.today ? { today: data.today } : {}), needsKey: false });
                // 画面の文は、流れてきた差分ではなく、確定した content から作る (流れていた吹き出しは、これに置き換わる)
                this.settleStreaming(textOf(content));

                const uses = toolUses(content);
                if (data.stop_reason === 'max_tokens') {
                    // 切れた応答の中のツールは、引数が途中かもしれないので実行しない (形は、下の finally で閉じる)
                    ending = { tone: 'error', text: '応答が長すぎて、途中で切れました。頼むことを小さく分けて、もう一度試してください' };
                    for (const use of uses) {
                        done.set(use.id, unrunResult(use.id, '応答が途中で切れたので、実行していません'));
                        this.push({ kind: 'tool', id: this.id(), name: use.name, state: 'cancelled', text: `${toolLabel(use.name)}: 応答が途中で切れたので、実行していません`, activity: [] });
                    }
                    break;
                }
                if (data.stop_reason !== 'tool_use' || uses.length === 0) break;

                for (const use of uses) {
                    const label = toolLabel(use.name);
                    if (controller.signal.aborted) {
                        // 中止した後のツールは始めない。結果だけ入れて、形を閉じる
                        done.set(use.id, unrunResult(use.id, '中止しました'));
                        this.push({ kind: 'tool', id: this.id(), name: use.name, state: 'cancelled', text: `${label}: 中止したので、実行していません`, activity: [] });
                        continue;
                    }
                    const rowId = this.id();
                    const running = Object.prototype.hasOwnProperty.call(TOOLS, use.name) ? TOOLS[use.name].running : `${label}…`;
                    this.push({ kind: 'tool', id: rowId, name: use.name, state: 'running', text: running, activity: [] });
                    this.update({ waiting: running });
                    await nextFrame();
                    // 変える操作の前に、依頼ごとの記録を開く (中の記録は、これにまとまる)
                    if (!commit && isWriteTool(use.name)) commit = deps.beginEdit(`アシスタント: ${requestHead(request)}`);
                    const entries = activityEntries();
                    const mark = entries.length > 0 ? entries[entries.length - 1].id : 0;
                    const outcome = await runTool(use.name, use.input, deps.env);
                    // この操作のあいだに、動きの記録に増えた行 (ステータスバーの文、API の呼び出し、MIDI の行)
                    const during = activityEntries().filter((entry) => entry.id > mark);
                    if (outcome.ok) {
                        done.set(use.id, { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(outcome.result) });
                        this.replace(rowId, { kind: 'tool', id: rowId, name: use.name, state: 'ok', text: outcome.result.summary, activity: during });
                        recordActivity('agent', outcome.result.summary);
                    } else {
                        done.set(use.id, { type: 'tool_result', tool_use_id: use.id, content: outcome.message, is_error: true });
                        // Claude には、直し方の分かる文 (message) を返す。操作ログと動きの記録には、利用者向けの文 (shown) を出す
                        this.replace(rowId, { kind: 'tool', id: rowId, name: use.name, state: 'error', text: `${label}: ${outcome.shown}`, activity: during });
                        recordActivity('agent', `できませんでした（${label}）: ${outcome.shown}`);
                    }
                }
                // 全部の結果を、1 つの user のメッセージにまとめる
                this.messages.push({ role: 'user', content: uses.map((use) => done.get(use.id) ?? unrunResult(use.id, '中止しました')) });
            }
        } catch (e) {
            if (isAbort(e) || controller.signal.aborted) {
                ending = { tone: 'info', text: '中止しました' };
            } else if (e instanceof GuideRequestError) {
                ending = { tone: 'error', text: e.message, code: e.code };
                if (e.needsKey) this.update({ needsKey: true });
                // 1 日の上限で断られたら、今日の使用量を読み直す (見出しの回数と、入力欄の上の知らせを合わせる。Claude は呼ばない)
                if (e.code === 'daily_limit') void fetchGuideSettings().then((saved) => this.setToday(saved.today)).catch(() => { /* 読めなくても、会話の知らせは出ている */ });
            } else {
                ending = { tone: 'error', text: `アシスタントを呼べませんでした。${describeError(e)}` };
            }
        } finally {
            // 会話の最後が、結果の無い tool_use のままなら、形を閉じる (開いたままだと、次の依頼が通らない)
            const last = this.messages[this.messages.length - 1];
            const open = last?.role === 'assistant' ? toolUses(last.content) : [];
            if (open.length > 0) {
                this.messages.push({ role: 'user', content: open.map((use) => done.get(use.id) ?? unrunResult(use.id, '中止しました')) });
            }
            // 依頼ごとの記録を閉じる (何も変わっていなければ、記録は作られない)。
            // 依頼の途中でプロジェクトが入れ替わっていたら、記録は作らずに閉じる
            const replaced = this.pendingRestore;
            this.pendingRestore = null;
            let changed = false;
            try { changed = commit ? commit(replaced ? { discard: true } : undefined) : false; } catch { /* 閉じられなくても、会話は続けられる */ }
            const undoEntryId = changed ? deps.topUndoId() : null;
            // 確定しないまま終わった吹き出し (中止・失敗) は消す。会話に入っていない文を、画面に残さない
            const items = this.state.items.filter((item) => !(item.kind === 'assistant' && item.streaming));
            if (ending) {
                const kept = ending.text === '中止しました' && changed ? '中止しました。ここまでに行った操作は残っています（「元に戻す」で戻せます）' : ending.text;
                items.push({ kind: 'notice', id: this.id(), tone: ending.tone, text: kept, ...(ending.code ? { code: ending.code } : {}) });
            }
            if (calls > 0 || changed) items.push({ kind: 'turn', id: this.id(), calls, costUsd: cost, changed, undoEntryId });
            this.controller = null;
            this.update({ items, running: false, waiting: null });
            // 入れ替わったプロジェクトの会話に置き換える (この依頼の並びは、前のプロジェクトのものなので残さない)
            if (replaced) this.restore(replaced.saved, replaced.archive);
        }
        return true;
    }
}

/** この画面の会話（1 つだけ。ドックを閉じても、練習画面に出入りしても残る）。 */
export const assistantSession = new AssistantSession();
