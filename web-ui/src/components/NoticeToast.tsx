/**
 * bunri DAW — 知らせ（失敗と「いまはできない理由」を、画面に浮かせて出す）。
 *
 * 画面全体で 1 つだけ置く（`main.tsx`）。中身は `lib/notice.ts` の `notify` で足す。DAW の画面では、
 * ストアの `setStatus(文, 'error' | 'hint')` が呼ぶ。
 *
 * - 失敗（`error`）は赤、いまはできない理由（`hint`）は水色の線を付ける。頭に「エラー」とは書かない（docs/ui-terms.md）
 * - しばらくすると閉じる（`noticeDuration`）。キーボードで中のボタンを選んでいるあいだと、ボタンにマウスを載せているあいだは閉じない
 * - 同じ文がもう一度来たら、並べずに、閉じるまでの時間を数え直す。少し間が空いていれば、もう一度目に入るように軽く動かす
 *   （続けざまに来たぶん — キーの押しっぱなしなど — では動かさない）
 * - 「次にすること」のボタンが付いていれば、押すとそれを行って閉じる
 * - 文の上のクリックは、下の画面に通す（ピアノロールの上に出ても、下のノートを押せる）。押せるのは、中のボタンだけ
 * - 読み上げ: 同じ文がステータスバーに出ていて、そちらが読み上げられる（失敗は `role="alert"`）ので、知らせには役割を付けない。
 *   ほかのどこにも出ない文（押せない部品を押したとき、など）だけ、いつも在る読み上げ用の欄（`#notice-live`）に流す
 *   （あとから差し込んだ要素に役割を付けても、読まれない環境が在るため）
 *
 * もう 1 つ、**押せない部品を押したとき**の知らせもここで受け持つ。押せないボタンは、押しても何も起きず、
 * 理由はマウスを載せて待たないと出ない。押した時点で、押せない理由（`blockedBy` で書いたもの。無ければ、その部品の説明。
 * 押せないあいだは「どうすれば押せるか」を書く決まり）を、知らせとして出す（`blockedReason`）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { blockedReason, dismissNotice, getNotices, noticeDuration, notify, subscribeNotices, type Notice } from '../lib/notice';
import { recordActivity } from '../lib/activity';
import { tip } from '../lib/tooltip';

function NoticeItem({ notice }: { notice: Notice }) {
    const [held, setHeld] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // 出し直されたら (renew が変わったら)、閉じるまでの時間を数え直す
    useEffect(() => {
        if (held) return;
        const timer = setTimeout(() => dismissNotice(notice.id), noticeDuration(notice));
        return () => clearTimeout(timer);
    }, [held, notice]);

    // 間を空けて出し直されたら、もう一度目に入るように軽く動かす。要素は作り直さない (中のボタンのフォーカスを失わない)
    useEffect(() => {
        const el = rootRef.current;
        if (!el || notice.bump === 0) return;
        el.classList.remove('again');
        void el.offsetWidth;
        el.classList.add('again');
    }, [notice.bump]);

    const hold = { onMouseEnter: () => setHeld(true), onMouseLeave: () => setHeld(false) };
    return (
        <div ref={rootRef} className={`notice-toast ${notice.kind}`} data-notice-kind={notice.kind}
            onFocus={() => setHeld(true)}
            onBlur={(e) => { if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setHeld(false); }}>
            <span className="notice-toast-mark" aria-hidden="true">{notice.kind === 'error' ? '!' : 'i'}</span>
            <span className="notice-toast-text">{notice.text}</span>
            {notice.action && (
                <button type="button" className="notice-toast-action" {...hold}
                    {...(notice.action.tip ? tip(notice.action.tip) : {})}
                    onClick={() => { const { run } = notice.action!; dismissNotice(notice.id); run(); }}>
                    {notice.action.label}
                </button>
            )}
            <button type="button" className="notice-toast-close" aria-label="知らせを閉じる" {...hold}
                onClick={() => dismissNotice(notice.id, { byUser: true })} {...tip('この知らせを閉じます')}>✕</button>
        </div>
    );
}

export default function NoticeLayer() {
    const notices = useSyncExternalStore(subscribeNotices, getNotices, getNotices);
    // ほかのどこにも出ない文のうち、いちばん新しいもの (読み上げ用の欄に流す)
    const spoken = [...notices].reverse().find((n) => n.live)?.text ?? '';

    // 押せない部品を押したとき: 理由を知らせる。押せない部品は click を出さないので、pointerdown を画面全体で受ける
    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0) return;
            // 押せない部品の上では、イベントの相手が親になる環境が在るので、位置からも引き直す (ツールチップと同じ)
            const reason = blockedReason(e.target as Element | null)
                ?? blockedReason(document.elementFromPoint?.(e.clientX, e.clientY) ?? null);
            if (!reason) return;
            recordActivity('status', `押せない状態の部品を押した: ${reason}`);
            notify('hint', reason, { live: true });
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
    }, []);

    return (
        <>
            <div id="notice-region" data-tip-side="top">
                {notices.map((notice) => <NoticeItem key={notice.id} notice={notice} />)}
            </div>
            <div id="notice-live" className="visually-hidden" role="status" aria-live="polite">{spoken}</div>
        </>
    );
}
