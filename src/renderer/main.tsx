// First: configures Zod before any other module builds a schema.
import './zod-config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { browserProfileStore } from './app/desktop/profile-store';
import './app/app.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Renderer root element #root is missing from index.html');
}

const bridge = window.freeIndustry;

/** Browser storage can be unavailable; preferences are then simply not remembered. */
function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

createRoot(container).render(
  <StrictMode>
    <App
      runtime={bridge?.runtime ?? null}
      simulation={bridge?.simulation ?? null}
      saves={bridge?.saves ?? null}
      workspace={bridge?.workspace ?? null}
      profile={browserProfileStore(localStorageOrNull())}
    />
  </StrictMode>,
);
