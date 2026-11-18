/**
 * 本物の窓の中の「押せるもの」を、画面のことば (ボタンの文、欄の名前) で探して操作する。
 *
 * 操作のコマンド (drive.ts) と、テスト (smoke.test.ts) が使う。セレクタや XPath を書かずに、
 * 利用者が言う呼び名のまま (「MIDI 入力」を押す、「録り方」を「ステップ入力」にする) 操作できるようにするため。
 *
 * - 対象は、いま見えている、ボタン・リンク・選択肢・入力欄・タブ・メニューの項目
 * - 名前は、読み上げの名前 (aria-label)、見えている文、紐づくラベルの順に決める
 * - 名前がぴったり同じものを先に探し、無ければ、その文を含むものを探す。
 *   2 つ以上あるときは、何番目か (`nth`。1 から) を指定させる (勝手に選ばない)
 * - クリックは画面の中の `element.click()` (OS のマウス操作ではない。webdriver.ts と同じ)。
 *   ドラッグや、ピアノロールのキャンバスの上の細かな操作はできない
 */
import type { WebDriverSession } from './webdriver.ts';

/** 押せるもの 1 つ。 */
export interface Control {
    /** 種類 (ボタン、選択肢、入力欄、チェック…)。 */
    kind: string;
    /** 名前 (画面のことば)。 */
    name: string;
    /** いまの状態 (押せない、選んでいるもの、オン / オフなど)。無ければ空。 */
    state: string;
}

/** 画面のいまの様子。 */
export interface Snapshot {
    /** 窓の題名。 */
    title: string;
    /** ステータスバーの文 (DAW の画面でなければ null)。 */
    status: string | null;
    controls: Control[];
}

/** 画面の中で行うこと。 */
type Action =
    | { type: 'list'; filter: string | null }
    | { type: 'click'; label: string; nth: number | null }
    | { type: 'set'; label: string; value: string; nth: number | null };

/**
 * 画面の中で実行する関数。文字列にして送られるので、外の変数や関数は使えない (全部この中に書く)。
 *
 * 失敗 (見つからない、2 つ以上ある、押せない) は、説明の文を載せた例外にする。
 */
function inPage(action: Action): Snapshot | string {
    const SELECTOR = 'button, a[href], select, input, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"]';
    const squash = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
    const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const kindOf = (el: Element) => {
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
    };
    const nameOf = (el: Element) => {
        const aria = squash(el.getAttribute('aria-label'));
        if (aria) return aria;
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') {
            const field = el as HTMLInputElement;
            const label = squash(field.labels?.[0]?.textContent) || squash(el.closest('label')?.textContent);
            if (label) return label;
            return squash(el.getAttribute('placeholder') ?? el.getAttribute('title') ?? el.getAttribute('name') ?? el.id);
        }
        return squash(el.textContent) || squash(el.getAttribute('title')) || (el.id ? `#${el.id}` : '');
    };
    const stateOf = (el: Element) => {
        const parts: string[] = [];
        if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') parts.push('押せない');
        if (el.getAttribute('aria-pressed') === 'true') parts.push('押してある');
        if (el.getAttribute('aria-selected') === 'true') parts.push('選んでいる');
        if (el.getAttribute('aria-expanded') === 'true') parts.push('開いている');
        if (el instanceof HTMLSelectElement) {
            const options = Array.from(el.options).map((o) => squash(o.textContent));
            parts.push(`いま「${squash(el.selectedOptions[0]?.textContent)}」。選べるもの: ${options.join(' / ')}`);
        } else if (el instanceof HTMLInputElement) {
            if (el.type === 'checkbox' || el.type === 'radio') parts.push(el.checked ? 'オン' : 'オフ');
            // パスワードの欄 (API キー) の中身は出さない
            else if (el.type !== 'password' && el.type !== 'file' && el.value !== '') parts.push(`いま「${el.value}」`);
        } else if (el instanceof HTMLTextAreaElement && el.value !== '') {
            parts.push(`いま「${el.value.slice(0, 60)}」`);
        }
        return parts.join('、');
    };
    const describe = (el: Element): Control => ({ kind: kindOf(el), name: nameOf(el), state: stateOf(el) });
    const line = (c: Control) => `${c.kind}「${c.name}」${c.state ? `（${c.state}）` : ''}`;
    const all = Array.from(document.querySelectorAll(SELECTOR)).filter(visible);

    const snapshot = (filter: string | null): Snapshot => ({
        title: document.title,
        status: document.querySelector('#status-text')?.textContent ?? null,
        controls: all.map(describe).filter((c) => filter === null || `${c.kind}「${c.name}」`.includes(filter)),
    });
    if (action.type === 'list') return snapshot(action.filter);

    // 名前がぴったり同じものを先に、無ければ、その文を含むものを探す
    const wanted = squash(action.label);
    let found = all.filter((el) => nameOf(el) === wanted);
    if (found.length === 0) found = all.filter((el) => nameOf(el).includes(wanted));
    if (found.length === 0) {
        const names = all.map(describe).filter((c) => c.name).map(line);
        throw new Error(`「${wanted}」という名前の、押せるものが見つかりません。いま見えているもの (${names.length} 個): ${names.slice(0, 60).join('、')}`);
    }
    if (found.length > 1 && action.nth === null) {
        const listed = found.map((el, i) => `${i + 1}: ${line(describe(el))}`).join('、');
        throw new Error(`「${wanted}」に当てはまるものが ${found.length} 個あります。何番目かを --nth で指定してください。${listed}`);
    }
    const target = found[(action.nth ?? 1) - 1];
    if (!target) throw new Error(`「${wanted}」に当てはまるものは ${found.length} 個です (--nth ${action.nth} は範囲の外)`);
    const what = line(describe(target));
    if ((target as HTMLButtonElement).disabled) throw new Error(`${what} は、いま押せません`);

    if (action.type === 'click') {
        (target as HTMLElement).click();
        return what;
    }

    // 値を入れる。React が管理している欄は、要素の value に直接入れても画面の状態が変わらないので、
    // 元の入れ口 (プロトタイプの setter) で入れてから、打ったときと同じイベントを出す
    const fire = (el: Element) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (target instanceof HTMLSelectElement) {
        const options = Array.from(target.options);
        const value = squash(action.value);
        const option = options.find((o) => squash(o.textContent) === value) ?? options.find((o) => o.value === action.value)
            ?? options.find((o) => squash(o.textContent).includes(value));
        if (!option) throw new Error(`${what} に「${value}」という選択肢がありません`);
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(target, option.value);
        fire(target);
        return `${kindOf(target)}「${nameOf(target)}」を「${squash(option.textContent)}」に`;
    }
    if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
        const on = ['on', 'オン', 'true', '1'].includes(action.value);
        if (!on && !['off', 'オフ', 'false', '0'].includes(action.value)) throw new Error(`${what} には、オン か オフ を指定してください`);
        if (target.checked !== on) target.click();
        return `${kindOf(target)}「${nameOf(target)}」を ${on ? 'オン' : 'オフ'} に`;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (target instanceof HTMLInputElement && target.type === 'file') throw new Error(`${what} には、ここからは値を入れられません (ファイルを選ぶ画面は操作できない)`);
        const proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(target, action.value);
        fire(target);
        return `${kindOf(target)}「${nameOf(target)}」に値を入れた`;
    }
    throw new Error(`${what} には、値を入れられません (押すなら click)`);
}

/** いま見えている、押せるものの一覧と、ステータスバーの文。 */
export function snapshot(session: WebDriverSession, filter: string | null = null): Promise<Snapshot> {
    return session.run(inPage, { type: 'list', filter }) as Promise<Snapshot>;
}

/**
 * 名前で探して押す。押したものの説明を返す。
 *
 * @param nth - 当てはまるものが 2 つ以上あるとき、何番目か (1 から)
 */
export function clickControl(session: WebDriverSession, label: string, nth: number | null = null): Promise<string> {
    return session.run(inPage, { type: 'click', label, nth }) as Promise<string>;
}

/**
 * 名前で探して、値を入れる (選択肢は選ぶ、チェックはオン / オフ、入力欄は文字)。行ったことの説明を返す。
 */
export function setControl(session: WebDriverSession, label: string, value: string, nth: number | null = null): Promise<string> {
    return session.run(inPage, { type: 'set', label, value, nth }) as Promise<string>;
}

/**
 * キーを押す (`Space`、`Meta+z`、`Escape` など)。画面の中でキーのイベントを出す (OS のキー操作ではない)。
 *
 * アプリのショートカット (再生、元に戻すなど) には効くが、入力欄に文字を打つことはできない (値は `setControl` で入れる)。
 */
export function pressKey(session: WebDriverSession, combo: string): Promise<string> {
    return session.run((keys: string) => {
        const parts = keys.split('+').map((p) => p.trim()).filter(Boolean);
        const name = parts.pop();
        if (!name) throw new Error('キーの名前が空です');
        const mods = parts.map((p) => p.toLowerCase());
        const unknown = mods.filter((m) => !['meta', 'cmd', 'command', 'ctrl', 'control', 'alt', 'option', 'shift'].includes(m));
        if (unknown.length > 0) throw new Error(`分からない修飾キーです: ${unknown.join(', ')}`);
        const key = name.toLowerCase() === 'space' ? ' ' : name;
        const code = key === ' ' ? 'Space' : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
        const init: KeyboardEventInit = {
            key, code, bubbles: true, cancelable: true,
            metaKey: mods.some((m) => ['meta', 'cmd', 'command'].includes(m)),
            ctrlKey: mods.some((m) => ['ctrl', 'control'].includes(m)),
            altKey: mods.some((m) => ['alt', 'option'].includes(m)),
            shiftKey: mods.includes('shift'),
        };
        const target = document.activeElement ?? document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
        return keys;
    }, combo);
}

/**
 * 動きの記録に、エージェントの行を足す (「いまから何をするか」)。利用者が見ている「記録」の一覧にも出る。
 *
 * 操作の前に足しておくと、記録の中で「この操作のあとに、これが起きた」と読める。
 */
export async function announce(session: WebDriverSession, message: string): Promise<void> {
    await session.run((text: string) => (window as unknown as {
        __TAURI__: { core: { invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> } };
    }).__TAURI__.core.invoke<void>('activity_record', { tag: 'agent', message: text, echo: true }), message);
}
