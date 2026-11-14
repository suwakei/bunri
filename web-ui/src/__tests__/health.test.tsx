/**
 * 処理を担当する部分の見張り (lib/health.ts) と、止まったときの知らせ (components/HealthBanner.tsx) のテスト。
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';
import { apiFetch, getBackend, restartBackend, setBackendForTest } from '../lib/api';
import { health } from '../lib/health';
import { jobTracker } from '../lib/jobs';
import HealthBanner from '../components/HealthBanner';

expect.extend(matchers);

let alive = true;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    alive = true;
    fetchMock = vi.fn(async (url: string) => {
        if (!alive) throw new TypeError('Failed to fetch');
        return Response.json(url.includes('/api/health') ? { ok: true } : {});
    });
    vi.stubGlobal('fetch', fetchMock);
    health.resetForTest();
    health.configure({ ok: 20, down: 20, hidden: 20, timeout: 5000, retry: 5 });
    jobTracker.resetForTest();
});

afterEach(() => {
    health.resetForTest();
    jobTracker.resetForTest();
    vi.unstubAllGlobals();
    setBackendForTest({ baseUrl: '', token: null });
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    cleanup();
});

describe('開発用のブラウザ起動', () => {
    it('応答している間は何も出さない。止まると、起動し直し方を案内する。戻ると消える', async () => {
        render(<HealthBanner />);
        const stop = health.start();
        await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/health')).toBe(true));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();

        alive = false;
        const banner = await screen.findByRole('alert');
        expect(banner).toHaveTextContent('処理を担当する部分が止まりました');
        expect(banner).toHaveTextContent('make dev-web');
        expect(screen.queryByRole('button', { name: '再起動' })).not.toBeInTheDocument();

        alive = true;
        fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
        stop();
    });

    it('API の呼び出しが届かなかったら、次の回を待たずに確かめる', async () => {
        health.configure({ ok: 60_000 });
        const stop = health.start();
        alive = false;
        await expect(apiFetch('/api/gm-instruments')).rejects.toBeInstanceOf(TypeError);
        await waitFor(() => expect(health.getState().kind).toBe('down'));
        stop();
    });

    it('一瞬の取りこぼしでは知らせない (もう 1 回確かめて応答があれば、応答しているとみなす)', async () => {
        let failures = 1;
        fetchMock.mockImplementation(async () => {
            if (failures-- > 0) throw new TypeError('Failed to fetch');
            return Response.json({ ok: true });
        });
        const seen: string[] = [];
        health.subscribe(() => seen.push(health.getState().kind));
        const stop = health.start();
        await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
        expect(seen).not.toContain('down');
        stop();
    });
});

describe('応答が遅いとき', () => {
    it('時間切れが 1〜2 回続くだけでは知らせない (重い解析の最中)。続けば知らせる', async () => {
        health.configure({ timeout: 20, ok: 5, down: 5, retry: 1 });
        // 中断されるまで応答しない (遅い)
        fetchMock.mockImplementation((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const seen: { kind: string; at: number }[] = [];
        let checks = 0;
        health.subscribe(() => seen.push({ kind: health.getState().kind, at: checks }));
        const stop = health.start();
        await waitFor(() => expect(health.getState().kind).toBe('down'), { timeout: 3000 });
        // 1 回の確かめで 2 回問い合わせる。3 回の確かめ (6 回の問い合わせ) より前には知らせていない
        checks = fetchMock.mock.calls.length;
        expect(checks).toBeGreaterThanOrEqual(6);
        stop();
    });
});

describe('デスクトップ版', () => {
    function desktop(invoke: (cmd: string) => unknown) {
        (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke: vi.fn(async (cmd: string) => invoke(cmd)) } };
    }

    it('Rust が sidecar の終了を知っていれば、すぐ止まったと知らせ、「再起動」で起動し直して新しい接続先に差し替える', async () => {
        setBackendForTest({ baseUrl: 'http://127.0.0.1:1111', token: 'old' });
        let phase = 'failed';
        desktop((cmd) => {
            if (cmd === 'boot_status') return { phase, message: 'バックエンドが終了しました', log: [], first_run: false };
            if (cmd === 'restart_backend') { phase = 'ready'; return { port: 2222, token: 'new' }; }
            if (cmd === 'backend_info') return { port: 2222, token: 'new' };
            throw new Error(cmd);
        });
        const serverRestarted = vi.spyOn(jobTracker, 'serverRestarted');
        render(<HealthBanner />);
        const stop = health.start();
        const banner = await screen.findByRole('alert');
        expect(banner).toHaveTextContent('処理を担当する部分が止まりました');
        expect(banner).toHaveTextContent('トラックとノートはそのまま残っています');
        expect(banner).not.toHaveTextContent('make dev-web');

        fireEvent.click(screen.getByRole('button', { name: '再起動' }));
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
        expect(getBackend()).toEqual({ baseUrl: 'http://127.0.0.1:2222', token: 'new' });
        expect(serverRestarted).toHaveBeenCalled();
        // 以後の呼び出しは新しい接続先とトークンで送る
        await apiFetch('/api/health');
        const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:2222/api/health');
        expect(new Headers(init.headers).get('X-Bunri-Token')).toBe('new');
        stop();
    });

    it('起動し直せなかったら、理由を出し、もう一度押せる', async () => {
        desktop((cmd) => {
            if (cmd === 'boot_status') return { phase: 'failed', message: '', log: [], first_run: false };
            if (cmd === 'restart_backend') throw 'uv が見つかりません';
            throw new Error(cmd);
        });
        render(<HealthBanner />);
        const stop = health.start();
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: '再起動' }));
        const banner = await screen.findByText('処理を担当する部分を起動し直せませんでした');
        expect(banner.parentElement).toHaveTextContent('uv が見つかりません');
        expect(screen.getByRole('button', { name: '再起動' })).toBeEnabled();
        stop();
    });

    it('ほかの窓が起動し直していたら、起動し直さずに新しい接続情報を受け取る', async () => {
        setBackendForTest({ baseUrl: 'http://127.0.0.1:1111', token: 'old' });
        desktop((cmd) => {
            if (cmd === 'boot_status') return { phase: 'ready', message: '', log: [], first_run: false };
            if (cmd === 'backend_info') return { port: 3333, token: 'other' };
            throw new Error(`呼ばないはず: ${cmd}`);
        });
        // 古いポートには届かない
        fetchMock.mockImplementation(async (url: string) => {
            if (url.startsWith('http://127.0.0.1:1111')) throw new TypeError('Failed to fetch');
            return Response.json({ ok: true });
        });
        const seen: string[] = [];
        health.subscribe(() => seen.push(health.getState().kind));
        const stop = health.start();
        await waitFor(() => expect(getBackend().token).toBe('other'));
        expect(seen).not.toContain('down');
        stop();
    });

    it('restartBackend は Rust の restart_backend を呼び、接続先を差し替える', async () => {
        desktop((cmd) => (cmd === 'restart_backend' ? { port: 4444, token: 't' } : { phase: 'starting', message: '', log: [], first_run: false }));
        expect(await restartBackend()).toEqual({ baseUrl: 'http://127.0.0.1:4444', token: 't' });
    });
});
