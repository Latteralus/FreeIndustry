import { expect, test, type Page } from '@playwright/test';
import {
  chooseMenu,
  diagnostics,
  loadSave,
  saveAs,
  waitReady,
  watchCsp,
  windowFrame,
  world,
} from './support/desktop';
import { mustBeDrawn, pointAtMm, sceneReady, zoomTo } from './support/factory';
import { launchApp, removeUserData } from './support/launch';

/**
 * Plan Step 10 in the real app: goods arrive by the development test
 * delivery at the workshop's roller shutter, are drawn top-down at their
 * exact footprints in every mode, and a click on a pallet opens its record —
 * contents, the cartons it carries, each lot's provenance back to the
 * delivery and its history. Scrapping part of a lot through the Stock window
 * writes its cost down exactly; a delivery with no room left is refused with
 * the fingerprint unchanged; everything survives save, quit, relaunch and
 * load identically.
 */

const SITE = 'hf-canal-8';

async function submit(page: Page, type: string, payload: unknown): Promise<string> {
  return page.evaluate(
    async ({ type, payload }) => {
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
        type,
        payload,
      });
      return submitted.ok ? 'ok' : submitted.error.message;
    },
    { type, payload },
  );
}

async function balance(page: Page, code: string): Promise<bigint> {
  const snapshot = await world(page);
  return BigInt(snapshot.company?.accounts.find((item) => item.code === code)?.balanceCents ?? '0');
}

async function mode(page: Page, name: 'Operating' | 'Layout' | 'Inspection') {
  await page
    .getByRole('toolbar', { name: 'Factory view' })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(page.getByTestId('facility-floor-plan')).toHaveAttribute(
    'data-mode',
    name.toLowerCase(),
  );
}

test('Step 10: stock delivered, drawn to its footprint, inspected to its provenance, scrapped exactly, surviving a restart', async () => {
  const first = await launchApp({ seed: 1910, sceneProbe: true });
  let userDataDir = first.userDataDir;
  try {
    const page = await waitReady(first.page);
    const cspViolations = await watchCsp(page);
    expect(
      await submit(page, 'company.found', {
        legalName: 'Stock Works',
        presidentName: 'Sam Stores',
        startingCapitalCents: '5000000',
        premises: { propertyId: SITE, termMonths: 12, standingOrder: true },
      }),
    ).toBe('ok');

    // 1. A test delivery through the Diagnostics window: four cartons of 200 screws on a pallet.
    const cashBefore = await balance(page, '1010');
    const tab = await diagnostics(page, 'Test delivery');
    await tab.getByLabel('Product').selectOption('wood-screw-8-1-25');
    await tab.getByLabel('Container', { exact: true }).selectOption('carton-24x16x16');
    await tab.getByLabel('Containers', { exact: true }).fill('4');
    await tab.getByLabel(/Each holds/).fill('200');
    await tab.getByLabel('Loaded on').selectOption('gma-pallet');
    await tab.getByLabel('Containers per pallet').fill('4');
    await tab.getByLabel('Total cost ($)').fill('41.60');
    await tab.getByRole('button', { name: 'Deliver' }).click();
    await expect.poll(() => balance(page, '1300')).toBe(4160n);
    expect(await balance(page, '1010')).toBe(cashBefore - 4160n);
    let snapshot = await world(page);
    expect(snapshot.stock?.loadUnits.map((unit) => [unit.id, unit.kind])).toEqual([
      ['load-unit:1', 'pallet'],
      ['load-unit:2', 'carton'],
      ['load-unit:3', 'carton'],
      ['load-unit:4', 'carton'],
      ['load-unit:5', 'carton'],
    ]);
    // 2. A second pallet, of six serialized motors; the shutter's landing then has no room.
    expect(
      await submit(page, 'diagnostics.deliverTestStock', {
        productId: 'motor-half-hp',
        grade: null,
        containerTypeId: 'gma-pallet',
        containers: 1,
        quantityPerContainerMicro: '6000000',
        palletTypeId: null,
        containersPerPallet: null,
        totalCostCents: '54000',
      }),
    ).toBe('ok');
    const full = await world(page);
    expect(
      await submit(page, 'diagnostics.deliverTestStock', {
        productId: 'motor-half-hp',
        grade: null,
        containerTypeId: 'gma-pallet',
        containers: 1,
        quantityPerContainerMicro: '6000000',
        palletTypeId: null,
        containersPerPallet: null,
        totalCostCents: '54000',
      }),
    ).toMatch(/There is no room for a Wooden pallet/);
    expect((await world(page)).fingerprint).toEqual(full.fingerprint);

    // 3. Drawn top-down at exactly its footprint, the same in every mode.
    await chooseMenu(page, 'Window', 'Close All');
    await sceneReady(page);
    await zoomTo(page, 40);
    snapshot = await world(page);
    const pallet = snapshot.stock?.loadUnits.find((unit) => unit.id === 'load-unit:1');
    if (pallet?.location.kind !== 'floor') {
      throw new Error('the pallet is not on the floor');
    }
    const rect = pallet.location.rect;
    await page.getByRole('button', { name: 'Centre' }).click();
    const drawn: { width: number; height: number }[] = [];
    for (const name of ['Operating', 'Layout', 'Inspection'] as const) {
      await mode(page, name);
      const bounds = await mustBeDrawn(page, 'load-unit:1');
      drawn.push({
        width: Math.round(bounds.width * 100) / 100,
        height: Math.round(bounds.height * 100) / 100,
      });
      await page
        .getByTestId('factory-viewport')
        .screenshot({ path: `test-results/step10-stock-${name.toLowerCase()}.png` });
    }
    for (const size of drawn) {
      expect(size).toEqual({ width: (rect.width * 40) / 1000, height: (rect.depth * 40) / 1000 });
    }

    // 4. Click the pallet: its record, then its contents and provenance in the Stock window.
    await mode(page, 'Operating');
    await pointAtMm(page, rect.x + rect.width / 2, rect.y + rect.depth / 2, true);
    const record = page.getByTestId('selection-record');
    await expect(record).toHaveAttribute('data-entity-id', 'load-unit:1');
    await expect(record).toContainText('0 lots, 4 load units inside');
    await record.getByRole('button', { name: 'Contents and provenance…' }).click();
    const stock = windowFrame(page, 'Stock');
    const card = stock.getByTestId('stock-record');
    await expect(card).toHaveAttribute('data-entity-id', 'load-unit:1');
    await expect(card).toContainText('Wooden pallet, 48 × 40 in (load-unit:1)');
    await expect(stock.getByTestId('stock-whereabouts')).toContainText(
      'the floor of 8 Canal Street',
    );
    await card.getByRole('button', { name: /Corrugated carton.*\(load-unit:2\)/ }).click();
    await expect(card).toHaveAttribute('data-entity-id', 'load-unit:2');
    await expect(stock.getByTestId('stock-record-lot-lot:1')).toContainText('200 each');
    await expect(stock.getByTestId('stock-provenance-lot:1')).toContainText(
      'lot:1 received 1996-01-01 from Diagnostic supplier (stock-receipt:1',
    );
    await expect(stock.getByTestId('stock-history')).toContainText('Received');

    // 5. Scrap 20 screws: they stay in the carton as their own lot, and $1.04 is written down.
    const inventory = await balance(page, '1300');
    await stock
      .getByTestId('stock-record-lot-lot:1')
      .getByRole('button', { name: 'Scrap…' })
      .click();
    await stock.getByLabel(/^Quantity/).fill('20');
    await stock.getByLabel('Reason').selectOption('damaged');
    await stock.getByRole('button', { name: 'Classify as scrap' }).click();
    await expect.poll(() => balance(page, '1300')).toBe(inventory - 104n);
    expect(await balance(page, '5910')).toBe(104n);
    await expect(stock.getByTestId('stock-record-lot-lot:6')).toContainText('Scrap');
    await stock.getByRole('tab', { name: 'Stock-take' }).click();
    await expect(stock.getByTestId('stock-reconciliation')).toContainText('(they agree)');
    expect(await cspViolations()).toEqual([]);

    // 6. Save, quit, relaunch, load: identical fingerprints, stock and books.
    await saveAs(page, 'Canal stock');
    const saved = await world(page);
    await first.close();
    const second = await launchApp({ seed: 7, userDataDir, sceneProbe: true });
    userDataDir = second.userDataDir;
    try {
      const again = await waitReady(second.page);
      await loadSave(again, 'Canal stock');
      const loaded = await world(again);
      expect(loaded.fingerprint).toEqual(saved.fingerprint);
      expect(loaded.stock).toEqual(saved.stock);
      expect(loaded.company).toEqual(saved.company);
      await chooseMenu(again, 'Window', 'Close All');
      await sceneReady(again);
      await zoomTo(again, 40);
      const bounds = await mustBeDrawn(again, 'load-unit:1');
      expect(Math.round(bounds.width * 100) / 100).toBe((rect.width * 40) / 1000);
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    removeUserData({ ...first, userDataDir });
  }
});
