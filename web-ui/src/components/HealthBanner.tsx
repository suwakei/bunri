/**
 * bunri DAW — 処理を担当する部分（sidecar）が止まったときの知らせ。
 *
 * 画面の上に重ねて出すが、操作は止めない（モーダルにしない）。トラックやノートは画面の側に在るので、
 * 止まっている間も編集は続けられる。解析や書き出しなど、処理を担当する部分を使う操作だけが失敗する。
 *
 * - デスクトップ版: 「再起動」で起動し直す（lib/health.ts → Rust の restart_backend）
 * - 開発用のブラウザ起動: 画面からは起動し直せないので、起動し直し方を案内する
 */
import { useSyncExternalStore } from 'react';
import { health } from '../lib/health';
import { isDesktop } from '../lib/api';
import { tip } from '../lib/tooltip';

/** 止まったときの知らせ。応答しているあいだは何も出さない。 */
export default function HealthBanner() {
    const state = useSyncExternalStore(health.subscribe, health.getState, health.getState);
    if (state.kind === 'ok') return null;

    if (state.kind === 'restarting') {
        return (
            <div id="health-banner" className="restarting" role="status">
                <strong>処理を担当する部分を起動し直しています…</strong>
                <p>数秒〜十数秒かかります。終わると、この知らせは消えます。</p>
            </div>
        );
    }

    const desktop = isDesktop();
    const failed = state.kind === 'restart-failed';
    return (
        <div id="health-banner" role="alert">
            <strong>{failed ? '処理を担当する部分を起動し直せませんでした' : '処理を担当する部分が止まりました'}</strong>
            {desktop ? (
                <p>
                    解析・パート分離・書き出しなどが使えません。トラックとノートはそのまま残っています。
                    再起動すると使えるようになります（動いていた処理は、もう一度やり直してください）。
                </p>
            ) : (
                // 開発用のブラウザ起動だけの文 (デスクトップアプリでは出さない。docs/ui-terms.md「書き方」)
                <p>
                    API サーバが応答していません。開発用のブラウザ起動では、画面からは起動し直せません。
                    ターミナルで <code>make dev-web</code> を起動し直してください。応答が戻ると、この知らせは消えます。
                </p>
            )}
            {failed && <p>{state.message}</p>}
            <div className="health-actions">
                {desktop
                    ? <button type="button" onClick={() => void health.restart()}
                        {...tip('裏で動いている解析の仕組みを起動し直します。開いているプロジェクトはそのままです')}>再起動</button>
                    : <button type="button" onClick={() => health.checkSoon()}
                        {...tip('API サーバが応答するか、もう一度確かめます')}>もう一度確かめる</button>}
            </div>
        </div>
    );
}
