/**
 * React コンポーネントの描画テスト
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// AudioContext モック
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

const { DawProvider } = await import('../lib/store');
const StatusBar = (await import('../components/StatusBar')).default;
const WelcomeGuide = (await import('../components/WelcomeGuide')).default;

function renderWithDaw(ui: React.ReactElement) {
    return render(<DawProvider>{ui}</DawProvider>);
}

describe('StatusBar', () => {
    beforeEach(() => cleanup());
    it('ステータスとヒントを表示', () => {
        renderWithDaw(<StatusBar />);
        expect(screen.getByText('準備完了')).toBeInTheDocument();
    });
});

describe('WelcomeGuide', () => {
    beforeEach(() => cleanup());
    it('初回表示時にガイドモーダルが表示される', () => {
        localStorage.removeItem('bunri-guide-seen');
        renderWithDaw(<WelcomeGuide />);
        expect(screen.getByText('bunri DAW へようこそ')).toBeInTheDocument();
        expect(screen.getByText('はじめる')).toBeInTheDocument();
    });

    it('ガイド済みの場合は非表示', () => {
        localStorage.setItem('bunri-guide-seen', '1');
        renderWithDaw(<WelcomeGuide />);
        expect(screen.queryByText('bunri DAW へようこそ')).not.toBeInTheDocument();
    });

    it('5つのステップが表示される', () => {
        localStorage.removeItem('bunri-guide-seen');
        renderWithDaw(<WelcomeGuide />);
        expect(screen.getByText('音声を追加する')).toBeInTheDocument();
        expect(screen.getByText('音を作る')).toBeInTheDocument();
        expect(screen.getByText('ドラムを追加する')).toBeInTheDocument();
        expect(screen.getByText('タイムラインで配置する')).toBeInTheDocument();
        expect(screen.getByText('再生・書き出し')).toBeInTheDocument();
    });
});

describe('ToolsPage', () => {
    beforeEach(() => cleanup());
    it('タブとナビゲーションが表示される', async () => {
        const ToolsPage = (await import('../pages/ToolsPage')).default;
        render(<MemoryRouter><ToolsPage /></MemoryRouter>);
        expect(screen.getByText('bunri ツール')).toBeInTheDocument();
        expect(screen.getByText('音源分離')).toBeInTheDocument();
        expect(screen.getByText('解析')).toBeInTheDocument();
        expect(screen.getByText('編集')).toBeInTheDocument();
        expect(screen.getByText('エフェクト')).toBeInTheDocument();
        expect(screen.getByText('一括編集')).toBeInTheDocument();
        expect(screen.getByText('音源合成')).toBeInTheDocument();
        expect(screen.getByText('変換')).toBeInTheDocument();
    });

    it('DAWに戻るリンクがある', async () => {
        const ToolsPage = (await import('../pages/ToolsPage')).default;
        render(<MemoryRouter><ToolsPage /></MemoryRouter>);
        expect(screen.getByText('DAWに戻る')).toBeInTheDocument();
    });
});

describe('HelpPage', () => {
    beforeEach(() => cleanup());
    it('ヘルプページのセクションが表示される', async () => {
        const HelpPage = (await import('../pages/HelpPage')).default;
        render(<MemoryRouter><HelpPage /></MemoryRouter>);
        expect(screen.getByText('bunri DAW 使い方ガイド')).toBeInTheDocument();
        // 目次とセクション見出しで複数マッチするため getAllByText を使用
        expect(screen.getAllByText('画面の構成').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('クイックスタート').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('キーボードショートカット').length).toBeGreaterThanOrEqual(1);
    });
});
