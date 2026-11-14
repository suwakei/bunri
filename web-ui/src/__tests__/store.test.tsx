/**
 * DawProvider / useDaw ストアのテスト
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// AudioContext モック（engine.ts が使用）
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

const { DawProvider, useDaw } = await import('../lib/store');

// テスト用コンシューマーコンポーネント
function TestConsumer() {
    const { status, setStatus, bpm, setBpm, showGuide, closeGuide, isPlaying } = useDaw();
    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="bpm">{bpm}</span>
            <span data-testid="guide">{showGuide ? 'open' : 'closed'}</span>
            <span data-testid="playing">{isPlaying ? 'yes' : 'no'}</span>
            <button data-testid="set-status" onClick={() => setStatus('テスト中')}>set status</button>
            <button data-testid="set-bpm" onClick={() => setBpm(140)}>set bpm</button>
            <button data-testid="close-guide" onClick={closeGuide}>close guide</button>
        </div>
    );
}

describe('DawProvider / useDaw', () => {
    beforeEach(() => {
        cleanup();
    });

    it('初期値が正しい', () => {
        render(<DawProvider><TestConsumer /></DawProvider>);
        expect(screen.getByTestId('status').textContent).toBe('準備完了');
        expect(screen.getByTestId('bpm').textContent).toBe('120');
        expect(screen.getByTestId('playing').textContent).toBe('no');
    });

    it('setStatus でステータス更新', async () => {
        render(<DawProvider><TestConsumer /></DawProvider>);
        await userEvent.click(screen.getByTestId('set-status'));
        expect(screen.getByTestId('status').textContent).toBe('テスト中');
    });

    it('setBpm でBPM更新', async () => {
        render(<DawProvider><TestConsumer /></DawProvider>);
        await userEvent.click(screen.getByTestId('set-bpm'));
        expect(screen.getByTestId('bpm').textContent).toBe('140');
    });

    it('closeGuide でガイドを閉じる', async () => {
        // localStorage をクリアして showGuide = true にする
        localStorage.removeItem('bunri-guide-seen');
        render(<DawProvider><TestConsumer /></DawProvider>);
        expect(screen.getByTestId('guide').textContent).toBe('open');
        await userEvent.click(screen.getByTestId('close-guide'));
        expect(screen.getByTestId('guide').textContent).toBe('closed');
        expect(localStorage.getItem('bunri-guide-seen')).toBe('1');
    });

    it('DawProvider の外で useDaw を呼ぶとエラー', () => {
        expect(() => render(<TestConsumer />)).toThrow('useDaw must be used within DawProvider');
    });
});

describe('グリッドと左パネルの状態', () => {
    beforeEach(() => { cleanup(); localStorage.clear(); });

    const chart = {
        version: 1, source: { filename: 'x.wav', duration_sec: 10 },
        grid: { bpm: 123.0469, bpm_confidence: 0.9, bpm_source: 'auto', downbeat_offset_sec: 0.75, time_signature: [3, 4], beat_times_sec: [0.75], user_confirmed: false },
        key: { tonic: null, mode: null, confidence: 0, alternatives: [] }, sections: [], chords: [],
        mix: { loudness_lufs: null, peak_dbfs: null, dynamic_range_db: null, stereo_width: null, bass_mono: null, reverb_tail_sec: null, spectrum_bands: [] },
        unavailable: {},
    } as unknown as import('../lib/chart').SongChart;

    function Grid() {
        const { bpm, setBpm, beatsPerBar, gridOffset, applyChartGrid, leftTab, learnTab, leftWidth, setLeftWidth } = useDaw();
        return (
            <div>
                <span data-testid="grid">{bpm}/{beatsPerBar}/{gridOffset}</span>
                <span data-testid="tabs">{leftTab}/{learnTab}/{leftWidth}</span>
                <button onClick={() => setBpm('97.333')}>bpm</button>
                <button onClick={() => applyChartGrid(chart)}>apply</button>
                <button onClick={() => applyChartGrid(chart, { force: true })}>force</button>
                <button onClick={() => setLeftWidth(9999)}>wide</button>
            </div>
        );
    }

    it('起動したときは「学ぶ」タブの「曲とパート」', () => {
        render(<DawProvider><Grid /></DawProvider>);
        expect(screen.getByTestId('tabs').textContent).toBe('learn/song/300');
    });

    it('BPM は小数も持つ (小数 2 桁)', async () => {
        render(<DawProvider><Grid /></DawProvider>);
        await userEvent.click(screen.getByText('bpm'));
        expect(screen.getByTestId('grid').textContent).toBe('97.33/4/0');
    });

    it('カルテのグリッド (テンポ・拍子・1 拍目の位置) を、プロジェクトと再生エンジンに当てる', async () => {
        const engine = (await import('../lib/engine')).default;
        engine.tracks = [];
        render(<DawProvider><Grid /></DawProvider>);
        await userEvent.click(screen.getByText('apply'));
        expect(screen.getByTestId('grid').textContent).toBe('123.05/3/0.75');
        expect([engine.bpm, engine.beatsPerBar, engine.gridOffset]).toEqual([123.05, 3, 0.75]);
    });

    it('お手本 (パートのトラック) が在るときは当てない。分け直すとき (force) だけ当てる', async () => {
        const engine = (await import('../lib/engine')).default;
        engine.init();
        engine.tracks = [];
        const part = engine.addTrack('ベース'); part.role = 'part';
        render(<DawProvider><Grid /></DawProvider>);
        await userEvent.click(screen.getByText('apply'));
        expect(screen.getByTestId('grid').textContent).toBe('120/4/0');
        await userEvent.click(screen.getByText('force'));
        expect(screen.getByTestId('grid').textContent).toBe('123.05/3/0.75');
        engine.tracks = [];
    });

    it('左パネルの幅は範囲に収め、この画面を開いた人ごとに覚える', async () => {
        render(<DawProvider><Grid /></DawProvider>);
        await userEvent.click(screen.getByText('wide'));
        expect(screen.getByTestId('tabs').textContent).toBe('learn/song/520');
        expect(localStorage.getItem('bunri-left-width')).toBe('520');
        cleanup();
        render(<DawProvider><Grid /></DawProvider>);
        expect(screen.getByTestId('tabs').textContent).toBe('learn/song/520');
    });
});
