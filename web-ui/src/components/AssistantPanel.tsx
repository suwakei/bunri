/**
 * bunri DAW — アシスタントのドック（画面の右側のチャット）。
 *
 * チャットで頼むと、アシスタント（Claude）がツールで bunri を操作する（docs/assistant-design.md）。
 * 行った操作は、会話の中に **操作ログ** として並ぶ（ツール 1 つが 1 行）。行を開くと、その操作のあいだに
 * アプリの中で起きたこと（動きの記録の行）が出る。1 回の依頼で変えたことは、「元に戻す」1 回で戻せる。
 *
 * - 左パネルは練習画面のあいだ隠れるので、チャットは左パネルのタブではなく、右側のドックに置く（練習画面でも見える）
 * - 会話と操作ログは lib/assistant.ts が持つ。ドックを閉じても、練習画面に出入りしても残る
 * - アシスタントの文は、少しずつ届く。流れている途中の吹き出しは、末尾に印を出し、読み上げは確定まで待つ
 * - 画面の入口（ツールが呼ぶもの）は lib/assistant-env.ts。ドックを閉じているあいだも、繰り返しは続く
 */
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useDaw } from '../lib/store';
import { assistantSession, type AssistantDeps, type AssistantSession, type ChatItem, type ToolRow, type TurnRow } from '../lib/assistant';
import { useAssistantDeps } from '../lib/assistant-env';
import { suggestionsFor } from '../lib/assistant-suggestions';
import { formatActivityTime, tagLabel } from '../lib/activity';
import { fetchGuideSettings, formatUsd } from '../lib/guide';
import { assistantBlockedLine, todayLine } from '../lib/claude-usage';
import { tip } from '../lib/tooltip';
import { blockedBy } from '../lib/notice';
import { ClaudeSendNote, ClaudeSettings } from './ClaudeParts';


/** 操作ログの行の頭の印と、読み上げの名前。 */
const ROW_MARKS: Record<ToolRow['state'], { mark: string; name: string }> = {
    ok: { mark: '✓', name: '成功' },
    error: { mark: '✕', name: '失敗' },
    running: { mark: '…', name: '実行中' },
    cancelled: { mark: '−', name: '実行していません' },
};

/** ヘッダに置く「アシスタント」のボタン。押すと、ドックを開く・閉じる。 */
export function AssistantToggle() {
    const { assistantOpen, setAssistantOpen } = useDaw();
    return (
        <button type="button" id="assistant-toggle" aria-expanded={assistantOpen}
            className={assistantOpen ? 'active' : undefined}
            {...tip(assistantOpen
                ? 'アシスタントを閉じます。会話は残ります'
                : 'チャットで頼むと、アシスタント（Claude）が代わりに操作します。行った操作は一覧に出て、1 回で元に戻せます')}
            onClick={() => setAssistantOpen(!assistantOpen)}>
            アシスタント
        </button>
    );
}

/** 操作ログの 1 行。終わった行は開けて、その操作のあいだの動きの記録を見られる。 */
function ToolLine({ row }: { row: ToolRow }) {
    const { mark, name } = ROW_MARKS[row.state];
    const head = (
        <>
            <span className="assistant-tool-mark" aria-hidden="true">{mark}</span>
            <span className="visually-hidden">{name}: </span>
            <span className="assistant-tool-text">{row.text}</span>
        </>
    );
    if (row.state === 'running' || row.state === 'cancelled') {
        return <div className={`assistant-tool ${row.state}`} data-tool={row.name}>{head}</div>;
    }
    return (
        // data-activity-ignore: 行を開いて読むだけの操作は、動きの記録に残さない（読んでいるだけで行が増えていかないように）
        <details className={`assistant-tool ${row.state}`} data-tool={row.name} data-activity-ignore>
            <summary>{head}</summary>
            {row.activity.length === 0
                ? <p className="assistant-tool-empty">この操作のあいだに、ほかに起きたことはありません</p>
                : (
                    <ol aria-label="この操作のあいだに起きたこと">
                        {row.activity.map((entry) => (
                            <li key={entry.id} className={`activity-${entry.tag}`}>
                                <time>{formatActivityTime(entry.at)}</time>
                                <span className="activity-tag">{tagLabel(entry.tag)}</span>
                                <span className="activity-message">{entry.message}</span>
                            </li>
                        ))}
                    </ol>
                )}
        </details>
    );
}

/** 依頼の終わりの行。変えたことが在れば「元に戻す」、Claude を呼んだ回数と概算の費用。 */
function TurnLine({ row, running }: { row: TurnRow; running: boolean }) {
    const { undo, undoEntryId } = useDaw();
    // この依頼の記録が、元に戻す履歴のいちばん上に在るあいだだけ押せる (その後に別の操作をしたら、それが先に戻ってしまう)
    const canUndo = row.undoEntryId !== null && row.undoEntryId === undoEntryId && !running;
    return (
        <div className="assistant-turn">
            {row.changed && (
                <button type="button" className="assistant-undo" disabled={!canUndo} aria-label="この依頼の変更を元に戻す"
                    {...tip(canUndo
                        ? 'この依頼でアシスタントが変えたことを、まとめて元に戻します'
                        : 'すでに元に戻したか、その後に別の操作をしています。ヘッダの ↶ で 1 つずつ戻せます')}
                    onClick={undo}>
                    元に戻す
                </button>
            )}
            {row.calls > 0 && (
                <span className="assistant-turn-usage">
                    Claude を {row.calls} 回呼びました{row.costUsd !== null ? `（概算 ${formatUsd(row.costUsd)}）` : ''}
                </span>
            )}
        </div>
    );
}

/** 会話に並ぶ 1 つぶん。 */
function Item({ item, running }: { item: ChatItem; running: boolean }) {
    switch (item.kind) {
        case 'user':
            return <div className="assistant-msg user"><span className="visually-hidden">あなた: </span>{item.text}</div>;
        case 'assistant':
            // 流れている途中の文は、差分ごとに読み上げが走らないよう aria-busy を付ける (role="log" の中なので、
            // 付けているあいだは読み上げを待ち、確定して外れたときに、全文が 1 回で読まれる)
            return (
                <div className={`assistant-msg assistant${item.streaming ? ' streaming' : ''}`} aria-busy={item.streaming ? true : undefined}>
                    <span className="visually-hidden">アシスタント: </span>{item.text}
                </div>
            );
        case 'tool':
            return <ToolLine row={item} />;
        case 'notice':
            return <p className={`assistant-notice ${item.tone}`} role={item.tone === 'error' ? 'alert' : undefined}>{item.text}</p>;
        case 'turn':
            return <TurnLine row={item} running={running} />;
    }
}

interface AssistantPanelProps {
    /** 画面の入口（ツールが呼ぶもの） */
    deps: AssistantDeps;
    /** 会話。省略すると、この画面の会話（テストでは差し替える） */
    session?: AssistantSession;
}

/** ドックの本体。開いているあいだだけ描く。 */
export function AssistantPanel({ deps, session = assistantSession }: AssistantPanelProps) {
    const { setAssistantOpen } = useDaw();
    const state = useSyncExternalStore(session.subscribe, session.getState);
    const [text, setText] = useState('');
    const [showSettings, setShowSettings] = useState(false);
    const logRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    /** 末尾を見ているか。見ているあいだだけ、新しい行に付いていく（さかのぼって読んでいるときは動かさない）。 */
    const followRef = useRef(true);

    // 今日の使用量は、開いたときに読む (Claude は呼ばない)。読めなくても、使うことはできる
    useEffect(() => {
        if (session.getState().today) return;
        let alive = true;
        void fetchGuideSettings().then((saved) => { if (alive) session.setToday(saved.today); }).catch(() => { /* 読めなくても出さないだけ */ });
        return () => { alive = false; };
    }, [session]);

    useEffect(() => {
        const log = logRef.current;
        if (log && followRef.current) log.scrollTop = log.scrollHeight;
    }, [state.items, state.waiting]);

    // 開いたら、すぐ打てるように入力欄へ
    useEffect(() => { inputRef.current?.focus(); }, []);

    const submit = useCallback(() => {
        const request = text.trim();
        if (!request || session.getState().running) return;
        setText('');
        // 送ったら、新しい行が見えるところまで付いていく
        followRef.current = true;
        void session.send(request, deps);
    }, [text, session, deps]);

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        // 日本語の変換中 (IME) の Enter は、変換を確定する操作。送らない。
        // 変換を確定した Enter は、ブラウザによって isComposing が false で届く (WebKit) ので、keyCode 229 でも見分ける
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        submit();
    };

    const settingsOpen = showSettings || state.needsKey;
    const empty = state.items.length === 0;
    const canSend = text.trim() !== '' && !state.running;
    // 1 日の上限に達しているときの知らせ (入力欄の上)。上限で断られた知らせが会話の最後に出ているあいだは、出さない
    // (同じことを 2 か所に出さない)
    const lastItem = state.items[state.items.length - 1];
    const refusedNow = lastItem?.kind === 'notice' && lastItem.code === 'daily_limit';
    const blockedLine = state.today && !refusedNow ? assistantBlockedLine(state.today) : null;
    // 頼み方の例は、いまの状況に合わせて選ぶ (Claude は呼ばない)。何も無いときにだけ出すので、そのときにだけ読む。
    // 状況は、読むだけの入口で見る (ツールの入口は、読む前にピアノロールの手元のノートを書き戻すので、描いている途中には使わない)
    const examples = empty ? suggestionsFor(deps.suggestionFacts()) : [];

    return (
        // 説明の吹き出しは、ドックの外 (左) に出す。ドックの中の、次に触る欄 (入力欄など) を隠さないため
        <aside id="assistant-panel" role="complementary" aria-label="アシスタント" data-tip-side="left" data-tip-box="">
            <header>
                <h2>アシスタント</h2>
                {state.today && (
                    <span className="assistant-today" {...tip(`${todayLine(state.today)}\n再現ガイド・差分の説明と合わせて数えます。アシスタントは、依頼 1 つを 1 回と数えます`)}>
                        今日 {state.today.calls} 回・{formatUsd(state.today.cost_usd)}
                    </span>
                )}
                <button type="button" className="assistant-new" disabled={state.running || empty}
                    {...blockedBy(state.running ? 'アシスタントが動いているあいだは、新しい会話にできません。終わるのを待つか、止めてから押してください'
                        : empty && '会話は、まだ空です。入力欄に頼みたいことを書いて、送ってください')}
                    {...tip('会話と操作ログを空にして、始め直します。行った操作は、そのまま残ります。プロジェクトに保存してある会話も、次の保存で消えます')}
                    onClick={() => { session.reset(); inputRef.current?.focus(); }}>
                    新しい会話
                </button>
                <button type="button" className="assistant-close" aria-label="アシスタントを閉じる"
                    {...tip('閉じます。会話は残ります')} onClick={() => setAssistantOpen(false)}>×</button>
            </header>

            <div className="assistant-log" ref={logRef} role="log" aria-label="会話と操作ログ" tabIndex={0}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                }}>
                {empty && (
                    <div className="assistant-empty">
                        <p>頼むと、アシスタントが代わりに操作します。行った操作はここに並び、1 回で元に戻せます。</p>
                        <p className="assistant-empty-head">頼み方の例</p>
                        <ul>
                            {examples.map((example) => (
                                <li key={example}>
                                    <button type="button" className="assistant-example" {...tip('この文を入力欄に入れます（送るのは、自分で）')}
                                        onClick={() => { setText(example); inputRef.current?.focus(); }}>
                                        {example}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {state.items.map((item, index) => (
                    <Fragment key={item.id}>
                        <Item item={item} running={state.running} />
                        {/* プロジェクトに保存してあった会話と、開いてからの会話の境目 */}
                        {index === state.restored - 1 && (
                            <p className="assistant-restored" role="separator">
                                ここまでは、プロジェクトに保存してあった会話です。アシスタントは、要点だけを覚えています
                            </p>
                        )}
                    </Fragment>
                ))}
            </div>

            {state.running && (
                <div className="assistant-waiting">
                    <span role="status">{state.waiting ?? '考えています…'}</span>
                    <button type="button" className="assistant-cancel"
                        {...tip('ここで止めます。すでに行った操作は残ります（「元に戻す」で戻せます）')}
                        onClick={() => session.cancel()}>
                        中止
                    </button>
                </div>
            )}

            <div className="assistant-foot">
                {blockedLine && <p className="assistant-notice error" role="alert">{blockedLine}</p>}
                <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                    <textarea id="assistant-text" ref={inputRef} rows={3} value={text} aria-label="アシスタントに頼むこと"
                        placeholder="例: 1〜2 小節にベースを置いて" aria-describedby="assistant-keys"
                        onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
                    <button type="submit" className="assistant-send" disabled={!canSend}
                        {...blockedBy(!canSend && !state.running && '頼みたいことを、入力欄に書いてから押してください')}
                        {...tip(state.running ? 'アシスタントが動いているあいだは、送れません' : 'アシスタントに頼みます', { key: 'Enter' })}>
                        送る
                    </button>
                </form>
                <p id="assistant-keys" className="assistant-keys">Enter で送る / Shift+Enter で改行</p>
                {/* 設定の欄は、左パネルと同じ見た目 (.panel-content の入力欄) を使う */}
                <div className="panel-content assistant-settings">
                    <ClaudeSendNote open={settingsOpen} onToggle={() => {
                        if (settingsOpen) { setShowSettings(false); session.setNeedsKey(false); } else setShowSettings(true);
                    }}>
                        Claude に送るのは、ここに打った文と、アシスタントが読んだプロジェクトの中身（トラックの名前・ノート・カルテ・再現ガイド・差分の結果）です。音声は送りません。ここに並んだ会話は、プロジェクトを保存すると、プロジェクトのファイルにも入ります。
                    </ClaudeSendNote>
                    <ClaudeSettings idPrefix="assistant" open={settingsOpen} today={state.today}
                        onToday={(today) => session.setToday(today)}
                        onSaved={(what) => {
                            setShowSettings(false);
                            if (what === 'key') session.setNeedsKey(false);
                        }} />
                </div>
            </div>
        </aside>
    );
}

/**
 * アシスタントのドック。DAW の画面に 1 つだけ置く（`#main` の右端）。閉じているあいだは何も描かないが、
 * 画面の入口は持ち続ける（動いている依頼は、閉じても続く）。
 */
export default function AssistantDock() {
    const { assistantOpen } = useDaw();
    const deps = useAssistantDeps();
    if (!assistantOpen) return null;
    return <AssistantPanel deps={deps} />;
}
