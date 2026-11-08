import fc from 'fast-check';
import { isValidRngState, Rng, seedStream, type RngState } from '../../../src/simulation/rng';

/**
 * Independent reference implementation of xoshiro128** written with BigInt
 * masks, following Blackman & Vigna's published C code line by line. The
 * production version uses 32-bit integer tricks (Math.imul, >>> 0); the two
 * must agree exactly.
 */
function referenceXoshiro128ss(seed: RngState) {
  const MASK = 0xffff_ffffn;
  const s = seed.map((word) => BigInt(word));
  const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (32n - k))) & MASK;
  return () => {
    const [s0, s1, s2, s3] = s as [bigint, bigint, bigint, bigint];
    const result = (rotl((s1 * 5n) & MASK, 7n) * 9n) & MASK;
    const t = (s1 << 9n) & MASK;
    let n2 = s2 ^ s0;
    let n3 = s3 ^ s1;
    const n1 = s1 ^ n2;
    const n0 = s0 ^ n3;
    n2 ^= t;
    n3 = rotl(n3, 11n);
    s[0] = n0;
    s[1] = n1;
    s[2] = n2;
    s[3] = n3;
    return Number(result);
  };
}

const uint32 = fc.integer({ min: 0, max: 0xffff_ffff });
const state = fc
  .tuple(uint32, uint32, uint32, uint32)
  .filter((words) => words.some((word) => word !== 0));

describe('xoshiro128** RNG', () => {
  it('property: matches the reference implementation for any state', () => {
    fc.assert(
      fc.property(state, (words) => {
        const rng = new Rng(words);
        const reference = referenceXoshiro128ss(words);
        for (let index = 0; index < 64; index += 1) {
          expect(rng.nextUint32()).toBe(reference());
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is locked to known output for a fixed seed (regression guard for the algorithm version)', () => {
    // If either of these changes, saved worlds would replay differently:
    // introduce a new RNG_ALGORITHM version instead of editing the old one.
    expect(seedStream(12345, 'diagnostics')).toEqual([
      3941492352, 1441060084, 3341658123, 779589083,
    ]);
    const rng = new Rng(seedStream(12345, 'diagnostics'));
    expect(Array.from({ length: 4 }, () => rng.nextUint32())).toEqual([
      2629268742, 1876175628, 3127345312, 776412437,
    ]);
  });

  it('continues identically from a saved state', () => {
    const rng = new Rng(seedStream(7, 'market'));
    for (let index = 0; index < 100; index += 1) {
      rng.nextUint32();
    }
    const saved = rng.state;
    const restored = new Rng(saved);
    for (let index = 0; index < 100; index += 1) {
      expect(restored.nextUint32()).toBe(rng.nextUint32());
    }
  });

  it('gives independent streams per name and per seed', () => {
    const draw = (seed: number, name: string) => new Rng(seedStream(seed, name)).nextUint32();
    expect(draw(1, 'market')).not.toBe(draw(1, 'labour'));
    expect(draw(1, 'market')).not.toBe(draw(2, 'market'));
    expect(draw(1, 'market')).toBe(draw(1, 'market'));
  });

  it('property: seeded states are always valid (never all zero)', () => {
    fc.assert(
      fc.property(uint32, fc.string({ maxLength: 32 }), (seed, name) => {
        expect(isValidRngState(seedStream(seed, name))).toBe(true);
      }),
    );
  });

  it.each([[[0, 0, 0, 0]], [[1, 2, 3]], [[1, 2, 3, -1]], [[1, 2, 3, 2 ** 32]], [[1, 2, 3, 0.5]]])(
    'rejects the invalid state %j',
    (words) => {
      expect(() => new Rng(words as unknown as RngState)).toThrow(RangeError);
    },
  );

  it('rejects a seed that is not an unsigned 32-bit integer', () => {
    expect(() => seedStream(-1, 'x')).toThrow(RangeError);
    expect(() => seedStream(2 ** 32, 'x')).toThrow(RangeError);
    expect(() => seedStream(1.5, 'x')).toThrow(RangeError);
  });

  it('property: nextBelow and nextIntInclusive stay in range', () => {
    fc.assert(
      fc.property(
        state,
        fc.integer({ min: 1, max: 2 ** 32 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (words, bound, min, span) => {
          const rng = new Rng(words);
          const value = rng.nextBelow(bound);
          expect(Number.isInteger(value) && value >= 0 && value < bound).toBe(true);
          const ranged = rng.nextIntInclusive(min, min + span);
          expect(ranged >= min && ranged <= min + span).toBe(true);
        },
      ),
    );
  });

  it('nextBelow is unbiased: each face of a die appears close to 1/6 of the time', () => {
    const rng = new Rng(seedStream(99, 'dice'));
    const counts = [0, 0, 0, 0, 0, 0];
    const draws = 60_000;
    for (let index = 0; index < draws; index += 1) {
      const face = rng.nextBelow(6);
      counts[face] = (counts[face] ?? 0) + 1;
    }
    // Chi-square with 5 degrees of freedom; 20.5 is the 0.1 % critical value.
    const expected = draws / 6;
    const chiSquare = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    expect(chiSquare).toBeLessThan(20.5);
  });

  it('chance uses exact rational odds', () => {
    const rng = new Rng(seedStream(5, 'odds'));
    expect(Array.from({ length: 50 }, () => rng.chance(0, 7)).some(Boolean)).toBe(false);
    expect(Array.from({ length: 50 }, () => rng.chance(7, 7)).every(Boolean)).toBe(true);
    expect(() => rng.chance(8, 7)).toThrow(RangeError);
    expect(() => rng.chance(1, 0)).toThrow(RangeError);
  });

  it('pick and shuffled are deterministic and complete', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const one = new Rng(seedStream(3, 'cards'));
    const two = new Rng(seedStream(3, 'cards'));
    const shuffled = one.shuffled(items);
    expect(shuffled).toEqual(two.shuffled(items));
    expect([...shuffled].sort()).toEqual(items);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']); // input untouched
    expect(items).toContain(one.pick(items));
    expect(() => one.pick([])).toThrow(RangeError);
  });
});
