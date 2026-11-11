/**
 * lib/api.ts のテスト。
 *
 * - ブラウザ版では fetch(url, init) とまったく同じ呼び出しになること（今までと同じに動く）
 * - デスクトップ版では接続先とトークンが付くこと
 * - バックエンド宛てでない URL（blob: や外部）にはトークンを付けないこと
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, backendUrl, initBackend, isDesktop, setBackendForTest, getBackend } from '../lib/api';

const DESKTOP = { baseUrl: 'http://127.0.0.1:54321', token: 'tok en/1' };
const BROWSER = { baseUrl: '', token: null };

type FetchArgs = [string, RequestInit?];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setBackendForTest(BROWSER);
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
});

function lastCall(): FetchArgs {
    return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as FetchArgs;
}

describe('ブラウザ版', () => {
    it('isDesktop は false で、initBackend は何も変えない', async () => {
        expect(isDesktop()).toBe(false);
        expect(await initBackend()).toEqual(BROWSER);
    });

    it('apiFetch は fetch と同じ引数で呼ぶ（相対パスのまま、ヘッダを足さない）', async () => {
        const body = new FormData();
        const init = { method: 'POST', body };
        await apiFetch('/api/chart', init);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lastCall()[0]).toBe('/api/chart');
        expect(lastCall()[1]).toBe(init);
    });

    it('init を渡さなければ fetch にも渡さない', async () => {
        await apiFetch('/api/gm-instruments');
        expect(fetchMock.mock.calls[0]).toEqual(['/api/gm-instruments']);
    });

    it('backendUrl は URL をそのまま返す', () => {
        expect(backendUrl('/api/download/a.wav')).toBe('/api/download/a.wav');
        expect(backendUrl('blob:http://x/1')).toBe('blob:http://x/1');
    });
});

describe('デスクトップ版', () => {
    beforeEach(() => setBackendForTest(DESKTOP));

    it('initBackend は Rust に問い合わせて接続先とトークンを決める', async () => {
        setBackendForTest(BROWSER);
        const invoke = vi.fn(async () => ({ port: 40123, token: 'abc' }));
        (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
        expect(isDesktop()).toBe(true);
        expect(await initBackend()).toEqual({ baseUrl: 'http://127.0.0.1:40123', token: 'abc' });
        expect(invoke).toHaveBeenCalledWith('backend_info');
        expect(getBackend().token).toBe('abc');
    });

    it('起動待ちの間、進み具合を onStatus に渡す', async () => {
        setBackendForTest(BROWSER);
        let finish: (v: { port: number; token: string }) => void = () => {};
        const setup = { phase: 'setup', message: '初回セットアップ中です', log: ['Downloading torch'], first_run: true };
        const invoke = vi.fn((cmd: string) => cmd === 'backend_info'
            ? new Promise((resolve) => { finish = resolve; })
            : Promise.resolve(setup));
        (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
        const seen: unknown[] = [];
        const done = initBackend((status) => seen.push(status));
        await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
        expect(seen[0]).toEqual(setup);
        finish({ port: 40124, token: 'xyz' });
        expect(await done).toEqual({ baseUrl: 'http://127.0.0.1:40124', token: 'xyz' });
    });

    it('Rust 側が理由を文字列で返しても Error として失敗する', async () => {
        (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
            core: { invoke: vi.fn(async () => { throw 'セットアップに失敗しました'; }) },
        };
        await expect(initBackend()).rejects.toThrow('セットアップに失敗しました');
    });

    it('sidecar を起動できなければ initBackend は失敗する', async () => {
        (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
            core: { invoke: vi.fn(async () => { throw new Error('uv が見つかりません'); }) },
        };
        await expect(initBackend()).rejects.toThrow('uv が見つかりません');
    });

    it('apiFetch は接続先とトークンのヘッダを付ける', async () => {
        const body = new FormData();
        await apiFetch('/api/chart', { method: 'POST', body, headers: { 'X-Other': '1' } });
        const [url, init] = lastCall();
        expect(url).toBe('http://127.0.0.1:54321/api/chart');
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe(body);
        const headers = new Headers(init?.headers);
        expect(headers.get('X-Bunri-Token')).toBe('tok en/1');
        expect(headers.get('X-Other')).toBe('1');
    });

    it('init 無しでもトークンが付く', async () => {
        await apiFetch('/api/gm-instruments');
        const [url, init] = lastCall();
        expect(url).toBe('http://127.0.0.1:54321/api/gm-instruments');
        expect(new Headers(init?.headers).get('X-Bunri-Token')).toBe('tok en/1');
    });

    it('接続先で始まる絶対 URL にもトークンが付く', async () => {
        await apiFetch('http://127.0.0.1:54321/api/download/a.wav');
        expect(new Headers(lastCall()[1]?.headers).get('X-Bunri-Token')).toBe('tok en/1');
    });

    it.each([
        'blob:tauri://localhost/1234',
        'https://example.com/api/x',
        '//example.com/api/x',
        'http://127.0.0.1:54321.evil.example/api/x',
        'http://127.0.0.1:5432/api/x',
    ])('バックエンド宛てでない URL (%s) にはトークンを付けず、そのまま渡す', async (url) => {
        await apiFetch(url);
        expect(fetchMock.mock.calls[0]).toEqual([url]);
    });

    it('backendUrl は接続先とクエリのトークンを付ける', () => {
        expect(backendUrl('/api/download/a.wav')).toBe('http://127.0.0.1:54321/api/download/a.wav?token=tok%20en%2F1');
        expect(backendUrl('/api/x?a=1')).toBe('http://127.0.0.1:54321/api/x?a=1&token=tok%20en%2F1');
    });

    it('backendUrl は blob: や外部の URL を変えない', () => {
        expect(backendUrl('blob:tauri://localhost/1234')).toBe('blob:tauri://localhost/1234');
        expect(backendUrl('https://example.com/a.wav')).toBe('https://example.com/a.wav');
    });
});
