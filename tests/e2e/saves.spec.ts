import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ClockControl } from '../../src/shared/ipc/clock';
import type { WorldSnapshot } from '../../src/shared/ipc/contract';
import { loadSave, openWindow, saveAs, waitReady } from './support/desktop';
import { launchApp, removeUserData, type LaunchedApp } from './support/launch';

/**
 * Step 04 acceptance in the real app: save during a pending event, quit,
 * relaunch, load and resume with the same domain hashes as an uninterrupted
 * run; the shutdown autosave; export/import through main's native dialogs
 * (stubbed here, because Playwright cannot click native dialogs); crash
 * recovery after the worker thread really dies.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

async function world(page: Page): Promise<WorldSnapshot> {
  const result = await page.evaluate(() => window.freeIndustry?.simulation.getSnapshot());
  if (!result?.ok || !result.value.world) {
    throw new Error(`no world: ${JSON.stringify(result)}`);
  }
  return result.value.world;
}

async function submit(page: Page, commandId: string, type: string, payload: unknown) {
  const current = await world(page);
  const result = await page.evaluate(
    (envelope) => window.freeIndustry?.simulation.submitCommand(envelope as never),
    {
      commandId,
      worldInstanceId: current.worldInstanceId,
      expectedWorldRevision: current.worldRevision,
      type,
      payload,
    },
  );
  expect(result, `${type} ${JSON.stringify(payload)}`).toMatchObject({ ok: true });
}

async function advance(page: Page, until: Extract<ClockControl, { action: 'advance' }>['until']) {
  await page.evaluate(
    (target) => window.freeIndustry?.simulation.control({ action: 'advance', until: target }),
    until,
  );
  await expect.poll(async () => (await world(page)).clock.advance, { timeout: 15_000 }).toBeNull();
  return world(page);
}

/** The same plan in every session: three probes, due at 00:10, 02:00 and 05:00. */
async function plan(page: Page) {
  await submit(page, uuid(1), 'diagnostics.recordProbe', { label: 'plan' });
  await submit(page, uuid(2), 'diagnostics.scheduleProbe', { label: 'a', delayMs: 600_000 });
  await submit(page, uuid(3), 'diagnostics.scheduleProbe', { label: 'b', delayMs: 7_200_000 });
  await submit(page, uuid(4), 'diagnostics.scheduleProbe', { label: 'c', delayMs: 18_000_000 });
}

async function ready(launched: LaunchedApp) {
  return waitReady(launched.page);
}

/** File → Save As; the Saved Games window then reports it too. */
async function saveNew(page: Page, name: string) {
  await saveAs(page, name);
  const saves = await openWindow(page, 'Saved Games');
  await expect(saves.getByTestId('saves-outcome')).toHaveText(`Saved "${name}".`);
}

test.describe('saves in the real app', () => {
  test('gate: save with events pending, quit, relaunch, load and resume = uninterrupted run', async () => {
    test.setTimeout(150_000);
    const SEED = 5150;
    const profile = mkdtempSync(join(tmpdir(), 'freeindustry-e2e-profile-'));
    try {
      // Session 1: play to the first event (00:10), with two probes still pending, then save.
      const first = await launchApp({ seed: SEED, userDataDir: profile });
      let atSave: WorldSnapshot;
      try {
        const page = await ready(first);
        const saves = await openWindow(page, 'Saved Games');
        await expect(saves.getByTestId('session-saved-as')).toHaveText('Not saved');
        await plan(page);
        const midway = await advance(page, 'nextEvent');
        expect(midway).toMatchObject({
          clock: { nowMs: '600000' },
          queue: { pending: 2 },
          diagnostics: { firedProbes: 1, pendingProbes: 2 },
        });
        await expect(saves.getByTestId('session-unsaved')).toHaveText('Yes');
        await page.evaluate(() =>
          window.freeIndustry?.workspace.set({
            key: 'window.personnel',
            value: { x: 12, open: true },
          }),
        );
        await saveNew(page, 'Before lunch');
        await expect(saves.getByTestId('save-row')).toHaveCount(1);
        await expect(saves.getByTestId('save-row').first()).toContainText('Before lunch (current)');
        await expect(saves.getByTestId('save-row').first()).toContainText(
          'Mon 1 Jan 1996 00:10:00',
        );
        await expect(saves.getByTestId('session-saved-as')).toHaveText('Before lunch');
        await expect(saves.getByTestId('session-unsaved')).toHaveText('No');
        atSave = await world(page);
      } finally {
        await first.close();
      }
      // Unchanged since the save, so quitting wrote no autosave and removed the recovery log.
      expect(existsSync(join(profile, 'saves', 'autosave-1.fisave'))).toBe(false);
      expect(existsSync(join(profile, 'recovery', 'session.fisave'))).toBe(false);

      // Session 2: same profile, a fresh world with another seed; load and resume.
      const second = await launchApp({ seed: SEED + 1, userDataDir: profile });
      let resumed: WorldSnapshot;
      try {
        const page = await ready(second);
        expect((await world(page)).seed).toBe(SEED + 1);
        await loadSave(page, 'Before lunch');
        const loaded = await world(page);
        expect(loaded.fingerprint).toEqual(atSave.fingerprint);
        expect(loaded.worldInstanceId).not.toBe(atSave.worldInstanceId);
        expect(loaded).toMatchObject({
          seed: SEED,
          worldRevision: 4,
          clock: { nowMs: '600000', speed: 'paused' },
          queue: atSave.queue,
          session: { worldId: atSave.session?.worldId, unsavedChanges: false },
        });
        await expect(page.getByTestId('sim-time')).toHaveText('00:10:00');
        const workspace = await page.evaluate(() => window.freeIndustry?.workspace.get());
        // The setting written in session 1 came back with the save, beside the desktop layout.
        expect(workspace).toMatchObject({
          ok: true,
          value: { settings: { 'window.personnel': { x: 12, open: true } } },
        });
        expect(Object.keys(workspace?.ok ? workspace.value.settings : {}).sort()).toEqual([
          'desktop.layout',
          'window.personnel',
        ]);
        resumed = await advance(page, 'endOfDay');
      } finally {
        await second.close();
      }
      // Changed since loading, so quitting autosaved it.
      expect(existsSync(join(profile, 'saves', 'autosave-1.fisave'))).toBe(true);
      expect(second.readLog().map((entry) => entry['message'])).toEqual(
        expect.arrayContaining(['Save loaded', 'Autosaved']),
      );

      // Session 3: the uninterrupted run, in a fresh profile.
      const straight = await launchApp({ seed: SEED });
      try {
        const page = await ready(straight);
        await plan(page);
        const expected = await advance(page, 'endOfDay');
        expect(resumed.fingerprint).toEqual(expected.fingerprint);
        expect(resumed.diagnostics).toEqual(expected.diagnostics);
        expect(resumed.journal).toEqual(expected.journal);
        expect(resumed.diagnostics.firedProbes).toBe(3);
      } finally {
        await straight.close();
        removeUserData(straight);
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('export and import go through main\u2019s dialogs; the renderer never handles a path', async () => {
    const launched = await launchApp();
    const elsewhere = mkdtempSync(join(tmpdir(), 'freeindustry-e2e-export-'));
    try {
      const page = await ready(launched);
      await plan(page);
      await saveNew(page, 'Shop');
      const saves = await openWindow(page, 'Saved Games');
      const exportPath = join(elsewhere, 'Shop.fisave');

      await launched.app.evaluate(({ dialog }) => {
        dialog.showSaveDialog = () => Promise.resolve({ canceled: true, filePath: '' });
      });
      await saves.getByRole('button', { name: 'Export Shop' }).click();
      await expect(saves.getByTestId('saves-outcome')).toHaveText('Export cancelled.');

      await launched.app.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
      }, exportPath);
      await saves.getByRole('button', { name: 'Export Shop' }).click();
      await expect(saves.getByTestId('saves-outcome')).toHaveText('Exported "Shop".');
      expect(existsSync(exportPath)).toBe(true);

      await launched.app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
      }, exportPath);
      await saves.getByRole('button', { name: 'Import…' }).click();
      await expect(saves.getByTestId('saves-outcome')).toHaveText('Imported "Shop".');
      await expect(saves.getByTestId('save-row')).toHaveCount(2);

      const notASave = join(elsewhere, 'notes.fisave');
      writeFileSync(notASave, 'shopping list');
      await launched.app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
      }, notASave);
      await saves.getByRole('button', { name: 'Import…' }).click();
      await expect(saves.getByTestId('saves-outcome')).toHaveText(
        'Import failed (SAVE_INCOMPATIBLE): This file is not a FreeIndustry save.',
      );
      await expect(saves.getByTestId('save-row')).toHaveCount(2);

      // The renderer can name saves only by ID; paths and traversal are refused in main.
      const refused = await page.evaluate(async () => {
        const saves = window.freeIndustry?.saves;
        return [
          await saves?.load('../../../Windows/win.ini'),
          await (saves?.exportSave as unknown as (id: string, path: string) => Promise<unknown>)(
            'C:/Windows',
            'C:/x.fisave',
          ),
        ];
      });
      expect(refused).toMatchObject([
        { ok: false, error: { code: 'MALFORMED_REQUEST' } },
        { ok: false, error: { code: 'MALFORMED_REQUEST' } },
      ]);
    } finally {
      await launched.close();
      removeUserData(launched);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('after the worker thread dies, its accepted commands come back as a "Recovered session"', async () => {
    const launched = await launchApp({ faultInjection: true });
    try {
      const page = await ready(launched);
      await plan(page);
      const beforeCrash = await world(page);
      // The thread exits before answering, so the command is never confirmed.
      const lost = await page.evaluate(
        (envelope) => window.freeIndustry?.simulation.submitCommand(envelope as never),
        {
          commandId: uuid(9),
          worldInstanceId: beforeCrash.worldInstanceId,
          expectedWorldRevision: beforeCrash.worldRevision,
          type: 'diagnostics.injectFault',
          payload: { fault: 'thread-exit' },
        },
      );
      expect(lost).toMatchObject({ ok: false, error: { code: 'WORKER_UNAVAILABLE' } });
      await expect(page.getByRole('heading', { name: 'Simulation worker stopped' })).toBeVisible();
      await page.getByRole('button', { name: 'Restart worker' }).click();
      await expect(page.getByTestId('worker-state')).toHaveText('Ready');
      const saves = await openWindow(page, 'Saved Games');
      await expect(saves.getByTestId('session-notice')).toContainText(
        'The previous session ended unexpectedly. It was rebuilt up to its last accepted command',
      );
      await expect(page.getByTestId('status-alerts')).toContainText(
        'The previous session ended unexpectedly.',
      );
      await loadSave(page, 'Recovered session');
      const recovered = await world(page);
      expect(recovered.fingerprint).toEqual(beforeCrash.fingerprint);
      expect(recovered.worldRevision).toBe(4);
    } finally {
      await launched.close();
      removeUserData(launched);
    }
  });
});
