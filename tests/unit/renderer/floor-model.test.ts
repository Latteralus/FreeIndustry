import fc from 'fast-check';
import {
  allChunks,
  buildFloorModel,
  cellVariant,
  CHUNK_CELLS,
  chunkKey,
  chunkRect,
  chunkRuns,
  dirtyChunks,
  floorDetail,
  materialAt,
  patternLines,
  visibleChunks,
} from '../../../src/renderer/scenes/factory/floor-model';
import { cameraOn, visibleWorldRect } from '../../../src/renderer/scenes/factory/camera';
import { ZOOM_STEPS } from '../../../src/renderer/scenes/plan-transform';
import { bandedCoverings, rectangularLevel } from '../../support/floor-fixtures';
import { sampleGarage } from '../../support/sample-facilities';

/**
 * The floor layer's model (plan Step 09 "floor rendering"; ADR-0046,
 * ADR-0051): coverings per cell from the worker's view, drawn and cached a
 * chunk at a time, culled to the camera, with a changed cell dirtying only
 * its own chunk, deterministic texture variants and level of detail.
 */

const MATERIALS = ['concrete-standard', 'epoxy-green', 'steel-plate', 'safety-hatching'];

describe('floor model', () => {
  it('reads the garage’s cells from the worker: every eligible cell has the starting surface', () => {
    const { facilities } = sampleGarage();
    const premises = facilities.premises;
    const level = premises?.levels[0];
    if (!premises || !level) {
      throw new Error('no premises');
    }
    const model = buildFloorModel(
      level,
      premises.surfaceMaterialId,
      facilities.floorMaterials.map((m) => m.id),
    );
    expect([model.cols, model.rows]).toEqual([6, 12]);
    let floorCells = 0;
    for (let row = 0; row < model.rows; row += 1) {
      for (let col = 0; col < model.cols; col += 1) {
        const material = materialAt(model, col, row);
        if (material !== null) {
          floorCells += 1;
          expect(material).toBe(premises.surfaceMaterialId);
        }
      }
    }
    expect(floorCells).toBe(level.cells.full + level.cells.partial);
    expect(materialAt(model, -1, 0)).toBeNull();
  });

  it('a fixture with mixed coverings gives each cell its own material, and a flat run per material', () => {
    const level = rectangularLevel(8000, 2000, [
      { col: 1, row: 0, materialId: 'epoxy-green' },
      { col: 2, row: 0, materialId: 'epoxy-green' },
      { col: 5, row: 1, materialId: 'steel-plate' },
    ]);
    const model = buildFloorModel(level, 'concrete-standard', MATERIALS);
    expect(materialAt(model, 0, 0)).toBe('concrete-standard');
    expect(materialAt(model, 1, 0)).toBe('epoxy-green');
    expect(materialAt(model, 5, 1)).toBe('steel-plate');
    const runs = chunkRuns(model, chunkKey(0, 0)).filter(([, row]) => row === 0);
    // Row 0: concrete (1 cell), epoxy (2 cells), concrete (13 cells): three rectangles, not 16.
    expect(runs.map(([col, , length, index]) => [col, length, model.materials[index]])).toEqual([
      [0, 1, 'concrete-standard'],
      [1, 2, 'epoxy-green'],
      [3, 13, 'concrete-standard'],
    ]);
  });

  it('changing one cell’s covering dirties only its own chunk', () => {
    const cols = 240;
    const rows = 200;
    const coverings = bandedCoverings(cols, rows, MATERIALS.slice(1), 7);
    const before = buildFloorModel(
      rectangularLevel(cols * 500, rows * 500, coverings),
      'concrete-standard',
      MATERIALS,
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: cols - 1 }),
        fc.integer({ min: 0, max: rows - 1 }),
        fc.constantFrom(...MATERIALS),
        (col, row, materialId) => {
          const changed = coverings.filter((cell) => cell.col !== col || cell.row !== row);
          changed.push({ col, row, materialId });
          const after = buildFloorModel(
            rectangularLevel(cols * 500, rows * 500, changed),
            'concrete-standard',
            MATERIALS,
          );
          const dirty = dirtyChunks(before, after);
          if (materialAt(before, col, row) === materialId) {
            expect(dirty.size).toBe(0);
          } else {
            expect([...dirty]).toEqual([
              chunkKey(Math.floor(col / CHUNK_CELLS), Math.floor(row / CHUNK_CELLS)),
            ]);
          }
        },
      ),
      { numRuns: 60 },
    );
    // An identical view dirties nothing; a different grid dirties everything.
    expect(
      dirtyChunks(
        before,
        buildFloorModel(
          rectangularLevel(cols * 500, rows * 500, coverings),
          'concrete-standard',
          MATERIALS,
        ),
      ).size,
    ).toBe(0);
    const resized = buildFloorModel(rectangularLevel(1000, 1000), 'concrete-standard', MATERIALS);
    expect(dirtyChunks(before, resized)).toEqual(new Set(allChunks(resized)));
  });

  it('a 48,000-cell floor is drawn with chunks bounded by the view, not by the cell count', () => {
    const level = rectangularLevel(120_000, 100_000);
    const model = buildFloorModel(level, 'concrete-standard', MATERIALS);
    expect(model.cols * model.rows).toBe(48_000);
    expect(allChunks(model)).toHaveLength(15 * 13);
    const viewport = { width: 1280, height: 720 };
    for (let zoom = 0; zoom < ZOOM_STEPS.length; zoom += 1) {
      const view = visibleWorldRect(cameraOn(level.bounds, zoom), viewport);
      const visible = visibleChunks(model, view);
      const ppm = ZOOM_STEPS[zoom] ?? 10;
      const chunkPx = 8 * ppm;
      // At most the chunks the screen can show (plus one partial on each side).
      const bound =
        (Math.ceil(viewport.width / chunkPx) + 1) * (Math.ceil(viewport.height / chunkPx) + 1);
      expect(visible.length).toBeLessThanOrEqual(Math.min(bound, 15 * 13));
      expect(visible.length).toBeGreaterThan(0);
    }
    // Zoomed in, a few dozen chunks for 48,000 cells.
    expect(
      visibleChunks(model, visibleWorldRect(cameraOn(level.bounds, 5), viewport)).length,
    ).toBeLessThanOrEqual(6);
  });

  it('chunks tile the grid exactly, clipped at its edges', () => {
    const model = buildFloorModel(rectangularLevel(9000, 3000), 'concrete-standard', MATERIALS);
    expect(chunkRect(model, chunkKey(0, 0))).toEqual({ x: 0, y: 0, width: 8000, depth: 3000 });
    expect(chunkRect(model, chunkKey(1, 0))).toEqual({ x: 8000, y: 0, width: 1000, depth: 3000 });
  });

  it('chooses each cell’s texture variant from a fixed hash of its coordinates', () => {
    const counts = [0, 0, 0, 0];
    for (let row = 0; row < 100; row += 1) {
      for (let col = 0; col < 100; col += 1) {
        const variant = cellVariant(col, row, 4);
        expect(variant).toBe(cellVariant(col, row, 4));
        counts[variant] = (counts[variant] ?? 0) + 1;
      }
    }
    // Every variant is used, none dominates.
    for (const count of counts) {
      expect(count).toBeGreaterThan(2000);
      expect(count).toBeLessThan(3000);
    }
    expect(cellVariant(5, 9, 1)).toBe(0);
  });

  it('draws flat colour zoomed out and texture zoomed in', () => {
    expect(ZOOM_STEPS.map(floorDetail)).toEqual([
      'flat',
      'flat',
      'flat',
      'texture',
      'texture',
      'texture',
    ]);
  });

  it('places a material’s joints at its own module from the origin, independent of the grid', () => {
    // 6 m saw cuts across a run of cells from 5.5 m to 13 m.
    expect(patternLines({ x: 5500, y: 0, width: 7500, depth: 500 }, { x: 6000, y: 6000 })).toEqual({
      xs: [6000, 12_000],
      ys: [],
    });
    // 300 mm vinyl tiles fall inside 500 mm cells.
    expect(patternLines({ x: 0, y: 500, width: 1000, depth: 500 }, { x: 300, y: 300 })).toEqual({
      xs: [300, 600, 900],
      ys: [600, 900],
    });
  });
});
