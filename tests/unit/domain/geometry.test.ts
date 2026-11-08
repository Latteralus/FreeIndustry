import fc from 'fast-check';
import {
  boundsOf,
  edgeLengthMm,
  floorOutlineProblems,
  polygonAreaMm2,
  type PointMm,
} from '../../../src/domain/geometry';

const rect = (w: number, d: number): PointMm[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: d },
  { x: 0, y: d },
];

/** An L-shape: a w × d rectangle with a cw × cd notch cut from one corner. */
const ell = (w: number, d: number, cw: number, cd: number): PointMm[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: d - cd },
  { x: w - cw, y: d - cd },
  { x: w - cw, y: d },
  { x: 0, y: d },
];

describe('floor geometry (integer millimetres)', () => {
  it('computes exact areas from the outline, whatever its orientation', () => {
    expect(polygonAreaMm2(rect(3000, 5800))).toBe(17_400_000n);
    expect(polygonAreaMm2(rect(3000, 5800).reverse())).toBe(17_400_000n);
    expect(polygonAreaMm2(ell(12_000, 14_000, 4000, 5000))).toBe(12_000n * 14_000n - 4000n * 5000n);
    // A 100 m × 100 m factory floor: far beyond 2^53 mm² would be unsafe as a number.
    expect(polygonAreaMm2(rect(1_000_000, 1_000_000))).toBe(1_000_000_000_000n);
  });

  it('measures bounds and wall lengths', () => {
    const outline = ell(12_000, 14_000, 4000, 5000);
    expect(boundsOf(outline)).toEqual({ minX: 0, minY: 0, maxX: 12_000, maxY: 14_000 });
    expect([0, 1, 2, 3, 4, 5].map((edge) => edgeLengthMm(outline, edge))).toEqual([
      12_000, 9000, 4000, 5000, 8000, 14_000,
    ]);
    expect(() => edgeLengthMm(outline, 6)).toThrow(RangeError);
  });

  it('accepts rectangles and stepped outlines', () => {
    expect(floorOutlineProblems(rect(3000, 5800))).toEqual([]);
    expect(floorOutlineProblems(ell(50_000, 70_000, 12_000, 15_000))).toEqual([]);
  });

  it('refuses outlines that are not simple rectilinear floors', () => {
    expect(floorOutlineProblems(rect(3000, 5800).slice(0, 3))).toEqual([
      'a floor outline needs 4–64 corners, not 3',
    ]);
    expect(
      floorOutlineProblems([
        { x: 0, y: 0 },
        { x: 3000, y: 0 },
        { x: 3000, y: 2000 },
        { x: 0, y: 3000 },
      ]),
    ).toContain('edge 2 is not along a wall axis');
    expect(
      floorOutlineProblems([
        { x: 0, y: 0 },
        { x: 3000, y: 0 },
        { x: 3000, y: 0 },
        { x: 3000, y: 2000 },
        { x: 0, y: 2000 },
      ]),
    ).toContain('edge 1 has no length');
    expect(
      floorOutlineProblems([
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 3000, y: 0 },
        { x: 3000, y: 2000 },
        { x: 0, y: 2000 },
      ]),
    ).toContain('corner 1 does not turn');
    // A figure of eight: two edges cross.
    expect(
      floorOutlineProblems([
        { x: 0, y: 1000 },
        { x: 2000, y: 1000 },
        { x: 2000, y: 3000 },
        { x: 1000, y: 3000 },
        { x: 1000, y: 0 },
        { x: 3000, y: 0 },
        { x: 3000, y: 2000 },
        { x: 0, y: 2000 },
      ]).some((problem) => problem.includes('cross or touch')),
    ).toBe(true);
    expect(floorOutlineProblems(rect(3000.5, 2000))).toContain(
      'corner 1 is not a whole number of mm within 0–1 km',
    );
    expect(floorOutlineProblems(rect(2_000_000, 2000))[0]).toMatch(/within 0–1 km/);
  });

  it('property: an L-shape’s area equals the rectangle less its notch, and a 500 mm grid count agrees', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 60 }),
        fc.integer({ min: 2, max: 60 }),
        fc.integer({ min: 1, max: 59 }),
        fc.integer({ min: 1, max: 59 }),
        (w, d, cwRaw, cdRaw) => {
          const cw = Math.min(cwRaw, w - 1);
          const cd = Math.min(cdRaw, d - 1);
          const outline = ell(w * 500, d * 500, cw * 500, cd * 500);
          expect(floorOutlineProblems(outline)).toEqual([]);
          // Independent oracle: count the 500 mm cells inside the outline.
          let cells = 0;
          for (let i = 0; i < w; i += 1) {
            for (let j = 0; j < d; j += 1) {
              if (!(i >= w - cw && j >= d - cd)) {
                cells += 1;
              }
            }
          }
          expect(polygonAreaMm2(outline)).toBe(BigInt(cells) * 250_000n);
        },
      ),
    );
  });
});
