/**
 * bunri DAW — 知らせ（画面に浮かせて出す、失敗と「いまはできない理由」の文）。
 *
 * ステータスバーは画面のいちばん下の 1 行なので、押した場所を見ていると気づかない。
 * 「押したのに何も起きない」をなくすため、次の 2 つは、ステータスバーに加えて知らせとしても出す:
 *
 * - `error`: 操作が失敗した（何が起きたか + 次にどうすればよいか）
 * - `hint`: 失敗ではないが、いまはできない（なぜ何も起きないか + どうすればできるか）
 *
 * うまくいった結果（「保存しました」など）は知らせにしない。ステータスバーに出るだけにする
 * （毎回浮かぶと、肝心の知らせが埋もれる）。
 *
 * DAW の画面では、ストアの `setStatus(文, 'error' | 'hint')` がここを呼ぶ。ストアの外の画面（ツール）や、
 * 押せないボタンを押したときの知らせ（components/NoticeToast.tsx）は、`notify` を直に呼ぶ。
 *
 * 画面の部品とは切り離してある（React の外からも呼べるように）。表示は `components/NoticeToast.tsx`。
 * 文の決まり（「エラー: 」で始めない、次にすることを書く）は docs/ui-terms.md。
 */

export type NoticeKind = 'error' | 'hint';

/** 知らせに付ける、次にすることのボタン。 */
export interface NoticeAction {
    /** ボタンの名前（動詞まで書く） */
    label: string;
    /** 押したときにすること。押すと、知らせは閉じる */
    run: () => void;
    /** ボタンの説明（ツールチップ） */
    tip?: string;
}

export interface Notice {
    id: number;
    kind: NoticeKind;
    text: string;
    action?: NoticeAction;
    /**
     * 知らせそのものを読み上げの対象にするか。ふだんは false（同じ文がステータスバーなどに出ていて、そちらが
     * 読み上げられる。両方を対象にすると 2 回読まれる）。ほかのどこにも出ない文のときだけ true にする
     */
    live: boolean;
    /**
     * 同じ文が出し直された回数。出ているあいだに同じ知らせが来たら、増やすだけで並べない
     * （鍵盤を弾くたびに同じ文が積み上がらないように）。表示の側は、これが変わると、もう一度目に入るように動かす。
     * 続けざまに来たぶん（`REPEAT_QUIET_MS` のうち。キーの押しっぱなしなど）は数えない
     */
    bump: number;
    /** 同じ文が来た回数（続けざまのぶんも数える）。表示の側は、これが変わると閉じるまでの時間を数え直す */
    renew: number;
    /** ✕ で閉じたときに呼ぶ（時間で閉じたときは呼ばない） */
    onDismiss?: () => void;
}

/** 同時に出す数の上限。超えたら古いものから閉じる。 */
export const MAX_NOTICES = 3;
/** 同じ文がこの時間のうちにまた来たら、目を引く動きはさせない（ミリ秒）。キーの押しっぱなしで点滅しないように。 */
export const REPEAT_QUIET_MS = 1500;

let notices: Notice[] = [];
let seq = 0;
/** 知らせごとの、最後に目を引く動きをさせた時刻 */
const lastBump = new Map<number, number>();
const listeners = new Set<() => void>();

function emit(next: Notice[]): void {
    notices = next;
    for (const listener of listeners) listener();
}

/**
 * 知らせを出す。
 *
 * @param kind - `error`（失敗）か `hint`（いまはできない理由）
 * @param text - 何が起きたか（なぜ何も起きないか）と、次にどうすればよいか
 * @param options.action - 次にすることを、その場で行うボタン
 * @param options.live - この文が、ほかのどこにも出ないとき true（知らせを読み上げの対象にする）
 * @param options.onDismiss - 利用者が ✕ で閉じたときに呼ぶ
 * @returns 知らせの番号（`dismissNotice` に渡せる）
 */
export function notify(kind: NoticeKind, text: string,
    options: { action?: NoticeAction; live?: boolean; onDismiss?: () => void } = {}): number {
    const message = text.trim();
    if (!message) return -1;
    const now = Date.now();
    const same = notices.find((n) => n.kind === kind && n.text === message);
    if (same) {
        const quiet = now - (lastBump.get(same.id) ?? 0) < REPEAT_QUIET_MS;
        if (!quiet) lastBump.set(same.id, now);
        emit(notices.map((n) => (n === same
            ? { ...n, action: options.action ?? n.action, bump: n.bump + (quiet ? 0 : 1), renew: n.renew + 1 }
            : n)));
        return same.id;
    }
    seq += 1;
    const notice: Notice = {
        id: seq, kind, text: message, action: options.action, live: options.live === true, bump: 0, renew: 0,
        onDismiss: options.onDismiss,
    };
    lastBump.set(notice.id, now);
    const next = [...notices, notice].slice(-MAX_NOTICES);
    for (const id of lastBump.keys()) if (!next.some((n) => n.id === id)) lastBump.delete(id);
    emit(next);
    return notice.id;
}

/**
 * 知らせを 1 つ閉じる。
 *
 * @param id - 知らせの番号
 * @param options.byUser - 利用者が ✕ で閉じたとき true（`onDismiss` を呼ぶ）
 */
export function dismissNotice(id: number, options: { byUser?: boolean } = {}): void {
    const notice = notices.find((n) => n.id === id);
    if (!notice) return;
    lastBump.delete(id);
    emit(notices.filter((n) => n.id !== id));
    if (options.byUser) notice.onDismiss?.();
}

/** 知らせをすべて閉じる。 */
export function clearNotices(): void {
    lastBump.clear();
    if (notices.length > 0) emit([]);
}

/** いま出ている知らせ（古い順）。`useSyncExternalStore` に渡せるよう、変わらないあいだは同じ配列を返す。 */
export function getNotices(): Notice[] {
    return notices;
}

/** 知らせが変わるたびに呼ばれる関数を登録する。戻り値を呼ぶと外れる。 */
export function subscribeNotices(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** 出しておく長さ（ミリ秒）。失敗の文は長いことが多いので、長めに出す。読む時間は、文の長さでも延ばす。 */
export function noticeDuration(notice: Pick<Notice, 'kind' | 'text' | 'action'>): number {
    const base = notice.kind === 'error' ? 10_000 : 7_000;
    // 1 文字あたり 60 ミリ秒ぶん延ばす（40 文字を超えたぶん）。ボタンが在るときは、押すかどうかを決める時間も足す
    const extra = Math.max(0, notice.text.length - 40) * 60 + (notice.action ? 3_000 : 0);
    return Math.min(base + extra, 20_000);
}

/** 押せない状態の部品（ボタン・入力欄・選択肢）を探すセレクタ。 */
const DISABLED_SELECTOR = 'button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"]';

/** ほかの処理が動いているあいだ押せない部品の、押せない理由（`blockedBy` に渡す）。 */
export const BUSY_REASON = 'ほかの処理が動いているあいだは、始められません。その処理が終わってから、もう一度押してください';

/**
 * 押せない理由を、部品に付ける属性にして返す（JSX に `{...blockedBy(busy && '理由')}` と書くため）。
 *
 * 説明（`data-tip`）が「押すと何が起きるか」のままで、押せない理由になっていないときに使う。
 * 理由が無い（押せる）ときは、何も付けない。
 *
 * @param reason - 押せない理由と、どうすれば押せるようになるか。押せるときは false / null / undefined / 空
 */
export function blockedBy(reason: string | false | null | undefined): Record<string, string> {
    return reason ? { 'data-blocked': reason } : {};
}

/**
 * 押せない状態の部品を押したときに出す文を返す。出すものが無ければ null。
 *
 * 文は、その部品の `data-blocked`（押せない理由。`blockedBy`）。無ければ、説明（`data-tip`）の頭に
 * 「いまは使えません。」を付ける。説明は「押せないあいだは、どうすれば押せるようになるかを書く」決まり
 * （docs/ui-terms.md）なので、そのまま「なぜ押せないか」の答えになる。
 *
 * `aria-disabled` の部品は、押したことが部品に届く。押されたときに自分で理由を出す部品は、空の `data-blocked` を
 * 書いておく（ここからは何も出さない）。
 *
 * @param start - 押された場所の要素
 */
export function blockedReason(start: Element | null): string | null {
    // ラベルの文字を押したときは、そのラベルが指す部品を見る (チェックボックスや選択肢は、文字のほうが押す面積が広い)
    const labelled = start?.closest('label')?.control as HTMLElement | null | undefined;
    const control = start?.closest<HTMLElement>(DISABLED_SELECTOR)
        ?? (labelled?.matches(DISABLED_SELECTOR) ? labelled : null);
    if (!control) return null;
    // 説明が、押せない部品そのものではなく、それを包むラベルに書いてあることも在る
    const holder = control.hasAttribute('data-blocked') || control.hasAttribute('data-tip')
        ? control
        : control.closest<HTMLElement>('[data-blocked], [data-tip]');
    // 空の data-blocked は「この部品は、押されたときに自分で理由を出す」のしるし (同じことを 2 回知らせない)
    if (holder?.getAttribute('data-blocked') === '') return null;
    const blocked = holder?.getAttribute('data-blocked')?.trim();
    if (blocked) return blocked;
    const described = holder?.getAttribute('data-tip')?.trim();
    return described ? `いまは使えません。${described}` : null;
}
