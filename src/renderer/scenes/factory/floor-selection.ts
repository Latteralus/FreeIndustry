import type { PremisesLevelView } from '../../../shared/ipc/facilities';
import { materialAt, type FloorModel } from './floor-model';

/**
 * Floor-covering selections for the layout tools (plan Step 09A; spec §5.6;
 * DECISIONS ADR-0046, ADR-0052): a single cell, a rectangle between two
 * clicked cells, the whole level, or a fill (the 4-connected region of
 * eligible cells with the same covering as the cell clicked, not crossing
 * cells under works). A selection is a list of cell rectangles: the order
 * the worker receives, validates again and prices exactly. Everything here
 * is presentation; the worker decides what an order costs and whether it
 * is allowed. Pure, so it is tested without a GPU.
 */

/** A rectangle of cells: `cols` × `rows` cells from (`col`, `row`). */
export interface CellRect {
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}

/** A run of cells along a row: `[row, firstCol, endCol)`. */
export type CellRunView = readonly [number, number, number];

export type FloorSelectionShape = 'cell' | 'rectangle' | 'level' | 'fill';

export const SELECTION_SHAPE_LABEL: Record<FloorSelectionShape, string> = {
  cell: 'Single cell',
  rectangle: 'Rectangle',
  level: 'Whole level',
  fill: 'Fill',
};

/** The floor tool: the material being laid and how cells are selected. */
export interface FloorTool {
  readonly materialId: string;
  readonly shape: FloorSelectionShape;
}

/** The rectangle spanned by two cells, corners included. */
export function rectBetween(
  a: { readonly col: number; readonly row: number },
  b: { readonly col: number; readonly row: number },
): CellRect {
  const col = Math.min(a.col, b.col);
  const row = Math.min(a.row, b.row);
  return {
    col,
    row,
    cols: Math.abs(a.col - b.col) + 1,
    rows: Math.abs(a.row - b.row) + 1,
  };
}

/**
 * Row runs as rectangles: a run repeated on consecutive rows with the same
 * columns becomes one taller rectangle, so a plain floor is a few rectangles.
 */
export function runsToRects(runs: readonly CellRunView[]): CellRect[] {
  const sorted = [...runs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const open = new Map<string, { col: number; row: number; cols: number; rows: number }>();
  const done: CellRect[] = [];
  for (const [row, from, to] of sorted) {
    const key = `${from}|${to}`;
    const rect = open.get(key);
    if (rect && rect.row + rect.rows === row) {
      rect.rows += 1;
      continue;
    }
    if (rect) {
      done.push(rect);
    }
    open.set(key, { col: from, row, cols: to - from, rows: 1 });
  }
  return [...done, ...open.values()].sort((a, b) => a.row - b.row || a.col - b.col);
}

/** Every eligible cell of the level, as rectangles. */
export function levelRects(level: Pick<PremisesLevelView, 'eligibleRuns'>): CellRect[] {
  return runsToRects(level.eligibleRuns);
}

/** Cells under a contractor's works on the level, as a lookup. */
export function worksCells(level: Pick<PremisesLevelView, 'works' | 'cells'>): Set<number> {
  const cells = new Set<number>();
  for (const job of level.works) {
    for (const [row, from, to] of job.runs) {
      for (let col = from; col < to; col += 1) {
        cells.add(row * level.cells.cols + col);
      }
    }
  }
  return cells;
}

/**
 * The fill from a cell: every eligible cell 4-connected to it with the same
 * covering, not crossing cells under works. Empty when the start cell is
 * not eligible or is under works.
 */
export function fillRects(
  model: FloorModel,
  blocked: ReadonlySet<number>,
  start: { readonly col: number; readonly row: number },
): CellRect[] {
  const material = materialAt(model, start.col, start.row);
  const index = (col: number, row: number) => row * model.cols + col;
  if (material === null || blocked.has(index(start.col, start.row))) {
    return [];
  }
  const seen = new Uint8Array(model.cols * model.rows);
  const stack: [number, number][] = [[start.col, start.row]];
  seen[index(start.col, start.row)] = 1;
  const byRow = new Map<number, number[]>();
  while (stack.length > 0) {
    const [col, row] = stack.pop() ?? [0, 0];
    byRow.set(row, [...(byRow.get(row) ?? []), col]);
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= model.cols || r >= model.rows || seen[index(c, r)] === 1) {
        continue;
      }
      seen[index(c, r)] = 1;
      if (materialAt(model, c, r) === material && !blocked.has(index(c, r))) {
        stack.push([c, r]);
      }
    }
  }
  const runs: [number, number, number][] = [];
  for (const [row, cols] of byRow) {
    cols.sort((a, b) => a - b);
    let from = cols[0] ?? 0;
    let previous = from;
    for (const col of cols.slice(1)) {
      if (col !== previous + 1) {
        runs.push([row, from, previous + 1]);
        from = col;
      }
      previous = col;
    }
    runs.push([row, from, previous + 1]);
  }
  return runsToRects(runs);
}

/** The eligible cells a selection covers, as row runs (what the preview draws). */
export function selectionRuns(
  level: Pick<PremisesLevelView, 'eligibleRuns'>,
  rects: readonly CellRect[],
): [number, number, number][] {
  const out: [number, number, number][] = [];
  const byRow = new Map<number, [number, number][]>();
  for (const rect of rects) {
    for (let row = rect.row; row < rect.row + rect.rows; row += 1) {
      byRow.set(row, [...(byRow.get(row) ?? []), [rect.col, rect.col + rect.cols]]);
    }
  }
  for (const [r, from, to] of level.eligibleRuns) {
    for (const [a, b] of byRow.get(r) ?? []) {
      const start = Math.max(from, a);
      const end = Math.min(to, b);
      if (start < end) {
        out.push([r, start, end]);
      }
    }
  }
  // Merge overlapping or touching runs per row.
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number, number][] = [];
  for (const run of out) {
    const last = merged[merged.length - 1];
    if (last?.[0] === run[0] && run[1] <= last[2]) {
      last[2] = Math.max(last[2], run[2]);
    } else {
      merged.push([...run]);
    }
  }
  return merged;
}
