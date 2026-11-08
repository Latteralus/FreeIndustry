import type { WebPreferences } from 'electron';

/**
 * Security baseline for every FreeIndustry renderer (spec §4.3, Electron
 * security checklist). Pure functions, so each rule is asserted in unit
 * tests without launching Electron.
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

export interface RendererLocation {
  /** `file:` URL of the bundled `index.html` (production and E2E builds). */
  readonly indexFileUrl: string;
  /** electron-vite dev server URL, only in unpackaged development runs. */
  readonly devServerUrl: string | undefined;
}

/**
 * Whether `url` is the app's own renderer page: exactly the bundled
 * index.html (ignoring `#hash`), or any page on the dev server's origin.
 */
export function isTrustedRendererUrl(url: string, location: RendererLocation): boolean {
  const candidate = parseUrl(url);
  if (!candidate) {
    return false;
  }
  if (location.devServerUrl) {
    const dev = parseUrl(location.devServerUrl);
    if (dev?.origin === candidate.origin && candidate.protocol.startsWith('http')) {
      return true;
    }
  }
  const index = parseUrl(location.indexFileUrl);
  return (
    index !== null &&
    candidate.protocol === 'file:' &&
    index.protocol === 'file:' &&
    candidate.host === index.host &&
    decodeURIComponent(candidate.pathname).toLowerCase() ===
      decodeURIComponent(index.pathname).toLowerCase() &&
    candidate.search === ''
  );
}

/**
 * In-window navigation is never allowed, except hot-reload navigation within
 * the dev server. The bundled app is a single page.
 */
export function isAllowedNavigation(url: string, location: RendererLocation): boolean {
  if (!location.devServerUrl) {
    return false;
  }
  const candidate = parseUrl(url);
  const dev = parseUrl(location.devServerUrl);
  return candidate !== null && dev !== null && candidate.origin === dev.origin;
}

/** Only plain https links may leave the app, and only to the user's browser. */
export function isAllowedExternalUrl(url: string): boolean {
  return parseUrl(url)?.protocol === 'https:';
}

/** The parts of an Electron `Session` used to refuse permissions. */
export interface PermissionSession {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: (...args: unknown[]) => boolean): void;
}

/**
 * The game needs no browser permissions (camera, notifications, geolocation,
 * clipboard-read, …): refuse every request and every check.
 */
export function denyAllPermissions(session: PermissionSession): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
