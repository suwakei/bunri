/**
 * bunri DAW — バックエンド API への接続口。
 *
 * 画面からの API 呼び出しは、すべてここを通す。接続先とトークンをここで付ける。
 *
 * - 開発用のブラウザ起動（Vite の開発サーバ + `backend/run_web.py`）: 画面をブラウザで開いて直すときや、
 *   自動操作でテストするときの経路。Vite が `/api` をバックエンドへ中継する。接続先は空文字（相対パス）、
 *   トークンは無し。`apiFetch(path, init)` は `fetch(path, init)` とまったく同じに動く
 * - デスクトップ版（Tauri）: 画面は `tauri://localhost`、API は `http://127.0.0.1:<port>` の
 *   Python sidecar。ポートとトークンは起動ごとに変わるので、Rust 側に問い合わせて受け取る
 */

/** バックエンドの接続情報。 */
export interface BackendInfo {
    /** API の接続先。開発用のブラウザ起動では空文字（相対パスのまま）。末尾にスラッシュは付けない。 */
    baseUrl: string;
    /** API の鍵。開発用のブラウザ起動では null。 */
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

/**
 * 起動の進み具合（Rust 側の `boot_status` コマンドが返す値）。
 * デスクトップ版で、起動待ちの間に表示する。
 */
export interface BootStatus {
    /** setup: Python 環境を用意中 / starting: sidecar を起動中 / ready: 待ち受け中 / failed: 失敗 */
    phase: 'setup' | 'starting' | 'ready' | 'failed';
    /** 利用者に見せる 1 行の説明。失敗のときは理由。 */
    message: string;
    /** 直近のログ（ダウンロード中の部品の名前など）。 */
    log: string[];
    /** 初めての環境づくりか（時間がかかる）。 */
    first_run: boolean;
}

/** `app.withGlobalTauri` で公開される Tauri の API のうち、ここで使うぶん。 */
interface TauriGlobal {
    core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
    event?: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
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
 * デスクトップアプリのネイティブ側（Rust）のコマンドを呼ぶ。
 *
 * 開発用のブラウザ起動では呼べないので、先に `isDesktop()` を確かめること。
 *
 * @param cmd - コマンド名（`src-tauri/src/lib.rs` の `invoke_handler` に並んでいるもの）
 * @param args - コマンドに渡す引数
 * @throws デスクトップアプリの外で呼んだ場合、またはコマンドが失敗した場合
 */
export async function invokeDesktop<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const tauri = tauriGlobal();
    if (!tauri) throw new Error('デスクトップアプリの中でしか使えません');
    try {
        return await tauri.core.invoke<T>(cmd, args);
    } catch (e) {
        // Rust 側は理由を文字列で返す
        throw e instanceof Error ? e : new Error(String(e));
    }
}

/** 起動待ちの間、進み具合を聞きにいく間隔（ミリ秒）。 */
const BOOT_POLL_MS = 500;

/**
 * 接続先とトークンを決める。アプリの描画を始める前に 1 回呼ぶ。
 *
 * デスクトップ版では、sidecar が待ち受けを始めるまで待つ（Rust 側のコマンドが待つ）。
 * 初回は Python 環境の用意に数分かかるので、その間 `onStatus` に進み具合を渡す。
 * 用意や起動に失敗した場合は、理由を載せた Error で失敗する。
 * 開発用のブラウザ起動では何も問い合わせず、すぐに終わる。
 *
 * @param onStatus - 起動待ちの間、進み具合が変わるたびに呼ばれる（デスクトップ版のみ）
 */
export async function initBackend(onStatus?: (status: BootStatus) => void): Promise<BackendInfo> {
    const tauri = tauriGlobal();
    if (!tauri) return backend;

    let waiting = true;
    const poll = async () => {
        while (waiting) {
            try {
                const status = await tauri.core.invoke<BootStatus>('boot_status');
                if (waiting) onStatus?.(status);
            } catch {
                // 進み具合が取れなくても、起動そのものは backend_info の結果で決まる
            }
            await new Promise((resolve) => setTimeout(resolve, BOOT_POLL_MS));
        }
    };
    if (onStatus) void poll();
    try {
        const info = await tauri.core.invoke<TauriBackendInfo>('backend_info');
        backend = { baseUrl: `http://127.0.0.1:${info.port}`, token: info.token };
    } catch (e) {
        // Rust 側は理由を文字列で返す
        throw e instanceof Error ? e : new Error(String(e));
    } finally {
        waiting = false;
    }
    return backend;
}

/** 現在の接続情報を返す。 */
export function getBackend(): BackendInfo {
    return backend;
}

/**
 * デスクトップアプリのネイティブ側（Rust）が送るイベントを受け取る。
 *
 * @param event - イベント名
 * @param handler - イベントの中身を受け取る関数
 * @returns 受け取りをやめる関数
 * @throws デスクトップアプリの外で呼んだ場合
 */
export async function listenDesktop<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    const tauri = tauriGlobal();
    if (!tauri || !tauri.event) throw new Error('デスクトップアプリの中でしか使えません');
    return tauri.event.listen<T>(event, (e) => handler(e.payload));
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
        // 開発用のブラウザ起動はここを通る。今までの fetch(url, init) とまったく同じ呼び出し
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
 * 開発用のブラウザ起動では受け取った URL をそのまま返す。blob: や外部の URL もそのまま返す。
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

/**
 * 状態コードから、利用者に見せる文を作る。「何が起きたか」と「次にどうすればよいか」を並べる。
 *
 * API が理由の文を返さなかったときに使う。`HTTP 500` のような番号だけの表示にしない
 * (番号を見ても、利用者は次に何をすればよいか分からない)。
 *
 * @param status - HTTP の状態コード
 */
export function statusMessage(status: number): string {
    if (status === 401 || status === 403) {
        return 'アプリの処理部分との接続が切れました。アプリを再起動してから、もう一度試してください';
    }
    if (status === 404) return '必要なデータが見つかりませんでした。最初の操作からやり直してください';
    if (status === 413) return 'ファイルが大きすぎて受け取れませんでした。短く切るか、別のファイルで試してください';
    if (status === 400 || status === 422) {
        return '入力した内容を受け付けられませんでした。ファイルと設定を確かめて、もう一度試してください';
    }
    if (status >= 500) {
        return '処理の途中で問題が起きました。もう一度試してください。繰り返す場合は、アプリを再起動してください';
    }
    return '処理できませんでした。もう一度試してください';
}

/** 入力の検査で API が返す指摘 (FastAPI の 422) の 1 件。 */
interface ValidationIssue {
    loc?: unknown[];
    msg?: unknown;
}

/**
 * 失敗した応答から、利用者に見せる文を作る。
 *
 * API は失敗の理由を `{"detail": "..."}` の形で返す。応答の本文をそのまま見せると
 * この JSON が画面に出てしまうので、中の文だけを取り出す。
 *
 * - 理由が文で返ってきた: 4xx (利用者が直せる失敗) はその文をそのまま返す。
 *   5xx (処理の側の失敗) は、次にどうすればよいかを添える
 * - 理由が文でない (入力の検査の指摘の一覧など) / 本文が JSON でない / 本文が無い:
 *   状態コードから文を作る (`statusMessage`)。生の JSON や `HTTP 500` は返さない
 *
 * @param resp - `ok` でない応答（本文をまだ読んでいないもの）
 */
export async function errorDetail(resp: Response): Promise<string> {
    let detail: unknown;
    try {
        detail = (JSON.parse(await resp.text()) as { detail?: unknown } | null)?.detail;
    } catch {
        // 本文が読めない、または JSON ではない。下で状態コードから文を作る
    }
    if (typeof detail === 'string' && detail.trim()) {
        const reason = detail.trim();
        return resp.status >= 500 ? `${statusMessage(resp.status)}（理由: ${reason}）` : reason;
    }
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        // {"message": "..."} の形で理由を返す API も在る (再現ガイド)
        const message = (detail as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) return message.trim();
    }
    if (Array.isArray(detail) && detail.length > 0) {
        // 入力の検査の指摘。どの項目かだけを添える (指摘の文は英語の定型文なので出さない)
        const fields = (detail as ValidationIssue[])
            .map((issue) => (Array.isArray(issue?.loc) ? String(issue.loc[issue.loc.length - 1] ?? '') : ''))
            .filter((name) => name !== '');
        const unique = [...new Set(fields)];
        return unique.length > 0
            ? `${statusMessage(resp.status)}（項目: ${unique.join('、')}）`
            : statusMessage(resp.status);
    }
    return statusMessage(resp.status);
}

/**
 * 捕まえた失敗を、利用者に見せる文にする。
 *
 * API に届かなかったとき (`fetch` そのものの失敗) は、ブラウザごとに違う英語の文
 * (`Failed to fetch` / `Load failed`) になるので、何が起きたかと次の手を日本語で返す。
 * それ以外は、失敗に付いている文 (`errorDetail` で作った文など) をそのまま返す。
 *
 * @param error - `catch` で受け取った値
 */
export function describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (error instanceof TypeError && /fetch|load failed|network/i.test(message)) {
        return 'アプリの処理部分に接続できませんでした。少し待ってから、もう一度試してください。繰り返す場合は、アプリを再起動してください';
    }
    return message.trim() || '処理できませんでした。もう一度試してください';
}
