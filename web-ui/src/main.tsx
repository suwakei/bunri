/**
 * bunri DAW — アプリケーションエントリーポイント。
 * React ルートを生成し、BrowserRouter でルーティングを設定する。
 * - `/`      → DawProvider でラップした DawPage（メイン DAW 画面）
 * - `/tools` → ToolsPage（音源分離・変換ツール群）
 * - `/help`  → HelpPage（使い方ガイド）
 *
 * 描画の前に、バックエンドの接続先を決める（lib/api.ts）。開発用のブラウザ起動ではすぐ終わる。
 * デスクトップ版では Python sidecar が待ち受けを始めるまで待つので、その間は
 * 「起動中」を、起動できなかったときは理由と「再試行」を表示する。
 *
 * 描画したあとは、処理を担当する部分が止まっていないかを見張り（lib/health.ts。止まったら知らせる）、
 * 動いている時間のかかる処理を探す（lib/jobs.ts。画面を開き直す前に始めた処理につなぎ直す）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { DawProvider } from './lib/store';
import { initBackend, isDesktop, restartBackend, type BootStatus } from './lib/api';
import { health } from './lib/health';
import { jobTracker } from './lib/jobs';
import BootMessage from './components/BootMessage';
import HealthBanner from './components/HealthBanner';
import TooltipLayer from './components/Tooltip';
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
        <TooltipLayer />
      </BrowserRouter>
      <HealthBanner />
    </StrictMode>
  );
  health.start();
  jobTracker.startDiscovery();
}

/** 起動待ちの間の進み具合を表示する。 */
function showStatus(status: BootStatus) {
  if (status.phase === 'setup' || status.phase === 'starting') {
    root.render(<BootMessage title={status.message} log={status.log} busy />);
  }
}

/**
 * sidecar が待ち受けを始めるのを待って、画面を描く（デスクトップ版）。
 * 起動できなかったら理由を出し、「再試行」で Rust に起動し直してもらう。
 *
 * @param retry - 再試行か（true なら sidecar を起動し直す）
 */
function boot(retry: boolean) {
  root.render(<BootMessage title={retry ? 'bunri を起動し直しています…' : 'bunri を起動しています…'} busy />);
  (retry ? restartBackend(showStatus) : initBackend(showStatus)).then(renderApp, (e: unknown) => {
    root.render(<BootMessage title="bunri を起動できませんでした" detail={String((e as Error)?.message ?? e)}
      onRetry={() => boot(true)} />);
  });
}

if (isDesktop()) {
  boot(false);
} else {
  // 開発用のブラウザ起動: 接続先は相対パスのままなので、待たずに描画する
  renderApp();
}
