/**
 * bunri DAW — キーボードの操作を受けるときの共通の判定。
 */

/** 文字を打ち込む欄ではない input の種類 (ここに居るときは、ショートカットを効かせてよい)。 */
const NON_TEXT_INPUT = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color']);

/**
 * 文字を書き換えられる欄 (文字の入力欄・複数行の欄・編集できる要素) に居るか。
 *
 * ここに居るときの Backspace は「1 文字消す」。それ以外の場所では、ブラウザによっては
 * 「前のページへ戻る」に割り当てられている (WebKit) ので、呼ぶ側で既定の動作を止める。
 *
 * @param target - キー操作を受けた要素 (`event.target`)
 */
export function isTextEntry(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return !NON_TEXT_INPUT.has((target as HTMLInputElement).type);
    return false;
}

/**
 * 文字を打ち込む欄 (入力欄・選択欄・編集できる要素) に居るか。
 *
 * ここに居るあいだは、1 文字のショートカット (Space で再生、Backspace でノート削除など) を効かせない。
 * 効かせると、BPM の欄で数字を消しただけでノートが消える。
 * 選択欄 (`<select>`) も含める (Space や文字キーで選択肢を選ぶため)。
 *
 * @param target - キー操作を受けた要素 (`event.target`)
 */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (isTextEntry(target)) return true;
    return target instanceof HTMLElement && target.tagName === 'SELECT';
}

/**
 * いま、キーボードで部品を移りながら操作しているか (Tab キーで移った後、マウスなどで押すまで true)。
 *
 * CSS の `:focus-visible` では見分けられない。マウスで押したボタンにフォーカスが残っているだけでも、
 * 次にキーを押した時点で `:focus-visible` に当たるようになるブラウザが在るため、自分で覚えておく。
 */
let keyboardNavigation = false;

if (typeof document !== 'undefined') {
    const byPointer = () => { keyboardNavigation = false; };
    document.addEventListener('pointerdown', byPointer, true);
    document.addEventListener('mousedown', byPointer, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Tab') keyboardNavigation = true; }, true);
}

/**
 * キーボードで選んでいる操作部品 (ボタン・リンク・タブなど) に居るか。
 *
 * Tab キーで移ってきた利用者は、Space でその部品を押そうとしている。そのときは、
 * Space を再生の切り替えに使わない (使うと、押したい部品が押せず、再生も二重に切り替わる)。
 * マウスで押した後に残っているだけのフォーカスは、これに当たらない。
 *
 * @param target - キー操作を受けた要素 (`event.target`)
 */
export function isKeyboardFocusedControl(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (!target.matches('button, a[href], summary, input, [role="tab"], [role="button"], [role="separator"]')) return false;
    return keyboardNavigation;
}

/** 画面を覆う窓 (案内、グリッドの補正) が開いているか。開いているあいだは、下の画面のショートカットを効かせない。 */
export function isDialogOpen(): boolean {
    return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null;
}
