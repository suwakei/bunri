/**
 * bunri DAW — アプリケーションエントリーポイント。
 * React ルートを生成し、BrowserRouter でルーティングを設定する。
 * - `/`      → DawProvider でラップした DawPage（メイン DAW 画面）
 * - `/tools` → ToolsPage（音源分離・変換ツール群）
 * - `/help`  → HelpPage（使い方ガイド）
 *
 * 描画の前に、バックエンドの接続先を決める（lib/api.ts）。開発用のブラウザ起動ではすぐ終わる。
 * デスクトップ版では Python sidecar が待ち受けを始めるまで待つので、その間は
 * 「起動中」を、起動できなかったときは理由を表示する。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { DawProvider } from './lib/store';
import { initBackend, isDesktop } from './lib/api';
import BootMessage from './components/BootMessage';
import DawPage from './pages/DawPage';
import ToolsPage from './pages/ToolsPage';
import HelpPage from './pages/HelpPage';
import './styles/global.css';

const root = createRoot(document.getElementById('root')!);

function renderApp() {
  root.render(
    <StrictMode>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<DawProvider><DawPage /></DawProvider>} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/help" element={<HelpPage />} />
        </Routes>
      </BrowserRouter>
    </StrictMode>
  );
}

if (isDesktop()) {
  root.render(<BootMessage title="bunri を起動しています…" busy />);
  initBackend((status) => {
    if (status.phase === 'setup' || status.phase === 'starting') {
      root.render(<BootMessage title={status.message} log={status.log} busy />);
    }
  }).then(renderApp, (e: unknown) => {
    root.render(<BootMessage title="bunri を起動できませんでした" detail={String((e as Error)?.message ?? e)} />);
  });
} else {
  // 開発用のブラウザ起動: 接続先は相対パスのままなので、待たずに描画する
  renderApp();
}
