/**
 * bunri DAW — 起動待ち・起動失敗の表示。
 * デスクトップ版で、Python sidecar が待ち受けを始めるまでの間と、起動できなかったときに出す。
 * 初回は Python 環境の用意（依存のダウンロード）に数分かかるので、進んでいることが分かるよう
 * 経過時間と直近のログを見せる。
 */
import { useEffect, useState } from 'react';

interface BootMessageProps {
    /** 1 行の説明（いま何をしているか、または失敗したこと）。 */
    title: string;
    /** 補足（失敗の理由など）。 */
    detail?: string;
    /** 直近のログ（ダウンロード中の部品の名前など）。 */
    log?: string[];
    /** 待っている最中か。true のとき経過時間を表示する。 */
    busy?: boolean;
}

/** 経過秒数を「1分05秒」の形にする。 */
function formatElapsed(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
}

/** 起動待ち・起動失敗のときに出す、最小限の表示。 */
export default function BootMessage({ title, detail, log, busy }: BootMessageProps) {
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        if (!busy) return;
        const started = Date.now();
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => clearInterval(timer);
    }, [busy]);

    return (
        <div style={{ padding: 32, fontFamily: 'sans-serif', color: '#e8e4de', background: '#111116', minHeight: '100vh', boxSizing: 'border-box' }}>
            <p style={{ fontSize: 16 }}>{title}</p>
            {busy && <p style={{ fontSize: 13, opacity: 0.7 }}>経過 {formatElapsed(elapsed)}</p>}
            {detail && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.8 }}>{detail}</pre>}
            {log && log.length > 0 && (
                <pre aria-label="進み具合" style={{ whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.6, fontFamily: 'ui-monospace, monospace' }}>
                    {log.join('\n')}
                </pre>
            )}
        </div>
    );
}
