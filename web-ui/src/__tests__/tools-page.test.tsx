/**
 * ツールの画面のうち、ブラウザを自動操作するテスト (e2e) では確かめられない点。
 *
 * e2e が相手にするのは開発用のブラウザ起動で、API は画面と同じ origin に在る。
 * デスクトップ版では API が別の origin に在り、鍵も要る。結果のリンクがその接続先を指すことを、
 * 接続情報を差し替えてここで確かめる。
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { errorDetail, setBackendForTest } from '../lib/api';
import ToolsPage from '../pages/ToolsPage';

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setBackendForTest({ baseUrl: '', token: null });
});

/** 一括編集のタブを開き、ファイルを 1 つ選んで実行する。API は `results` を返す。 */
async function runBatch(results: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(results), { status: 200 })));
    render(<MemoryRouter><ToolsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '一括編集' }));
    const input = document.getElementById('batch-files') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.wav', { type: 'audio/wav' })] } });
    fireEvent.click(screen.getByRole('button', { name: '一括実行' }));
    await waitFor(() => expect(document.querySelector('.status')?.textContent).toMatch(/^完了/));
}

describe('一括編集の結果', () => {
    it('デスクトップ版では、プレーヤーもダウンロードのリンクも、API の接続先を鍵付きで指す', async () => {
        setBackendForTest({ baseUrl: 'http://127.0.0.1:54321', token: 'tok' });
        await runBatch([{ filename: 'a.wav', url: '/api/download/batch_normalize_a.wav', status: 'ok' }]);
        const expected = 'http://127.0.0.1:54321/api/download/batch_normalize_a.wav?token=tok';
        expect(document.querySelector('.result-area audio')?.getAttribute('src')).toBe(expected);
        // リンクが相対パスのままだと、画面側の origin (tauri://localhost) を指してしまう
        expect(screen.getByText('ダウンロード').getAttribute('href')).toBe(expected);
    });

    it('失敗したファイルは、理由と一緒に出る', async () => {
        await runBatch([
            { filename: 'a.wav', url: '/api/download/batch_normalize_a.wav', status: 'ok' },
            { filename: 'b.wav', url: null, status: 'error: 無音のファイルです' },
        ]);
        expect(document.querySelector('.status')?.textContent).toBe('完了: 1個成功 / 1個失敗');
        expect(document.querySelector('.batch-failures')?.textContent).toBe('b.wav: 無音のファイルです');
    });

    it('範囲の要る操作を選ぶと入力欄が出て、その値が API に渡る', async () => {
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('[]', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        render(<MemoryRouter><ToolsPage /></MemoryRouter>);
        fireEvent.click(screen.getByRole('button', { name: '一括編集' }));
        const selects = document.querySelectorAll('.tool-panel select');
        fireEvent.change(selects[1], { target: { value: 'loop' } });
        const inputs = document.querySelectorAll<HTMLInputElement>('.batch-params input');
        expect([...inputs].map((i) => i.value)).toEqual(['0', '10', '3']);
        fireEvent.change(inputs[1], { target: { value: '2' } });
        const input = document.getElementById('batch-files') as HTMLInputElement;
        fireEvent.change(input, { target: { files: [new File(['x'], 'a.wav', { type: 'audio/wav' })] } });
        fireEvent.click(screen.getByRole('button', { name: '一括実行' }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const body = fetchMock.mock.calls[0][1]!.body as FormData;
        expect(body.get('action')).toBe('loop');
        expect(JSON.parse(body.get('params') as string)).toEqual({ start: 0, end: 2, count: 3 });
    });
});

describe('errorDetail', () => {
    it('API の {"detail": "..."} から、理由の文だけを取り出す', async () => {
        const resp = new Response(JSON.stringify({ detail: '開始が終了以降になっています' }), { status: 400 });
        expect(await errorDetail(resp)).toBe('開始が終了以降になっています');
    });

    it('その形でなければ本文をそのまま、本文も無ければ状態コードを返す', async () => {
        expect(await errorDetail(new Response('Internal Server Error', { status: 500 }))).toBe('Internal Server Error');
        expect(await errorDetail(new Response('', { status: 502 }))).toBe('HTTP 502');
        expect(await errorDetail(new Response(JSON.stringify({ detail: [{ msg: 'x' }] }), { status: 422 }))).toBe('[{"msg":"x"}]');
    });
});
