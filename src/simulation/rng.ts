/**
 * Seeded, versioned pseudo-random numbers (spec §9.4). No `Math.random`.
 *
 * Algorithm `xoshiro128**` (Blackman & Vigna, 2018) with 128 bits of state,
 * seeded through SplitMix32. The state is four unsigned 32-bit integers and
 * is persisted with the world, so a restored world continues the exact same
 * sequence. Only integer results are offered: simulation code must not
 * derive authoritative values from floating point.
 *
 * The world keeps one independent stream per subsystem (`diagnostics`,
 * later `labour-market`, `suppliers`, …). Each stream's starting state comes
 * from the world seed and the stream name, so adding draws to one subsystem
 * never shifts the numbers another subsystem sees.
 */

/** Recorded in the world so a future algorithm change is detectable. */
export const RNG_ALGORITHM = 'xoshiro128**/splitmix32/v1';

/** Four unsigned 32-bit words; never all zero. */
export type RngState = readonly [number, number, number, number];

const UINT32_RANGE = 0x1_0000_0000;

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** SplitMix32 output for `counter` (a bijective mix of the 32-bit counter). */
function splitMix32(counter: number): number {
  let z = counter >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85eb_ca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2_ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

/** FNV-1a over the UTF-16 code units of `text` (stream names are ASCII). */
function fnv1a32(text: string): number {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x0100_0193);
  }
  return hash >>> 0;
}

export function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < UINT32_RANGE;
}

export function isValidRngState(state: readonly number[]): state is RngState {
  return state.length === 4 && state.every(isUint32) && state.some((word) => word !== 0);
}

/**
 * Starting state of stream `name` for world `seed`. Four consecutive
 * SplitMix32 outputs; because SplitMix32 is a bijection, at most one of them
 * can be zero, so the state is never the forbidden all-zero state.
 */
export function seedStream(seed: number, name: string): RngState {
  if (!isUint32(seed)) {
    throw new RangeError(`World seed must be an unsigned 32-bit integer, got ${seed}`);
  }
  const base = (seed ^ Math.imul(fnv1a32(name), 0x9e37_79b9)) >>> 0;
  const golden = 0x9e37_79b9;
  return [
    splitMix32(base + golden),
    splitMix32(base + 2 * golden),
    splitMix32(base + 3 * golden),
    splitMix32(base + 4 * golden),
  ];
}

export class Rng {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;

  constructor(state: RngState) {
    if (!isValidRngState(state)) {
      throw new RangeError('Invalid RNG state: need four uint32 words, not all zero');
    }
    [this.#s0, this.#s1, this.#s2, this.#s3] = state;
  }

  get state(): RngState {
    return [this.#s0, this.#s1, this.#s2, this.#s3];
  }

  /** Next value in [0, 2³²). */
  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.#s1, 5) >>> 0, 7), 9) >>> 0;
    const shifted = (this.#s1 << 9) >>> 0;
    this.#s2 = (this.#s2 ^ this.#s0) >>> 0;
    this.#s3 = (this.#s3 ^ this.#s1) >>> 0;
    this.#s1 = (this.#s1 ^ this.#s2) >>> 0;
    this.#s0 = (this.#s0 ^ this.#s3) >>> 0;
    this.#s2 = (this.#s2 ^ shifted) >>> 0;
    this.#s3 = rotl(this.#s3, 11);
    return result;
  }

  /** Uniform integer in [0, bound), unbiased (rejection sampling). 1 ≤ bound ≤ 2³². */
  nextBelow(bound: number): number {
    if (!Number.isInteger(bound) || bound < 1 || bound > UINT32_RANGE) {
      throw new RangeError(`nextBelow bound must be an integer in [1, 2^32], got ${bound}`);
    }
    const limit = UINT32_RANGE - (UINT32_RANGE % bound);
    for (;;) {
      const value = this.nextUint32();
      if (value < limit) {
        return value % bound;
      }
    }
  }

  /** Uniform integer in [min, max] (inclusive); the range may span at most 2³² values. */
  nextIntInclusive(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`Invalid integer range [${min}, ${max}]`);
    }
    return min + this.nextBelow(max - min + 1);
  }

  /** True with probability `numerator / denominator` (exact rational odds). */
  chance(numerator: number, denominator: number): boolean {
    if (
      !Number.isInteger(numerator) ||
      !Number.isInteger(denominator) ||
      denominator < 1 ||
      numerator < 0 ||
      numerator > denominator
    ) {
      throw new RangeError(`Invalid odds ${numerator}/${denominator}`);
    }
    return this.nextBelow(denominator) < numerator;
  }

  /** One element chosen uniformly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Cannot pick from an empty list');
    }
    return items[this.nextBelow(items.length)] as T;
  }

  /** A uniformly shuffled copy (Fisher–Yates). */
  shuffled<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = this.nextBelow(index + 1);
      [result[index], result[other]] = [result[other] as T, result[index] as T];
    }
    return result;
  }
}
