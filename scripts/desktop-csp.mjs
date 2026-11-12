/**
 * デスクトップアプリの CSP (Content-Security-Policy) を、開発用のブラウザ起動でも同じに掛けるための部品。
 *
 * 正本は src-tauri/tauri.conf.json の `app.security.csp`。ここに写しを書くとずれていくので、
 * 起動のたびに JSON から読む。開発用のブラウザ起動 (Vite の開発サーバ) の事情で、足すものだけを足す:
 *
 * - script-src に nonce: Vite の開発サーバは、React の再読み込みの仕掛けを `<script>` で直に埋め込む。
 *   Tauri も、自分が埋め込むスクリプトには nonce やハッシュを足している。どちらも「自分が埋め込んだもの」だけを通す
 * - connect-src に ws://<画面の origin>: Vite の開発サーバの自動再読み込み (HMR) の接続
 * - report-uri: 違反をサーバに知らせる (ブラウザのテストが、どのテストでも違反を見落とさないため)。
 *   制限を増やすだけで、何かを許すものではない
 *
 * それ以外の値 (default-src、style-src、font-src、img-src、media-src、connect-src の残り) は、デスクトップ版と同じ。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 違反の知らせを受け取る経路 (Vite の開発サーバが受ける)。 */
export const CSP_REPORT_PATH = '/__csp-report';
/** 受け取った違反の一覧を返す経路。 */
export const CSP_REPORTS_PATH = '/__csp-reports';

/**
 * tauri.conf.json の CSP を、指令ごとの表にして返す。
 *
 * @param {string} [configPath] - tauri.conf.json の場所 (テスト用)
 * @returns {Record<string, string>} 指令 → 値 (例: `{"default-src": "'self'"}`)
 */
export function desktopCspDirectives(configPath = join(ROOT, 'src-tauri', 'tauri.conf.json')) {
    const csp = JSON.parse(readFileSync(configPath, 'utf8'))?.app?.security?.csp;
    if (!csp) throw new Error(`CSP が設定されていません: ${configPath} の app.security.csp`);
    if (typeof csp === 'object') {
        return Object.fromEntries(Object.entries(csp).map(([name, value]) => [name, Array.isArray(value) ? value.join(' ') : String(value)]));
    }
    // 文字列で書かれていても読めるようにする ("default-src 'self'; img-src ...")
    return Object.fromEntries(String(csp).split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values.join(' ')];
    }));
}

/**
 * 開発用のブラウザ起動で掛ける CSP の文字列を作る。
 *
 * @param {object} options
 * @param {string} options.nonce - Vite が埋め込むスクリプトに付ける nonce
 * @param {string} [options.wsOrigin] - 自動再読み込みの接続先 (例: `ws://127.0.0.1:5199`)。無ければ足さない
 * @param {string} [options.reportUri] - 違反の知らせ先。無ければ足さない
 * @param {Record<string, string>} [options.directives] - 元にする CSP (既定は tauri.conf.json)
 */
export function devCsp({ nonce, wsOrigin, reportUri, directives = desktopCspDirectives() }) {
    const csp = { ...directives };
    const add = (name, value) => {
        // 指令が無いときは default-src の値を引き継いでから足す (指令を新しく作ると default-src が効かなくなるため)
        csp[name] = `${csp[name] ?? csp['default-src'] ?? ''} ${value}`.trim();
    };
    add('script-src', `'nonce-${nonce}'`);
    if (wsOrigin) add('connect-src', wsOrigin);
    if (reportUri) csp['report-uri'] = reportUri;
    return Object.entries(csp).map(([name, value]) => `${name} ${value}`.trim()).join('; ');
}
