import { secureWebPreferences } from '../../../src/main/window-security';

describe('renderer window security baseline', () => {
  const prefs = secureWebPreferences('C:\\app\\out\\preload\\index.cjs');

  it('isolates and sandboxes the renderer with no Node.js integration', () => {
    expect(prefs).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
    });
  });

  it('keeps web security on and disables risky features', () => {
    expect(prefs).toMatchObject({
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });

  it('uses the supplied preload script', () => {
    expect(prefs.preload).toBe('C:\\app\\out\\preload\\index.cjs');
  });
});
