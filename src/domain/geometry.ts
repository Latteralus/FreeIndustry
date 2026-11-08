/**
 * Plan geometry in canonical integer millimetres (spec §5.1, design law D05).
 *
 * A floor is a simple rectilinear polygon: every edge runs along the x or y
 * axis, and no two edges cross. Rectangles, L-shapes and other stepped
 * outlines are allowed. Areas are exact `bigint` square millimetres from the
 * shoelace formula, so a floor's area always derives from its outline and
 * never from how large it happens to be drawn.
 */

/** A point on a floor plan, in whole millimetres. */
export interface PointMm {
  readonly x: number;
  readonly y: number;
}

/** Largest coordinate accepted on a plan: one kilometre. */
const MAX_PLAN_COORDINATE_MM = 1_000_000;

/** Most corners a floor outline may have. */
const MAX_FLOOR_POINTS = 64;

/** One square foot is exactly 92 903.04 mm² (0.3048 m squared). */
export const MM2_PER_SQ_FT_NUMERATOR = 9_290_304n;
export const MM2_PER_SQ_FT_DENOMINATOR = 100n;

/** Exact enclosed area of a polygon, in square millimetres (orientation-independent). */
export function polygonAreaMm2(points: readonly PointMm[]): bigint {
  let twice = 0n;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    twice += BigInt(point.x) * BigInt(next.y) - BigInt(next.x) * BigInt(point.y);
  });
  return (twice < 0n ? -twice : twice) / 2n;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function boundsOf(points: readonly PointMm[]): Bounds {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

/** Length of edge `edge` (from corner `edge` to the next corner), in millimetres. */
export function edgeLengthMm(points: readonly PointMm[], edge: number): number {
  const from = points[edge];
  const to = points[(edge + 1) % points.length];
  if (!from || !to) {
    throw new RangeError(`The outline has no edge ${edge}`);
  }
  return Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
}

interface Segment {
  readonly a: PointMm;
  readonly b: PointMm;
}

function segmentsOf(points: readonly PointMm[]): Segment[] {
  return points.map((a, index) => ({ a, b: points[(index + 1) % points.length] ?? a }));
}

/** Whether two axis-aligned segments share any point. */
function touches(first: Segment, second: Segment): boolean {
  const lo = (p: number, q: number) => Math.min(p, q);
  const hi = (p: number, q: number) => Math.max(p, q);
  return (
    lo(first.a.x, first.b.x) <= hi(second.a.x, second.b.x) &&
    lo(second.a.x, second.b.x) <= hi(first.a.x, first.b.x) &&
    lo(first.a.y, first.b.y) <= hi(second.a.y, second.b.y) &&
    lo(second.a.y, second.b.y) <= hi(first.a.y, first.b.y)
  );
}

/**
 * Why `points` is not a valid floor outline; empty when it is. Checks:
 * integer coordinates within the plan limits, 4–64 corners, every edge
 * axis-aligned and of positive length, consecutive edges turning (no
 * collinear corners), and no edge touching a non-adjacent edge.
 */
export function floorOutlineProblems(points: readonly PointMm[]): string[] {
  if (points.length < 4 || points.length > MAX_FLOOR_POINTS) {
    return [`a floor outline needs 4–${MAX_FLOOR_POINTS} corners, not ${points.length}`];
  }
  const problems: string[] = [];
  for (const [index, point] of points.entries()) {
    for (const value of [point.x, point.y]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PLAN_COORDINATE_MM) {
        problems.push(`corner ${index} is not a whole number of mm within 0–1 km`);
        break;
      }
    }
  }
  if (problems.length > 0) {
    return problems;
  }
  const segments = segmentsOf(points);
  segments.forEach(({ a, b }, index) => {
    if (a.x !== b.x && a.y !== b.y) {
      problems.push(`edge ${index} is not along a wall axis`);
    } else if (a.x === b.x && a.y === b.y) {
      problems.push(`edge ${index} has no length`);
    }
  });
  if (problems.length > 0) {
    return problems;
  }
  segments.forEach((segment, index) => {
    const next = segments[(index + 1) % segments.length] ?? segment;
    const vertical = segment.a.x === segment.b.x;
    if (vertical === (next.a.x === next.b.x)) {
      problems.push(`corner ${(index + 1) % points.length} does not turn`);
    }
  });
  const count = segments.length;
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 2; j < count; j += 1) {
      if (i === 0 && j === count - 1) {
        continue; // adjacent through the closing corner
      }
      const first = segments[i];
      const second = segments[j];
      if (first && second && touches(first, second)) {
        problems.push(`edges ${i} and ${j} cross or touch`);
      }
    }
  }
  return problems;
}
