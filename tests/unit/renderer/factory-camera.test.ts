import fc from 'fast-check';
import {
  cameraOn,
  cameraTransform,
  clampToBounds,
  FACTORY_MODES,
  panBy,
  pixelsPerMetreOf,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAbout,
  type Camera,
} from '../../../src/renderer/scenes/factory/camera';
import { snap, ZOOM_STEPS } from '../../../src/renderer/scenes/plan-transform';

/**
 * The factory camera (plan Step 09 "transform and camera tests"; D11,
 * ADR-0044, ADR-0051): one orthographic, north-up map shared by every mode.
 * World ↔ screen round-trips exactly at every zoom step; a 500 mm cell and
 * a footprint measure exactly mm × pixels per metre ÷ 1,000; the camera has
 * a centre and a zoom step and nothing else.
 */

const zoomIndex = fc.integer({ min: 0, max: ZOOM_STEPS.length - 1 });
const camera = fc.record({
  centreXMm: fc.integer({ min: -50_000, max: 250_000 }),
  centreYMm: fc.integer({ min: -50_000, max: 250_000 }),
  zoomIndex,
});
const viewport = fc.record({
  width: fc.integer({ min: 1, max: 4000 }),
  height: fc.integer({ min: 1, max: 3000 }),
});

describe('factory camera', () => {
  it('round-trips world ↔ screen exactly on the 250 mm lattice at every zoom step', () => {
    fc.assert(
      fc.property(
        camera,
        viewport,
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 0, max: 800 }),
        (cam, view, i, j) => {
          const screen = worldToScreen(cam, view, i * 250, j * 250);
          expect(screenToWorld(cam, view, screen.x, screen.y)).toEqual({
            xMm: i * 250,
            yMm: j * 250,
          });
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('round-trips every integer millimetre at every zoom step', () => {
    fc.assert(
      fc.property(
        camera,
        viewport,
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        (cam, view, x, y) => {
          const screen = worldToScreen(cam, view, x, y);
          const back = screenToWorld(cam, view, screen.x, screen.y);
          expect(Math.abs(back.xMm - x)).toBeLessThan(1e-6);
          expect(Math.abs(back.yMm - y)).toBeLessThan(1e-6);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('draws a 500 mm cell and a 3,658 × 1,829 mm footprint at mm × px/m ÷ 1000, wherever the camera is', () => {
    fc.assert(
      fc.property(camera, viewport, fc.integer({ min: 0, max: 100 }), (cam, view, k) => {
        const ppm = pixelsPerMetreOf(cam);
        const a = worldToScreen(cam, view, k * 500, k * 500);
        const b = worldToScreen(cam, view, k * 500 + 500, k * 500 + 500);
        expect(b.x - a.x).toBeCloseTo((500 * ppm) / 1000, 9);
        expect(b.y - a.y).toBeCloseTo((500 * ppm) / 1000, 9);
        const c = worldToScreen(cam, view, 3658, 1829);
        const o = worldToScreen(cam, view, 0, 0);
        expect(c.x - o.x).toBeCloseTo((3658 * ppm) / 1000, 9);
        expect(c.y - o.y).toBeCloseTo((1829 * ppm) / 1000, 9);
      }),
    );
  });

  it('holds a centre and a zoom step only: no tilt, no rotation, always north-up', () => {
    const cam = cameraOn({ x: 0, y: 0, width: 3000, depth: 5800 }, 2);
    expect(Object.keys(cam).sort()).toEqual(['centreXMm', 'centreYMm', 'zoomIndex']);
    // North-up and unrotated: +x is screen right, +y is screen down, at equal scale.
    const view = { width: 800, height: 600 };
    const o = worldToScreen(cam, view, 0, 0);
    const east = worldToScreen(cam, view, 1000, 0);
    const south = worldToScreen(cam, view, 0, 1000);
    expect(east.y).toBe(o.y);
    expect(south.x).toBe(o.x);
    expect(east.x - o.x).toBe(south.y - o.y);
    // The scene graph gets a uniform scale and a translation: nothing else to tilt.
    expect(Object.keys(cameraTransform(cam, view)).sort()).toEqual(['scale', 'x', 'y']);
  });

  it('every mode shares the one projection: the map takes no mode at all', () => {
    expect(FACTORY_MODES).toEqual(['operating', 'layout', 'inspection']);
    // worldToScreen(camera, viewport, x, y): a mode cannot change where anything is drawn.
    expect(worldToScreen.length).toBe(4);
    expect(screenToWorld.length).toBe(4);
  });

  it('the scene-graph transform is the same map as worldToScreen', () => {
    fc.assert(
      fc.property(camera, viewport, fc.integer({ min: 0, max: 100_000 }), (cam, view, x) => {
        const t = cameraTransform(cam, view);
        const screen = worldToScreen(cam, view, x, x);
        expect(x * t.scale + t.x).toBeCloseTo(screen.x, 6);
        expect(x * t.scale + t.y).toBeCloseTo(screen.y, 6);
      }),
    );
  });

  it('zooming changes pixels per metre and keeps the point under the pointer within a millimetre', () => {
    fc.assert(
      fc.property(
        camera,
        viewport,
        zoomIndex,
        fc.integer({ min: 0, max: 4000 }),
        fc.integer({ min: 0, max: 3000 }),
        (cam, view, next, ax, ay) => {
          const anchor = { x: Math.min(ax, view.width), y: Math.min(ay, view.height) };
          const before = screenToWorld(cam, view, anchor.x, anchor.y);
          const zoomed = zoomAbout(cam, view, next, anchor);
          expect(zoomed.zoomIndex).toBe(next);
          const after = screenToWorld(zoomed, view, anchor.x, anchor.y);
          expect(Math.abs(after.xMm - before.xMm)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(after.yMm - before.yMm)).toBeLessThanOrEqual(0.5);
          expect(Number.isInteger(zoomed.centreXMm) && Number.isInteger(zoomed.centreYMm)).toBe(
            true,
          );
        },
      ),
    );
  });

  it('panning moves the floor with the pointer and keeps the zoom', () => {
    const cam: Camera = { centreXMm: 10_000, centreYMm: 10_000, zoomIndex: 2 };
    const moved = panBy(cam, 50, -20);
    // 10 px a metre: 50 px is 5 m.
    expect(moved).toEqual({ centreXMm: 5000, centreYMm: 12_000, zoomIndex: 2 });
    const view = { width: 400, height: 300 };
    const a = worldToScreen(cam, view, 7000, 7000);
    const b = worldToScreen(moved, view, 7000, 7000);
    expect([b.x - a.x, b.y - a.y]).toEqual([50, -20]);
  });

  it('shows the floor it is centred on, and cannot be panned away from it', () => {
    const bounds = { x: 0, y: 0, width: 24_000, depth: 40_000 };
    const cam = cameraOn(bounds, 2);
    expect(cam).toEqual({ centreXMm: 12_000, centreYMm: 20_000, zoomIndex: 2 });
    expect(visibleWorldRect(cam, { width: 240, height: 400 })).toEqual(bounds);
    expect(clampToBounds({ ...cam, centreXMm: -90_000, centreYMm: 900_000 }, bounds)).toEqual({
      centreXMm: -2000,
      centreYMm: 42_000,
      zoomIndex: 2,
    });
  });

  it('snaps to the 500 mm grid or the 250 mm sub-grid', () => {
    expect(snap(1240, 500)).toBe(1000);
    expect(snap(1260, 500)).toBe(1500);
    expect(snap(1260, 250)).toBe(1250);
  });
});
