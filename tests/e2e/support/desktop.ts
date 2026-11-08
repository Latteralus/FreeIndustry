import { expect, type Locator, type Page } from '@playwright/test';
import type { WorldSnapshot } from '../../../src/shared/ipc/contract';

/**
 * Driving the classic desktop in the real app: menus, windows, dialogs.
 * Every helper goes through the UI the player uses.
 */

export async function waitReady(page: Page): Promise<Page> {
  await expect(page.getByTestId('worker-state')).toHaveText('Ready');
  return page;
}

/** The world read model straight from the bridge (for assertions only). */
export async function world(page: Page): Promise<WorldSnapshot> {
  const result = await page.evaluate(() => window.freeIndustry?.simulation.getSnapshot());
  if (!result?.ok || !result.value.world) {
    throw new Error(`no world: ${JSON.stringify(result)}`);
  }
  return result.value.world;
}

/** Choose a command from the menubar with the mouse. */
export async function chooseMenu(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: menu, exact: true }).click();
  const popup = page.getByRole('menu');
  await popup
    .getByRole('menuitem', { name: item, exact: true })
    .or(popup.getByRole('menuitemradio', { name: item, exact: true }))
    .click();
  await expect(popup).toHaveCount(0);
}

export function windowFrame(page: Page, title: string): Locator {
  return page.getByRole('dialog', { name: title, exact: true });
}

const OPEN = {
  Company: ['Company', 'Company Profile…'],
  Accounts: ['Finance', 'Accounts…'],
  'Bills and Obligations': ['Finance', 'Bills and Obligations…'],
  'Saved Games': ['File', 'Saved Games…'],
  'Simulation Diagnostics': ['Help', 'Simulation Diagnostics…'],
} as const satisfies Record<string, readonly [string, string]>;

export type WindowTitle = keyof typeof OPEN;

/** Open (or bring forward) a management window from its menu. */
export async function openWindow(page: Page, title: WindowTitle): Promise<Locator> {
  const [menu, item] = OPEN[title];
  await chooseMenu(page, menu, item);
  const frame = windowFrame(page, title);
  await expect(frame).toBeVisible();
  return frame;
}

/** The diagnostics window on one of its tabs. */
export async function diagnostics(
  page: Page,
  tab: 'World' | 'Probes' | 'Test obligations',
): Promise<Locator> {
  const frame = await openWindow(page, 'Simulation Diagnostics');
  await frame.getByRole('tab', { name: tab }).click();
  return frame;
}

/** File → Save As…, then wait for the outcome in the status bar. */
export async function saveAs(page: Page, name: string): Promise<void> {
  await chooseMenu(page, 'File', 'Save As…');
  const dialog = page.getByRole('dialog', { name: 'Save As' });
  await dialog.getByLabel('Save name').fill(name);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('status-message')).toHaveText(`Saved "${name}".`);
  await expect(dialog).toHaveCount(0);
}

/** Load a save from the Saved Games window. */
export async function loadSave(page: Page, name: string): Promise<void> {
  const saves = await openWindow(page, 'Saved Games');
  await saves.getByRole('button', { name: `Load ${name}`, exact: true }).click();
  await expect(page.getByTestId('status-message')).toHaveText(`Loaded "${name}".`);
}

/** Collect Content-Security-Policy violations reported in the page. */
export async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const store = window as unknown as { cspViolations?: string[] };
    store.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      store.cspViolations?.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { cspViolations?: string[] }).cspViolations ?? []);
}
