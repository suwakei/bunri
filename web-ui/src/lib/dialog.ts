/**
 * bunri DAW — 画面を覆う窓（案内、グリッドの補正）に共通の振る舞い。
 */
import { useEffect, type RefObject } from 'react';

/** 窓の中で、キーボードで移れる部品。 */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 画面を覆う窓に、キーボードの基本の操作を付ける。
 *
 * - 開いたとき、窓の中へフォーカスを移す（`data-autofocus` を付けた部品、無ければ最初の部品）
 * - Esc で閉じる
 * - Tab で、窓の外（下に隠れている画面）へ出ない
 * - 閉じたとき、開く前に居た場所へフォーカスを戻す
 *
 * 窓の要素には、呼ぶ側で `role="dialog"` と `aria-modal="true"` を付ける。
 *
 * @param ref - 窓の要素
 * @param open - 窓が開いているか
 * @param onClose - Esc が押されたときに呼ぶ。閉じてはいけない間（処理中など）は、呼ばれた側で無視する
 */
export function useDialog(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
    useEffect(() => {
        if (!open) return;
        const dialog = ref.current;
        if (!dialog) return;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const first = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
        (first ?? dialog).focus();

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
                return;
            }
            if (e.key !== 'Tab') return;
            const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
            if (items.length === 0) { e.preventDefault(); return; }
            const head = items[0], tail = items[items.length - 1];
            const active = document.activeElement;
            if (!dialog.contains(active)) { e.preventDefault(); head.focus(); }
            else if (e.shiftKey && active === head) { e.preventDefault(); tail.focus(); }
            else if (!e.shiftKey && active === tail) { e.preventDefault(); head.focus(); }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            // 開く前に居た場所が、まだ画面に在れば戻す
            if (previous && document.contains(previous)) previous.focus();
        };
    }, [ref, open, onClose]);
}
