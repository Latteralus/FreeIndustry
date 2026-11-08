import {
  denyAllPermissions,
  isAllowedExternalUrl,
  isAllowedNavigation,
  isTrustedRendererUrl,
  secureWebPreferences,
  type RendererLocation,
} from '../../../src/main/window-security';

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

describe('trusted renderer origin', () => {
  const production: RendererLocation = {
    indexFileUrl:
      'file:///C:/Program%20Files/FreeIndustry/resources/app.asar/out/renderer/index.html',
    devServerUrl: undefined,
  };
  const development: RendererLocation = {
    indexFileUrl: 'file:///C:/dev/out/renderer/index.html',
    devServerUrl: 'http://localhost:5173/',
  };

  it.each([
    'file:///C:/Program%20Files/FreeIndustry/resources/app.asar/out/renderer/index.html',
    'file:///c:/program%20files/freeindustry/resources/app.asar/out/renderer/index.html',
    'file:///C:/Program%20Files/FreeIndustry/resources/app.asar/out/renderer/index.html#window=bank',
  ])('trusts the bundled index page %s', (url) => {
    expect(isTrustedRendererUrl(url, production)).toBe(true);
  });

  it.each([
    'file:///C:/Users/me/Downloads/evil.html',
    'file:///C:/Program%20Files/FreeIndustry/resources/app.asar/out/renderer/index.html?x=1',
    'file://server/share/out/renderer/index.html',
    'https://example.com/out/renderer/index.html',
    'http://localhost:5173/',
    'devtools://devtools/bundled/inspector.html',
    'not a url',
    '',
  ])('does not trust %s in a production build', (url) => {
    expect(isTrustedRendererUrl(url, production)).toBe(false);
  });

  it('trusts the dev server origin only in development', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/', development)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5174/', development)).toBe(false);
    expect(isTrustedRendererUrl('http://evil.localhost:5173/', development)).toBe(false);
  });

  it('refuses all navigation in production and off-origin navigation in development', () => {
    expect(isAllowedNavigation('file:///C:/x.html', production)).toBe(false);
    expect(isAllowedNavigation('https://example.com/', production)).toBe(false);
    expect(isAllowedNavigation('http://localhost:5173/index.html', development)).toBe(true);
    expect(isAllowedNavigation('https://example.com/', development)).toBe(false);
  });

  it('lets only https links open externally', () => {
    expect(isAllowedExternalUrl('https://example.com/')).toBe(true);
    for (const url of [
      'http://example.com/',
      'file:///C:/Windows/system32/calc.exe',
      'javascript:alert(1)',
      'ms-settings:',
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(false);
    }
  });
});

describe('browser permissions', () => {
  it('denies every permission request and check', () => {
    let requestHandler:
      ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | undefined;
    let checkHandler: ((...args: unknown[]) => boolean) | undefined;
    denyAllPermissions({
      setPermissionRequestHandler: (handler) => {
        requestHandler = handler;
      },
      setPermissionCheckHandler: (handler) => {
        checkHandler = handler;
      },
    });
    const granted: boolean[] = [];
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'clipboard-read',
      'openExternal',
    ]) {
      requestHandler?.({}, permission, (value) => granted.push(value));
    }
    expect(granted).toEqual([false, false, false, false, false]);
    expect(checkHandler?.({}, 'media', 'file://', {})).toBe(false);
  });
});
