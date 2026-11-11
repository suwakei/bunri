/**
 * 再現ガイド（第2層）のテスト: API 呼び出しのヘルパーと、パネルの表示。
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// AudioContext モック（store が engine を読み込むため）
class MockGainNode {
    gain = { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    connect() { return this; }
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return { pan: { value: 0 }, connect() { return this; } } as unknown as StereoPannerNode; }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { GuideRequestError, refLabel, requestGuide, saveApiKey, deleteApiKey } = await import('../lib/guide');
type GuideResponse = import('../lib/guide').GuideResponse;
type SongChart = import('../lib/chart').SongChart;
const { DawProvider, useDaw } = await import('../lib/store');
const GuidePanel = (await import('../components/GuidePanel')).default;

const chart: SongChart = {
    version: 1,
    source: { filename: 'demo.wav', duration_sec: 16 },
    grid: {
        bpm: 120, bpm_confidence: 0.9, bpm_source: 'auto', downbeat_offset_sec: 0,
        time_signature: [4, 4], beat_times_sec: [0, 0.5, 1, 1.5], user_confirmed: false,
    },
    key: { tonic: 'C', mode: 'major', confidence: 0.8, alternatives: [] },
    sections: [
        { id: 'S1', label: null, suggested_label: 'verse', suggested_confidence: 0.6, start_bar: 1, end_bar: 4,
          start_sec: 0, end_sec: 8, repeat_group: 'A', features: { rms_db: -14, onset_density: 3 } },
        { id: 'S2', label: 'chorus', suggested_label: 'chorus', suggested_confidence: 0.7, start_bar: 5, end_bar: 8,
          start_sec: 8, end_sec: 16, repeat_group: 'B', features: { rms_db: -10, onset_density: 5 } },
    ],
    chords: [],
    mix: null,
    unavailable: {},
} as unknown as SongChart;

const response: GuideResponse = {
    chart_id: 'demo',
    focus: null,
    model: 'claude-opus-5-5',
    usage: {},
    guide: {
        overview: 'キーは C メジャー、テンポは 120 BPM の曲です。',
        steps: [
            { title: 'テンポを合わせる', topic: 'grid', body: 'まず 120 BPM に設定します。', refs: [{ section_id: null, bar: 1, beat: 1 }] },
            { title: 'サビのコード', topic: 'chords', body: 'I → V → vi → IV の進行です。', refs: [{ section_id: 'S2', bar: null, beat: null }] },
        ],
        cautions: ['4 小節目のコードは確信度が低めです。'],
        dropped_refs: 0,
        unverified_terms: [],
    },
};

let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    cleanup();
});

describe('refLabel', () => {
    it('セクションは名前と小節の範囲で示す', () => {
        expect(refLabel({ section_id: 'S2', bar: null, beat: null }, chart)).toBe('サビ（5〜8 小節）');
    });
    it('小節と拍', () => {
        expect(refLabel({ section_id: null, bar: 3, beat: null }, chart)).toBe('3 小節');
        expect(refLabel({ section_id: null, bar: 3, beat: 2 }, chart)).toBe('3 小節 2 拍目');
    });
    it('両方在れば並べる', () => {
        expect(refLabel({ section_id: 'S1', bar: 2, beat: null }, chart)).toMatch(/（1〜4 小節） \/ 2 小節$/);
    });
});

describe('requestGuide', () => {
    it('カルテの ID と対象を送り、結果を返す', async () => {
        stubFetch(async () => Response.json(response));
        expect(await requestGuide('demo', 'S2')).toEqual(response);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/chart/demo/guide');
        expect(init.method).toBe('POST');
        expect((init.body as FormData).get('focus')).toBe('S2');
    });

    it('失敗の理由と種類を取り出す', async () => {
        stubFetch(async () => Response.json({ detail: { message: 'API キーが設定されていません', code: 'no_key' } }, { status: 401 }));
        const err = await requestGuide('demo', null).catch((e) => e);
        expect(err).toBeInstanceOf(GuideRequestError);
        expect(err.message).toBe('API キーが設定されていません');
        expect(err.code).toBe('no_key');
        expect(err.needsKey).toBe(true);
    });

    it('文字列の detail や JSON でない応答でも壊れない', async () => {
        stubFetch(async () => Response.json({ detail: 'カルテが見つかりません' }, { status: 404 }));
        expect((await requestGuide('x', null).catch((e) => e)).message).toBe('カルテが見つかりません');
        stubFetch(async () => new Response('Bad Gateway', { status: 502 }));
        const err = await requestGuide('x', null).catch((e) => e);
        expect(err.code).toBe('api');
        expect(err.needsKey).toBe(false);
    });
});

describe('API キーの保存', () => {
    const settings = { has_key: true, key_source: 'settings', model: 'claude-opus-5-5' };

    it('開発用のブラウザ起動ではバックエンドに渡すだけ', async () => {
        stubFetch(async () => Response.json(settings));
        expect(await saveApiKey('sk-abc')).toEqual(settings);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/settings/anthropic-key');
        expect((init.body as FormData).get('key')).toBe('sk-abc');
    });

    it('デスクトップ版では先にキーチェーンへ保存し、そのあとバックエンドに渡す', async () => {
        const order: string[] = [];
        const invoke = vi.fn(async (cmd: string) => { order.push(cmd); });
        (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
        stubFetch(async () => { order.push('fetch'); return Response.json(settings); });
        await saveApiKey('sk-abc');
        expect(invoke).toHaveBeenCalledWith('save_api_key', { key: 'sk-abc' });
        expect(order).toEqual(['save_api_key', 'fetch']);
    });

    it('キーチェーンへの保存に失敗したら、バックエンドには渡さない', async () => {
        (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
            core: { invoke: vi.fn(async () => { throw 'キーチェーンに保存できません'; }) },
        };
        stubFetch(async () => Response.json(settings));
        await expect(saveApiKey('sk-abc')).rejects.toThrow('キーチェーンに保存できません');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('削除はデスクトップ版ではキーチェーンからも消す', async () => {
        const invoke = vi.fn(async () => {});
        (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
        stubFetch(async () => Response.json({ ...settings, has_key: false, key_source: 'none' }));
        await deleteApiKey();
        expect(invoke).toHaveBeenCalledWith('delete_api_key', undefined);
        expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe('DELETE');
    });
});

/** カルテを流し込んでからパネルを描画する */
function Loader() {
    const { chart: current, setChartResult } = useDaw();
    if (!current) setChartResult({ chart_id: 'demo', chart, glossary: {} });
    return <GuidePanel />;
}

describe('GuidePanel', () => {
    beforeEach(() => cleanup());

    it('カルテが無ければ何も出さない', () => {
        const { container } = render(<DawProvider><GuidePanel /></DawProvider>);
        expect(container).toBeEmptyDOMElement();
    });

    it('外部に送る内容を、作る前に明示する', () => {
        render(<DawProvider><Loader /></DawProvider>);
        expect(screen.getByText(/Anthropic の Claude に送ります。音声は送りません/)).toBeInTheDocument();
    });

    it('ガイドを作って、手順・場所・注意を表示する', async () => {
        stubFetch(async () => Response.json(response));
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'ガイドを作る' }));
        await waitFor(() => expect(screen.getByText('テンポを合わせる')).toBeInTheDocument());
        expect(screen.getByText(/キーは C メジャー/)).toBeInTheDocument();
        expect(screen.getByText('I → V → vi → IV の進行です。')).toBeInTheDocument();
        expect(screen.getByText('1 小節 1 拍目')).toBeInTheDocument();
        expect(document.querySelectorAll('.guide-ref')[1]).toHaveTextContent('サビ（5〜8 小節）');
        expect(screen.getByText('4 小節目のコードは確信度が低めです。')).toBeInTheDocument();
        expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    it('選んだセクションを対象として送る', async () => {
        stubFetch(async () => Response.json(response));
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.change(screen.getByLabelText('対象'), { target: { value: 'S2' } });
        fireEvent.click(screen.getByRole('button', { name: 'ガイドを作る' }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData).get('focus')).toBe('S2');
    });

    it('カルテに無い語が説明に含まれていたら、推測かもしれないと伝える', async () => {
        stubFetch(async () => Response.json({ ...response, guide: { ...response.guide, unverified_terms: ['Dm7', 'E4'] } }));
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'ガイドを作る' }));
        const note = await screen.findByRole('note');
        expect(note).toHaveTextContent('Dm7、E4');
        expect(note).toHaveTextContent('モデルの推測かもしれません');
    });

    it('API キーが無いと言われたら、理由と入力欄を出す', async () => {
        stubFetch(async () => Response.json({ detail: { message: 'Claude の API キーが設定されていません', code: 'no_key' } }, { status: 401 }));
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'ガイドを作る' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('API キーが設定されていません');
        expect(screen.getByLabelText('Claude の API キー')).toHaveAttribute('type', 'password');
    });

    it('API キーを設定すると入力欄が閉じ、キーは画面に残らない', async () => {
        stubFetch(async () => Response.json({ has_key: true, key_source: 'settings', model: 'm' }));
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'API キーの設定' }));
        fireEvent.change(screen.getByLabelText('Claude の API キー'), { target: { value: 'sk-secret' } });
        fireEvent.click(screen.getByRole('button', { name: '設定する' }));
        await waitFor(() => expect(screen.getByText('API キーを設定しました')).toBeInTheDocument());
        expect(screen.queryByLabelText('Claude の API キー')).not.toBeInTheDocument();
        expect(document.body.innerHTML).not.toContain('sk-secret');
    });

    it('それ以外の失敗では入力欄を出さない', async () => {
        stubFetch(async () => Response.json({ detail: { message: 'Claude に接続できませんでした', code: 'network' } }, { status: 502 }));
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'ガイドを作る' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('接続できませんでした');
        expect(screen.queryByLabelText('Claude の API キー')).not.toBeInTheDocument();
    });
});
