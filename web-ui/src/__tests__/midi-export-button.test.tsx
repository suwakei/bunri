/**
 * ヘッダの「MIDI」ボタンのテスト。
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

class MockGainNode {
    gain = { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    connect() { return this; }
    disconnect() {}
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return { pan: { value: 0 }, connect() { return this; }, disconnect() {} } as unknown as StereoPannerNode; }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { DawProvider } = await import('../lib/store');
const engine = (await import('../lib/engine')).default;
const HeaderBar = (await import('../components/HeaderBar')).default;
const StatusBar = (await import('../components/StatusBar')).default;

let created: Blob[];

beforeEach(() => {
    created = [];
    vi.stubGlobal('URL', Object.assign(URL, {
        createObjectURL: vi.fn((blob: Blob) => { created.push(blob); return 'blob:mock'; }),
        revokeObjectURL: vi.fn(),
    }));
    // jsdom はリンクのクリックで画面遷移を試みるので、何もしないようにする
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    engine.init();
    engine.tracks.length = 0;
});

afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
});

describe('MIDI 書き出しボタン', () => {
    it('ノートが無ければ書き出さず、理由を出す', () => {
        engine.addTrack('Piano');
        render(<DawProvider><HeaderBar /><StatusBar /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'MIDI 書き出し' }));
        expect(created).toHaveLength(0);
        expect(screen.getByText(/書き出すノートがありません/)).toBeInTheDocument();
    });

    it('ノートが在れば MIDI ファイルを作ってダウンロードさせる', async () => {
        const track = engine.addTrack('Piano');
        track.pianoNotes = [{ note: 'C', octave: 4, step: 0, length: 4 }];
        render(<DawProvider><HeaderBar /><StatusBar /></DawProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'MIDI 書き出し' }));
        expect(created).toHaveLength(1);
        expect(created[0].type).toBe('audio/midi');
        const head = new Uint8Array(await created[0].arrayBuffer()).slice(0, 4);
        expect(String.fromCharCode(...head)).toBe('MThd');
        expect(screen.getByText('MIDI ファイルを書き出しました')).toBeInTheDocument();
    });
});
