/**
 * bunri DAW — 小さなメニュー (クリップの右クリック、トラックの「…」)。
 *
 * - 開くと最初の項目にフォーカスが移る。上下の矢印・Home・End で移り、Enter / Space で選ぶ
 * - Esc か、メニューの外を押すと閉じる。閉じたら、開いたもの (クリップ・「…」のボタン) にフォーカスを戻す
 * - 画面の端からはみ出さないよう、位置を内側に寄せる
 */
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { tip } from '../lib/tooltip';

/** メニューの 1 項目。 */
export interface MenuItem {
    /** 項目の名前 */
    label: string;
    /** 選んだときの処理 */
    action: () => void;
    /** 押せない項目 (理由は title で伝える) */
    disabled?: boolean;
    /** 消す操作 (赤で示す) */
    danger?: boolean;
    /** マウスを載せたときの説明 */
    title?: string;
    /** 選んだ後、開いたものにフォーカスを戻すか (既定 true。名前の変更のように、別の場所へ移すものは false) */
    restoreFocus?: boolean;
}

/** 開くメニューの中身と位置。 */
export interface MenuRequest {
    /** メニューの名前 (読み上げ) */
    label: string;
    /** 左上の位置 (画面の座標) */
    x: number;
    y: number;
    items: MenuItem[];
    /** 閉じたときにフォーカスを戻す先 (描き直しで要素が替わるので、閉じるときに探す) */
    returnFocus?: () => HTMLElement | null | undefined;
}

/**
 * 小さなメニュー。
 * @param request - 開く中身。null なら何も出さない
 * @param onClose - 閉じるとき (項目を選んだときも呼ぶ)
 */
export default function PopupMenu({ request, onClose }: { request: MenuRequest | null; onClose: () => void }) {
    const menuRef = useRef<HTMLDivElement>(null);

    const close = (restoreFocus = true) => {
        const find = request?.returnFocus;
        onClose();
        // 選んだ操作で描き直された後の要素を探して戻す (消す操作なら、もう無い)
        if (restoreFocus && find) requestAnimationFrame(() => find()?.focus());
    };

    // 画面の端からはみ出さない位置に置いてから、最初の項目にフォーカスを移す
    useLayoutEffect(() => {
        const el = menuRef.current;
        if (!request || !el) return;
        el.style.left = Math.max(4, Math.min(request.x, window.innerWidth - el.offsetWidth - 4)) + 'px';
        el.style.top = Math.max(4, Math.min(request.y, window.innerHeight - el.offsetHeight - 4)) + 'px';
        el.style.visibility = 'visible';
        el.querySelector<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    }, [request]);

    // メニューの外を押したら閉じる (フォーカスは押した先に任せる)
    useEffect(() => {
        if (!request) return;
        const onDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) close(false);
        };
        document.addEventListener('mousedown', onDown, true);
        return () => document.removeEventListener('mousedown', onDown, true);
    });

    if (!request) return null;

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const move = (next: number) => { e.preventDefault(); items[(next + items.length) % items.length]?.focus(); };
        if (e.key === 'ArrowDown') move(index + 1);
        else if (e.key === 'ArrowUp') move(index - 1);
        else if (e.key === 'Home') move(0);
        else if (e.key === 'End') move(items.length - 1);
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'Tab') close(false);
        // メニューの中のキーは、下の画面のショートカット (Space で再生、Delete でノート削除) に渡さない
        if (e.key !== 'Tab') e.stopPropagation();
    };

    return (
        <div className="popup-menu" data-tip-side="right" role="menu" aria-label={request.label} ref={menuRef} onKeyDown={onKeyDown}
            style={{ left: request.x, top: request.y, visibility: 'hidden' }}
            onContextMenu={(e) => e.preventDefault()}>
            {request.items.map((item) => (
                <button key={item.label} type="button" role="menuitem" tabIndex={-1}
                    className={'popup-menu-item' + (item.danger ? ' danger' : '')}
                    aria-disabled={item.disabled ? 'true' : undefined} {...(item.title ? tip(item.title) : {})}
                    onClick={() => {
                        if (item.disabled) return;
                        close(item.restoreFocus !== false);
                        item.action();
                    }}>
                    {item.label}
                </button>
            ))}
        </div>
    );
}
