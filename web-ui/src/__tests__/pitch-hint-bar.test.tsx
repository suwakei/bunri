/**
 * 「キーの音」「コードの音」の切り替え（components/PitchHintBar.tsx）の、押せないときの理由。
 * ほかの押せないボタンと同じく、理由を `data-blocked` に持ち、押すと知らせとして出す（lib/notice.ts の `blockedReason`）。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

class MockNode {
    gain = { value: 1 };
    pan = { value: 0 };
    connect() { return this; }
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockNode() as unknown as GainNode; }
    createStereoPanner() { return new MockNode() as unknown as StereoPannerNode; }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { default: engine } = await import('../lib/engine');
const { DawProvider } = await import('../lib/store');
const { blockedReason } = await import('../lib/notice');
const PitchHintBar = (await import('../components/PitchHintBar')).default;

beforeEach(() => {
    localStorage.clear();
    engine.init();
    engine.tracks = [];
});
afterEach(() => cleanup());

describe('押せないときの理由', () => {
    it('カルテが無いと、2 つとも押せず、押すと出る理由 (data-blocked) を持つ', () => {
        const track = engine.addTrack('Track 1');
        render(<DawProvider><PitchHintBar activeTrackId={track.id} /></DawProvider>);
        const key = screen.getByRole('button', { name: 'キーの音' });
        const chord = screen.getByRole('button', { name: 'コードの音' });
        expect(key).toBeDisabled();
        expect(chord).toBeDisabled();
        expect(key).toHaveAttribute('data-blocked', expect.stringContaining('曲を取り込んでカルテを作ると'));
        expect(chord).toHaveAttribute('data-blocked', expect.stringContaining('曲を取り込んでカルテを作ると'));
        // 押したときの知らせは、説明の頭に「いまは使えません。」を付けたものではなく、理由そのもの
        expect(blockedReason(key)).toBe(key.getAttribute('data-blocked'));
    });
});
