/**
 * bunri DAW — アプリケーションエントリーポイント。
 * React ルートを生成し、BrowserRouter でルーティングを設定する。
 * - `/`      → DawProvider でラップした DawPage（メイン DAW 画面）
 * - `/tools` → ToolsPage（音源分離・変換ツール群）
 * - `/help`  → HelpPage（使い方ガイド）
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { DawProvider } from './lib/store';
import DawPage from './pages/DawPage';
import ToolsPage from './pages/ToolsPage';
import HelpPage from './pages/HelpPage';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(
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
