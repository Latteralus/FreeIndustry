import { expect, test } from '@playwright/test';
import { chooseMenu, waitReady } from './support/desktop';
import { launchApp, removeUserData, type LaunchedApp } from './support/launch';

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.close();
  removeUserData(launched);
});

test('launches the business desktop with a working preload bridge', async () => {
  const { page } = launched;
  await expect(page).toHaveTitle('FreeIndustry');
  await waitReady(page);
  await expect(page.getByRole('menubar', { name: 'Main menu' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Main toolbar' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Factory floor' })).toBeVisible();
  await expect(page.getByRole('contentinfo', { name: 'Status bar' })).toBeVisible();
  await chooseMenu(page, 'Help', 'About FreeIndustry…');
  await expect(page.getByTestId('runtime-versions')).toContainText('Electron ');
});

test('Electron’s own application menu is removed: the menubar is the renderer’s', async () => {
  const menu = await launched.app.evaluate(({ Menu }) => Menu.getApplicationMenu());
  expect(menu).toBeNull();
});

test('loads only the bundled local page', () => {
  const url = launched.page.url();
  expect(url.startsWith('file:')).toBe(true);
  expect(url.endsWith('/out/renderer/index.html')).toBe(true);
});

test('renderer has no Node.js or raw IPC access', async () => {
  const exposure = await launched.page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    ipcRenderer: typeof (globalThis as { ipcRenderer?: unknown }).ipcRenderer,
    electron: typeof (globalThis as { electron?: unknown }).electron,
  }));
  expect(exposure).toEqual({
    require: 'undefined',
    process: 'undefined',
    ipcRenderer: 'undefined',
    electron: 'undefined',
  });
});

test('preload bridge is narrow and frozen, and exactly one window opens', async () => {
  const shape = await launched.page.evaluate(() => {
    const bridge = window.freeIndustry;
    if (!bridge) {
      return null;
    }
    return {
      keys: Object.keys(bridge).sort(),
      simulationKeys: Object.keys(bridge.simulation).sort(),
      savesKeys: Object.keys(bridge.saves).sort(),
      workspaceKeys: Object.keys(bridge.workspace).sort(),
      frozen:
        Object.isFrozen(bridge) &&
        Object.isFrozen(bridge.simulation) &&
        Object.isFrozen(bridge.saves) &&
        Object.isFrozen(bridge.workspace),
      protocolVersion: bridge.protocolVersion,
    };
  });
  expect(shape).toEqual({
    keys: ['protocolVersion', 'runtime', 'saves', 'simulation', 'workspace'],
    simulationKeys: [
      'control',
      'getSnapshot',
      'newWorld',
      'restartWorker',
      'submitCommand',
      'subscribe',
    ],
    savesKeys: ['exportSave', 'importSave', 'list', 'load', 'save'],
    workspaceKeys: ['get', 'set'],
    frozen: true,
    protocolVersion: 1,
  });
  expect(launched.app.windows()).toHaveLength(1);
});

// Note: `eval` cannot be probed from here. Code run through Playwright's
// `evaluate` arrives via DevTools, which Chromium exempts from CSP eval
// checks. The policy text is asserted to omit 'unsafe-eval' instead, and
// enforcement is proved with inline script, which the same directive governs.
test('content security policy is enforced and forbids inline script and eval', async () => {
  const result = await launched.page.evaluate(async () => {
    const policy =
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content') ?? '';
    const violation = new Promise<string>((resolve) => {
      document.addEventListener(
        'securitypolicyviolation',
        (event) => {
          resolve(event.effectiveDirective);
        },
        { once: true },
      );
    });
    const marker = window as { inlineScriptRan?: boolean };
    const script = document.createElement('script');
    script.textContent = 'window.inlineScriptRan = true;';
    document.body.append(script);
    return { policy, violated: await violation, inlineScriptRan: marker.inlineScriptRan === true };
  });
  const scriptSrc = /script-src ([^;]*)/.exec(result.policy)?.[1] ?? '';
  expect(scriptSrc.trim()).toBe("'self'");
  expect(result.policy).toContain("object-src 'none'");
  expect(result.violated).toBe('script-src-elem');
  expect(result.inlineScriptRan).toBe(false);
});

test('window.open and navigation away from the app are refused', async () => {
  const { page, app } = launched;
  // An https link is handed to the user's browser (ADR-0017). Record the hand-off
  // instead of letting it open a real browser window during the test run.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { openedExternally?: string[] }).openedExternally = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
  const before = page.url();
  await page.evaluate(() => {
    window.open('https://example.invalid/', '_blank');
    window.location.href = 'https://example.invalid/';
  });
  await page.waitForTimeout(500);
  expect(app.windows()).toHaveLength(1);
  expect(page.url()).toBe(before);
  // The refused window.open went to the browser; the refused navigation went nowhere.
  expect(
    await app.evaluate(() => (globalThis as { openedExternally?: string[] }).openedExternally),
  ).toEqual(['https://example.invalid/']);
});

test('browser permission requests are denied', async () => {
  const state = await launched.page.evaluate(async () => {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state;
  });
  expect(state).toBe('denied');
});
