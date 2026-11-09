import { ZOOM_STEPS } from '../plan-transform';

/**
 * The factory camera (spec §3.3, §11.3; DECISIONS ADR-0044, ADR-0051): one
 * orthographic projection straight down, shared by the layout, operating and
 * inspection modes. Its whole state is a centre point in world millimetres
 * and a step on the fixed zoom ladder. It has no tilt, pitch, yaw or
 * rotation and is always north-up. World-to-screen is one affine map,
 *
 *   screen = (mm − centre) × pixelsPerMetre ÷ 1000 + viewport centre,
 *
 * and screen-to-world is its exact inverse. A zoom step changes only how many
 * pixels stand for a metre, never the size of anything. Presentation only:
 * the worker never sees pixels.
 */

export type FactoryMode = 'layout' | 'operating' | 'inspection';

export const FACTORY_MODES: readonly FactoryMode[] = ['operating', 'layout', 'inspection'];

export interface Camera {
  /** World point at the viewport centre, integer millimetres in the level's frame. */
  readonly centreXMm: number;
  readonly centreYMm: number;
  /** Index into `ZOOM_STEPS`. */
  readonly zoomIndex: number;
}

/** The size of the drawing surface, in CSS pixels. */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface WorldPoint {
  readonly xMm: number;
  readonly yMm: number;
}

export interface WorldRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly depth: number;
}

export function clampZoom(index: number): number {
  return Math.min(ZOOM_STEPS.length - 1, Math.max(0, Math.round(index)));
}

export function pixelsPerMetreOf(camera: Pick<Camera, 'zoomIndex'>): number {
  return ZOOM_STEPS[clampZoom(camera.zoomIndex)] ?? 10;
}

/**
 * The viewport centre in whole CSS pixels, so the map's constant term is an
 * integer and the inverse stays exact.
 */
function viewportCentre(viewport: ViewportSize): ScreenPoint {
  return { x: Math.floor(viewport.width / 2), y: Math.floor(viewport.height / 2) };
}

export function worldToScreen(
  camera: Camera,
  viewport: ViewportSize,
  xMm: number,
  yMm: number,
): ScreenPoint {
  const ppm = pixelsPerMetreOf(camera);
  const centre = viewportCentre(viewport);
  return {
    x: ((xMm - camera.centreXMm) * ppm) / 1000 + centre.x,
    y: ((yMm - camera.centreYMm) * ppm) / 1000 + centre.y,
  };
}

/**
 * Resolve to a millionth of a millimetre, far below anything physical, so
 * floating-point noise from the forward map (about 10⁻¹⁴ mm) cancels and
 * every whole millimetre comes back exactly.
 */
const RESOLUTION = 1e6;
const resolve = (mm: number) => Math.round(mm * RESOLUTION) / RESOLUTION + 0;

export function screenToWorld(
  camera: Camera,
  viewport: ViewportSize,
  x: number,
  y: number,
): WorldPoint {
  const ppm = pixelsPerMetreOf(camera);
  const centre = viewportCentre(viewport);
  return {
    xMm: resolve(((x - centre.x) * 1000) / ppm + camera.centreXMm),
    yMm: resolve(((y - centre.y) * 1000) / ppm + camera.centreYMm),
  };
}

/**
 * The parameters of the affine map for a scene graph: a uniform scale (no
 * shear, no rotation) and a translation.
 */
export function cameraTransform(camera: Camera, viewport: ViewportSize) {
  const scale = pixelsPerMetreOf(camera) / 1000;
  const centre = viewportCentre(viewport);
  return {
    scale,
    x: centre.x - camera.centreXMm * scale,
    y: centre.y - camera.centreYMm * scale,
  };
}

/** The world rectangle the viewport shows, in millimetres. */
export function visibleWorldRect(camera: Camera, viewport: ViewportSize): WorldRect {
  const topLeft = screenToWorld(camera, viewport, 0, 0);
  const bottomRight = screenToWorld(camera, viewport, viewport.width, viewport.height);
  return {
    x: topLeft.xMm,
    y: topLeft.yMm,
    width: bottomRight.xMm - topLeft.xMm,
    depth: bottomRight.yMm - topLeft.yMm,
  };
}

/** A camera centred on a rectangle (a level's bounds), at a zoom step. */
export function cameraOn(rect: WorldRect, zoomIndex: number): Camera {
  return {
    centreXMm: Math.round(rect.x + rect.width / 2),
    centreYMm: Math.round(rect.y + rect.depth / 2),
    zoomIndex: clampZoom(zoomIndex),
  };
}

/** Move the view by a screen distance (a drag): the floor follows the pointer. */
export function panBy(camera: Camera, dxPx: number, dyPx: number): Camera {
  const ppm = pixelsPerMetreOf(camera);
  return {
    ...camera,
    centreXMm: Math.round(camera.centreXMm - (dxPx * 1000) / ppm),
    centreYMm: Math.round(camera.centreYMm - (dyPx * 1000) / ppm),
  };
}

/**
 * Change the zoom step keeping the world point under `anchor` (the pointer,
 * or the viewport centre) where it is, to within the millimetre the centre is
 * rounded to.
 */
export function zoomAbout(
  camera: Camera,
  viewport: ViewportSize,
  zoomIndex: number,
  anchor: ScreenPoint = viewportCentre(viewport),
): Camera {
  const next = clampZoom(zoomIndex);
  if (next === camera.zoomIndex) {
    return camera;
  }
  const under = screenToWorld(camera, viewport, anchor.x, anchor.y);
  const ppm = ZOOM_STEPS[next] ?? 10;
  const centre = viewportCentre(viewport);
  return {
    zoomIndex: next,
    centreXMm: Math.round(under.xMm - ((anchor.x - centre.x) * 1000) / ppm),
    centreYMm: Math.round(under.yMm - ((anchor.y - centre.y) * 1000) / ppm),
  };
}

/** Keep the centre within the level (plus a margin), so the floor cannot be lost off-screen. */
export function clampToBounds(camera: Camera, bounds: WorldRect, marginMm = 2000): Camera {
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  return {
    ...camera,
    centreXMm: clamp(camera.centreXMm, bounds.x - marginMm, bounds.x + bounds.width + marginMm),
    centreYMm: clamp(camera.centreYMm, bounds.y - marginMm, bounds.y + bounds.depth + marginMm),
  };
}
