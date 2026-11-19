/**
 * 再現ガイド（第2層）のテスト: API 呼び出しのヘルパーと、パネルの表示。
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
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
const { guideRequestText } = await import('../lib/guide');
const { DawProvider, useDaw } = await import('../lib/store');
const GuidePanel = (await import('../components/GuidePanel')).default;
const { GuideCardView } = await import('../components/AssistantCards');
const { guideCardOf } = await import('../lib/assistant-cards');
const { assistantSession } = await import('../lib/assistant');
type DawContextType = import('../lib/store').DawContextType;
type AssistantDeps = import('../lib/assistant').AssistantDeps;

/** アシスタントの入口（偽物）。このファイルの依頼は、ツールを呼ばない応答で終わる。 */
const fakeDeps: AssistantDeps = {
    env: {} as AssistantDeps['env'],
    beginEdit: () => () => false,
    topUndoId: () => null,
    suggestionFacts: () => ({
        trackCount: 0, imported: false, hasChart: false, separated: false, practiced: false,
        practiceOpen: false, selectedNotes: 0, openTrackHasNotes: false, jobRunning: false,
    }),
};

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

    it('モデルは、指定したときだけ送る（アシスタントの依頼で選んだモデル）', async () => {
        stubFetch(async () => Response.json(response));
        await requestGuide('demo', null);
        await requestGuide('demo', null, false, 'claude-sonnet-5-5');
        const bodies = fetchMock.mock.calls.map((call) => (call as [string, RequestInit])[1].body as FormData);
        expect(bodies[0].has('model')).toBe(false);
        expect(bodies[1].get('model')).toBe('claude-sonnet-5-5');
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

/** ドックのかわりに、アシスタントの入口を置き、ストアを外から読めるようにする。 */
function AskHarness({ expose }: { expose: (daw: DawContextType) => void }) {
    const daw = useDaw();
    expose(daw);
    useEffect(() => assistantSession.attach(fakeDeps), []);
    return null;
}

/** 送られた依頼の文（`/api/assistant/step` の最後の user の文）。 */
function askedTexts(): string[] {
    return (fetchMock.mock.calls as [string, RequestInit | undefined][])
        .filter(([url]) => url === '/api/assistant/step')
        .map(([, init]) => {
            const messages = JSON.parse(String(init?.body)).messages as { role: string; content: { type: string; text?: string }[] }[];
            const users = messages.filter((m) => m.role === 'user');
            return users[users.length - 1].content.find((b: { type: string; text?: string }) => b.type === 'text')!.text!;
        });
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

describe('GuidePanel: アシスタントに頼む入口', () => {
    beforeEach(() => {
        cleanup();
        assistantSession.reset();
        stubFetch(async (url) => {
            if (url === '/api/assistant/step') return Response.json({ content: [{ type: 'text', text: 'どうぞ。' }], stop_reason: 'end_turn', model: 'claude-haiku-5-5', cost_usd: 0.001 });
            return Response.json({ saved: false, chart_id: 'demo', focus: null, today });
        });
    });

    it('カルテが無ければ、先に曲を取り込むよう案内する (頼むボタンは出さない)', () => {
        render(<DawProvider><GuidePanel /></DawProvider>);
        expect(screen.getByText(/先に曲を取り込んでください/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /ガイドを頼む/ })).not.toBeInTheDocument();
    });

    it('押すとドックが開き、曲全体の依頼が送られる。パネル自身は Claude を呼ばず、設定の欄も持たない', async () => {
        const ref: { daw: DawContextType | null } = { daw: null };
        render(<DawProvider><AskHarness expose={(daw) => { ref.daw = daw; }} /><Loader /></DawProvider>);
        expect(screen.queryByRole('button', { name: 'API キーと上限の設定' })).not.toBeInTheDocument();
        expect(screen.getByText(/Anthropic の Claude に送ります。音声は送りません。ファイル名も送りません/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'アシスタントにガイドを頼む' }));
        expect(ref.daw!.assistantOpen).toBe(true);
        await waitFor(() => expect(askedTexts()).toEqual(['再現ガイドを作って']));
        // ガイドの API は、パネルからは呼ばない (作るのはアシスタントのツール)
        expect((fetchMock.mock.calls as [string][]).some(([url]) => /\/guide/.test(url))).toBe(false);
        await waitFor(() => expect(assistantSession.getState().running).toBe(false));
    });

    it('区間を選んでいれば、その名前と小節の範囲を入れて頼む', async () => {
        render(<DawProvider><AskHarness expose={() => {}} /><Loader /></DawProvider>);
        fireEvent.change(screen.getByLabelText('対象'), { target: { value: 'S2' } });
        fireEvent.click(screen.getByRole('button', { name: 'アシスタントにガイドを頼む' }));
        await waitFor(() => expect(askedTexts()).toEqual(['「サビ」（5〜8 小節）の再現ガイドを作って']));
        await waitFor(() => expect(assistantSession.getState().running).toBe(false));
    });

    it('guideRequestText: 名前の無い区間は ID で呼ぶ。知らない区間は曲全体', () => {
        const unnamed = { ...chart, sections: [{ ...chart.sections[0], suggested_label: null }] } as SongChart;
        expect(guideRequestText(unnamed, 'S1')).toBe('「区間 S1」（1〜4 小節）の再現ガイドを作って');
        expect(guideRequestText(chart, 'zz')).toBe('再現ガイドを作って');
        expect(guideRequestText(chart, '')).toBe('再現ガイドを作って');
    });
});

describe('再現ガイドのカード（アシスタントのチャット）', () => {
    beforeEach(() => cleanup());

    /** カルテを流し込んでから、カードを描画する */
    function CardLoader({ resp, target = '曲全体' }: { resp: GuideResponse; target?: string }) {
        const { chart: current, setChartResult } = useDaw();
        if (!current) setChartResult({ chart_id: 'demo', chart, glossary: {} });
        return <GuideCardView card={guideCardOf(resp, chart, target)} />;
    }

    it('手順・場所・注意を表示する。場所の名前は、作ったときのカルテで決める', () => {
        render(<DawProvider><CardLoader resp={response} /></DawProvider>);
        expect(screen.getByText('テンポを合わせる')).toBeInTheDocument();
        expect(screen.getByText(/キーは C メジャー/)).toBeInTheDocument();
        expect(screen.getByText('I → V → vi → IV の進行です。')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '1 小節 1 拍目' })).toBeInTheDocument();
        expect(document.querySelectorAll('.guide-ref')[1]).toHaveTextContent('サビ（5〜8 小節）');
        expect(screen.getByText('4 小節目のコードは確信度が低めです。')).toBeInTheDocument();
        expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    it('場所を押すと、そこへ移動したと知らせる', async () => {
        const ref: { daw: DawContextType | null } = { daw: null };
        render(<DawProvider><AskHarness expose={(daw) => { ref.daw = daw; }} /><CardLoader resp={response} /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'サビ（5〜8 小節）' }));
        await waitFor(() => expect(ref.daw!.status).toBe('サビ（5〜8 小節） へ移動しました'));
    });

    it('カルテに無い語が説明に含まれていたら、推測かもしれないと伝える', () => {
        render(<DawProvider><CardLoader resp={{ ...response, guide: { ...response.guide, unverified_terms: ['Dm7', 'E4'] } }} /></DawProvider>);
        const note = screen.getByRole('note');
        expect(note).toHaveTextContent('Dm7、E4');
        expect(note).toHaveTextContent('モデルの推測かもしれません');
    });

    it('作ったときのモデル・トークン数・概算の費用を見せる。保存済みを出しただけなら、Claude を呼んでいないと添える', () => {
        render(<DawProvider><CardLoader resp={made} /></DawProvider>);
        const usage = screen.getByText(/このガイドを作ったときの使用量/);
        expect(usage).toHaveTextContent('入力 5,312 トークン（うち 5,300 はキャッシュから）');
        expect(usage).toHaveTextContent('出力 4,200 トークン');
        expect(usage).toHaveTextContent('概算 $0.09');
        expect(screen.getByText(/作成: Opus/)).toBeInTheDocument();
        cleanup();
        render(<DawProvider><CardLoader resp={{ ...made, cached: true }} /></DawProvider>);
        expect(screen.getByText(/保存済みのガイドを出しました（Claude は呼んでいません。作ったときは概算 \$0.09）/)).toBeInTheDocument();
        expect(screen.queryByText(/このガイドを作ったときの使用量/)).not.toBeInTheDocument();
    });

    it('単価が分からないモデルでは、費用を出さずトークン数だけ見せる', () => {
        render(<DawProvider><CardLoader resp={{ ...made, cost_usd: null }} /></DawProvider>);
        expect(screen.getByText(/このガイドを作ったときの使用量/)).not.toHaveTextContent('概算');
    });
});
