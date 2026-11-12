/**
 * 本物の窓を操作するための、最小限の WebDriver の呼び出し口。
 *
 * 相手は、テスト用のビルドのアプリの中で動く WebDriver サーバ (Rust のプラグイン
 * `tauri-plugin-wdio-webdriver`。WebdriverIO の公式)。W3C WebDriver の決まった HTTP の API なので、
 * npm のクライアント (webdriverio) は入れずに、使うものだけを fetch で呼ぶ。
 * webdriverio は 200 を超える依存 (ブラウザのダウンロード、FTP など、ここでは使わないもの) を連れてくるため
 * (docs/ui-testing.md「本物の窓を操作するテスト」)。
 *
 * 注意: クリックは、画面の中で `element.click()` を呼ぶ形で行われる (OS のマウス操作ではない)。
 */

/** WebDriver の応答のエラー。 */
interface WebDriverError {
    error: string;
    message: string;
}

/** 画面の中で実行した関数の結果 (例外は文字列にして返す)。 */
type Outcome<T> = { ok: T } | { error: string };

/** W3C WebDriver の、要素を指す識別子のキー。 */
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export class WebDriverSession {
    private readonly base: string;
    /** セッションの識別子。 */
    readonly id: string;

    private constructor(base: string, id: string) {
        this.base = base;
        this.id = id;
    }

    /**
     * セッションを始める。
     *
     * @param port - WebDriver サーバのポート (127.0.0.1)
     */
    static async create(port: number): Promise<WebDriverSession> {
        const base = `http://127.0.0.1:${port}`;
        const value = await call<{ sessionId: string }>(base, 'POST', '/session', {
            capabilities: { alwaysMatch: { browserName: 'tauri' } },
        });
        const session = new WebDriverSession(base, value.sessionId);
        await session.request('POST', '/timeouts', { script: 60_000 });
        return session;
    }

    private request<T>(method: string, path: string, body?: unknown): Promise<T> {
        return call<T>(this.base, method, `/session/${this.id}${path}`, body);
    }

    /**
     * 画面の中で関数を実行し、戻り値を返す。関数は文字列にして送られるので、外の変数は使えない (引数で渡す)。
     * Promise を返す関数なら、解決するまで待つ。
     */
    async run<T, A extends unknown[]>(fn: (...args: A) => T | Promise<T>, ...args: A): Promise<T> {
        const script = `
            const done = arguments[arguments.length - 1];
            const args = Array.prototype.slice.call(arguments, 0, -1);
            Promise.resolve().then(() => (${fn.toString()}).apply(null, args))
                .then((value) => done({ ok: value === undefined ? null : value }),
                      (e) => done({ error: String((e && e.stack) || e) }));`;
        const outcome = await this.request<Outcome<T>>('POST', '/execute/async', { script, args });
        if ('error' in outcome) throw new Error(`画面の中で失敗しました: ${outcome.error}`);
        return outcome.ok;
    }

    /**
     * 条件が満たされるまで、画面の中で繰り返し確かめる。
     *
     * `fn` は、満たされたら `true` を、まだなら `false` か、いまの様子を説明する文を返す
     * (文は時間切れのときの説明に出る)。`true` 以外はすべて「まだ」として扱う
     * (以前は、説明の文も真とみなして待たずに通っていた)。
     *
     * @param what - 待っているもの (時間切れのときの説明)
     */
    async waitFor<A extends unknown[]>(what: string, fn: (...args: A) => unknown, args: A, timeoutMs = 20_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        let last: unknown;
        while (Date.now() < deadline) {
            try {
                last = await this.run(fn, ...args);
                if (last === true) return;
            } catch (e) {
                last = e;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error(`待ちきれませんでした: ${what} (最後の結果: ${String(last)})`);
    }

    /** XPath で要素を 1 つ探す。 */
    async find(xpath: string): Promise<string> {
        const value = await this.request<Record<string, string>>('POST', '/element', { using: 'xpath', value: xpath });
        return value[ELEMENT_KEY];
    }

    /** 要素をクリックする (画面の中で `element.click()`)。 */
    async click(xpath: string): Promise<void> {
        const element = await this.find(xpath);
        await this.request('POST', `/element/${element}/click`, {});
    }

    /** 窓のスクリーンショット (PNG) を返す。 */
    async screenshot(): Promise<Buffer> {
        return Buffer.from(await this.request<string>('GET', '/screenshot'), 'base64');
    }

    /** 窓を閉じる (メインの窓なら、アプリが終わる)。 */
    async closeWindow(): Promise<void> {
        await this.request('DELETE', '/window').catch(() => undefined);
    }

    /** セッションを終える。 */
    async delete(): Promise<void> {
        await this.request('DELETE', '').catch(() => undefined);
    }
}

/** WebDriver サーバを呼ぶ。失敗の応答は、中身の説明を付けた Error にする。 */
async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as { value?: unknown };
    if (!response.ok) {
        const error = json.value as WebDriverError | undefined;
        throw new Error(`WebDriver ${method} ${path} が失敗しました (${response.status}): ${error?.error ?? ''} ${error?.message ?? ''}`);
    }
    return json.value as T;
}

/** WebDriver サーバが応答するようになるまで待つ。 */
export async function waitForWebDriver(port: number, timeoutMs: number, alive: () => boolean): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!alive()) throw new Error('アプリが WebDriver サーバの起動前に終了しました');
        try {
            const status = await call<{ ready?: boolean }>(`http://127.0.0.1:${port}`, 'GET', '/status');
            if (status?.ready !== false) return;
        } catch {
            // まだ待ち受けていない
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`WebDriver サーバが ${timeoutMs / 1000} 秒以内に応答しませんでした (ポート ${port})`);
}
