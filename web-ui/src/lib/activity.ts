/**
 * bunri DAW — 動きの記録。アプリの中でいま何が起きたかを、起きた順に並べる。
 *
 * 利用者が見るための記録（ステータスバーの「記録」。components/ActivityPanel.tsx）で、同じものを
 * Claude Code などのエージェントも読む。デスクトップ版では、1 行ごとにネイティブ側へ送り、ファイルに残す
 * （src-tauri/src/activity.rs。置き場はデータ置き場の `logs/activity.log`）。
 *
 * 載せるもの（札）:
 * - `click` `change` `key`: 画面の操作（どのボタン・どの欄か。lib/activity-setup.ts が画面全体で拾う）
 * - `status`: ステータスバーの文（操作の結果やエラーは、ここに出る）
 * - `api`: 処理を担当する部分の呼び出しと、その結果
 * - `midi`: MIDI 入力のつなぎ、鍵盤の操作、置いたノート
 * - `midi-in`: 鍵盤から届いたメッセージ（ネイティブ側が、ポートの名前つきで足す）
 * - `error`: 捕まえられなかった例外
 * - `agent`: エージェントが窓を操作したときの「いまから何をするか」（外から足される）
 *
 * 載せないもの: 入力欄に打っている途中の文字、API キー、sidecar のトークン、API に送った中身・返ってきた中身、
 * API のクエリの値（`async` を除く）。
 * プロジェクト・トラック・ファイルの名前は、結果の文（`status`）やボタンの名前（`click`）、API のパスとして載る
 * （何を操作したのかが分からないと、記録として役に立たないため）。
 *
 * このファイルは、ほかの lib を import しない（lib/api.ts からも呼ぶので、循環させないため）。
 * ネイティブ側とのつなぎと、画面全体の操作を拾う仕掛けは lib/activity-setup.ts。
 */

/** 記録の 1 行。 */
export interface ActivityEntry {
    /** 通し番号（一覧の並びと、React の key に使う）。 */
    id: number;
    /** 起きた時刻（`Date.now()`）。 */
    at: number;
    /** どこで起きたか（`click` `status` `api` `midi` など）。 */
    tag: string;
    message: string;
}

/** 画面の中に持っておく行数。古いものから捨てる（ファイルには全部残る）。 */
export const MAX_ENTRIES = 500;

let entries: readonly ActivityEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
/** ネイティブ側へ送る関数（デスクトップ版だけ）。 */
let forward: ((tag: string, message: string) => void) | null = null;
/** 直前と同じエラーが、続けて何回来たか（まとめて 1 行にする）。 */
let repeatedErrors = 0;

/** 一覧に 1 行足して、送り先と聞き手に知らせる。 */
function push(tag: string, message: string, local: boolean): void {
    const entry: ActivityEntry = { id: nextId++, at: Date.now(), tag, message };
    // 一覧は毎回新しい配列にする（useSyncExternalStore が、変わったことを配列の同一性で見分ける）
    entries = entries.length >= MAX_ENTRIES ? [...entries.slice(entries.length - MAX_ENTRIES + 1), entry] : [...entries, entry];
    if (!local) forward?.(tag, message);
    for (const listener of listeners) listener();
}

/**
 * 1 行を記録する。
 *
 * 記録の失敗で、呼び出した側の本来の動きを止めない（例外を外へ出さない）。
 *
 * 同じエラーが続けて来たとき（毎フレーム投げられる例外など）は、最初の 1 行だけを残し、続きは回数にまとめる。
 * そのまま残すと、1 秒に何十行も増えて、原因の行が流れてしまう。
 *
 * @param tag - どこで起きたか（英小文字・数字・ハイフン）
 * @param message - 何が起きたか（1 行の文）
 * @param options.local - true なら、画面の中の一覧にだけ入れる（ネイティブ側から届いた行。送り返さない）
 */
export function recordActivity(tag: string, message: string, options?: { local?: boolean }): void {
    try {
        const last = entries[entries.length - 1];
        if (tag === 'error' && last?.tag === 'error' && last.message === message) {
            repeatedErrors++;
            return;
        }
        if (repeatedErrors > 0) {
            const count = repeatedErrors;
            repeatedErrors = 0;
            push('error', `（同じエラーが、さらに ${count} 回続きました）`, false);
        }
        push(tag, message, options?.local === true);
    } catch {
        // 記録できなくても、何もしない
    }
}

/** いま画面の中に持っている記録（古い順）。 */
export function activityEntries(): readonly ActivityEntry[] {
    return entries;
}

/** 記録が増えたときに呼ばれる関数を登録する。戻り値を呼ぶと、登録を外す。 */
export function subscribeActivity(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** ネイティブ側へ送る関数を決める（デスクトップ版の起動時）。null で、送らなくする。 */
export function setActivityForward(next: ((tag: string, message: string) => void) | null): void {
    forward = next;
}

/** テスト用: 記録を空にして、送り先も外す。 */
export function resetActivityForTest(): void {
    entries = [];
    nextId = 1;
    forward = null;
    repeatedErrors = 0;
    listeners.clear();
}

/** 札の、画面での呼び名。 */
const TAG_LABELS: Record<string, string> = {
    app: 'アプリ', click: '操作', change: '変更', key: 'キー', status: '状態', api: '通信',
    midi: 'MIDI', 'midi-in': 'MIDI 受信', error: 'エラー', agent: 'アシスタント',
};

/** 札を、画面に出す呼び名にする。 */
export function tagLabel(tag: string): string {
    return TAG_LABELS[tag] ?? tag;
}

/** 時刻を「時:分:秒.ミリ秒」にする（ファイルの行の頭と同じ形）。 */
export function formatActivityTime(at: number): string {
    const d = new Date(at);
    const two = (n: number) => String(n).padStart(2, '0');
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 文を、決まった長さで切る。 */
function clip(text: string, max: number): string {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max) + '…' : one;
}

/** 操作の対象になる要素（ボタン、リンク、入力欄など）。 */
const CONTROL_SELECTOR = 'button, a[href], select, input, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"]';

/** 要素の種類の、記録での呼び名。 */
function kindOf(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (tag === 'button' || role === 'button') return 'ボタン';
    if (tag === 'a') return 'リンク';
    if (tag === 'select') return '選択肢';
    if (role === 'tab') return 'タブ';
    if (role === 'menuitem' || role === 'option') return '項目';
    if (tag === 'input') {
        const type = (el as HTMLInputElement).type;
        if (type === 'checkbox' || type === 'radio') return 'チェック';
        if (type === 'range') return 'スライダー';
        if (type === 'file') return 'ファイルの欄';
        return '入力欄';
    }
    if (tag === 'textarea') return '入力欄';
    if (tag === 'summary') return '見出し';
    return tag;
}

/**
 * ラベルの文。中の入力欄（の値や選択肢）は除く。
 *
 * ラベルで包んだ textarea は、打った文がラベルの `textContent` に入る。そのまま名前にすると、打った文が記録に載る。
 */
function labelText(label: Element | null | undefined): string {
    if (!label) return '';
    const copy = label.cloneNode(true) as Element;
    for (const field of Array.from(copy.querySelectorAll('input, select, textarea'))) field.remove();
    return clip(copy.textContent ?? '', 60);
}

/** 要素の名前（読み上げの名前、見えている文、紐づくラベルの順に探す）。 */
function nameOf(el: Element): string {
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, 60);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        const label = labelText((el as HTMLInputElement).labels?.[0]) || labelText(el.closest('label'));
        if (label) return label;
        const hint = el.getAttribute('placeholder') ?? el.getAttribute('title') ?? el.getAttribute('name') ?? el.id;
        return hint ? clip(hint, 60) : '';
    }
    const text = el.textContent;
    if (text && text.trim()) return clip(text, 60);
    // 文の無いリンク (書き出しの保存に使う、見えないリンク) は、保存するファイルの名前で示す
    const hint = el.getAttribute('title') ?? el.getAttribute('download');
    if (hint) return clip(hint, 60);
    return el.id ? `#${el.id}` : '';
}

/**
 * 操作された要素を、記録用の短い文にする（`ボタン「再生」` など）。
 *
 * ボタンなどの中の要素（アイコンの span など）が押されたときは、外側のボタンを指す。
 * 操作の対象でない要素（キャンバス、ただの領域）は、タグと id・クラスで示す。
 */
export function describeElement(target: Element): string {
    const control = target.closest(CONTROL_SELECTOR);
    if (control) {
        const name = nameOf(control);
        return name ? `${kindOf(control)}「${name}」` : kindOf(control);
    }
    const tag = target.tagName.toLowerCase();
    if (target.id) return `${tag}#${target.id}`;
    const cls = typeof target.className === 'string' ? target.className.trim().split(/\s+/)[0] : '';
    return cls ? `${tag}.${cls}` : tag;
}

/**
 * 値が変わった欄を、記録用の文にする（`選択肢「録り方」→ ステップ入力` など）。
 *
 * 文字を打つ欄（テキスト、パスワード、検索など）は、**値を載せない**。API キーや、利用者が打った文を
 * 記録に残さないため。選択肢・チェック・数値・スライダーは、選んだものが分からないと記録として役に立たないので載せる。
 */
export function describeChange(target: Element): string {
    const what = describeElement(target);
    const tag = target.tagName.toLowerCase();
    if (tag === 'select') {
        const select = target as HTMLSelectElement;
        const chosen = select.selectedOptions?.[0]?.textContent ?? select.value;
        return `${what} → ${clip(chosen, 60)}`;
    }
    if (tag === 'input') {
        const input = target as HTMLInputElement;
        if (input.type === 'checkbox' || input.type === 'radio') return `${what} → ${input.checked ? 'オン' : 'オフ'}`;
        if (input.type === 'number' || input.type === 'range') return `${what} → ${clip(input.value, 20)}`;
        if (input.type === 'file') return `${what} → ファイルを ${input.files?.length ?? 0} 個選んだ`;
    }
    return `${what}（値は記録しません）`;
}

/** クエリのうち、値まで載せるもの（処理の始め方を表すだけで、利用者の文やファイルの名前が入らないもの）。 */
const QUERY_VALUES_SHOWN = ['async'];

/**
 * API の呼び出し先を、記録用の短い形にする。
 *
 * 接続先を外し、トークンを落とす。クエリは、何を付けたかが分かるよう名前だけ残し、値は載せない
 * （`?name=…`。ファイルの名前などが入るため）。`async` のように値まで載せてよいものだけ、そのまま残す。
 *
 * @param url - `/api/...` のような相対パス、または接続先つきの URL
 */
export function describeApiPath(url: string): string {
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
    const [base, query] = path.split('?');
    if (!query) return base;
    const kept = query.split('&')
        .map((pair) => pair.split('=')[0])
        .filter((name) => name && name !== 'token')
        .map((name) => (QUERY_VALUES_SHOWN.includes(name) ? query.split('&').find((pair) => pair.split('=')[0] === name)! : `${name}=…`));
    return kept.length > 0 ? `${base}?${kept.join('&')}` : base;
}

/** 押されたキーを、記録用の文にする（`⌘+Z`、`Space` など）。修飾キーだけのときは null。 */
export function describeKey(event: { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): string | null {
    if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return null;
    const parts: string[] = [];
    if (event.metaKey) parts.push('⌘');
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    parts.push(event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key);
    return parts.join('+');
}
