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
    const { status, setStatus, bpm, setBpm, hint, setHint, showGuide, closeGuide, isPlaying } = useDaw();
    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="bpm">{bpm}</span>
            <span data-testid="hint">{hint}</span>
            <span data-testid="guide">{showGuide ? 'open' : 'closed'}</span>
            <span data-testid="playing">{isPlaying ? 'yes' : 'no'}</span>
            <button data-testid="set-status" onClick={() => setStatus('テスト中')}>set status</button>
            <button data-testid="set-bpm" onClick={() => setBpm(140)}>set bpm</button>
            <button data-testid="set-hint" onClick={() => setHint('ヒント')}>set hint</button>
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
        expect(screen.getByTestId('hint').textContent).toBe('');
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

    it('setHint でヒント更新', async () => {
        render(<DawProvider><TestConsumer /></DawProvider>);
        await userEvent.click(screen.getByTestId('set-hint'));
        expect(screen.getByTestId('hint').textContent).toBe('ヒント');
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
