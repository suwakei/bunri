/**
 * bunri DAW — 起動待ち・起動失敗の表示。
 * デスクトップ版で、Python sidecar が待ち受けを始めるまでの間と、起動できなかったときに出す。
 * 初回は Python 環境の用意（依存のダウンロード）に数分かかるので、進んでいることが分かるよう
 * 経過時間と直近のログを見せる。起動できなかったときは「再試行」を出す（sidecar を起動し直す）。
 */
import { useEffect, useState } from 'react';
import { formatElapsed } from '../lib/time';

interface BootMessageProps {
    /** 1 行の説明（いま何をしているか、または失敗したこと）。 */
    title: string;
    /** 補足（失敗の理由など）。 */
    detail?: string;
    /** 直近のログ（ダウンロード中の部品の名前など）。 */
    log?: string[];
    /** 待っている最中か。true のとき経過時間を表示する。 */
    busy?: boolean;
    /** 起動できなかったときの「再試行」（押すと sidecar を起動し直す）。無ければボタンを出さない。 */
    onRetry?: () => void;
}

/** 起動待ち・起動失敗のときに出す、最小限の表示。 */
export default function BootMessage({ title, detail, log, busy, onRetry }: BootMessageProps) {
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        if (!busy) return;
        const started = Date.now();
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => clearInterval(timer);
    }, [busy]);

    return (
        <div style={{ padding: 32, fontFamily: 'sans-serif', color: 'var(--text)', background: 'var(--bg-primary)', minHeight: '100vh', boxSizing: 'border-box' }}>
            <p style={{ fontSize: 16 }}>{title}</p>
            {busy && <p style={{ fontSize: 13, opacity: 0.7 }}>経過 {formatElapsed(elapsed)}</p>}
            {detail && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.8 }}>{detail}</pre>}
            {onRetry && (
                <button type="button" onClick={onRetry} autoFocus
                    style={{ marginTop: 8, padding: '6px 18px', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--accent)', color: 'var(--bg-deep)' }}>
                    再試行
                </button>
            )}
            {log && log.length > 0 && (
                <pre aria-label="進み具合" style={{ whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.6, fontFamily: 'ui-monospace, monospace' }}>
                    {log.join('\n')}
                </pre>
            )}
        </div>
    );
}
