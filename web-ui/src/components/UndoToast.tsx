/**
 * bunri DAW — 「〜を削除しました — 元に戻す」の知らせ。
 *
 * トラックやクリップを消すときは、確かめの窓を出さずにすぐ消し、この知らせから元に戻せるようにする
 * (窓で毎回止めるより、間違えたときに戻せるほうが早い)。Cmd+Z / Ctrl+Z でも戻せる。
 *
 * 読み上げには `role="status"` で伝える (割り込まない)。10 秒で閉じる。マウスを載せているあいだと、
 * キーボードで中のボタンを選んでいるあいだは閉じない。別の操作をすると、ストアの側で閉じる
 * (押すと、その別の操作が戻ってしまうため)。
 */
import { useEffect, useRef, useState } from 'react';
import { useDaw, type UndoToastState } from '../lib/store';
import { modKeyLabel } from '../lib/keys';

/** 知らせを出しておく長さ (ミリ秒)。 */
const UNDO_TOAST_MS = 10_000;

/** 知らせの中身。知らせが替わるたびに作り直す (押さえていた状態を持ち越さない)。 */
function ToastBody({ toast }: { toast: UndoToastState }) {
    const { undoFromToast, dismissUndoToast } = useDaw();
    const [held, setHeld] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (held) return;
        const timer = setTimeout(dismissUndoToast, UNDO_TOAST_MS);
        return () => clearTimeout(timer);
    }, [held, dismissUndoToast]);

    return (
        <div className="undo-toast" ref={rootRef}
            onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={(e) => { if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setHeld(false); }}>
            <span className="undo-toast-text">{toast.message}</span>
            <button type="button" className="undo-toast-action" onClick={undoFromToast}
                title={`元に戻す（${modKeyLabel()}Z）`}>元に戻す</button>
            <button type="button" className="undo-toast-close" onClick={dismissUndoToast} aria-label="知らせを閉じる">✕</button>
        </div>
    );
}

export default function UndoToast() {
    const { undoToast } = useDaw();
    return (
        <div id="undo-toast-region" role="status" aria-live="polite">
            {undoToast && <ToastBody key={undoToast.id} toast={undoToast} />}
        </div>
    );
}
