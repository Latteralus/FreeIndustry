/**
 * Canonical JSON text for plain data: object keys sorted, no whitespace.
 * Two values that are structurally equal always produce the same string,
 * whatever order their keys were written in. Used to compare command
 * contents for idempotency (ADR-0013); later steps reuse it for state
 * fingerprints.
 *
 * Accepts only JSON data (null, boolean, finite number, string, array, plain
 * object). `bigint` must be encoded first with `bigint-codec`; anything else
 * (undefined, functions, NaN, class instances) throws rather than being
 * silently dropped, because silent dropping would make different values equal.
 */
/** Plain JSON data: what persisted event payloads and fingerprinted state are made of. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalJson: non-finite number ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}
