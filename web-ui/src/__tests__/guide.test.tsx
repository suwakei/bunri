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

const {
    GuideRequestError, refLabel, requestGuide, saveApiKey, deleteApiKey, fetchSavedGuide, saveGuideSettings, formatUsd,
} = await import('../lib/guide');
type GuideResponse = import('../lib/guide').GuideResponse;
type GuideToday = import('../lib/guide').GuideToday;
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

    it('作り直すときだけ regenerate を付ける', async () => {
        stubFetch(async () => Response.json(response));
        await requestGuide('demo', null);
        await requestGuide('demo', null, true);
        const bodies = fetchMock.mock.calls.map((call) => (call as [string, RequestInit])[1].body as FormData);
        expect(bodies[0].has('regenerate')).toBe(false);
        expect(bodies[1].get('regenerate')).toBe('true');
    });

    it('保存済みの確認は GET で、対象をクエリに載せる', async () => {
        stubFetch(async () => Response.json({ saved: false, chart_id: 'demo', focus: 'S2' }));
        expect((await fetchSavedGuide('demo', 'S2')).saved).toBe(false);
        await fetchSavedGuide('demo', null);
        expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/chart/demo/guide?focus=S2', '/api/chart/demo/guide']);
        expect(fetchMock.mock.calls.every((call) => call[1] === undefined)).toBe(true);
    });

    it('上限の設定は JSON で送る（上限なしは null）', async () => {
        stubFetch(async () => Response.json({ settings: {}, today: {} }));
        await saveGuideSettings({ daily_limit_calls: null });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/settings/guide');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({ daily_limit_calls: null });
    });

    it('概算の費用の表示', () => {
        expect(formatUsd(0.1123)).toBe('$0.11');
        expect(formatUsd(0.0042)).toBe('$0.004');
        expect(formatUsd(0)).toBe('$0.00');
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

/** Claude を呼ぶことになるリクエスト（ガイドの POST）だけを取り出す。保存済みの確認（GET）は含めない */
function posts(): [string, RequestInit][] {
    return (fetchMock.mock.calls as [string, RequestInit | undefined][])
        .filter(([url, init]) => /\/guide$/.test(url) && init?.method === 'POST') as [string, RequestInit][];
}

const today: GuideToday = { date: '2026-11-11', calls: 3, cost_usd: 0.3312, limit_calls: 20, limit_usd: null, blocked: null };

/** Claude を呼んで作ったときのレスポンス（使用量と費用つき） */
const made: GuideResponse = {
    ...response,
    usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 5300, output_tokens: 4200, thinking_tokens: 900 },
    cost_usd: 0.0851,
    created_at: '2026-11-11T03:00:00+00:00',
    cached: false,
    today,
};

/**
 * ガイドの API を差し替える。保存済みの確認（GET）と、作る（POST）で応答を分ける。
 *
 * @param saved - 対象（'' は曲全体）ごとの、保存済みのガイド。無い対象は「保存済みなし」
 * @param post - POST への応答
 */
function stubGuideApi(saved: Record<string, GuideResponse>, post: (body: FormData) => Response) {
    stubFetch(async (url, init) => {
        if (init?.method === 'POST') return post(init.body as FormData);
        const focus = new URL(url, 'http://test').searchParams.get('focus') ?? '';
        const hit = saved[focus];
        return Response.json(hit ? { ...hit, saved: true, cached: true, today } : { saved: false, chart_id: 'demo', focus: focus || null, today });
    });
}

describe('GuidePanel: 保存済みのガイドと費用', () => {
    beforeEach(() => cleanup());

    it('保存済みが在れば最初から表示し、Claude は呼ばない', async () => {
        stubGuideApi({ '': made }, () => { throw new Error('保存済みが在るのに POST した'); });
        render(<DawProvider><Loader /></DawProvider>);
        expect(await screen.findByText('テンポを合わせる')).toBeInTheDocument();
        expect(posts()).toHaveLength(0);
        // ボタンは「作り直す」になり、費用がかかる旨が添えられる
        expect(screen.getByRole('button', { name: 'ガイドを作り直す（費用がかかります）' })).toBeInTheDocument();
        expect(screen.getByText(/このガイドは保存済みです/)).toHaveTextContent('前回は概算 $0.09');
    });

    it('保存済みが無ければ、押すまで何も作らない', async () => {
        stubGuideApi({}, () => Response.json(made));
        render(<DawProvider><Loader /></DawProvider>);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.getByRole('button', { name: 'ガイドを作る' })).toBeInTheDocument();
        expect(screen.queryByText('テンポを合わせる')).not.toBeInTheDocument();
        expect(posts()).toHaveLength(0);
    });

    it('対象を変えると、その対象の保存済みを探す（無ければ表示を消す）', async () => {
        stubGuideApi({ '': made }, () => Response.json(made));
        render(<DawProvider><Loader /></DawProvider>);
        await screen.findByText('テンポを合わせる');
        fireEvent.change(screen.getByLabelText('対象'), { target: { value: 'S2' } });
        await waitFor(() => expect(screen.queryByText('テンポを合わせる')).not.toBeInTheDocument());
        expect(screen.getByRole('button', { name: 'ガイドを作る' })).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('対象'), { target: { value: '' } });
        expect(await screen.findByText('テンポを合わせる')).toBeInTheDocument();
        expect(posts()).toHaveLength(0);
    });

    it('最初に作るときは regenerate を付けず、作り直すときだけ付ける', async () => {
        stubGuideApi({}, () => Response.json(made));
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'ガイドを作る' }));
        fireEvent.click(await screen.findByRole('button', { name: /ガイドを作り直す/ }));
        await waitFor(() => expect(posts()).toHaveLength(2));
        expect((posts()[0][1].body as FormData).has('regenerate')).toBe(false);
        expect((posts()[1][1].body as FormData).get('regenerate')).toBe('true');
    });

    it('1 回ごとのトークン数と概算の費用、今日の累計と上限を見せる', async () => {
        stubGuideApi({}, () => Response.json(made));
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'ガイドを作る' }));
        await screen.findByText('テンポを合わせる');
        const usage = document.getElementById('guide-usage');
        expect(usage).toHaveTextContent('入力 5,312 トークン（うち 5,300 はキャッシュから）');
        expect(usage).toHaveTextContent('出力 4,200 トークン');
        expect(usage).toHaveTextContent('概算 $0.09');
        const total = document.getElementById('guide-today');
        expect(total).toHaveTextContent('3 回');
        expect(total).toHaveTextContent('概算 $0.33');
        expect(total).toHaveTextContent('上限 20 回');
    });

    it('単価が分からないモデルでは、費用を出さずトークン数だけ見せる', async () => {
        stubGuideApi({ '': { ...made, cost_usd: null } }, () => Response.json(made));
        render(<DawProvider><Loader /></DawProvider>);
        await screen.findByText('テンポを合わせる');
        expect(document.getElementById('guide-usage')).not.toHaveTextContent('概算');
        expect(screen.getByText(/このガイドは保存済みです/)).not.toHaveTextContent('前回');
    });

    it('1 日の上限を超えたと言われたら、理由を出す（API キーの入力欄は出さない）', async () => {
        const message = '今日は再現ガイドを 20 回作りました。1 日の上限（20 回）に達したので、Claude を呼びません。';
        stubGuideApi({}, () => Response.json({ detail: { message, code: 'daily_limit' } }, { status: 429 }));
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'ガイドを作る' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('1 日の上限（20 回）に達したので、Claude を呼びません');
        expect(screen.queryByLabelText('Claude の API キー')).not.toBeInTheDocument();
    });

    it('作り直しに失敗しても、表示中のガイドは残す', async () => {
        stubGuideApi({ '': made }, () => Response.json({ detail: { message: '上限に達しました', code: 'daily_limit' } }, { status: 429 }));
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.click(await screen.findByRole('button', { name: /ガイドを作り直す/ }));
        expect(await screen.findByRole('alert')).toHaveTextContent('上限に達しました');
        expect(screen.getByText('テンポを合わせる')).toBeInTheDocument();
    });

    it('1 日の上限を設定で変えられる', async () => {
        stubFetch(async (url, init) => {
            if (url === '/api/settings/guide') {
                const limit = JSON.parse(init?.body as string).daily_limit_calls;
                return Response.json({ settings: { daily_limit_calls: limit }, today: { ...today, limit_calls: limit } });
            }
            return Response.json({ saved: false, chart_id: 'demo', focus: null, today });
        });
        render(<DawProvider><Loader /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'API キーと上限の設定' }));
        fireEvent.change(screen.getByLabelText('1 日に Claude を呼ぶ回数の上限'), { target: { value: '5' } });
        fireEvent.click(screen.getByRole('button', { name: '上限を変える' }));
        expect(await screen.findByText('1 日の上限を 5 回にしました')).toBeInTheDocument();
        expect(document.getElementById('guide-today')).toHaveTextContent('上限 5 回');
        // 空にして押すと上限なし
        fireEvent.click(screen.getByRole('button', { name: '上限を変える' }));
        expect(await screen.findByText('1 日の上限を無しにしました')).toBeInTheDocument();
        expect(document.getElementById('guide-today')).toHaveTextContent('上限なし');
    });
});

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
        await waitFor(() => expect(posts()).toHaveLength(1));
        expect((posts()[0][1].body as FormData).get('focus')).toBe('S2');
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
        fireEvent.click(screen.getByRole('button', { name: 'API キーと上限の設定' }));
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
