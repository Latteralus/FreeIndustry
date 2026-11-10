import type { PremisesLevelView } from '../../../shared/ipc/facilities';
import type { WorldRect } from './camera';
import { GRID_MM } from '../plan-transform';

/**
 * The floor layer's model (spec §5.6, §11.3; DECISIONS ADR-0046, ADR-0051):
 * each eligible 500 mm cell's covering, read from the worker's view, grouped
 * into square chunks of cells so the renderer draws and caches a chunk at a
 * time. Nothing here is per-cell on screen: the scene shows one display
 * object per visible chunk. Which chunks a changed covering dirties, which
 * chunks the camera can see, each cell's texture variant and the level of
 * detail are all decided here, as pure functions, so they are tested without
 * a GPU. Presentation only.
 */

/** Cells along each side of a chunk. 16 × 16 cells = 8 m × 8 m. */
export const CHUNK_CELLS = 16;
const CHUNK_MM = CHUNK_CELLS * GRID_MM;

/** Marks a cell outside the usable floor. */
const NOT_FLOOR = -1;

export interface FloorModel {
  readonly cols: number;
  readonly rows: number;
  /** Material ids in a fixed order; a cell holds an index into it. */
  readonly materials: readonly string[];
  /** Row-major material index per cell, or `NOT_FLOOR`. */
  readonly cells: Int16Array;
  readonly chunkCols: number;
  readonly chunkRows: number;
}

export type ChunkKey = `${number},${number}`;

export function chunkKey(chunkCol: number, chunkRow: number): ChunkKey {
  return `${chunkCol},${chunkRow}`;
}

function parseChunkKey(key: ChunkKey): { readonly col: number; readonly row: number } {
  const [col, row] = key.split(',').map(Number);
  return { col: col ?? 0, row: row ?? 0 };
}

/** Build the per-cell covering grid from the worker's level view and the premises' starting surface. */
export function buildFloorModel(
  level: Pick<PremisesLevelView, 'cells' | 'eligibleRuns' | 'coverings'>,
  surfaceMaterialId: string,
  materialIds: readonly string[],
): FloorModel {
  const { cols, rows } = level.cells;
  const materials = [...materialIds];
  const index = new Map(materials.map((id, position) => [id, position]));
  const indexOf = (id: string) => {
    const known = index.get(id);
    if (known !== undefined) {
      return known;
    }
    // A material the catalog does not list still draws (flat), never as bare floor.
    materials.push(id);
    index.set(id, materials.length - 1);
    return materials.length - 1;
  };
  const cells = new Int16Array(cols * rows).fill(NOT_FLOOR);
  const surface = indexOf(surfaceMaterialId);
  for (const [row, from, to] of level.eligibleRuns) {
    if (row < 0 || row >= rows) {
      continue;
    }
    for (let col = Math.max(0, from); col < Math.min(cols, to); col += 1) {
      cells[row * cols + col] = surface;
    }
  }
  // Runs of one material along a row; a later run over the same cell wins (a preview over the floor).
  for (const [row, from, to, materialId] of level.coverings) {
    if (row < 0 || row >= rows) {
      continue;
    }
    const material = indexOf(materialId);
    for (let col = Math.max(0, from); col < Math.min(cols, to); col += 1) {
      if (cells[row * cols + col] !== NOT_FLOOR) {
        cells[row * cols + col] = material;
      }
    }
  }
  return {
    cols,
    rows,
    materials,
    cells,
    chunkCols: Math.ceil(cols / CHUNK_CELLS),
    chunkRows: Math.ceil(rows / CHUNK_CELLS),
  };
}

/** The material id of a cell, or null outside the usable floor. */
export function materialAt(model: FloorModel, col: number, row: number): string | null {
  if (col < 0 || row < 0 || col >= model.cols || row >= model.rows) {
    return null;
  }
  const value = model.cells[row * model.cols + col] ?? NOT_FLOOR;
  return value === NOT_FLOOR ? null : (model.materials[value] ?? null);
}

export function allChunks(model: FloorModel): ChunkKey[] {
  const keys: ChunkKey[] = [];
  for (let row = 0; row < model.chunkRows; row += 1) {
    for (let col = 0; col < model.chunkCols; col += 1) {
      keys.push(chunkKey(col, row));
    }
  }
  return keys;
}

/**
 * The chunks whose drawing differs between two models: every chunk holding a
 * cell whose material (by id) or eligibility changed. A different grid size
 * dirties everything.
 */
export function dirtyChunks(previous: FloorModel | null, next: FloorModel): Set<ChunkKey> {
  if (previous?.cols !== next.cols || previous.rows !== next.rows) {
    return new Set(allChunks(next));
  }
  const idOf = (model: FloorModel, index: number) => {
    const value = model.cells[index] ?? NOT_FLOOR;
    return value === NOT_FLOOR ? null : (model.materials[value] ?? null);
  };
  const dirty = new Set<ChunkKey>();
  for (let index = 0; index < next.cells.length; index += 1) {
    if (idOf(previous, index) !== idOf(next, index)) {
      const col = index % next.cols;
      const row = Math.floor(index / next.cols);
      dirty.add(chunkKey(Math.floor(col / CHUNK_CELLS), Math.floor(row / CHUNK_CELLS)));
    }
  }
  return dirty;
}

/** The chunks a world rectangle (the camera's view) touches, inside the grid. */
export function visibleChunks(model: FloorModel, view: WorldRect): ChunkKey[] {
  const firstCol = Math.max(0, Math.floor(view.x / CHUNK_MM));
  const firstRow = Math.max(0, Math.floor(view.y / CHUNK_MM));
  const lastCol = Math.min(model.chunkCols - 1, Math.floor((view.x + view.width) / CHUNK_MM));
  const lastRow = Math.min(model.chunkRows - 1, Math.floor((view.y + view.depth) / CHUNK_MM));
  const keys: ChunkKey[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) {
      keys.push(chunkKey(col, row));
    }
  }
  return keys;
}

/** A chunk's world rectangle, clipped to the grid. */
export function chunkRect(model: FloorModel, key: ChunkKey): WorldRect {
  const { col, row } = parseChunkKey(key);
  const cols = Math.min(CHUNK_CELLS, model.cols - col * CHUNK_CELLS);
  const rows = Math.min(CHUNK_CELLS, model.rows - row * CHUNK_CELLS);
  return { x: col * CHUNK_MM, y: row * CHUNK_MM, width: cols * GRID_MM, depth: rows * GRID_MM };
}

/**
 * Runs of one material along each row of a chunk: `[col, row, length,
 * material index]`, in cell coordinates of the level. A flat drawing needs
 * one rectangle per run, not per cell.
 */
export function chunkRuns(model: FloorModel, key: ChunkKey): [number, number, number, number][] {
  const { col: chunkCol, row: chunkRow } = parseChunkKey(key);
  const runs: [number, number, number, number][] = [];
  const colStart = chunkCol * CHUNK_CELLS;
  const colEnd = Math.min(model.cols, colStart + CHUNK_CELLS);
  const rowStart = chunkRow * CHUNK_CELLS;
  const rowEnd = Math.min(model.rows, rowStart + CHUNK_CELLS);
  for (let row = rowStart; row < rowEnd; row += 1) {
    let col = colStart;
    while (col < colEnd) {
      const material = model.cells[row * model.cols + col] ?? NOT_FLOOR;
      let end = col + 1;
      while (end < colEnd && (model.cells[row * model.cols + end] ?? NOT_FLOOR) === material) {
        end += 1;
      }
      if (material !== NOT_FLOOR) {
        runs.push([col, row, end - col, material]);
      }
      col = end;
    }
  }
  return runs;
}

/**
 * A cell's texture variant, from a fixed hash of its coordinates (never
 * random, never the frame), so the same floor always looks the same and
 * neighbouring cells rarely repeat.
 */
export function cellVariant(col: number, row: number, variants: number): number {
  if (variants <= 1) {
    return 0;
  }
  let hash = Math.imul(col ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(row ^ 0xc2b2ae35, 0x27d4eb2f);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2c1b3c6d);
  hash ^= hash >>> 12;
  return (hash >>> 0) % variants;
}

/**
 * Level of detail by zoom: flat material colour when zoomed out, the
 * material's texture from about 20 px a metre (a cell is then 10 px or more).
 */
export type FloorDetail = 'flat' | 'texture';

const TEXTURE_FROM_PIXELS_PER_METRE = 20;

export function floorDetail(pixelsPerMetre: number): FloorDetail {
  return pixelsPerMetre >= TEXTURE_FROM_PIXELS_PER_METRE ? 'texture' : 'flat';
}

/**
 * Joint lines of a material's own pattern (saw cuts, plate seams, tile
 * edges) crossing a rectangle, at multiples of the pattern module measured
 * from the level origin, so the pattern is continuous across cells and
 * chunks and independent of the construction grid.
 */
export function patternLines(
  rect: WorldRect,
  patternMm: { readonly x: number; readonly y: number },
): { readonly xs: number[]; readonly ys: number[] } {
  const lines = (from: number, length: number, step: number) => {
    const out: number[] = [];
    if (step <= 0) {
      return out;
    }
    for (let value = Math.ceil(from / step) * step; value <= from + length; value += step) {
      if (value > 0) {
        out.push(value);
      }
    }
    return out;
  };
  return { xs: lines(rect.x, rect.width, patternMm.x), ys: lines(rect.y, rect.depth, patternMm.y) };
}
