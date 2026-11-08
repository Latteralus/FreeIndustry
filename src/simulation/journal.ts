import { decodeBigInt, encodeBigInt } from '../shared/bigint-codec';
import { canonicalJson, type JsonValue } from '../shared/canonical-json';
import type { EncodedJournalEntry } from '../shared/world-checkpoint';
import type { SimTimeMs } from '../domain/time';
import type { Fact } from './rules';
import { sha256Hex } from './sha256';

/**
 * The command/event journal (spec §9.2, §10.2 `command_log`,
 * `simulation_events`). Append-only, in the exact order things happened:
 * every accepted command with the simulation time it took effect, and every
 * processed event, each with the facts its handler recorded.
 *
 * The command entries alone are enough to replay the world from its seed;
 * the event entries are the audit trail. A SHA-256 hash chain over all
 * entries gives one fingerprint for the whole history. The live journal is
 * held in memory; saves store it in SQLite (`journal_entries`, ADR-0026).
 */

export interface CommandRecord {
  readonly kind: 'command';
  readonly seq: number;
  readonly atMs: SimTimeMs;
  /** World revision after this command. */
  readonly revision: number;
  readonly commandId: string;
  readonly type: string;
  readonly payload: JsonValue;
  /** Canonical JSON of the command's contents, for idempotency checks. */
  readonly fingerprint: string;
  readonly facts: readonly Fact[];
}

interface EventRecord {
  readonly kind: 'event';
  readonly seq: number;
  readonly atMs: SimTimeMs;
  readonly eventId: string;
  readonly type: string;
  readonly payload: JsonValue;
  readonly facts: readonly Fact[];
}

export type JournalEntry = CommandRecord | EventRecord;

type NewEntry = Omit<CommandRecord, 'seq'> | Omit<EventRecord, 'seq'>;

/** Hash-chain value before the first entry. */
const JOURNAL_GENESIS_HASH = '0'.repeat(64);

export function encodeJournalEntry(entry: JournalEntry): EncodedJournalEntry {
  const facts = entry.facts.map((fact) => ({ type: fact.type, data: fact.data }));
  return entry.kind === 'command'
    ? {
        kind: entry.kind,
        seq: entry.seq,
        atMs: encodeBigInt(entry.atMs),
        revision: entry.revision,
        commandId: entry.commandId,
        type: entry.type,
        payload: entry.payload,
        fingerprint: entry.fingerprint,
        facts,
      }
    : {
        kind: entry.kind,
        seq: entry.seq,
        atMs: encodeBigInt(entry.atMs),
        eventId: entry.eventId,
        type: entry.type,
        payload: entry.payload,
        facts,
      };
}

export function decodeJournalEntry(encoded: EncodedJournalEntry): JournalEntry {
  const common = {
    seq: encoded.seq,
    atMs: decodeBigInt(encoded.atMs),
    type: encoded.type,
    payload: encoded.payload,
    facts: encoded.facts,
  };
  return encoded.kind === 'command'
    ? {
        kind: 'command',
        ...common,
        revision: encoded.revision,
        commandId: encoded.commandId,
        fingerprint: encoded.fingerprint,
      }
    : { kind: 'event', ...common, eventId: encoded.eventId };
}

export class Journal {
  readonly #entries: JournalEntry[] = [];
  readonly #commands = new Map<string, CommandRecord>();
  #eventCount = 0;
  #chainHash = JOURNAL_GENESIS_HASH;
  #hashedCount = 0;

  static from(entries: readonly JournalEntry[]): Journal {
    const journal = new Journal();
    entries.forEach((entry, index) => {
      if (entry.seq !== index + 1) {
        throw new Error(`Journal entry ${index + 1} has sequence ${entry.seq}`);
      }
      journal.#push(entry);
    });
    return journal;
  }

  get length(): number {
    return this.#entries.length;
  }

  get commandCount(): number {
    return this.#commands.size;
  }

  get eventCount(): number {
    return this.#eventCount;
  }

  get entries(): readonly JournalEntry[] {
    return this.#entries;
  }

  command(commandId: string): CommandRecord | undefined {
    return this.#commands.get(commandId);
  }

  append(entry: NewEntry): JournalEntry {
    const complete = { ...entry, seq: this.#entries.length + 1 } as JournalEntry;
    this.#push(complete);
    return complete;
  }

  /** Hash chain over every entry; extended incrementally on demand. */
  hash(): string {
    for (const entry of this.#entries.slice(this.#hashedCount)) {
      this.#chainHash = sha256Hex(
        `${this.#chainHash}\n${canonicalJson(encodeJournalEntry(entry))}`,
      );
      this.#hashedCount += 1;
    }
    return this.#chainHash;
  }

  #push(entry: JournalEntry): void {
    if (entry.kind === 'command') {
      if (this.#commands.has(entry.commandId)) {
        throw new Error(`Command ${entry.commandId} is already in the journal`);
      }
      this.#commands.set(entry.commandId, entry);
    } else {
      this.#eventCount += 1;
    }
    this.#entries.push(entry);
  }
}
