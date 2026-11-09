// First: configures Zod before any other module builds a schema.
import './zod-config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { browserProfileStore } from './app/desktop/profile-store';
import { installSceneProbe } from './scenes/factory/scene-probe';
import './app/app.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Renderer root element #root is missing from index.html');
}

const bridge = window.freeIndustry;
// Real-app measurement of the factory drawing; main enables it only in unpackaged test runs.
if (bridge?.runtime.sceneProbe === true) {
  installSceneProbe(window);
}

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
