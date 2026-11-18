/**
 * bunri DAW — 動きの記録の一覧（ステータスバーの「記録」）。
 *
 * アプリの中でいま何が起きたか（押したボタン、ステータスバーの文、処理を担当する部分の呼び出し、MIDI の入力）を、
 * 起きた順に見せる。思ったとおりに動かないとき、利用者が「何を押して、何が起きたか」を確かめるためのもの。
 * 同じ内容がファイルにも残り（デスクトップ版）、Claude Code などのエージェントもそれを読む。
 *
 * 記録そのものは lib/activity.ts が持つ（この一覧を開いていないあいだも、記録は続いている）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { activityEntries, formatActivityTime, subscribeActivity, tagLabel } from '../lib/activity';
import { activityFilePath } from '../lib/activity-setup';
import { tip } from '../lib/tooltip';

/** 一覧の本体。開いているあいだだけ描く。 */
function ActivityPanel({ onClose }: { onClose: () => void }) {
    const entries = useSyncExternalStore(subscribeActivity, activityEntries);
    const [path, setPath] = useState<string | null>(null);
    const listRef = useRef<HTMLOListElement>(null);
    /** 末尾を見ているか。見ているあいだだけ、新しい行に付いていく（さかのぼって読んでいるときは動かさない）。 */
    const followRef = useRef(true);

    useEffect(() => {
        let alive = true;
        void activityFilePath().then((p) => { if (alive) setPath(p); });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        const list = listRef.current;
        if (list && followRef.current) list.scrollTop = list.scrollHeight;
    }, [entries]);

    return (
        // data-activity-ignore: この一覧の中の操作は、記録しない（読んでいるだけで行が増えていかないように）
        <section id="activity-panel" role="region" aria-label="動きの記録" data-activity-ignore>
            <header>
                <h2>動きの記録</h2>
                <span className="area-hint">新しいものが下</span>
                <button type="button" aria-label="動きの記録を閉じる" onClick={onClose}>×</button>
            </header>
            {entries.length === 0
                ? <p className="activity-empty">まだ記録がありません</p>
                : (
                    <ol ref={listRef} tabIndex={0} aria-label="起きたこと（古い順）"
                        onScroll={(e) => {
                            const el = e.currentTarget;
                            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                        }}>
                        {entries.map((entry) => (
                            <li key={entry.id} className={`activity-row activity-${entry.tag}`}>
                                <time>{formatActivityTime(entry.at)}</time>
                                <span className="activity-tag">{tagLabel(entry.tag)}</span>
                                <span className="activity-message">{entry.message}</span>
                            </li>
                        ))}
                    </ol>
                )}
            <footer>
                {path
                    ? <>同じ内容をファイルにも残しています: <code>{path}</code></>
                    : 'この環境では、画面の中にだけ残ります（ファイルには残りません）'}
            </footer>
        </section>
    );
}

/** ステータスバーに置く「記録」のボタン。押すと、動きの記録の一覧を開く・閉じる。 */
export default function ActivityButton() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" id="activity-toggle" aria-expanded={open} data-activity-ignore
                {...tip(open ? '動きの記録を閉じます' : 'いま何が起きたかの記録（押したボタン、結果、MIDI の入力など）を開きます')}
                onClick={() => setOpen((o) => !o)}>
                記録
            </button>
            {open && <ActivityPanel onClose={() => setOpen(false)} />}
        </>
    );
}
