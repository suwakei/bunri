/**
 * 楽曲カルテ（第1層）のヘルパーと表示のテスト
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// AudioContext モック（store が engine を読み込むため）
class MockGainNode {
    gain = { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    connect() { return this; }
}
class MockStereoPannerNode {
    pan = { value: 0 };
    connect() { return this; }
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return new MockStereoPannerNode() as unknown as StereoPannerNode; }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const {
    confidenceTier, formatTime, isChartResponse, secondsToBarBeat, tempoCandidates, TIER_DISPLAY,
} = await import('../lib/chart');
type SongChart = import('../lib/chart').SongChart;
type ChartGrid = import('../lib/chart').ChartGrid;

const { DawProvider, useDaw } = await import('../lib/store');
const ChartPanel = (await import('../components/ChartPanel')).default;
const StatusBar = (await import('../components/StatusBar')).default;

/** テスト用のカルテ */
function makeChart(overrides: Partial<SongChart> = {}): SongChart {
    return {
        version: 1,
        source: { filename: 'demo.wav', duration_sec: 125 },
        grid: {
            bpm: 120, bpm_confidence: 0.9, bpm_source: 'auto',
            downbeat_offset_sec: 0.35, time_signature: [4, 4],
            beat_times_sec: [0.35, 0.85, 1.35, 1.85, 2.35], user_confirmed: false,
        },
        key: {
            tonic: 'C', mode: 'major', confidence: 0.85,
            alternatives: [{ tonic: 'A', mode: 'minor', confidence: 0.6 }],
        },
        sections: [{
            id: 'S1', label: null, suggested_label: 'intro', suggested_confidence: 0.5,
            start_bar: 1, end_bar: 4, start_sec: 0.35, end_sec: 8.35,
            repeat_group: 'A', features: { rms_db: -18, onset_density: 3 },
        }],
        chords: [{
            bar: 1, beat: 1, beat_index: 0, beat_count: 4,
            start_sec: 0.35, end_sec: 2.35, root: 'C', quality: 'maj',
            symbol: 'C', degree: 'I', confidence: 0.88,
        }],
        mix: {
            loudness_lufs: -8.2, peak_dbfs: -0.3, dynamic_range_db: 6.1,
            stereo_width: 0.62, bass_mono: true, reverb_tail_sec: 1.4,
            spectrum_bands: [{ name: 'low', hz: [60, 250], energy_db: -14 }],
        },
        unavailable: {},
        ...overrides,
    };
}

/** カルテを流し込んだ状態で子を描画するヘルパー */
function ChartLoader({ chart }: { chart: SongChart | null }) {
    const { setChartResult } = useDaw();
    if (chart && !loaded.has(chart)) {
        loaded.add(chart);
        setChartResult({
            chart_id: 'demo',
            chart,
            // 本番の GLOSSARY と同じキーを持たせる（Term が包むかどうかが変わるため）
            glossary: {
                bpm: { ja: 'テンポ。1分間に刻まれる拍の数。' },
                key: { ja: '曲全体の中心となる音。' },
                major: { ja: '長調。明るい響き。' },
                minor: { ja: '短調。暗い響き。' },
                confidence: { ja: '解析結果の確からしさ。' },
                degree: { ja: 'ディグリー。キーから見た度数。' },
                chord: { ja: '複数の音を同時に鳴らした和音。' },
                section: { ja: '曲の構成上のまとまり。' },
                repeat_group: { ja: '似た内容で繰り返される区間。' },
                time_signature: { ja: '拍子。1小節に何拍入るか。' },
                downbeat_offset: { ja: '曲の1拍目が始まる位置。' },
                beat: { ja: '拍。' },
                loudness_lufs: { ja: '体感的な音の大きさ。' },
                peak_dbfs: { ja: '波形の最大値。' },
                dynamic_range_db: { ja: '曲中の音量の幅。' },
                stereo_width: { ja: '音の左右の広がり。' },
                bass_mono: { ja: '低音が中央にまとまっているか。' },
                reverb_tail_sec: { ja: '残響の長さ。' },
                spectrum_bands: { ja: '帯域ごとのエネルギー配分。' },
            },
        });
    }
    return <ChartPanel />;
}
const loaded = new WeakSet<SongChart>();

function renderChart(chart: SongChart | null, withStatusBar = false) {
    return render(
        <DawProvider>
            <ChartLoader chart={chart} />
            {withStatusBar && <StatusBar />}
        </DawProvider>
    );
}

describe('isChartResponse', () => {
    it('カルテの API の結果の形なら true', () => {
        expect(isChartResponse({ chart_id: 'demo', chart: makeChart(), glossary: {} })).toBe(true);
    });

    it('カルテの入っていない結果 (e2e の遅いジョブの結果など)・グリッドの欠けたカルテ・空は false', () => {
        expect(isChartResponse({ ok: true, kind: 'chart', filename: 'e2e-card.wav' })).toBe(false);
        expect(isChartResponse({ chart_id: 'demo', chart: { ...makeChart(), grid: undefined } })).toBe(false);
        expect(isChartResponse({ chart_id: 'demo', chart: { ...makeChart(), chords: null } })).toBe(false);
        expect(isChartResponse(null)).toBe(false);
        expect(isChartResponse(undefined)).toBe(false);
        expect(isChartResponse('chart')).toBe(false);
    });
});

describe('confidenceTier', () => {
    it.each([
        [1.0, 'certain'], [0.7, 'certain'],
        [0.69, 'likely'], [0.4, 'likely'],
        [0.39, 'unsure'], [0, 'unsure'],
        [null, 'unsure'], [undefined, 'unsure'],
    ])('%s は %s になる', (value, expected) => {
        expect(confidenceTier(value as number | null)).toBe(expected);
    });

    it('バックエンドと同じ3段階を持つ', () => {
        expect(Object.keys(TIER_DISPLAY).sort()).toEqual(['certain', 'likely', 'unsure']);
    });
});

describe('formatTime', () => {
    it.each([[0, '0:00'], [59, '0:59'], [60, '1:00'], [125, '2:05']])(
        '%s秒 → %s', (sec, expected) => expect(formatTime(sec)).toBe(expected));

    it('負の値でも壊れない', () => expect(formatTime(-5)).toBe('0:00'));
});

describe('secondsToBarBeat', () => {
    const grid: ChartGrid = {
        bpm: 120, bpm_confidence: 1, bpm_source: 'auto',
        downbeat_offset_sec: 0, time_signature: [4, 4],
        beat_times_sec: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5],
        user_confirmed: true,
    };

    it('最初の拍は1小節1拍目', () => expect(secondsToBarBeat(0, grid)).toEqual({ bar: 1, beat: 1 }));
    it('3拍目を正しく引く', () => expect(secondsToBarBeat(1.1, grid)).toEqual({ bar: 1, beat: 3 }));
    it('2小節目に入る', () => expect(secondsToBarBeat(2.1, grid)).toEqual({ bar: 2, beat: 1 }));
    it('ビート列が空なら null', () => {
        expect(secondsToBarBeat(1, { ...grid, beat_times_sec: [] })).toBeNull();
    });
});

describe('tempoCandidates', () => {
    it('いまのテンポの半分と倍を、整数に丸めて出す', () => {
        expect(tempoCandidates(120)).toEqual({ half: 60, double: 240 });
        expect(tempoCandidates(119.95)).toEqual({ half: 60, double: 240 });
        expect(tempoCandidates(87.5)).toEqual({ half: 44, double: 175 });
    });

    it('ほとんどの曲が収まる範囲 (40〜250 BPM) の外になる候補は出さない', () => {
        // 164 は 82 の倍に読み取られた形。328 は候補にしない
        expect(tempoCandidates(164)).toEqual({ half: 82, double: null });
        // 60 は 120 の半分に読み取られた形。30 は候補にしない
        expect(tempoCandidates(60)).toEqual({ half: null, double: 120 });
        expect(tempoCandidates(80)).toEqual({ half: 40, double: 160 });
        expect(tempoCandidates(125)).toEqual({ half: 63, double: 250 });
    });

    it('テンポが出ていないときは、候補も無い', () => {
        expect(tempoCandidates(0)).toEqual({ half: null, double: null });
        expect(tempoCandidates(Number.NaN)).toEqual({ half: null, double: null });
    });
});

/** グリッドの確認・補正の窓が開いているかを出す（窓そのものは描かない） */
function GridEditorProbe() {
    const { showGridEditor } = useDaw();
    return <div data-testid="grid-editor-open">{showGridEditor ? 'open' : 'closed'}</div>;
}

describe('ChartPanel', () => {
    beforeEach(() => cleanup());

    it('カルテ未取得なら、曲を取り込むよう案内する', () => {
        render(<DawProvider><ChartPanel /></DawProvider>);
        expect(screen.getByText(/まだ解析していません/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '曲を取り込む' })).toBeInTheDocument();
    });

    it('コードの升目を押すと、カルテの実測のビート列で引いたその小節の頭へ、再生位置が移る', async () => {
        const engine = (await import('../lib/engine')).default;
        engine.init();
        renderChart(makeChart(), true);
        fireEvent.click(screen.getByRole('button', { name: /^1 小節: C/ }));
        // カルテの 1 小節目は 1 拍目の位置 (0.35 秒) から
        expect(engine.playOffset).toBeCloseTo(0.35, 5);
        expect(screen.getByRole('status')).toHaveTextContent('1 小節（C）へ移動しました');
        // 構成の行を押すと、区間の頭へ
        engine.playOffset = 0;
        fireEvent.click(screen.getByRole('button', { name: /1〜4 小節の区間/ }));
        expect(engine.playOffset).toBeCloseTo(0.35, 5);
    });

    it('キーとBPMを表示する', () => {
        renderChart(makeChart());
        expect(screen.getByText('120.0')).toBeInTheDocument();
        // キーは「C メジャー」として1箇所に出る
        expect(screen.getByText('メジャー')).toBeInTheDocument();
    });

    it('確信度を数値ではなく段階で表示する', () => {
        renderChart(makeChart());
        // 0.85 や 0.9 といった生値は画面に出さない
        expect(screen.queryByText(/0\.85/)).not.toBeInTheDocument();
        expect(screen.getAllByText('確実').length).toBeGreaterThan(0);
    });

    it('コードにディグリー表記を併記する', () => {
        renderChart(makeChart());
        // "C" はキー表示とコード名の両方に出るので複数一致で構わない
        expect(screen.getAllByText('C').length).toBeGreaterThanOrEqual(1);
        // ディグリーはキーから見た度数として併記される
        expect(screen.getByText('I')).toBeInTheDocument();
    });

    it('コードの確信度は数値ではなく枠線の色で示す', () => {
        renderChart(makeChart());
        expect(screen.queryByText(/0\.88/)).not.toBeInTheDocument();
    });

    it('セクションのラベルは提案として疑問符付きで出す', () => {
        renderChart(makeChart());
        // 区間の行そのものと、下部の注意書きの両方に現れる
        expect(screen.getAllByText(/イントロ？/).length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText(/確定ではありません/)).toBeInTheDocument();
    });

    it('セクションのラベルを確定済みとして扱わない', () => {
        renderChart(makeChart());
        // label は null のままで、確定ラベルとしては描画されない
        expect(screen.queryByText('イントロ')).not.toBeInTheDocument();
    });

    it('検出できなかった項目は理由を出し、値を出さない', () => {
        renderChart(makeChart({
            key: { tonic: null, mode: null, confidence: 0, alternatives: [] },
            chords: [],
            unavailable: {
                key: 'キーを判定できませんでした（無調の可能性があります）',
                chords: 'コードを検出できませんでした',
            },
        }));
        expect(screen.getByText(/キーを判定できませんでした/)).toBeInTheDocument();
        expect(screen.getByText(/コードを検出できませんでした/)).toBeInTheDocument();
    });

    it('グリッド未確定なら注意を促す', () => {
        renderChart(makeChart());
        expect(screen.getByText(/コードも構成も全部ずれます/)).toBeInTheDocument();
    });

    it('グリッド確定済みなら注意は出さない', () => {
        const chart = makeChart();
        chart.grid.user_confirmed = true;
        renderChart(chart);
        expect(screen.queryByText(/コードも構成も全部ずれます/)).not.toBeInTheDocument();
    });

    it('BPM の下に、倍・半分の候補を実際の BPM から計算して出す', () => {
        const chart = makeChart();
        chart.grid.bpm = 180;
        renderChart(chart);
        const hint = document.querySelector('#tempo-hint')!;
        // 180 の倍 (360) は範囲の外なので、半分だけ
        expect(hint).toHaveTextContent('このテンポが速すぎると感じたら、90 かもしれません。');
        cleanup();
        renderChart(makeChart());
        expect(document.querySelector('#tempo-hint')).toHaveTextContent(
            'このテンポが速すぎると感じたら 60、遅すぎると感じたら 240 かもしれません。');
    });

    it('倍・半分の候補は、確信度が「確実」でも「自信なし」でも出す', () => {
        for (const confidence of [0.95, 0.1]) {
            const chart = makeChart();
            chart.grid.bpm_confidence = confidence;
            renderChart(chart);
            expect(document.querySelector('#tempo-hint')).toHaveTextContent('60');
            cleanup();
        }
    });

    it('「波形で確かめる」を押すと、グリッドの確認・補正の窓が開く。説明は data-tip で付け、title は使わない', () => {
        render(
            <DawProvider>
                <ChartLoader chart={makeChart()} />
                <GridEditorProbe />
            </DawProvider>
        );
        expect(screen.getByTestId('grid-editor-open')).toHaveTextContent('closed');
        const button = screen.getByRole('button', { name: '波形で確かめる' });
        expect(button.getAttribute('data-tip')).toMatch(/倍や半分に読み取られることがあります/);
        expect(button).not.toHaveAttribute('title');
        fireEvent.click(button);
        expect(screen.getByTestId('grid-editor-open')).toHaveTextContent('open');
    });

    it('利用者がグリッドを確定した後と、グリッドを検出できなかったときは、倍・半分の候補を出さない', () => {
        const confirmed = makeChart();
        confirmed.grid.user_confirmed = true;
        confirmed.grid.bpm_source = 'user';
        renderChart(confirmed);
        expect(document.querySelector('#tempo-hint')).toBeNull();
        // 確かめる窓への入口 (もとからのボタン) は残る
        expect(screen.getByRole('button', { name: 'グリッドを確認・補正する' })).toBeInTheDocument();
        cleanup();
        renderChart(makeChart({ unavailable: { grid: 'テンポを検出できませんでした' } }));
        expect(document.querySelector('#tempo-hint')).toBeNull();
    });

    it('用語には、辞書の解説をツールチップとして付ける（ツールチップ義務化）', () => {
        renderChart(makeChart(), true);
        // 表示そのものは components/Tooltip.tsx (画面全体で 1 つ) が受け持つ。ここでは説明が付いていることを見る
        expect(screen.getByText('BPM').closest('[data-tip]')?.getAttribute('data-tip')).toMatch(/1分間に刻まれる拍の数/);
    });

    it('モノラル音源ではステレオ項目を出さない', () => {
        const chart = makeChart();
        chart.mix.stereo_width = null;
        chart.mix.bass_mono = null;
        renderChart(chart);
        expect(screen.queryByText('ステレオ幅')).not.toBeInTheDocument();
        expect(screen.queryByText('低音の定位')).not.toBeInTheDocument();
    });
});
