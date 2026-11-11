/**
 * bunri DAW — バックエンド API への接続口。
 *
 * 画面からの API 呼び出しは、すべてここを通す。接続先とトークンをここで付ける。
 *
 * - ブラウザ版（`python run_web.py`）: 画面と API は同じ origin。接続先は空文字（相対パス）、
 *   トークンは無し。`apiFetch(path, init)` は `fetch(path, init)` とまったく同じに動く
 * - デスクトップ版（Tauri）: 画面は `tauri://localhost`、API は `http://127.0.0.1:<port>` の
 *   Python sidecar。ポートとトークンは起動ごとに変わるので、Rust 側に問い合わせて受け取る
 */

/** バックエンドの接続情報。 */
export interface BackendInfo {
    /** API の接続先。ブラウザ版では空文字（相対パスのまま）。末尾にスラッシュは付けない。 */
    baseUrl: string;
    /** API の鍵。ブラウザ版では null。 */
    token: string | null;
}

/** トークンを載せるヘッダ名（backend/access_control.py と合わせる）。 */
export const TOKEN_HEADER = 'X-Bunri-Token';
/** ヘッダを付けられない経路（`<audio src>` など）でトークンを載せるクエリ名。 */
export const TOKEN_QUERY = 'token';

/** Rust 側の `backend_info` コマンドが返す値。 */
interface TauriBackendInfo {
    port: number;
    token: string;
}

/** `app.withGlobalTauri` で公開される Tauri の API のうち、ここで使うぶん。 */
interface TauriGlobal {
    core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
}

let backend: BackendInfo = { baseUrl: '', token: null };

/** Tauri の中で動いているなら、その API を返す。ブラウザなら null。 */
function tauriGlobal(): TauriGlobal | null {
    const t = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
    return t && t.core ? t : null;
}

/** デスクトップアプリ（Tauri）の中で動いているか。 */
export function isDesktop(): boolean {
    return tauriGlobal() !== null;
}

/**
 * 接続先とトークンを決める。アプリの描画を始める前に 1 回呼ぶ。
 *
 * デスクトップ版では、sidecar が待ち受けを始めるまで待つ（Rust 側のコマンドが待つ）。
 * sidecar を起動できなかった場合は、理由を載せた Error で失敗する。
 * ブラウザ版では何も問い合わせず、すぐに終わる。
 */
export async function initBackend(): Promise<BackendInfo> {
    const tauri = tauriGlobal();
    if (tauri) {
        const info = await tauri.core.invoke<TauriBackendInfo>('backend_info');
        backend = { baseUrl: `http://127.0.0.1:${info.port}`, token: info.token };
    }
    return backend;
}

/** 現在の接続情報を返す。 */
export function getBackend(): BackendInfo {
    return backend;
}

/** テスト用: 接続情報を差し替える。 */
export function setBackendForTest(info: BackendInfo): void {
    backend = info;
}

/** バックエンド宛ての URL か（`/api/...` のような相対パス、または接続先で始まる URL）。 */
function isBackendUrl(url: string): boolean {
    if (url.startsWith('/') && !url.startsWith('//')) return true;
    return backend.baseUrl !== '' && url.startsWith(backend.baseUrl + '/');
}

/** 相対パスに接続先を付ける。それ以外（blob: や絶対 URL）はそのまま返す。 */
function withBase(url: string): string {
    return url.startsWith('/') && !url.startsWith('//') ? backend.baseUrl + url : url;
}

/**
 * バックエンドの API を呼ぶ。`fetch` と同じ引数・同じ戻り値。
 *
 * バックエンド宛ての URL には接続先とトークンのヘッダを付ける。
 * blob: URL や外部の URL はそのまま `fetch` に渡す（トークンを外へ漏らさない）。
 *
 * @param url - `/api/...` のような相対パス、または任意の URL
 * @param init - `fetch` の第 2 引数
 */
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
    if (!isBackendUrl(url) || (backend.baseUrl === '' && backend.token === null)) {
        // ブラウザ版はここを通る。今までの fetch(url, init) とまったく同じ呼び出し
        return init === undefined ? fetch(url) : fetch(url, init);
    }
    const headers = new Headers(init?.headers);
    if (backend.token !== null) headers.set(TOKEN_HEADER, backend.token);
    return fetch(withBase(url), { ...init, headers });
}

/**
 * `<audio src>` や `<a href>` に渡す URL を作る。
 *
 * これらの経路はヘッダを付けられないので、トークンをクエリに載せる。
 * ブラウザ版では受け取った URL をそのまま返す。blob: や外部の URL もそのまま返す。
 *
 * @param url - API が返した `/api/download/...` のような相対パス、または任意の URL
 */
export function backendUrl(url: string): string {
    if (!isBackendUrl(url)) return url;
    const full = withBase(url);
    if (backend.token === null) return full;
    const sep = full.includes('?') ? '&' : '?';
    return `${full}${sep}${TOKEN_QUERY}=${encodeURIComponent(backend.token)}`;
}
