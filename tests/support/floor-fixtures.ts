import type { PremisesLevelView } from '../../src/shared/ipc/facilities';

/**
 * Level drawings for floor-rendering tests (plan Step 09 "floor rendering"):
 * plain rectangular floors with a chosen covering per cell. Nothing in the
 * game can lay a covering until Step 09A, so the floor layer is measured on
 * these. They are drawings only, shaped exactly like the worker's level view.
 */

export interface FixtureCovering {
  readonly col: number;
  readonly row: number;
  readonly materialId: string;
}

export function rectangularLevel(
  widthMm: number,
  depthMm: number,
  coverings: readonly FixtureCovering[] = [],
): PremisesLevelView {
  const cols = Math.ceil(widthMm / 500);
  const rows = Math.ceil(depthMm / 500);
  const area = String(BigInt(widthMm) * BigInt(depthMm));
  const eligibleRuns: [number, number, number][] = [];
  for (let row = 0; row < rows; row += 1) {
    eligibleRuns.push([row, 0, cols]);
  }
  return {
    index: 0,
    name: 'Fixture floor',
    elevationMm: 0,
    clearHeightMm: 6000,
    floorLoadKgPerM2: 2500,
    floor: [
      { x: 0, y: 0 },
      { x: widthMm, y: 0 },
      { x: widthMm, y: depthMm },
      { x: 0, y: depthMm },
    ],
    bounds: { x: 0, y: 0, width: widthMm, depth: depthMm },
    outlineAreaMm2: area,
    usableAreaMm2: area,
    cells: { cols, rows, full: cols * rows, partial: 0, outside: 0 },
    eligibleRuns,
    partialCells: [],
    features: [],
    keepClear: [],
    coverings: [...coverings],
  };
}

/** Bands of four materials across a floor, a band every `bandCells` columns. */
export function bandedCoverings(
  cols: number,
  rows: number,
  materials: readonly string[],
  bandCells: number,
): FixtureCovering[] {
  const out: FixtureCovering[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const band = Math.floor(col / bandCells) % (materials.length + 1);
      const materialId = materials[band - 1];
      if (band > 0 && materialId) {
        out.push({ col, row, materialId });
      }
    }
  }
  return out;
}
