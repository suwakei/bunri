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

export default async function cspCheck(): Promise<void> {
    let reports: CspReport[];
    try {
        reports = await (await fetch(`${E2E_URL}/__csp-reports`)).json();
    } catch (e) {
        throw new Error(`CSP の違反の一覧を取れませんでした (開発サーバが CSP を掛けていない?): ${(e as Error).message}`);
    }
    // 「CSP が効いているか」を確かめるテスト (csp.spec.ts) が、わざと起こした違反は除く。
    // 開発サーバの自動再読み込みの仕組み (@vite/client) が出した違反も除く。接続が切れたときに、つなぎ直せるかを
    // blob の SharedWorker で確かめにいくもので、デスクトップアプリ (同梱した画面) には入っていない
    const real = reports.filter((r) => !(r['blocked-uri'] ?? '').startsWith(CSP_PROBE_ORIGIN)
        && !(r['source-file'] ?? '').endsWith('/@vite/client'));
    if (real.length > 0) {
        const lines = real.map((r) => `- ${r['effective-directive'] ?? r['violated-directive']} が ${r['blocked-uri']} を止めました`
            + ` (ページ: ${r['document-uri']}${r['source-file'] ? `、出どころ: ${r['source-file']}:${r['line-number']}` : ''})`);
        throw new Error(`CSP の違反が ${real.length} 件ありました。デスクトップアプリでは、これらは読み込まれません:\n${lines.join('\n')}`);
    }
}
