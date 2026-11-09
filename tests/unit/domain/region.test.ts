import fc from 'fast-check';
import { polygonAreaMm2, floorOutlineProblems, type PointMm } from '../../../src/domain/geometry';
import {
  CELL_AREA_MM2,
  cellCoverage,
  classifyCell,
  decompose,
  gridSpan,
  overlapAreaMm2,
  reachableTargets,
  rectAreaMm2,
  regionContains,
  type RectMm,
} from '../../../src/domain/region';

/**
 * Exact rectilinear regions and the 500 mm construction grid (plan Step 08
 * area tests; ADR-0045, ADR-0047): usable area derives from geometry, never
 * from cell counts or bounding boxes; per-cell covered areas sum exactly to
 * it; walkways are exact to the millimetre.
 */

const box = (w: number, d: number): PointMm[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: d },
  { x: 0, y: d },
];

const sum = (coverage: Map<number, number>) =>
  [...coverage.values()].reduce((total, area) => total + BigInt(area), 0n);

describe('construction grid on exact geometry', () => {
  it('the 3,000 × 5,800 mm garage: 72 cells, 6 of them partial, 17.4 m², not 18 m²', () => {
    const { region, bounds } = decompose(box(3000, 5800));
    expect(region.areaMm2).toBe(17_400_000n);
    expect(gridSpan(bounds)).toEqual({ cols: 6, rows: 12 });
    const coverage = cellCoverage(region);
    expect(coverage.size).toBe(72);
    const partial = [...coverage.entries()].filter(([, area]) => area < CELL_AREA_MM2);
    expect(partial).toHaveLength(6);
    expect(partial.every(([, area]) => area === 150_000)).toBe(true);
    expect(sum(coverage)).toBe(region.areaMm2);
    expect(classifyCell(coverage, { col: 0, row: 0 })).toBe('full');
    expect(classifyCell(coverage, { col: 5, row: 11 })).toBe('partial');
    expect(classifyCell(coverage, { col: 6, row: 0 })).toBe('outside');
    // 72 × 0.25 m² would be 18 m²: a cell count never stands for area.
    expect(BigInt(coverage.size * CELL_AREA_MM2)).toBe(18_000_000n);
  });

  it('removes columns and obstacles exactly, including a column under four cells', () => {
    const column: RectMm = { x: 2300, y: 2300, width: 400, depth: 400 };
    const { region } = decompose(box(5000, 5000), [column]);
    expect(region.areaMm2).toBe(25_000_000n - 160_000n);
    const coverage = cellCoverage(region);
    // The column straddles cells (4,4), (5,4), (4,5), (5,5): 200 × 200 mm off each.
    for (const [col, row] of [
      [4, 4],
      [5, 4],
      [4, 5],
      [5, 5],
    ] as const) {
      expect(coverage.get(row * 4096 + col)).toBe(CELL_AREA_MM2 - 40_000);
    }
    expect(sum(coverage)).toBe(region.areaMm2);
    expect(regionContains(region, column)).toBe(false);
    expect(overlapAreaMm2(region, { x: 2000, y: 2000, width: 1000, depth: 1000 })).toBe(840_000n);
  });

  it('an L-shaped floor: area from the outline, not its bounding box; cells in the notch are outside', () => {
    const outline = [
      { x: 0, y: 0 },
      { x: 6000, y: 0 },
      { x: 6000, y: 2750 },
      { x: 3250, y: 2750 },
      { x: 3250, y: 5000 },
      { x: 0, y: 5000 },
    ];
    const { region } = decompose(outline);
    expect(region.areaMm2).toBe(polygonAreaMm2(outline));
    expect(region.areaMm2).toBeLessThan(30_000_000n);
    const coverage = cellCoverage(region);
    expect(classifyCell(coverage, { col: 11, row: 9 })).toBe('outside');
    expect(classifyCell(coverage, { col: 6, row: 5 })).toBe('partial');
    expect(sum(coverage)).toBe(region.areaMm2);
  });
});

/** A random simple rectilinear polygon: a staircase of columns of random height. */
const staircaseOutline = fc
  .array(fc.tuple(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 60 })), {
    minLength: 1,
    maxLength: 6,
  })
  .map((steps) => {
    // Each step is (width, height) in 250 mm units or odd mm; heights must change between steps.
    const points: PointMm[] = [{ x: 0, y: 0 }];
    let x = 0;
    let previous = -1;
    const tops: [number, number][] = [];
    for (const [w, h] of steps) {
      const height = h === previous ? h + 1 : h;
      previous = height;
      tops.push([x, height * 137]);
      x += w * 173;
    }
    // Walk along the top edge (y = 0) then down the right side and back along the steps.
    points.push({ x, y: 0 });
    for (let i = tops.length - 1; i >= 0; i -= 1) {
      const [start, depth] = tops[i] ?? [0, 0];
      const end = i === tops.length - 1 ? x : (tops[i + 1]?.[0] ?? x);
      points.push({ x: end, y: depth }, { x: start, y: depth });
    }
    // Merge collinear points (consecutive equal depths are avoided above).
    return points.filter((point, index) => {
      const prev = points[(index + points.length - 1) % points.length];
      const next = points[(index + 1) % points.length];
      return !(
        prev &&
        next &&
        ((prev.x === point.x && point.x === next.x) || (prev.y === point.y && point.y === next.y))
      );
    });
  })
  .filter((outline) => floorOutlineProblems(outline).length === 0);

const columns = fc.array(
  fc.record({
    x: fc.integer({ min: 0, max: 7000 }),
    y: fc.integer({ min: 0, max: 8000 }),
    width: fc.integer({ min: 1, max: 900 }),
    depth: fc.integer({ min: 1, max: 900 }),
  }),
  { maxLength: 8 },
);

describe('property: per-cell covered areas sum exactly to the usable area', () => {
  it('holds for random rectilinear outlines with random columns', () => {
    fc.assert(
      fc.property(staircaseOutline, columns, (outline, holes) => {
        const { region } = decompose(outline, holes);
        const coverage = cellCoverage(region);
        expect(sum(coverage)).toBe(region.areaMm2);
        // The usable area is the outline's area less what the columns take off it, exactly.
        const outlineRegion = decompose(outline).region;
        expect(region.areaMm2).toBe(polygonAreaMm2(outline) - removedArea(outlineRegion, holes));
        for (const area of coverage.values()) {
          expect(area).toBeGreaterThan(0);
          expect(area).toBeLessThanOrEqual(CELL_AREA_MM2);
        }
        // Disjoint pieces: their areas add up to the region's area.
        expect(region.rects.reduce((total, part) => total + rectAreaMm2(part), 0n)).toBe(
          region.areaMm2,
        );
      }),
      { numRuns: 200 },
    );
  });
});

/** Area of the union of `holes` inside `outline`, by inclusion through decomposition. */
function removedArea(outline: ReturnType<typeof decompose>['region'], holes: readonly RectMm[]) {
  // The holes' union inside the outline, measured as the outline minus the region.
  let inside = 0n;
  const union = decompose(
    [
      { x: -1, y: -1 },
      { x: 1_000_000, y: -1 },
      { x: 1_000_000, y: 1_000_000 },
      { x: -1, y: 1_000_000 },
    ],
    holes,
  ).region;
  for (const part of outline.rects) {
    inside += rectAreaMm2(part) - overlapAreaMm2(union, part);
  }
  return inside;
}

describe('walkways are exact to the millimetre', () => {
  const bounds: RectMm = { x: 0, y: 0, width: 4000, depth: 3000 };
  const start: RectMm = { x: 0, y: 0, width: 4000, depth: 500 };
  const target: RectMm = { x: 0, y: 2500, width: 4000, depth: 500 };
  // A wall across the room, leaving one gap of `gap` mm.
  const wall = (gap: number): RectMm[] => [
    { x: 0, y: 1400, width: 2000, depth: 200 },
    { x: 2000 + gap, y: 1400, width: 2000 - gap, depth: 200 },
  ];

  it('an 800 mm gap lets a person through, a 799 mm gap does not', () => {
    const reach = (gap: number) =>
      reachableTargets({
        bounds,
        blocked: wall(gap),
        starts: [start],
        targets: [target],
        walkerMm: 800,
      })[0];
    expect(reach(800)).toBe(true);
    expect(reach(799)).toBe(false);
    expect(reach(2000)).toBe(true);
  });

  it('the room edges are walls: a gap against the outside does not help', () => {
    const blocked: RectMm[] = [{ x: 0, y: 1400, width: 3300, depth: 200 }]; // 700 mm left to the edge
    expect(
      reachableTargets({ bounds, blocked, starts: [start], targets: [target], walkerMm: 800 }),
    ).toEqual([false]);
  });
});
