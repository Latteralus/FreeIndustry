import { expect, type Page } from '@playwright/test';

/**
 * Real-app helpers for the PixiJS factory scene (plan Step 09). Sizes and
 * positions are read from the scene's own probe (`launchApp({ sceneProbe:
 * true })`): the bounds PixiJS computes for what it drew, in page pixels.
 */

export interface PageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export async function sceneReady(page: Page): Promise<void> {
  await expect(page.getByTestId('facility-floor-plan')).toHaveAttribute('data-scene-ready', 'true');
}

/** Where the scene drew `floor` (the outline) or an entity id, or null. */
export async function drawnBounds(page: Page, id: string): Promise<PageRect | null> {
  return (
    (await page.evaluate((target) => window.__freeIndustryScene?.boundsOf(target), id)) ?? null
  );
}

export async function mustBeDrawn(page: Page, id: string): Promise<PageRect> {
  const rect = await drawnBounds(page, id);
  if (!rect) {
    throw new Error(`nothing drawn for ${id}`);
  }
  return rect;
}

/** Drawn size to a hundredth of a pixel, for exact comparisons. */
export async function drawnSize(page: Page, id: string) {
  const rect = await mustBeDrawn(page, id);
  return {
    width: Math.round(rect.width * 100) / 100,
    height: Math.round(rect.height * 100) / 100,
  };
}

export async function zoomTo(page: Page, pixelsPerMetre: number): Promise<void> {
  const scale = page.getByTestId('viewport-scale');
  for (let guard = 0; guard < 10; guard += 1) {
    const current = Number((await scale.textContent())?.split(' ')[0]);
    if (current === pixelsPerMetre) {
      return;
    }
    await page
      .getByRole('button', { name: current < pixelsPerMetre ? 'Zoom in' : 'Zoom out' })
      .click();
  }
  throw new Error(`could not zoom to ${pixelsPerMetre}`);
}

/**
 * Point at (xMm, yMm) of the level through the camera the canvas reports:
 * page = host corner + (mm − centre) × px/m ÷ 1000 + the viewport's whole-pixel centre.
 */
export async function pointAtMm(page: Page, xMm: number, yMm: number, click = false) {
  const plan = page.getByTestId('facility-floor-plan');
  const box = await plan.boundingBox();
  const ppm = Number(await plan.getAttribute('data-pixels-per-metre'));
  const cx = Number(await plan.getAttribute('data-camera-x-mm'));
  const cy = Number(await plan.getAttribute('data-camera-y-mm'));
  const size = await plan.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
  }));
  if (!box) {
    throw new Error('no plan');
  }
  const x = box.x + ((xMm - cx) * ppm) / 1000 + Math.floor(size.width / 2);
  const y = box.y + ((yMm - cy) * ppm) / 1000 + Math.floor(size.height / 2);
  await page.mouse.move(x, y);
  if (click) {
    await page.mouse.click(x, y);
  }
}
