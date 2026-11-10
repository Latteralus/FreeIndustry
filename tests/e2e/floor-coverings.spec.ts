import { expect, test, type Page } from '@playwright/test';
import type { ClockControl } from '../../src/shared/ipc/clock';
import {
  chooseMenu,
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
 * Spec scenario S11 in the real app (plan Step 09A): in the L-shaped
 * factory at 8 Northgate Drive, with a bench installed beside steel column
 * A1, the floor is replaced across a rectangle and a filled area that include
 * the cells under the bench and the column's partial cells, through the
 * Floor Materials window and the layout floor tool. The worker's quote is the
 * exact covered area × prices and cash falls by exactly that, removal shown
 * separately; a cell outside the floor and an unaffordable order are refused
 * with the fingerprint unchanged; the bench and the slab are unchanged; the
 * floor is drawn overhead in every mode; and it all survives save, quit,
 * relaunch and load identically.
 */

const SITE = 'hf-ng-8';

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

/** Run the clock to the end of the current day and wait for the worker to stop there. */
async function endOfDay(page: Page): Promise<void> {
  const request: ClockControl = { action: 'advance', until: 'endOfDay' };
  await page.evaluate((value) => window.freeIndustry?.simulation.control(value), request);
  await expect.poll(async () => (await world(page)).clock.advance, { timeout: 15_000 }).toBeNull();
}

async function cash(page: Page): Promise<bigint> {
  const snapshot = await world(page);
  const account = snapshot.company?.accounts.find((item) => item.code === '1010');
  return BigInt(account?.balanceCents ?? '0');
}

/** Click a cell's centre on the plan. */
async function clickCell(page: Page, col: number, row: number): Promise<void> {
  await pointAtMm(page, col * 500 + 250, row * 500 + 250, true);
}

async function pixelAtCell(page: Page, col: number, row: number): Promise<number[]> {
  const floor = await mustBeDrawn(page, 'floor');
  const plan = page.getByTestId('facility-floor-plan');
  const ppm = Number(await plan.getAttribute('data-pixels-per-metre'));
  const read = await page.evaluate(
    (point) =>
      window.__freeIndustryScene?.readPixels({ x: point.x, y: point.y, width: 1, height: 1 }),
    {
      x: Math.floor(floor.x + ((col * 500 + 250) * ppm) / 1000),
      y: Math.floor(floor.y + ((row * 500 + 250) * ppm) / 1000),
    },
  );
  return read?.data.slice(0, 3) ?? [];
}

const hex = (colour: string) => {
  const value = Number.parseInt(colour.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

function expectColour(actual: number[], expected: number[]) {
  for (let channel = 0; channel < 3; channel += 1) {
    expect(Math.abs((actual[channel] ?? -999) - (expected[channel] ?? 0))).toBeLessThanOrEqual(3);
  }
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

test('S11: floor coverings bought across a rectangle and a fill, refusals unchanged, drawn in every mode, surviving a restart', async () => {
  const first = await launchApp({ seed: 1911, sceneProbe: true });
  let userDataDir = first.userDataDir;
  try {
    const page = await waitReady(first.page);
    const cspViolations = await watchCsp(page);
    expect(
      await submit(page, 'company.found', {
        legalName: 'Floor Works Ltd',
        presidentName: 'Robin Slab',
        startingCapitalCents: '15000000',
        premises: { propertyId: SITE, termMonths: 24, standingOrder: true },
      }),
    ).toBe('ok');
    expect(
      await submit(page, 'equipment.purchase', { equipmentTypeId: 'steel-workbench', quantity: 1 }),
    ).toBe('ok');
    expect(
      await submit(page, 'equipment.install', {
        equipmentId: 'equipment:1',
        propertyId: SITE,
        level: 0,
        xMm: 13000,
        yMm: 13000,
        rotation: 0,
      }),
    ).toBe('ok');
    await chooseMenu(page, 'Window', 'Close All');
    await sceneReady(page);
    const start = await world(page);
    const bench = start.facilities?.equipment[0]?.placement;
    const slab = start.realEstate?.properties.find((p) => p.id === SITE)?.floorLoadKgPerM2;
    const colours = new Map(
      (start.facilities?.floorMaterials ?? []).map((material) => [material.id, material.colour]),
    );

    // Catalog → Floor Materials: prices and samples; "Lay in layout…" opens the floor tool.
    await chooseMenu(page, 'Catalog', 'Floor Materials…');
    const catalog = windowFrame(page, 'Floor Materials');
    const epoxy = catalog.getByTestId('floor-material-epoxy-grey');
    await expect(epoxy).toContainText('$55.00/m²');
    await expect(catalog.getByTestId('floor-material-concrete-standard')).toContainText(
      '(your existing floor)',
    );
    await epoxy.getByRole('button', { name: 'Lay in layout…' }).click();
    await chooseMenu(page, 'Window', 'Close All');
    await expect(page.getByTestId('facility-floor-plan')).toHaveAttribute('data-mode', 'layout');
    const tool = page.getByTestId('floor-tool');
    await expect(tool).toHaveAttribute('data-material', 'epoxy-grey');
    await zoomTo(page, 10);
    await page.getByRole('button', { name: 'Centre' }).click();

    // 1. A rectangle of 10 × 10 cells round column A1 and under the bench: 24.84 m², $1,366.20.
    await clickCell(page, 20, 20);
    await clickCell(page, 29, 29);
    const quote = page.getByTestId('floor-quote');
    await expect(quote).toHaveAttribute('data-total', '136620');
    await expect(quote).toHaveAttribute('data-area', '24840000');
    await expect(quote).toContainText(
      '100 cells, 267.38 sq ft of Industrial epoxy, grey: laying $1,366.20',
    );
    await page
      .getByTestId('factory-viewport')
      .screenshot({ path: 'test-results/step09a-floor-preview.png' });
    let before = await cash(page);
    await quote.getByRole('button', { name: 'Order floor works' }).click();
    await expect.poll(() => cash(page)).toBe(before - 136_620n);
    await expect(page.getByTestId('floor-quote')).toHaveText('Nothing selected.');
    let snapshot = await world(page);
    expect(snapshot.facilities?.floorOrders[0]).toMatchObject({
      kind: 'installation',
      status: 'scheduled',
      installCents: '136620',
      removalCents: '0',
    });
    // Under works until the contractor finishes the next day.
    expect(snapshot.facilities?.premises?.levels[0]?.works).toHaveLength(1);
    await endOfDay(page);
    await endOfDay(page);
    snapshot = await world(page);
    expect(snapshot.facilities?.floorOrders[0]?.status).toBe('complete');

    // 2. A fill from inside the epoxy, in steel plate: a replacement, removal on its own line.
    await tool.getByLabel('Floor material').selectOption('steel-plate');
    await tool.getByRole('button', { name: 'Fill' }).click();
    await clickCell(page, 22, 22);
    await expect(quote).toHaveAttribute('data-total', '486864');
    await expect(quote).toHaveAttribute('data-install', '447120');
    await expect(quote).toHaveAttribute('data-removal', '39744');
    await expect(quote).toContainText('taking up 267.38 sq ft of Industrial epoxy, grey $397.44');
    before = await cash(page);
    await quote.getByRole('button', { name: 'Order floor works' }).click();
    await expect.poll(() => cash(page)).toBe(before - 486_864n);
    snapshot = await world(page);
    expect(snapshot.facilities?.floorOrders[1]).toMatchObject({
      kind: 'replacement',
      installCents: '447120',
      removalCents: '39744',
      costCents: '486864',
    });
    const removal = snapshot.company?.accounts.find((item) => item.code === '6310');
    expect(removal?.balanceCents).toBe('39744');
    await endOfDay(page);
    await endOfDay(page);

    // 3. Refusals with the fingerprint unchanged: a cell in the missing corner, then the whole level in diamond plate.
    const steady = await world(page);
    await tool.getByRole('button', { name: 'Single cell' }).click();
    await clickCell(page, 90, 120);
    await expect(quote).toContainText('Not allowed: 1 selected cell is outside the usable floor');
    expect(
      await submit(page, 'facility.installFloorCovering', {
        propertyId: SITE,
        level: 0,
        materialId: 'epoxy-grey',
        rectangles: [{ col: 90, row: 120, cols: 1, rows: 1 }],
      }),
    ).toMatch(/outside the usable floor/);
    await tool.getByLabel('Floor material').selectOption('diamond-plate');
    await tool.getByRole('button', { name: 'Whole level' }).click();
    await expect(quote).toHaveAttribute('data-allowed', 'false');
    await expect(quote).toContainText('Insufficient funds');
    await expect(quote.getByRole('button', { name: 'Order floor works' })).toBeDisabled();
    const whole = (steady.facilities?.premises?.levels[0]?.eligibleRuns ?? []).map(
      ([row, from, to]) => ({ col: from, row, cols: to - from, rows: 1 }),
    );
    expect(
      await submit(page, 'facility.installFloorCovering', {
        propertyId: SITE,
        level: 0,
        materialId: 'diamond-plate',
        rectangles: whole,
      }),
    ).toMatch(/^Insufficient funds/);
    expect((await world(page)).fingerprint).toEqual(steady.fingerprint);
    await tool.getByRole('button', { name: 'Close' }).click();

    // 4. The bench and the slab are unchanged.
    expect(steady.facilities?.equipment[0]?.placement).toEqual(bench);
    expect(steady.realEstate?.properties.find((p) => p.id === SITE)?.floorLoadKgPerM2).toBe(slab);

    // 5. Overhead in every mode: the same cells drawn in steel plate, untouched cells in the surface.
    for (const name of ['Operating', 'Layout', 'Inspection'] as const) {
      await mode(page, name);
      expectColour(await pixelAtCell(page, 21, 21), hex(colours.get('steel-plate') ?? ''));
      expectColour(await pixelAtCell(page, 21, 40), hex(colours.get('concrete-standard') ?? ''));
      await page
        .getByTestId('factory-viewport')
        .screenshot({ path: `test-results/step09a-floor-${name.toLowerCase()}.png` });
    }
    expect((await world(page)).fingerprint).toEqual(steady.fingerprint);
    expect(await cspViolations()).toEqual([]);

    // 6. Save, quit, relaunch, load: identical fingerprints, floor and books.
    await saveAs(page, 'Northgate floor');
    const saved = await world(page);
    await first.close();
    const second = await launchApp({ seed: 7, userDataDir, sceneProbe: true });
    userDataDir = second.userDataDir;
    try {
      const again = await waitReady(second.page);
      await loadSave(again, 'Northgate floor');
      const loaded = await world(again);
      expect(loaded.fingerprint).toEqual(saved.fingerprint);
      expect(loaded.facilities).toEqual(saved.facilities);
      expect(loaded.company).toEqual(saved.company);
      await sceneReady(again);
      await zoomTo(again, 10);
      await again.getByRole('button', { name: 'Centre' }).click();
      expectColour(await pixelAtCell(again, 21, 21), hex(colours.get('steel-plate') ?? ''));
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    removeUserData({ ...first, userDataDir });
  }
});
