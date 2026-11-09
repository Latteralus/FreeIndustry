import { expect, test, type Page } from '@playwright/test';
import type { PremisesLevelView } from '../../src/shared/ipc/facilities';
import { bandedCoverings, rectangularLevel } from '../support/floor-fixtures';
import { chooseMenu, waitReady, watchCsp, world } from './support/desktop';
import { drawnSize, mustBeDrawn, sceneReady, zoomTo } from './support/factory';
import { launchApp, removeUserData } from './support/launch';

/**
 * Plan Step 09 acceptance in the real app: the PixiJS factory scene, measured
 * through its read-only probe (`FREEINDUSTRY_SCENE_PROBE`, unpackaged runs
 * only). A garage and a warehouse at the same zoom are drawn in true
 * proportion; a machine's drawn bounds equal its footprint at every zoom; the
 * construction grid's lines fall on the exact 500 mm cell boundaries; every
 * mode draws the same machine in the same place, selects the same entity
 * and leaves the world hash alone; a mixed floor draws each cell's material,
 * a changed cell redraws only its chunk and leaves every machine sprite
 * untouched, and a 48,000-cell floor is drawn with display objects bounded by
 * the visible chunks. Screenshots of the three modes are kept for the
 * visual review in docs/TEST_SCENARIOS.md.
 */

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

async function foundLeasing(page: Page, propertyId: string): Promise<void> {
  expect(
    await submit(page, 'company.found', {
      legalName: 'Render Works',
      presidentName: 'Pat Plan',
      startingCapitalCents: '20000000',
      premises: { propertyId, termMonths: 12, standingOrder: true },
    }),
  ).toBe('ok');
}

async function stats(page: Page) {
  const result = await page.evaluate(() => window.__freeIndustryScene?.stats());
  if (!result) {
    throw new Error('no scene');
  }
  return result;
}

/** RGBA of one drawn pixel, at page coordinates. */
async function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  const read = await page.evaluate(
    (point) =>
      window.__freeIndustryScene?.readPixels({ x: point.x, y: point.y, width: 1, height: 1 }),
    { x: Math.floor(x), y: Math.floor(y) },
  );
  return read?.data.slice(0, 4) ?? [];
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

test('proportions, footprints, grid lines and one entity in every mode, measured on the canvas', async () => {
  const launched = await launchApp({ seed: 909, sceneProbe: true });
  try {
    const page = await waitReady(launched.page);
    const cspViolations = await watchCsp(page);
    await foundLeasing(page, 'hf-canal-2');
    expect(
      await submit(page, 'equipment.purchase', {
        equipmentTypeId: 'steel-workbench',
        quantity: 1,
      }),
    ).toBe('ok');
    expect(
      await submit(page, 'equipment.install', {
        equipmentId: 'equipment:1',
        propertyId: 'hf-canal-2',
        level: 0,
        xMm: 500,
        yMm: 1000,
        rotation: 0,
      }),
    ).toBe('ok');
    await chooseMenu(page, 'Window', 'Close All');
    await sceneReady(page);
    const before = await world(page);

    // The 3.0 × 5.8 m garage at 10 px a metre: 30 × 58 px.
    await expect(page.getByTestId('viewport-scale')).toHaveText('10 px/m');
    await expect
      .poll(async () => await drawnSize(page, 'floor'))
      .toEqual({
        width: 30,
        height: 58,
      });

    // The bench, 1,800 × 750 mm, drawn exactly to its footprint at every zoom step.
    for (const [ppm, width, height] of [
      [10, 18, 7.5],
      [20, 36, 15],
      [40, 72, 30],
      [80, 144, 60],
    ] as const) {
      await zoomTo(page, ppm);
      await expect
        .poll(async () => await drawnSize(page, 'equipment:1'))
        .toEqual({
          width,
          height,
        });
      const floor = await mustBeDrawn(page, 'floor');
      const bench = await mustBeDrawn(page, 'equipment:1');
      // At its real position: 500 mm east and 1,000 mm south of the floor's corner.
      expect(bench.x - floor.x).toBeCloseTo((500 * ppm) / 1000, 1);
      expect(bench.y - floor.y).toBeCloseTo((1000 * ppm) / 1000, 1);
    }

    // Every mode: same place, same size, same entity selected, nothing changed in the world.
    const reference = await mustBeDrawn(page, 'equipment:1');
    for (const name of ['Layout', 'Inspection', 'Operating'] as const) {
      await mode(page, name);
      expect(await mustBeDrawn(page, 'equipment:1')).toEqual(reference);
      await page.mouse.click(reference.x + reference.width / 2, reference.y + reference.height / 2);
      await expect(page.getByTestId('selection-record')).toHaveAttribute(
        'data-entity-id',
        'equipment:1',
      );
      await expect(page.getByTestId('hover-tooltip')).toHaveText('Steel workbench (equipment:1)');
    }
    expect((await world(page)).fingerprint).toEqual(before.fingerprint);

    // Grid lines on exact 500 mm cell boundaries: at 40 px a metre, a line every 20 px.
    await mode(page, 'Layout');
    await zoomTo(page, 40);
    await page.mouse.move(5, 5);
    const floor = await mustBeDrawn(page, 'floor');
    const y = floor.y + floor.height - 12;
    const row = await page.evaluate((rect) => window.__freeIndustryScene?.readPixels(rect), {
      x: Math.round(floor.x),
      y: Math.round(y),
      width: Math.round(floor.width),
      height: 1,
    });
    if (!row) {
      throw new Error('no pixels');
    }
    const lum = (index: number) =>
      (row.data[index * 4] ?? 0) + (row.data[index * 4 + 1] ?? 0) + (row.data[index * 4 + 2] ?? 0);
    // The darkest pixel in each 20 px span lies on the boundary (within the pixel a 1 px line straddles).
    const cells = Math.floor(row.width / 20);
    for (let cell = 1; cell < cells; cell += 1) {
      let darkest = -1;
      for (let x = cell * 20 - 6; x <= cell * 20 + 6; x += 1) {
        if (darkest < 0 || lum(x) < lum(darkest)) {
          darkest = x;
        }
      }
      expect(Math.abs(darkest - cell * 20)).toBeLessThanOrEqual(1);
    }
    // Switching the grid off removes those lines (the darkest pixel moves off the boundaries).
    await page.getByLabel('Grid (500 mm)').uncheck();
    const plain = await page.evaluate((rect) => window.__freeIndustryScene?.readPixels(rect), {
      x: Math.round(floor.x),
      y: Math.round(y),
      width: Math.round(floor.width),
      height: 1,
    });
    expect(plain?.data).not.toEqual(row.data);
    await page.getByLabel('Grid (500 mm)').check();

    // Screenshots for the visual review (TEST_SCENARIOS): every mode is overhead.
    await zoomTo(page, 80);
    for (const name of ['Layout', 'Operating', 'Inspection'] as const) {
      await mode(page, name);
      await page
        .getByTestId('factory-viewport')
        .screenshot({ path: `test-results/step09-garage-${name.toLowerCase()}.png` });
    }
    expect((await world(page)).fingerprint).toEqual(before.fingerprint);

    // A 24 × 40 m warehouse in a new world at the same zoom: 240 × 400 px against the garage's 30 × 58.
    const created = await page.evaluate(async () => {
      const result = await window.freeIndustry?.simulation.newWorld({
        scenarioId: 'standard',
        seed: 11,
      });
      return result?.ok === true;
    });
    expect(created).toBe(true);
    await foundLeasing(page, 'hf-canal-33');
    await sceneReady(page);
    await zoomTo(page, 10);
    await expect
      .poll(async () => await drawnSize(page, 'floor'))
      .toEqual({
        width: 240,
        height: 400,
      });
    expect(await cspViolations()).toEqual([]);
  } finally {
    await launched.close();
    removeUserData(launched);
  }
});

test('floor coverings: each cell its material, one dirty chunk per change, display objects bounded by the view', async () => {
  const launched = await launchApp({ seed: 910, sceneProbe: true });
  try {
    const page = await waitReady(launched.page);
    await foundLeasing(page, 'hf-canal-2');
    expect(
      await submit(page, 'equipment.purchase', { equipmentTypeId: 'steel-workbench', quantity: 1 }),
    ).toBe('ok');
    expect(
      await submit(page, 'equipment.install', {
        equipmentId: 'equipment:1',
        propertyId: 'hf-canal-2',
        level: 0,
        xMm: 0,
        yMm: 0,
        rotation: 0,
      }),
    ).toBe('ok');
    await chooseMenu(page, 'Window', 'Close All');
    await sceneReady(page);
    const before = await world(page);
    const materials = new Map(
      (before.facilities?.floorMaterials ?? []).map((material) => [material.id, material]),
    );
    const surface = before.facilities?.premises?.surfaceMaterialId ?? '';

    // A 120 × 100 m fixture floor: 48,000 cells in bands of three materials over the surface.
    const cols = 240;
    const rows = 200;
    const bands = ['epoxy-green', 'steel-plate', 'safety-hatching'];
    const coverings = bandedCoverings(cols, rows, bands, 4);
    const setFixture = (level: PremisesLevelView | null) =>
      page.evaluate((fixture) => {
        window.__freeIndustryScene?.setFixtureLevel(fixture);
      }, level);
    await setFixture(rectangularLevel(cols * 500, rows * 500, coverings));
    await expect(page.getByTestId('fixture-notice')).toBeVisible();
    await expect.poll(async () => (await stats(page)).floorCells).toBe(48_000);

    // At every zoom step, the floor is drawn by the visible chunks only.
    const viewport = await page.getByTestId('facility-floor-plan').boundingBox();
    if (!viewport) {
      throw new Error('no viewport');
    }
    const record: Record<string, unknown>[] = [];
    for (const ppm of [2.5, 5, 10, 20, 40, 80]) {
      await zoomTo(page, ppm);
      const now = await stats(page);
      const chunkPx = 8 * ppm;
      const bound =
        (Math.ceil(viewport.width / chunkPx) + 1) * (Math.ceil(viewport.height / chunkPx) + 1);
      expect(now.floorChunksVisible).toBeLessThanOrEqual(Math.min(bound, now.floorChunks));
      // Whole scene: a fixed handful of layers, one sprite per visible chunk, the machine.
      expect(now.displayObjects).toBeLessThanOrEqual(now.floorChunksVisible + 40);
      record.push({
        pixelsPerMetre: ppm,
        cells: now.floorCells,
        chunks: now.floorChunks,
        visibleChunks: now.floorChunksVisible,
        displayObjects: now.displayObjects,
        detail: now.floorDetail,
      });
    }
    console.log(`Step 09 floor display-object counts: ${JSON.stringify(record)}`);

    // Each cell its own material: flat colour at 10 px a metre, sampled at cell centres.
    await zoomTo(page, 10);
    await page.getByRole('button', { name: 'Centre' }).click();
    const fixtureFloor = await mustBeDrawn(page, 'floor');
    const centreOf = (col: number, row: number) => ({
      x: fixtureFloor.x + ((col * 500 + 250) * 10) / 1000,
      y: fixtureFloor.y + ((row * 500 + 250) * 10) / 1000,
    });
    // Columns 100–131 around the centre: surface, then a band of each material.
    for (const [col, materialId] of [
      [96, surface],
      [100, 'epoxy-green'],
      [105, 'steel-plate'],
      [110, 'safety-hatching'],
      [113, surface],
    ] as const) {
      const at = centreOf(col, 100);
      expectColour(
        await pixelAt(page, at.x, at.y),
        hex(materials.get(materialId)?.colour ?? '#000000'),
      );
    }

    // Change one cell: exactly one chunk is redrawn, and no machine sprite is touched.
    const steady = await stats(page);
    const changed = coverings.filter((cell) => cell.col !== 97 || cell.row !== 100);
    changed.push({ col: 97, row: 100, materialId: 'epoxy-green' });
    await setFixture(rectangularLevel(cols * 500, rows * 500, changed));
    await expect
      .poll(async () => (await stats(page)).floorChunkRedraws)
      .toBe(steady.floorChunkRedraws + 1);
    const after = await stats(page);
    expect(after.objectRedraws).toBe(steady.objectRedraws);
    expect(after.objectRedrawsById).toEqual(steady.objectRedrawsById);
    const at = centreOf(97, 100);
    expectColour(await pixelAt(page, at.x, at.y), hex(materials.get('epoxy-green')?.colour ?? ''));
    // Textured zoomed in: still each material's own colour family, with surface detail.
    await zoomTo(page, 40);
    expect((await stats(page)).floorDetail).toBe('texture');
    await page
      .getByTestId('factory-viewport')
      .screenshot({ path: 'test-results/step09-floor-fixture-40.png' });

    // The fixture was a drawing only: the world never changed.
    await setFixture(null);
    await expect(page.getByTestId('fixture-notice')).toHaveCount(0);
    expect((await world(page)).fingerprint).toEqual(before.fingerprint);
  } finally {
    await launched.close();
    removeUserData(launched);
  }
});

test('without the probe flag the scene exposes nothing', async () => {
  const launched = await launchApp({ seed: 911 });
  try {
    const page = await waitReady(launched.page);
    await foundLeasing(page, 'hf-canal-2');
    await chooseMenu(page, 'Window', 'Close All');
    await sceneReady(page);
    expect(await page.evaluate(() => typeof window.__freeIndustryScene)).toBe('undefined');
  } finally {
    await launched.close();
    removeUserData(launched);
  }
});
