import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { DawProvider } from './lib/store.jsx';
import DawPage from './pages/DawPage.jsx';
import ToolsPage from './pages/ToolsPage.jsx';
import HelpPage from './pages/HelpPage.jsx';
import './styles/global.css';

createRoot(document.getElementById('root')).render(
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
