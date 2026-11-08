import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { WorldSnapshot } from '../../src/shared/ipc/contract';
import {
  chooseMenu,
  diagnostics,
  loadSave,
  openWindow,
  saveAs,
  waitReady,
  watchCsp,
  windowFrame,
  world,
} from './support/desktop';
import { launchApp, removeUserData } from './support/launch';

/**
 * Step 06 acceptance in the real app (spec scenario S09): several management
 * windows stay interactive while the factory viewport is visible; they move,
 * resize, minimize, maximize, tile and cascade; the layout is saved with the
 * world and restored exactly on closing/reopening, on load and on relaunch;
 * and moving windows cannot change a simulation outcome.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** Drag from a point inside `handle` by (dx, dy) screen pixels. */
async function dragBy(
  page: Page,
  handle: Locator,
  dx: number,
  dy: number,
  at = { x: 0.5, y: 0.5 },
) {
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error('handle not visible');
  }
  const x = box.x + box.width * at.x;
  const y = box.y + box.height * at.y;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 });
  await page.mouse.move(x + dx, y + dy, { steps: 3 });
  await page.mouse.up();
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) {
    throw new Error('not visible');
  }
  return value;
}

/** Everything the layout should restore: bounds, stacking, state, tabs and filters. */
function captureLayout(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-window-id]'))
      .map((frame) => ({
        id: frame.dataset['windowId'],
        left: frame.style.left,
        top: frame.style.top,
        width: frame.style.width,
        height: frame.style.height,
        zIndex: frame.style.zIndex,
        mode: frame.dataset['mode'],
        active: frame.dataset['active'],
        tab: frame.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null,
        filters: Array.from(frame.querySelectorAll('select')).map((select) => select.value),
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  );
}

async function found(page: Page, name: string) {
  const company = await openWindow(page, 'Company');
  await company.getByLabel('Company name').fill(name);
  await company.getByLabel('President').fill('Ruth Calloway');
  await company.getByLabel('Starting capital ($)').fill('30,000');
  await company.getByRole('button', { name: 'Found company' }).click();
  await expect(company.getByRole('heading', { name })).toBeVisible();
}

test.describe('classic movable-window desktop', () => {
  test('gate (S09): windows over the live viewport; move, resize, tile; layout saved and restored exactly', async () => {
    test.setTimeout(180_000);
    const profile = mkdtempSync(join(tmpdir(), 'freeindustry-e2e-desktop-'));
    try {
      const first = await launchApp({ userDataDir: profile });
      let atSave: Awaited<ReturnType<typeof captureLayout>>;
      try {
        const page = await waitReady(first.page);
        const cspViolations = await watchCsp(page);
        const workspace = page.getByTestId('workspace');
        const viewport = page.getByRole('region', { name: 'Factory floor' });
        await found(page, 'Calloway Works');
        // The Step 06 gate arranges its own five windows; the Main Menu (Step 07) is closed.
        await page.getByRole('button', { name: 'Close Main Menu' }).click();

        // Five management windows open at once, over the factory viewport.
        const company = windowFrame(page, 'Company');
        const accounts = await openWindow(page, 'Accounts');
        const bills = await openWindow(page, 'Bills and Obligations');
        const saves = await openWindow(page, 'Saved Games');
        const diagnosticsWindow = await openWindow(page, 'Simulation Diagnostics');
        for (const frame of [company, accounts, bills, saves, diagnosticsWindow]) {
          await expect(frame).toBeVisible();
        }
        await expect(viewport).toBeVisible();
        // The viewport is really there behind them: an uncovered point of the workspace is it.
        const area = await box(workspace);
        const hit = await page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'),
          { x: area.x + area.width - 10, y: area.y + area.height - 10 },
        );
        expect(hit).toBe('factory-viewport');

        // Each one stays interactive while the others are open. As on a classic desktop,
        // a window is brought forward (here from its menu) before it is used.
        await openWindow(page, 'Accounts');
        await accounts.getByRole('tab', { name: 'Ledger entries' }).click();
        await expect(accounts.getByTestId('ledger-entries')).toContainText('Opening capital');
        await openWindow(page, 'Bills and Obligations');
        await bills.getByLabel('Show').selectOption({ label: 'Unpaid' });
        await openWindow(page, 'Saved Games');
        await saves.getByLabel('Show').selectOption({ label: 'Your saves' });
        await openWindow(page, 'Simulation Diagnostics');
        await diagnosticsWindow.getByRole('tab', { name: 'Probes' }).click();
        await diagnosticsWindow.getByRole('button', { name: 'Send probe' }).click();
        await expect(diagnosticsWindow.getByTestId('probe-count')).toHaveText('1');
        // Windows behind the front one keep showing live data.
        await expect(company.getByTestId('company-cash')).toHaveText('$30,000.00');
        await expect(windowFrame(page, 'Company')).toHaveAttribute('data-active', 'false');

        // Move a window by its title bar and size another from its corner, to the pixel.
        await openWindow(page, 'Company');
        const companyBefore = await box(company);
        await dragBy(page, company.locator('.window-title'), 150, 60, { x: 0.3, y: 0.5 });
        const companyAfter = await box(company);
        expect(companyAfter.x - companyBefore.x).toBeCloseTo(150, 0);
        expect(companyAfter.y - companyBefore.y).toBeCloseTo(60, 0);
        expect(companyAfter.width).toBe(companyBefore.width);
        await openWindow(page, 'Accounts');
        const accountsBefore = await box(accounts);
        await dragBy(page, accounts.locator('[data-resize="se"]'), 80, 40);
        const accountsAfter = await box(accounts);
        expect(accountsAfter.width - accountsBefore.width).toBeCloseTo(80, 0);
        expect(accountsAfter.height - accountsBefore.height).toBeCloseTo(40, 0);
        expect(accountsAfter.x).toBe(accountsBefore.x);
        // Not below the minimum size, however far it is dragged.
        await dragBy(page, accounts.locator('[data-resize="se"]'), -2000, -2000);
        expect(await box(accounts)).toMatchObject({ width: 380, height: 200 });
        await dragBy(page, accounts.locator('[data-resize="se"]'), 240, 220);

        // Minimize to the strip, maximize within the workspace, restore.
        await openWindow(page, 'Simulation Diagnostics');
        await diagnosticsWindow
          .getByRole('button', { name: 'Minimize Simulation Diagnostics' })
          .click();
        await expect(diagnosticsWindow).toBeHidden();
        const strip = page.getByRole('group', { name: 'Minimized windows' });
        await expect(
          strip.getByRole('button', { name: 'Restore Simulation Diagnostics' }),
        ).toBeVisible();
        await openWindow(page, 'Bills and Obligations');
        await bills.getByRole('button', { name: 'Maximize Bills and Obligations' }).click();
        expect(await box(bills)).toEqual(await box(workspace));
        await bills.getByRole('button', { name: 'Restore Bills and Obligations' }).click();
        expect((await box(bills)).width).toBeLessThan(area.width);

        // Tile and cascade arrange the visible windows inside the workspace.
        // Four visible windows (one is minimized) tile as a 2 x 2 grid: inside the
        // workspace, edge to edge, none overlapping another.
        await chooseMenu(page, 'Window', 'Tile Horizontally');
        const tiles = await Promise.all(
          [company, accounts, bills, saves].map((frame) => box(frame)),
        );
        for (const tile of tiles) {
          expect(tile.x).toBeGreaterThanOrEqual(area.x);
          expect(tile.y).toBeGreaterThanOrEqual(area.y);
          expect(tile.x + tile.width).toBeLessThanOrEqual(area.x + area.width + 1);
          expect(tile.y + tile.height).toBeLessThanOrEqual(area.y + area.height + 1);
        }
        for (const [index, a] of tiles.entries()) {
          for (const b of tiles.slice(index + 1)) {
            const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
            const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
            expect(overlapX <= 1 || overlapY <= 1).toBe(true);
          }
        }
        const covered = tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0);
        expect(covered / (area.width * area.height)).toBeGreaterThan(0.99);
        await page.keyboard.press('Shift+F5');
        const cascaded = await captureLayout(page);
        const lefts = cascaded
          .filter((frame) => frame.mode === 'normal')
          .map((frame) => frame.left)
          .sort();
        expect(new Set(lefts).size).toBe(4);

        // A last arrangement, then save it with the world.
        await openWindow(page, 'Company');
        await dragBy(page, company.locator('.window-title'), 120, 90, { x: 0.3, y: 0.5 });
        await company.click({ position: { x: 30, y: 60 } });
        await expect(company).toHaveAttribute('data-active', 'true');
        await saveAs(page, 'Layout');
        atSave = await captureLayout(page);
        expect(atSave.find((frame) => frame.id === 'accounts')).toMatchObject({
          tab: 'Ledger entries',
          mode: 'normal',
        });
        expect(atSave.find((frame) => frame.id === 'diagnostics')?.mode).toBe('minimized');

        // Rearrange everything.
        await chooseMenu(page, 'Window', 'Close All');
        await expect(page.locator('[data-window-id]')).toHaveCount(0);
        await expect(viewport).toBeVisible();
        // Reopening a closed window brings it back where it was, on its last tab.
        await openWindow(page, 'Accounts');
        const reopened = (await captureLayout(page)).find((frame) => frame.id === 'accounts');
        const saved = atSave.find((frame) => frame.id === 'accounts');
        expect({ ...reopened, zIndex: null, active: null }).toEqual({
          ...saved,
          zIndex: null,
          active: null,
        });
        await dragBy(page, windowFrame(page, 'Accounts').locator('.window-title'), -200, 100, {
          x: 0.3,
          y: 0.5,
        });
        await chooseMenu(page, 'Window', 'Reset Layout');
        expect(await captureLayout(page)).not.toEqual(atSave);

        // Loading the save restores its layout exactly.
        await loadSave(page, 'Layout');
        await expect.poll(() => captureLayout(page)).toEqual(atSave);
        expect(await cspViolations()).toEqual([]);

        // A larger UI scale for the next session (a profile preference).
        await chooseMenu(page, 'View', 'UI Scale 125%');
        await expect(page.locator('.desktop')).toHaveAttribute('data-ui-scale', '125');
      } finally {
        await first.close();
      }

      // Relaunch on the same profile: the new world starts from the last layout and scale.
      const second = await launchApp({ userDataDir: profile });
      try {
        const page = await waitReady(second.page);
        await expect(page.locator('.desktop')).toHaveAttribute('data-ui-scale', '125');
        // Bounds, stacking and state are as they were. This new world has no company, so
        // the finance windows have no tabs or filters to show yet...
        const geometry = (layout: Awaited<ReturnType<typeof captureLayout>>) =>
          layout.map((frame) => ({ ...frame, tab: null, filters: null }));
        await expect
          .poll(async () => geometry(await captureLayout(page)))
          .toEqual(geometry(atSave));
        // ...until there are books: then their remembered tab and filter come back.
        await found(page, 'Second Works');
        await expect(
          windowFrame(page, 'Accounts').getByRole('tab', { name: 'Ledger entries' }),
        ).toHaveAttribute('aria-selected', 'true');
        await expect(windowFrame(page, 'Bills and Obligations').getByLabel('Show')).toHaveValue(
          'unpaid',
        );
        // At 125% a dragged window still follows the pointer exactly.
        const company = windowFrame(page, 'Company');
        const before = await box(company);
        await dragBy(page, company.locator('.window-title'), 100, 50, { x: 0.3, y: 0.5 });
        const after = await box(company);
        expect(Math.abs(after.x - before.x - 100)).toBeLessThanOrEqual(1.25);
        expect(Math.abs(after.y - before.y - 50)).toBeLessThanOrEqual(1.25);
        // Maximized still fills the workspace (to within the zoom's sub-pixel rounding).
        await company.getByRole('button', { name: 'Maximize Company' }).click();
        const maximized = await box(company);
        const space = await box(page.getByTestId('workspace'));
        for (const key of ['x', 'y', 'width', 'height'] as const) {
          expect(Math.abs(maximized[key] - space[key])).toBeLessThanOrEqual(1);
        }
      } finally {
        await second.close();
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('moving windows cannot affect simulation outcomes', async () => {
    test.setTimeout(150_000);
    const SEED = 6006;

    async function session(play: (page: Page) => Promise<void>): Promise<WorldSnapshot> {
      const launched = await launchApp({ seed: SEED });
      try {
        const page = await waitReady(launched.page);
        const plan: [string, unknown][] = [
          [
            'company.found',
            {
              legalName: 'Steady Fittings',
              presidentName: 'Ivo Brandt',
              startingCapitalCents: '2500000',
            },
          ],
          ['diagnostics.scheduleProbe', { label: 'a', delayMs: 600_000 }],
          ['diagnostics.scheduleProbe', { label: 'b', delayMs: 7_200_000 }],
          ['diagnostics.scheduleProbe', { label: 'c', delayMs: 50_000_000 }],
        ];
        for (const [index, [type, payload]] of plan.entries()) {
          const current = await world(page);
          const result = await page.evaluate(
            (envelope) => window.freeIndustry?.simulation.submitCommand(envelope as never),
            {
              commandId: uuid(index + 1),
              worldInstanceId: current.worldInstanceId,
              expectedWorldRevision: current.worldRevision,
              type,
              payload,
            },
          );
          expect(result).toMatchObject({ ok: true });
        }
        await play(page);
        await page.getByRole('button', { name: 'End of day' }).click();
        await expect
          .poll(async () => (await world(page)).clock.advance, { timeout: 30_000 })
          .toBeNull();
        const end = await world(page);
        expect(end.clock.nowMs).toBe('86400000');
        return end;
      } finally {
        await launched.close();
        removeUserData(launched);
      }
    }

    const straight = await session(async () => {
      // No windows touched.
    });

    const busy = await session(async (page) => {
      const before = await world(page);
      // Saved: window activity must not make the world "changed".
      await saveAs(page, 'Plan');
      expect((await world(page)).session?.unsavedChanges).toBe(false);
      await page
        .getByRole('group', { name: 'Simulation speed' })
        .getByRole('button', { name: 'Fastest' })
        .click();
      for (let round = 0; round < 2; round += 1) {
        await diagnostics(page, 'World');
        const accounts = await openWindow(page, 'Accounts');
        await dragBy(page, accounts.locator('.window-title'), 90 - round * 40, 70, {
          x: 0.3,
          y: 0.5,
        });
        const bills = await openWindow(page, 'Bills and Obligations');
        await dragBy(page, bills.locator('[data-resize="se"]'), -60, 30);
        await chooseMenu(page, 'Window', 'Tile Vertically');
        await page.keyboard.press('Shift+F5');
        await openWindow(page, 'Bills and Obligations');
        await bills.getByRole('button', { name: 'Maximize Bills and Obligations' }).click();
        await bills.getByRole('button', { name: 'Restore Bills and Obligations' }).click();
        await openWindow(page, 'Accounts');
        await accounts.getByRole('button', { name: 'Minimize Accounts' }).click();
        await page.keyboard.press('Control+F6');
        await chooseMenu(page, 'View', 'UI Scale 150%');
        await chooseMenu(page, 'View', 'UI Scale 100%');
        await chooseMenu(page, 'Window', 'Close All');
      }
      await page
        .getByRole('group', { name: 'Simulation speed' })
        .getByRole('button', { name: 'Pause' })
        .click();
      const after = await world(page);
      // Time ran, but no window action was a command.
      expect(BigInt(after.clock.nowMs)).toBeGreaterThan(0n);
      expect(after.worldRevision).toBe(before.worldRevision);
      expect(after.journal.commands).toBe(before.journal.commands);
    });

    expect(busy.fingerprint).toEqual(straight.fingerprint);
    expect(busy.journal).toEqual(straight.journal);
    expect(busy.diagnostics).toEqual(straight.diagnostics);
    expect(busy.company).toEqual(straight.company);
    // Probes due at 00:10, 02:00 and about 13:53 have all fired by midnight.
    expect(busy.diagnostics.firedProbes).toBe(3);
  });

  test('keyboard: menubar, shortcuts, window cycling, keyboard move', async () => {
    const launched = await launchApp();
    try {
      const page = await waitReady(launched.page);
      const menubar = page.getByRole('menubar');

      // Alt pressed and released alone, then arrows; Escape closes back to the bar.
      await page.keyboard.press('Alt');
      await expect(menubar.getByRole('menuitem', { name: 'File', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(menubar.getByRole('menuitem', { name: 'View', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(menubar.getByRole('menuitem', { name: 'View', exact: true })).toBeFocused();

      // Alt+H opens Help; Down moves past Help Topics; Enter chooses Simulation Diagnostics.
      await page.keyboard.press('Alt+h');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const diagnosticsWindow = windowFrame(page, 'Simulation Diagnostics');
      await expect(diagnosticsWindow).toBeFocused();

      // Ctrl+O, Ctrl+F6 and Ctrl+F4.
      await page.keyboard.press('Control+o');
      const saves = windowFrame(page, 'Saved Games');
      await expect(saves).toHaveAttribute('data-active', 'true');
      await expect(saves).toBeFocused();
      await page.keyboard.press('Control+F6');
      await expect(saves).toHaveAttribute('data-active', 'false');
      const active = page.locator('[data-window-id][data-active="true"]');
      await expect(active).toBeFocused();
      const cycledTo = await active.getAttribute('data-window-id');
      await page.keyboard.press('Control+F4');
      await expect(page.locator(`[data-window-id="${cycledTo}"]`)).toHaveCount(0);

      // Alt+Minus opens the active window's system menu; Move with the arrow keys.
      await page.keyboard.press('Control+o');
      const start = await saves.evaluate((frame) => [frame.style.left, frame.style.top]);
      await page.keyboard.press('Alt+-');
      await page
        .getByRole('menu', { name: 'Window menu: Saved Games' })
        .getByRole('menuitem', { name: 'Move' })
        .press('Enter');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const moved = await saves.evaluate((frame) => [frame.style.left, frame.style.top]);
      expect(moved).toEqual([
        `${Number.parseInt(start[0] ?? '0', 10) + 16}px`,
        `${Number.parseInt(start[1] ?? '0', 10) + 8}px`,
      ]);

      // Pause/Run from the keyboard.
      await page.keyboard.press('Pause');
      await expect(page.getByTestId('sim-speed')).toHaveText('Normal (20×)');
      await page.keyboard.press('Pause');
      await expect(page.getByTestId('sim-speed')).toHaveText('Paused');
    } finally {
      await launched.close();
      removeUserData(launched);
    }
  });
});
