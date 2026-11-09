import type { PointMm } from './geometry';

/**
 * Exact rectilinear regions in integer millimetres (spec §5.1–5.2,
 * DECISIONS ADR-0045, ADR-0047).
 *
 * A floor's usable region is its outline polygon minus axis-aligned
 * rectangles (columns, walls, obstacles, forbidden zones). Every boundary of
 * such a region lies on one of finitely many x and y coordinates, so cutting
 * the plane along all of them (coordinate compression) yields elementary
 * rectangles that are each wholly inside or wholly outside the region. The
 * region is then an exact list of disjoint rectangles: its area, its overlap
 * with any rectangle and its coverage of every 500 mm cell follow by integer
 * arithmetic, with no sampling, rounding or cell counting.
 *
 * Rectangles are half-open: x ∈ [x, x + width), y ∈ [y, y + depth). Two
 * rectangles "overlap" only when they share positive area; touching edges do
 * not overlap.
 */

export interface RectMm {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly depth: number;
}

/** The construction grid pitch: one world-wide constant (ADR-0045). */
const CONSTRUCTION_GRID_MM = 500;

/** Area of one full construction-grid cell, in mm². */
export const CELL_AREA_MM2 = CONSTRUCTION_GRID_MM * CONSTRUCTION_GRID_MM;

export function rectAreaMm2(r: RectMm): bigint {
  return BigInt(r.width) * BigInt(r.depth);
}

/** The intersection of two rectangles, or null when they share no area. */
export function intersection(a: RectMm, b: RectMm): RectMm | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.depth, b.y + b.depth);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, depth: y1 - y0 } : null;
}

export function overlaps(a: RectMm, b: RectMm): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.depth && b.y < a.y + a.depth;
}

/** Whether a rectangle has whole-millimetre coordinates within the plan and positive size. */
export function isValidRect(r: RectMm, limit = 1_000_000): boolean {
  return (
    [r.x, r.y, r.width, r.depth].every(Number.isSafeInteger) &&
    r.width > 0 &&
    r.depth > 0 &&
    r.x >= -limit &&
    r.y >= -limit &&
    r.x + r.width <= 2 * limit &&
    r.y + r.depth <= 2 * limit
  );
}

/** An exact region: disjoint rectangles (in row-major order) and its bounding box. */
export interface Region {
  readonly rects: readonly RectMm[];
  readonly areaMm2: bigint;
}

function sortedUnique(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((p, q) => p - q);
}

/** Index of `value` in the sorted array `values` (it must be present). */
function indexOf(values: readonly number[], value: number): number {
  let lo = 0;
  let hi = values.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = values[mid] ?? 0;
    if (at === value) {
      return mid;
    }
    if (at < value) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  throw new RangeError(`${value} is not a grid coordinate`);
}

/** Index of the first coordinate ≥ `value`, clamped to the array. */
function lowerBound(values: readonly number[], value: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((values[mid] ?? 0) < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * A grid of elementary cells over the compressed coordinates, each flagged
 * filled or not. Used for both regions and walkway connectivity.
 */
class CompressedGrid {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  /** Row-major flags, (xs.length − 1) × (ys.length − 1). */
  readonly filled: Uint8Array;

  constructor(xs: readonly number[], ys: readonly number[]) {
    this.xs = xs;
    this.ys = ys;
    this.filled = new Uint8Array(Math.max(0, xs.length - 1) * Math.max(0, ys.length - 1));
  }

  get columns(): number {
    return Math.max(0, this.xs.length - 1);
  }

  get rows(): number {
    return Math.max(0, this.ys.length - 1);
  }

  cellRect(column: number, row: number): RectMm {
    const x = this.xs[column] ?? 0;
    const y = this.ys[row] ?? 0;
    return { x, y, width: (this.xs[column + 1] ?? x) - x, depth: (this.ys[row + 1] ?? y) - y };
  }

  /** Set (or clear) every elementary cell inside `r`, whose edges must be grid coordinates. */
  paint(r: RectMm, value: 0 | 1): void {
    const x0 = lowerBound(this.xs, r.x);
    const x1 = lowerBound(this.xs, r.x + r.width);
    const y0 = lowerBound(this.ys, r.y);
    const y1 = lowerBound(this.ys, r.y + r.depth);
    const columns = this.columns;
    for (let row = y0; row < y1; row += 1) {
      this.filled.fill(value, row * columns + x0, row * columns + x1);
    }
  }

  /** Filled cells merged into horizontal runs, row by row. */
  runs(value: 0 | 1 = 1): RectMm[] {
    const out: RectMm[] = [];
    const columns = this.columns;
    for (let row = 0; row < this.rows; row += 1) {
      let column = 0;
      while (column < columns) {
        if (this.filled[row * columns + column] !== value) {
          column += 1;
          continue;
        }
        const start = column;
        while (column < columns && this.filled[row * columns + column] === value) {
          column += 1;
        }
        const first = this.cellRect(start, row);
        const x1 = this.xs[column] ?? first.x;
        out.push({ x: first.x, y: first.y, width: x1 - first.x, depth: first.depth });
      }
    }
    return out;
  }
}

/**
 * Fill the cells of `grid` inside a simple rectilinear polygon whose corners
 * are all grid coordinates. For each row, the vertical edges crossing the
 * row's mid-line are found once, and columns are swept left to right: a cell
 * is inside when an odd number of those edges lie to its left. Mid-lines and
 * mid-points never coincide with an edge, so there are no ambiguous cases.
 */
function fillPolygon(grid: CompressedGrid, outline: readonly PointMm[]): void {
  const verticals: { x: number; y0: number; y1: number }[] = [];
  outline.forEach((a, index) => {
    const b = outline[(index + 1) % outline.length] ?? a;
    if (a.x === b.x && a.y !== b.y) {
      verticals.push({ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
    }
  });
  const columns = grid.columns;
  for (let row = 0; row < grid.rows; row += 1) {
    // Doubled mid-line, so the comparison stays in integers.
    const mid2 = (grid.ys[row] ?? 0) + (grid.ys[row + 1] ?? 0);
    const crossings = verticals
      .filter((edge) => 2 * edge.y0 < mid2 && mid2 < 2 * edge.y1)
      .map((edge) => indexOf(grid.xs, edge.x))
      .sort((p, q) => p - q);
    let inside = false;
    let next = 0;
    for (let column = 0; column < columns; column += 1) {
      while (next < crossings.length && (crossings[next] ?? 0) <= column) {
        inside = !inside;
        next += 1;
      }
      if (inside) {
        grid.filled[row * columns + column] = 1;
      }
    }
  }
}

/**
 * The exact region of a simple rectilinear `outline` minus `holes`. Holes
 * may extend beyond the outline; only their part inside it is removed. Also
 * returns the parts of the outline's bounding box that are *not* in the
 * region, for walkway computations.
 */
export function decompose(
  outline: readonly PointMm[],
  holes: readonly RectMm[] = [],
): { readonly region: Region; readonly outside: readonly RectMm[]; readonly bounds: RectMm } {
  const xs = sortedUnique([
    ...outline.map((point) => point.x),
    ...holes.flatMap((hole) => [hole.x, hole.x + hole.width]),
  ]);
  const ys = sortedUnique([
    ...outline.map((point) => point.y),
    ...holes.flatMap((hole) => [hole.y, hole.y + hole.depth]),
  ]);
  const grid = new CompressedGrid(xs, ys);
  fillPolygon(grid, outline);
  for (const hole of holes) {
    grid.paint(hole, 0);
  }
  const minX = Math.min(...outline.map((point) => point.x));
  const minY = Math.min(...outline.map((point) => point.y));
  const maxX = Math.max(...outline.map((point) => point.x));
  const maxY = Math.max(...outline.map((point) => point.y));
  const bounds = { x: minX, y: minY, width: maxX - minX, depth: maxY - minY };
  const rects = grid.runs(1);
  const outside = grid
    .runs(0)
    .map((part) => intersection(part, bounds))
    .filter((part): part is RectMm => part !== null);
  return { region: regionOfRects(rects), outside, bounds };
}

function regionOfRects(rects: readonly RectMm[]): Region {
  return { rects, areaMm2: rects.reduce((sum, part) => sum + rectAreaMm2(part), 0n) };
}

/** Area of `r` that lies inside `region`, in mm². */
export function overlapAreaMm2(region: Region, r: RectMm): bigint {
  let area = 0n;
  for (const part of region.rects) {
    const shared = intersection(part, r);
    if (shared) {
      area += rectAreaMm2(shared);
    }
  }
  return area;
}

/** Whether `r` lies entirely inside `region`. */
export function regionContains(region: Region, r: RectMm): boolean {
  return overlapAreaMm2(region, r) === rectAreaMm2(r);
}

// ------------------------------------------------------ construction grid

/** A construction-grid cell of a level: (col, row) covers [500·col, 500·col + 500) × [500·row, …). */
export interface CellRef {
  readonly col: number;
  readonly row: number;
}

/** Cell key for maps: rows and columns stay below 4,096 (a 2 km plan). */
export function cellKey(col: number, row: number): number {
  return row * 4096 + col;
}

export function cellOfKey(key: number): CellRef {
  return { col: key % 4096, row: Math.floor(key / 4096) };
}

export type CellClass = 'full' | 'partial' | 'outside';

/**
 * Covered area of every cell the region touches, keyed by `cellKey`. Cells
 * absent from the map are outside (covered area 0). Each disjoint region
 * rectangle adds its exact overlap to the cells beneath it, so the covered
 * areas sum exactly to the region's area.
 */
export function cellCoverage(region: Region): Map<number, number> {
  const coverage = new Map<number, number>();
  const g = CONSTRUCTION_GRID_MM;
  for (const part of region.rects) {
    const col0 = Math.floor(part.x / g);
    const col1 = Math.floor((part.x + part.width - 1) / g);
    const row0 = Math.floor(part.y / g);
    const row1 = Math.floor((part.y + part.depth - 1) / g);
    for (let row = row0; row <= row1; row += 1) {
      const y0 = Math.max(part.y, row * g);
      const y1 = Math.min(part.y + part.depth, row * g + g);
      for (let col = col0; col <= col1; col += 1) {
        const x0 = Math.max(part.x, col * g);
        const x1 = Math.min(part.x + part.width, col * g + g);
        const key = cellKey(col, row);
        coverage.set(key, (coverage.get(key) ?? 0) + (x1 - x0) * (y1 - y0));
      }
    }
  }
  return coverage;
}

export function classifyCell(coverage: ReadonlyMap<number, number>, cell: CellRef): CellClass {
  const area = coverage.get(cellKey(cell.col, cell.row)) ?? 0;
  if (area <= 0) {
    return 'outside';
  }
  return area >= CELL_AREA_MM2 ? 'full' : 'partial';
}

/** The number of grid columns and rows a bounding box from the origin spans. */
export function gridSpan(bounds: RectMm): { readonly cols: number; readonly rows: number } {
  return {
    cols: Math.ceil((bounds.x + bounds.width) / CONSTRUCTION_GRID_MM),
    rows: Math.ceil((bounds.y + bounds.depth) / CONSTRUCTION_GRID_MM),
  };
}

// ------------------------------------------------------------- walkways

/**
 * Which `targets` a walker of square plan size `walkerMm` can reach from any
 * of `starts`, moving only where it stands clear of every `blocked`
 * rectangle (spec §5.2 walkways, ADR-0047).
 *
 * Exact: the walker's centre may stand where the square of side `walkerMm`
 * around it overlaps no blocked rectangle. That free set is computed in
 * doubled coordinates with every blocked rectangle grown by `walkerMm − 1`
 * doubled units each side, so a gap of exactly `walkerMm` is passable and a
 * gap of `walkerMm − 1` is not. Free elementary cells are connected through
 * shared edges of positive length; a start or target counts when a free cell
 * shares positive area with it. Everything outside `bounds` is blocked.
 */
export function reachableTargets(input: {
  readonly bounds: RectMm;
  readonly blocked: readonly RectMm[];
  readonly starts: readonly RectMm[];
  readonly targets: readonly RectMm[];
  readonly walkerMm: number;
}): boolean[] {
  const grow = input.walkerMm - 1;
  const double = (r: RectMm): RectMm => ({
    x: 2 * r.x,
    y: 2 * r.y,
    width: 2 * r.width,
    depth: 2 * r.depth,
  });
  const box = double(input.bounds);
  const { x, y, width, depth } = input.bounds;
  // The bounding box's own edges are walls too: strips just outside it.
  const border: RectMm[] = [
    { x: x - 1, y: y - 1, width: width + 2, depth: 1 },
    { x: x - 1, y: y + depth, width: width + 2, depth: 1 },
    { x: x - 1, y, width: 1, depth },
    { x: x + width, y, width: 1, depth },
  ];
  const blocked = [...input.blocked, ...border]
    .map(double)
    .map((r) => ({
      x: r.x - grow,
      y: r.y - grow,
      width: r.width + 2 * grow,
      depth: r.depth + 2 * grow,
    }))
    .map((r) => intersection(r, box))
    .filter((r): r is RectMm => r !== null);
  const starts = input.starts.map(double);
  const targets = input.targets.map(double);
  const clip = (r: RectMm) => intersection(r, box);
  const marks = [...starts, ...targets].map(clip).filter((r): r is RectMm => r !== null);
  const xs = sortedUnique([
    box.x,
    box.x + box.width,
    ...[...blocked, ...marks].flatMap((r) => [r.x, r.x + r.width]),
  ]);
  const ys = sortedUnique([
    box.y,
    box.y + box.depth,
    ...[...blocked, ...marks].flatMap((r) => [r.y, r.y + r.depth]),
  ]);
  const grid = new CompressedGrid(xs, ys);
  grid.filled.fill(1); // 1 = free
  for (const r of blocked) {
    grid.paint(r, 0);
  }
  const columns = grid.columns;
  const reached = new Uint8Array(grid.filled.length);
  const queue: number[] = [];
  const seed = (r: RectMm) => {
    const x0 = lowerBound(xs, r.x);
    const x1 = lowerBound(xs, r.x + r.width);
    const y0 = lowerBound(ys, r.y);
    const y1 = lowerBound(ys, r.y + r.depth);
    for (let row = y0; row < y1; row += 1) {
      for (let column = x0; column < x1; column += 1) {
        const index = row * columns + column;
        if (grid.filled[index] === 1 && reached[index] === 0) {
          reached[index] = 1;
          queue.push(index);
        }
      }
    }
  };
  for (const start of starts) {
    const clipped = clip(start);
    if (clipped) {
      seed(clipped);
    }
  }
  while (queue.length > 0) {
    const index = queue.pop() ?? 0;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const neighbours = [
      column > 0 ? index - 1 : -1,
      column < columns - 1 ? index + 1 : -1,
      row > 0 ? index - columns : -1,
      row < grid.rows - 1 ? index + columns : -1,
    ];
    for (const next of neighbours) {
      if (next >= 0 && grid.filled[next] === 1 && reached[next] === 0) {
        reached[next] = 1;
        queue.push(next);
      }
    }
  }
  return targets.map((target) => {
    const clipped = clip(target);
    if (!clipped) {
      return false;
    }
    const x0 = lowerBound(xs, clipped.x);
    const x1 = lowerBound(xs, clipped.x + clipped.width);
    const y0 = lowerBound(ys, clipped.y);
    const y1 = lowerBound(ys, clipped.y + clipped.depth);
    for (let row = y0; row < y1; row += 1) {
      for (let column = x0; column < x1; column += 1) {
        if (reached[row * columns + column] === 1) {
          return true;
        }
      }
    }
    return false;
  });
}
