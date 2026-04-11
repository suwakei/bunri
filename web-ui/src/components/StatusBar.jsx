/**
 * bunri DAW — ステータスバー + プログレスバー
 */
import { useDaw } from '../lib/store.jsx';

export default function StatusBar() {
    const { status, hint } = useDaw();
    return (
        <div id="status-bar">
            <span id="status-text">{status}</span>
            <span id="hint-text">{hint}</span>
        </div>
    );
}
