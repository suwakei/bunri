/**
 * bunri DAW — ステータスバー + プログレスバー
 */
import { useDaw } from '../lib/store';

/**
 * 画面下部に表示するステータスバーコンポーネント。
 * `useDaw()` から `status`（操作状況）と `hint`（ヒントテキスト）を取得して表示する。
 * @returns ステータスバーの JSX 要素
 */
export default function StatusBar() {
    const { status, hint } = useDaw();
    return (
        <div id="status-bar">
            <span id="status-text">{status}</span>
            <span id="hint-text">{hint}</span>
        </div>
    );
}
