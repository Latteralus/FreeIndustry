import { z } from 'zod';
import type { JsonValue } from './canonical-json';

/**
 * The encoded form of a simulation-kernel checkpoint (DECISIONS ADR-0022,
 * ADR-0026): the complete kernel state plus its journal, as plain JSON data
 * with every `bigint` written as a canonical decimal string.
 *
 * It is a data contract between two layers that may not import each other:
 * `simulation` produces and restores it, and `persistence` maps it to SQLite
 * tables. The kernel re-validates everything on restore, so this schema checks
 * shape only; consistency (sequences, fingerprints, invariants) is the
 * kernel's job.
 *
 * The field names and nesting are part of the state and journal
 * fingerprints. Changing them is a new kernel format version.
 */

const CANONICAL_NATURAL = /^(?:0|[1-9][0-9]*)$/;

/** A non-negative `bigint` as a canonical decimal string. */
const natural = z
  .string()
  .regex(CANONICAL_NATURAL, 'Expected a non-negative canonical decimal integer');

const jsonValue = z.json();
const count = z.int().min(0);

interface EncodedFact {
  readonly type: string;
  readonly data: JsonValue;
}

interface EncodedCommandEntry {
  readonly kind: 'command';
  readonly seq: number;
  readonly atMs: string;
  /** World revision after this command. */
  readonly revision: number;
  readonly commandId: string;
  readonly type: string;
  readonly payload: JsonValue;
  readonly fingerprint: string;
  readonly facts: readonly EncodedFact[];
}

interface EncodedEventEntry {
  readonly kind: 'event';
  readonly seq: number;
  readonly atMs: string;
  readonly eventId: string;
  readonly type: string;
  readonly payload: JsonValue;
  readonly facts: readonly EncodedFact[];
}

export type EncodedJournalEntry = EncodedCommandEntry | EncodedEventEntry;

export interface EncodedEvent {
  readonly id: string;
  readonly timeMs: string;
  readonly priority: number;
  readonly sequence: string;
  readonly type: string;
  readonly payload: JsonValue;
}

export interface EncodedKernelState {
  readonly format: number;
  readonly rules: { readonly id: string; readonly version: number };
  readonly rng: string;
  readonly config: {
    readonly seed: number;
    readonly epoch: { readonly year: number; readonly month: number; readonly day: number };
  };
  readonly nowMs: string;
  readonly worldRevision: number;
  readonly processedEvents: number;
  readonly nextSequence: string;
  /** Last ordinal issued per entity kind. */
  readonly ids: Readonly<Record<string, number>>;
  /** Four unsigned 32-bit words per named random stream. */
  readonly rngStreams: Readonly<Record<string, readonly number[]>>;
  /** Pending events in `(time, priority, sequence)` order. */
  readonly queue: readonly EncodedEvent[];
  /** The rules' own encoding of the domain state. */
  readonly domain: JsonValue;
}

export interface WorldCheckpoint {
  readonly state: EncodedKernelState;
  readonly journal: readonly EncodedJournalEntry[];
}

const factSchema = z.strictObject({ type: z.string().min(1).max(64), data: jsonValue });

const journalEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('command'),
    seq: z.int().min(1),
    atMs: natural,
    revision: z.int().min(1),
    commandId: z.string().min(1).max(64),
    type: z.string().min(1).max(64),
    payload: jsonValue,
    fingerprint: z.string(),
    facts: z.array(factSchema),
  }),
  z.strictObject({
    kind: z.literal('event'),
    seq: z.int().min(1),
    atMs: natural,
    eventId: z.string().min(1).max(40),
    type: z.string().min(1).max(64),
    payload: jsonValue,
    facts: z.array(factSchema),
  }),
]);

const encodedEventSchema = z.strictObject({
  id: z.string().max(40),
  timeMs: natural,
  priority: z.int(),
  sequence: natural,
  type: z.string().min(1).max(64),
  payload: jsonValue,
});

export const worldCheckpointSchema: z.ZodType<WorldCheckpoint> = z.strictObject({
  state: z.strictObject({
    format: z.int(),
    rules: z.strictObject({ id: z.string(), version: z.int() }),
    rng: z.string(),
    config: z.strictObject({
      seed: z.int().min(0),
      epoch: z.strictObject({ year: z.int(), month: z.int(), day: z.int() }),
    }),
    nowMs: natural,
    worldRevision: count,
    processedEvents: count,
    nextSequence: natural,
    ids: z.record(z.string(), z.int().min(1)),
    rngStreams: z.record(z.string(), z.array(z.int().min(0))),
    queue: z.array(encodedEventSchema),
    domain: jsonValue,
  }),
  journal: z.array(journalEntrySchema),
});
