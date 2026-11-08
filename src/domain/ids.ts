/**
 * Entity identifiers (spec §10.2: "deterministic sequence-based IDs during
 * simulation"). An ID is `<kind>:<n>`, where `kind` names the entity family
 * and `n` is a positive counter kept per kind in the world state. The same
 * seed and commands therefore always produce the same IDs, and adding a new
 * entity kind never renumbers the others.
 */

declare const entityKind: unique symbol;

/** A world entity ID such as `probe:3`; the brand records its kind. */
export type EntityId<K extends string = string> = string & { readonly [entityKind]: K };

/** Lower-case ASCII words joined by hyphens: `probe`, `stock-lot`. */
const KIND = /^[a-z]+(?:-[a-z]+)*$/;
const ENTITY_ID = /^([a-z]+(?:-[a-z]+)*):([1-9][0-9]*)$/;

/**
 * Issues the next ID of a kind. Business rules receive one from the
 * simulation kernel (staged and discarded with the handler on rejection), so
 * they stay pure and deterministic.
 */
export type AllocateId = <K extends string>(kind: K) => EntityId<K>;

export function isEntityKind(kind: string): boolean {
  return kind.length <= 32 && KIND.test(kind);
}

export function formatEntityId<K extends string>(kind: K, ordinal: number): EntityId<K> {
  if (!isEntityKind(kind)) {
    throw new RangeError(`Invalid entity kind ${JSON.stringify(kind)}`);
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`Entity ordinal must be a positive safe integer, got ${ordinal}`);
  }
  return `${kind}:${ordinal}` as EntityId<K>;
}

export function parseEntityId(
  id: string,
): { readonly kind: string; readonly ordinal: number } | null {
  const match = ENTITY_ID.exec(id);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const ordinal = Number(match[2]);
  return Number.isSafeInteger(ordinal) ? { kind: match[1], ordinal } : null;
}

export function isEntityIdOf<K extends string>(kind: K, id: string): id is EntityId<K> {
  return parseEntityId(id)?.kind === kind;
}
