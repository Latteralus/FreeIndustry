import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

let app: ElectronApplication;

/**
 * Environment for the app under test. VS Code (and other Electron-based hosts)
 * export ELECTRON_RUN_AS_NODE=1 to their terminals, which would make
 * electron.exe behave as plain Node and refuse to open a window.
 */
function appEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') {
      env[key] = value;
    }
  }
  return env;
}

test.beforeEach(async () => {
  // Launch the built app the same way `electron .` would: via package.json "main".
  app = await electron.launch({ args: ['.'], env: appEnvironment() });
});

test.afterEach(async () => {
  await app.close();
});

test('launches the development shell with a working preload bridge', async () => {
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('FreeIndustry');
  await expect(page.getByRole('heading', { name: 'FreeIndustry development shell' })).toBeVisible();
  await expect(page.getByTestId('runtime-versions')).toContainText('Electron ');
});

test('renderer has no Node.js access', async () => {
  const page = await app.firstWindow();
  const exposure = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
  }));
  expect(exposure).toEqual({ require: 'undefined', process: 'undefined' });
});

test('preload bridge is frozen and opens exactly one window', async () => {
  const page = await app.firstWindow();
  const frozen = await page.evaluate(() => Object.isFrozen(window.freeIndustry));
  expect(frozen).toBe(true);
  expect(app.windows()).toHaveLength(1);
});
