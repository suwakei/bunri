/**
 * bunri DAW — ステータスバー + プログレスバー
 */
import { useDaw } from '../lib/store';

/**
 * 画面下部に表示するステータスバーコンポーネント。
 * `useDaw()` から `status`（操作状況）と `hint`（ヒントテキスト）を取得して表示する。
 *
 * 失敗の知らせ（`statusKind` が `error`）は、色を変えて、読み上げの対象（`role="alert"`）にする。
 * 文が長いときは 1 行に収めて末尾を … にするので、全文は `title` でも読めるようにしてある。
 * @returns ステータスバーの JSX 要素
 */
export default function StatusBar() {
    const { status, statusKind, hint } = useDaw();
    const isError = statusKind === 'error';
    return (
        <div id="status-bar">
            <span id="status-text" className={isError ? 'error' : undefined}
                role={isError ? 'alert' : 'status'} title={status}>{status}</span>
            <span id="hint-text">{hint}</span>
        </div>
    );
}
