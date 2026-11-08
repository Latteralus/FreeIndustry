import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './app/app.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Renderer root element #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App runtime={window.freeIndustry?.runtime ?? null} />
  </StrictMode>,
);
