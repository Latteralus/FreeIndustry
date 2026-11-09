import { expect, test, type Page } from '@playwright/test';
import { chooseMenu, loadSave, saveAs, waitReady, windowFrame, world } from './support/desktop';
import {
  drawnBounds,
  drawnSize,
  mustBeDrawn,
  pointAtMm as pointAt,
  sceneReady,
  zoomTo,
} from './support/factory';
import { launchApp, removeUserData } from './support/launch';

/**
 * Step 08 acceptance in the real app: a leased garage is drawn small and a
 * warehouse large at the same zoom, from their geometry; layout mode shows
 * the construction grid; an oversized machine is refused with its
 * dimensions and changes nothing; a bench is bought through the books,
 * installed exactly to its footprint and moved for a fee; zooming never
 * changes its physical size; and every placement and expenditure survives
 * save, quit, relaunch and load with identical fingerprints.
 */

/** Found a company leasing `propertyId`, through the real command over IPC. */
async function foundLeasing(page: Page, propertyId: string, termMonths: number): Promise<void> {
  const result = await page.evaluate(
    async ({ propertyId, termMonths }) => {
      const bridge = window.freeIndustry;
      const snapshot = await bridge?.simulation.getSnapshot();
      const current = snapshot?.ok ? snapshot.value.world : null;
      if (!bridge || !current) {
        return 'no world';
      }
      const submitted = await bridge.simulation.submitCommand({
        commandId: crypto.randomUUID(),
        worldInstanceId: current.worldInstanceId,
        expectedWorldRevision: current.worldRevision,
        type: 'company.found',
        payload: {
          legalName: 'Layout Works',
          presidentName: 'Sam Planner',
          startingCapitalCents: '20000000',
          premises: { propertyId, termMonths, standingOrder: true },
        },
      });
      return submitted.ok ? 'ok' : submitted.error.message;
    },
    { propertyId, termMonths },
  );
  expect(result).toBe('ok');
}

test('lay out a garage: grid, refusal, purchase, install, move, zoom; it survives a restart; a warehouse is drawn larger', async () => {
  const first = await launchApp({ seed: 1998, sceneProbe: true });
  let userDataDir = first.userDataDir;
  try {
    const page = await waitReady(first.page);
    await foundLeasing(page, 'hf-canal-2', 12);
    await chooseMenu(page, 'Window', 'Close All');
    await expect(page.getByTestId('status-facility')).toHaveText('Facility: 2 Canal Street (rear)');
    // 3.0 × 5.8 m at 10 px a metre; usable area and cells from the worker.
    await sceneReady(page);
    await expect.poll(() => drawnSize(page, 'floor')).toEqual({ width: 30, height: 58 });

    // Layout mode from the toolbar: the construction grid on 500 mm cells.
    await page
      .getByRole('toolbar', { name: 'Main toolbar' })
      .getByRole('button', { name: 'Factory' })
      .click();
    await expect(page.getByTestId('facility-floor-plan')).toHaveAttribute('data-mode', 'layout');
    await expect(page.getByLabel('Grid (500 mm)')).toBeChecked();
    await expect(page.getByTestId('level-area')).toContainText(
      '72 cells (66 full, 6 partial, 0 outside)',
    );
    await zoomTo(page, 80);
    await expect.poll(() => drawnSize(page, 'floor')).toEqual({ width: 240, height: 464 });

    // Buy an edge bander and try to install it: refused with its dimensions, nothing changes.
    await page
      .getByRole('toolbar', { name: 'Main toolbar' })
      .getByRole('button', { name: 'Equipment Catalog' })
      .click();
    let catalog = windowFrame(page, 'Equipment Catalog');
    await catalog.getByLabel('Spec sheet').selectOption('edge-bander');
    await expect(catalog.getByTestId('sheet-footprint')).toContainText('6,400 × 1,300 mm');
    await catalog.getByRole('button', { name: 'Buy' }).click();
    await expect(catalog.getByTestId('equipment-outcome')).toContainText(
      'Bought 1 × Automatic edge-banding machine',
    );
    await expect(page.getByTestId('status-cash')).toHaveText('Cash: $161,310.00');
    await catalog.getByRole('tab', { name: 'Owned' }).click();
    await catalog
      .getByTestId('owned-equipment:1')
      .getByRole('button', { name: 'Install…' })
      .click();
    await chooseMenu(page, 'Window', 'Close All');
    const beforeRefusal = await world(page);
    await pointAt(page, 1500, 2900);
    await expect(page.getByTestId('placement-ghost')).toHaveAttribute('data-allowed', 'false');
    await expect(page.getByTestId('placement-verdict')).toContainText(
      'does not fit: its footprint is 6,400 mm × 1,300 mm and the floor of 2 Canal Street (rear) is only 3,000 mm × 5,800 mm',
    );
    await pointAt(page, 1500, 2900, true);
    await expect(page.getByTestId('layout-refusal')).toContainText('does not fit');
    expect((await world(page)).fingerprint).toEqual(beforeRefusal.fingerprint);
    await page.keyboard.press('Escape');

    // Buy a bench and install it in the north-west corner, exactly to its footprint.
    catalog = await (async () => {
      await page
        .getByRole('toolbar', { name: 'Main toolbar' })
        .getByRole('button', { name: 'Equipment Catalog' })
        .click();
      return windowFrame(page, 'Equipment Catalog');
    })();
    await catalog.getByRole('tab', { name: 'Catalog' }).click();
    await catalog.getByLabel('Spec sheet').selectOption('steel-workbench');
    await catalog.getByRole('button', { name: 'Buy' }).click();
    await expect(page.getByTestId('status-cash')).toHaveText('Cash: $161,025.00');
    await catalog.getByRole('tab', { name: 'Owned' }).click();
    await catalog
      .getByTestId('owned-equipment:2')
      .getByRole('button', { name: 'Install…' })
      .click();
    await chooseMenu(page, 'Window', 'Close All');
    await pointAt(page, 900, 375);
    await expect(page.getByTestId('placement-ghost')).toHaveAttribute('data-allowed', 'true');
    await pointAt(page, 900, 375, true);
    await expect.poll(() => drawnBounds(page, 'equipment:2')).not.toBeNull();
    const pixels = () => drawnSize(page, 'equipment:2');
    // 1,800 × 750 mm at 80 px a metre.
    await expect.poll(pixels).toEqual({ width: 144, height: 60 });
    let snapshot = await world(page);
    expect(snapshot.facilities?.equipment[1]?.placement).toMatchObject({
      xMm: 0,
      yMm: 0,
      rotation: 0,
    });

    // Zooming changes pixels per metre, never the bench or the world.
    await zoomTo(page, 20);
    await expect.poll(pixels).toEqual({ width: 36, height: 15 });
    expect((await world(page)).fingerprint).toEqual(snapshot.fingerprint);
    await zoomTo(page, 80);

    // Move it a metre south for the dealer's $40 rigging charge.
    const bench = await mustBeDrawn(page, 'equipment:2');
    await page.mouse.click(bench.x + bench.width / 2, bench.y + bench.height / 2);
    await page.getByTestId('layout-status').getByRole('button', { name: 'Move…' }).click();
    await pointAt(page, 900, 1375);
    await expect(page.getByTestId('placement-verdict')).toContainText(
      'Allowed; the dealer charges $40.00',
    );
    await pointAt(page, 900, 1375, true);
    await expect(page.getByTestId('status-cash')).toHaveText('Cash: $160,985.00');
    snapshot = await world(page);
    expect(snapshot.facilities?.equipment[1]?.placement).toMatchObject({ xMm: 0, yMm: 1000 });

    // Save, quit, relaunch, load: the layout and the books are back exactly.
    await saveAs(page, 'Garage layout');
    const saved = await world(page);
    await first.close();
    const second = await launchApp({ seed: 7, userDataDir, sceneProbe: true });
    userDataDir = second.userDataDir;
    try {
      const again = await waitReady(second.page);
      await loadSave(again, 'Garage layout');
      const loaded = await world(again);
      expect(loaded.fingerprint).toEqual(saved.fingerprint);
      expect(loaded.facilities).toEqual(saved.facilities);
      expect(loaded.company).toEqual(saved.company);
      // The saved workspace had every window closed; the bench is drawn where it stood.
      await sceneReady(again);
      await expect.poll(() => drawnSize(again, 'equipment:2')).toEqual({ width: 18, height: 7.5 });

      // A large warehouse in a new world, at the same zoom: drawn far larger, in true proportion.
      const created = await again.evaluate(async () => {
        const result = await window.freeIndustry?.simulation.newWorld({
          scenarioId: 'standard',
          seed: 11,
        });
        return result?.ok === true;
      });
      expect(created).toBe(true);
      await foundLeasing(again, 'hf-canal-33', 12);
      await expect(again.getByTestId('status-facility')).toHaveText('Facility: 33 Canal Street');
      await zoomTo(again, 10);
      // 24 × 40 m at 10 px a metre, against the garage's 30 × 58 px.
      await expect.poll(() => drawnSize(again, 'floor')).toEqual({ width: 240, height: 400 });
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    removeUserData({ ...first, userDataDir });
  }
});
