/**
 * Plan scale constants shared by every drawing of the factory (spec §11.3,
 * DECISIONS ADR-0042, ADR-0044, ADR-0045, ADR-0051). A zoom step only
 * chooses how many pixels stand for a metre, the same for every building; it
 * never changes the physical size of anything. The factory camera
 * (`factory/camera.ts`) holds the one world-to-screen map. Presentation
 * only: the worker never sees pixels.
 */

/** The fixed zoom ladder, in pixels per metre (ADR-0042, ADR-0050). */
export const ZOOM_STEPS = [2.5, 5, 10, 20, 40, 80] as const;
export const DEFAULT_ZOOM_INDEX = 2;

/** The construction grid and the placement lattice (ADR-0045). */
export const GRID_MM = 500;
export const LATTICE_MM = 250;

/** Round a millimetre value to the nearest multiple of `stepMm` (500 by default, 250 with the sub-grid). */
export function snap(mm: number, stepMm: number): number {
  return Math.round(mm / stepMm) * stepMm;
}
