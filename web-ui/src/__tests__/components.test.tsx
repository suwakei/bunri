/**
 * React コンポーネントの描画テスト
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
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

const { DawProvider, useDaw } = await import('../lib/store');
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
        // 普段の知らせは、読み上げを急がせない (role="status")
        expect(screen.getByRole('status')).toHaveTextContent('準備完了');
    });

    it('失敗の知らせは、色を変えて、読み上げの対象 (role="alert") にする', () => {
        function Fail() {
            const { setStatus } = useDaw();
            return (
                <>
                    <button onClick={() => setStatus('保存できませんでした', 'error')}>失敗</button>
                    <button onClick={() => setStatus('保存しました')}>成功</button>
                </>
            );
        }
        renderWithDaw(<><Fail /><StatusBar /></>);
        fireEvent.click(screen.getByText('失敗'));
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('保存できませんでした');
        expect(alert).toHaveClass('error');
        // 長くて末尾が切れても、全文を読める
        expect(alert).toHaveAttribute('data-tip', '保存できませんでした');
        // 次の知らせが失敗でなければ、元に戻る
        fireEvent.click(screen.getByText('成功'));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByRole('status')).not.toHaveClass('error');
    });

    it('時間のかかる処理が失敗すると、理由が失敗の知らせとして出る。処理中は showProgress が立つ', async () => {
        let release: (e: Error) => void = () => {};
        function Job() {
            const { withProgress, showProgress } = useDaw();
            return (
                <>
                    <button onClick={() => { void withProgress('処理しています…', () => new Promise<void>((_, reject) => { release = reject; })); }}>始める</button>
                    <span data-testid="busy">{showProgress ? 'busy' : 'idle'}</span>
                </>
            );
        }
        renderWithDaw(<><Job /><StatusBar /></>);
        fireEvent.click(screen.getByText('始める'));
        expect(screen.getByTestId('busy')).toHaveTextContent('busy');
        expect(screen.getByRole('status')).toHaveTextContent('処理しています…');
        await act(async () => { release(new Error('ファイルを読めませんでした')); });
        expect(screen.getByTestId('busy')).toHaveTextContent('idle');
        expect(screen.getByRole('alert')).toHaveTextContent('ファイルを読めませんでした');
        // 「エラー: 」を頭に付けない (色と role で失敗だと分かる)
        expect(screen.getByRole('alert').textContent).not.toMatch(/^エラー/);
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

    it('画面を覆う窓として組んであり、最初のフォーカスが「はじめる」に入る', () => {
        localStorage.removeItem('bunri-guide-seen');
        renderWithDaw(<WelcomeGuide />);
        const dialog = screen.getByRole('dialog', { name: 'bunri DAW へようこそ' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByRole('button', { name: 'はじめる' })).toHaveFocus();
    });

    it('Esc キーで閉じて、次からは出ない', () => {
        localStorage.removeItem('bunri-guide-seen');
        renderWithDaw(<WelcomeGuide />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(localStorage.getItem('bunri-guide-seen')).toBe('1');
    });

    it('学ぶ流れの 5 つの段階が、進み具合と同じ名前で表示される', () => {
        localStorage.removeItem('bunri-guide-seen');
        renderWithDaw(<WelcomeGuide />);
        for (const title of ['曲を取り込む', 'カルテを見る', 'パートに分ける', '打ち込む', '差分で直す']) {
            expect(screen.getByText(title)).toBeInTheDocument();
        }
        expect(document.querySelectorAll('.guide-step')).toHaveLength(5);
        // 使わないことば (答え・正解、「！」) が無い
        expect(document.body.textContent).not.toMatch(/答え|正解|！/);
    });
});

describe('ToolsPage', () => {
    beforeEach(() => cleanup());
    it('タブとナビゲーションが表示される', async () => {
        const ToolsPage = (await import('../pages/ToolsPage')).default;
        render(<MemoryRouter><ToolsPage /></MemoryRouter>);
        expect(screen.getByText('bunri ツール')).toBeInTheDocument();
        // 同じものを「パート」と呼ぶ (ステム / 完全分解 / 音源分離 を混ぜない)
        expect(screen.getByRole('button', { name: 'パート分離' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'パート分離と採譜' })).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/ステム|レイヤー|完全分解|Decompose/);
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
        expect(screen.getByText('DAW に戻る')).toBeInTheDocument();
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
        expect(screen.getAllByText('曲を教材にして学ぶ（5 つの段階）').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('自由に作る').length).toBeGreaterThanOrEqual(1);
        // 左パネルは 3 つのタブ
        expect(document.body.textContent).toContain('学ぶ:');
        expect(document.body.textContent).toContain('音作り:');
        expect(screen.getAllByText('キーボードとマウスの操作').length).toBeGreaterThanOrEqual(1);
        // 外した機能 (AI のタブ、オートメーション) と、使わないことば (答え・正解) が残っていない
        expect(document.body.textContent).not.toMatch(/オートメーション|AI アシスタント|答え|正解|読込|書出/);
    });
});

describe('BootMessage', () => {
    beforeEach(() => cleanup());

    it('起動できなかったときは理由と「再試行」を出し、押すと呼ぶ', async () => {
        const BootMessage = (await import('../components/BootMessage')).default;
        let retried = 0;
        render(<BootMessage title="bunri を起動できませんでした" detail="uv が見つかりません" onRetry={() => { retried += 1; }} />);
        expect(screen.getByText('uv が見つかりません')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '再試行' }));
        expect(retried).toBe(1);
    });

    it('待っている間は「再試行」を出さない', async () => {
        const BootMessage = (await import('../components/BootMessage')).default;
        render(<BootMessage title="bunri を起動しています…" busy />);
        expect(screen.queryByRole('button', { name: '再試行' })).not.toBeInTheDocument();
        expect(screen.getByText(/経過 0秒/)).toBeInTheDocument();
    });
});
