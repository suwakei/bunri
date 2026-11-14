/**
 * ブラウザのテストの最後に、CSP の違反が 1 つも無かったことを確かめる (playwright.config.ts の globalTeardown)。
 *
 * 画面にはデスクトップアプリと同じ CSP が掛かっていて (scripts/dev-web.mjs)、違反はブラウザから
 * 開発サーバに知らされる (web-ui/vite.config.js)。どのテストの途中で起きた違反も、ここで拾う。
 * デスクトップアプリで画面の一部が黙って読み込まれない (フォント、音声、API の呼び出し) 不具合は、
 * 単体テストでも見た目でも気づきにくいため。
 */
import { CSP_PROBE_ORIGIN, E2E_URL } from './helpers';

/** ブラウザが送ってくる違反の知らせ (report-uri の形)。 */
interface CspReport {
    'document-uri'?: string;
    'violated-directive'?: string;
    'effective-directive'?: string;
    'blocked-uri'?: string;
    'source-file'?: string;
    'line-number'?: number;
}

/**
 * Vite の開発サーバの自動再読み込みの仕組み (`/@vite/client`) が、接続が切れたときに作る blob の SharedWorker か。
 *
 * テストがページを閉じると (beforeunload は起きない)、あるいは Mac が休止に近い状態で接続が切れると、Vite は
 * つなぎ直しを待つ worker を blob で作ろうとし、CSP に止められる。開発サーバだけの仕組みで、デスクトップアプリには
 * 入っていない (同梱した画面に /@vite/client は無い)。main でも、時々この違反だけが出ていた (2026-11-12 に確かめた。
 * #56 と #57 がそれぞれ別に見つけた同じ違反)。
 * 出どころ・種類・止めたものの 3 つが全部合うものだけを除く。アプリ自身の worker の違反や、@vite/client が
 * 止められたほかのもの (blob 以外) は除かない。
 * - 種類: CSP に worker-src が無いので、ブラウザによって worker-src (Chromium の effective-directive) か、
 *   代わりに使われた script-src / child-src / default-src として知らされる
 * - 止めたもの: Chromium は `blob`、ほかのブラウザは `blob:http://...` と知らせることがある
 * - 出どころ: `/@vite/client` (問い合わせの文字列 `?t=...` が付くことがある)
 */
const WORKER_DIRECTIVES = ['worker-src', 'script-src', 'child-src', 'default-src'];

function isViteClientPing(r: CspReport): boolean {
    const directive = r['effective-directive'] ?? r['violated-directive'] ?? '';
    const blocked = r['blocked-uri'] ?? '';
    const source = (r['source-file'] ?? '').split('?')[0];
    return WORKER_DIRECTIVES.some((d) => directive.startsWith(d))
        && (blocked === 'blob' || blocked.startsWith('blob:'))
        && source.endsWith('/@vite/client');
}

export default async function cspCheck(): Promise<void> {
    let reports: CspReport[];
    try {
        reports = await (await fetch(`${E2E_URL}/__csp-reports`)).json();
    } catch (e) {
        throw new Error(`CSP の違反の一覧を取れませんでした (開発サーバが CSP を掛けていない?): ${(e as Error).message}`);
    }
    // 「CSP が効いているか」を確かめるテスト (csp.spec.ts) が、わざと起こした違反と、
    // 開発サーバの自動再読み込みの仕組み (@vite/client) が出した違反は除く
    const real = reports.filter((r) => !(r['blocked-uri'] ?? '').startsWith(CSP_PROBE_ORIGIN) && !isViteClientPing(r));
    if (real.length > 0) {
        const lines = real.map((r) => `- ${r['effective-directive'] ?? r['violated-directive']} が ${r['blocked-uri']} を止めました`
            + ` (ページ: ${r['document-uri']}${r['source-file'] ? `、出どころ: ${r['source-file']}:${r['line-number']}` : ''})`);
        throw new Error(`CSP の違反が ${real.length} 件ありました。デスクトップアプリでは、これらは読み込まれません:\n${lines.join('\n')}`);
    }
}
