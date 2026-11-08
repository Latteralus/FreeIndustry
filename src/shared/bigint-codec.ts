import { z } from 'zod';

/**
 * Deterministic decimal-string codec for `bigint` values that cross a JSON
 * boundary (IPC messages, persisted event payloads). Specification §9.3 and
 * §11.1: JSON has no bigint type, so values travel as canonical base-10
 * strings and are validated on the way back in.
 *
 * Canonical form: optional leading '-', no leading zeros, no '+', no
 * whitespace, and never "-0". Exactly one encoding exists per value, which
 * keeps hashes of encoded payloads stable.
 */
const CANONICAL_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;

export function encodeBigInt(value: bigint): string {
  return value.toString(10);
}

export function decodeBigInt(text: string): bigint {
  if (!CANONICAL_DECIMAL.test(text)) {
    throw new RangeError(`Not a canonical decimal integer: ${JSON.stringify(text)}`);
  }
  return BigInt(text);
}

/** Zod schema that accepts a canonical decimal string and yields a bigint. */
export const bigIntString = z
  .string()
  .regex(CANONICAL_DECIMAL, 'Expected a canonical decimal integer string')
  .transform((text) => BigInt(text));
