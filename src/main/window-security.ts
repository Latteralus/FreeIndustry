import type { WebPreferences } from 'electron';

/**
 * Web preferences for every FreeIndustry renderer window (spec §4.3).
 * Kept as a pure function so the security baseline is asserted in unit tests.
 */
export function secureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  };
}
