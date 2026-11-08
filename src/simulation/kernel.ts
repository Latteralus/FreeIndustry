import { encodeBigInt } from '../shared/bigint-codec';
import { canonicalJson, type JsonValue } from '../shared/canonical-json';
import { describeZodError } from '../shared/ipc/contract';
import {
  worldCheckpointSchema,
  type EncodedJournalEntry,
  type EncodedKernelState,
  type WorldCheckpoint,
} from '../shared/world-checkpoint';
import { formatEntityId, isEntityKind, type EntityId } from '../domain/ids';
import { Rejection } from '../domain/rejection';
import {
  calendarAt,
  isValidCivilDate,
  type CalendarInstant,
  type CivilDate,
  type SimTimeMs,
} from '../domain/time';
import { EventQueue, eventIdFor, type ScheduledEvent } from './event-queue';
import { decodeJournalEntry, encodeJournalEntry, Journal } from './journal';
import { isUint32, isValidRngState, Rng, RNG_ALGORITHM, seedStream, type RngState } from './rng';
import {
  LANE_PRIORITY,
  type Fact,
  type KernelContext,
  type ScheduleRequest,
  type SimulationRules,
} from './rules';
import { sha256Hex } from './sha256';

/**
 * The deterministic simulation kernel (spec §9, plan Step 03, DECISIONS
 * ADR-0019 – ADR-0022). Pure TypeScript: no wall clock, no ambient
 * randomness, no I/O, no Electron, no rendering.
 *
 * - **Time** is a discrete `bigint` millisecond clock. It moves only through
 *   `advanceTo`. Invariant: every event at or before `nowMs` has been
 *   processed (from creation onwards, so nothing is ever pending "now").
 * - **Ordering**: events pop by `(time, lane priority, sequence)`.
 * - **Commands** take effect at the current `nowMs`, after every event due
 *   at that instant; events they schedule for "now" run straight after.
 * - **Atomicity**: a handler's state, random draws, new IDs, scheduled
 *   events and facts are staged and committed together, or not at all.
 * - **Determinism**: the same rules, config and command journal (each
 *   command with its simulation time) yield the same state and journal
 *   fingerprints, however the clock was advanced in between.
 */

export interface WorldConfig {
  /** Unsigned 32-bit world seed. */
  readonly seed: number;
  /** Calendar date of day 0; simulation time 0 is midnight at its start. */
  readonly epoch: CivilDate;
}

/** Version of the kernel's own state encoding (fingerprints, checkpoints and saves). */
export const KERNEL_FORMAT_VERSION = 1;

/** Safety stop for an event that keeps rescheduling itself at the same instant. */
const MAX_EVENTS_PER_INSTANT = 100_000;

const STREAM_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export interface CommandInput {
  readonly commandId: string;
  readonly expectedWorldRevision: number;
  readonly type: string;
  readonly payload: unknown;
}

type KernelErrorCode =
  | 'UNKNOWN_COMMAND'
  | 'INVALID_PAYLOAD'
  | 'STALE_REVISION'
  | 'COMMAND_ID_REUSED'
  | 'COMMAND_REJECTED'
  | 'INVALID_STATE'
  | 'INTERNAL_ERROR';

export interface KernelError {
  readonly code: KernelErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

interface KernelReceipt {
  readonly commandId: string;
  /** World revision after the command. */
  readonly worldRevision: number;
  /** Simulation time at which the command took effect. */
  readonly atMs: SimTimeMs;
  readonly duplicate: boolean;
}

export type SubmitResult =
  | { readonly ok: true; readonly receipt: KernelReceipt }
  | { readonly ok: false; readonly error: KernelError };

export interface AdvanceOptions {
  /**
   * Stop once this many events have been processed — but only at an instant
   * boundary, so a command can never land between two events of one instant.
   */
  readonly maxEvents?: number;
  /** Stop after the first instant that contained a notable event. */
  readonly stopAfterNotable?: boolean;
}

type AdvanceStop = 'reached' | 'budget' | 'notable' | 'fault';

export interface AdvanceResult {
  readonly stop: AdvanceStop;
  readonly nowMs: SimTimeMs;
  readonly processed: number;
}

/** An event handler threw. The kernel stops; the failed event stays queued, uncommitted. */
export interface KernelFault {
  readonly atMs: SimTimeMs;
  readonly eventId: string;
  readonly type: string;
  readonly message: string;
}

export interface WorldFingerprint {
  /** SHA-256 of the canonical encoding of the complete world state. */
  readonly stateHash: string;
  /** Head of the SHA-256 hash chain over the journal. */
  readonly journalHash: string;
}

export interface PendingEventView {
  readonly id: string;
  readonly timeMs: SimTimeMs;
  readonly type: string;
  readonly notable: boolean;
}

/** Everything a handler changes, held until commit. */
class Stage {
  readonly scheduled: ScheduledEvent[] = [];
  readonly facts: Fact[] = [];
  readonly ids = new Map<string, number>();
  readonly streams = new Map<string, Rng>();
  nextSequence: bigint;

  constructor(nextSequence: bigint) {
    this.nextSequence = nextSequence;
  }
}

type ContextPhase = 'genesis' | 'command' | 'event';

export class SimulationKernel<S> {
  readonly rules: SimulationRules<S>;
  readonly config: WorldConfig;

  #now: SimTimeMs = 0n;
  #revision = 0;
  #processedEvents = 0;
  #nextSequence = 1n;
  readonly #ids = new Map<string, number>();
  readonly #streams = new Map<string, RngState>();
  #queue = new EventQueue();
  #state!: S;
  #journal = new Journal();
  #fault: KernelFault | null = null;
  /** Bumped on every change; keys the state-hash cache. */
  #version = 0;
  #stateHashCache: { readonly version: number; readonly hash: string } | null = null;

  private constructor(rules: SimulationRules<S>, config: WorldConfig) {
    validateRules(rules);
    if (!isUint32(config.seed)) {
      throw new RangeError(`World seed must be an unsigned 32-bit integer, got ${config.seed}`);
    }
    if (!isValidCivilDate(config.epoch)) {
      throw new RangeError('World epoch is not a valid calendar date');
    }
    this.rules = rules;
    this.config = { seed: config.seed, epoch: { ...config.epoch } };
  }

  /**
   * A new world at time 0, revision 0. `setup` is plain-JSON content the
   * rules build the world from (ADR-0037); it is not kept, because the state
   * it produces is.
   */
  static create<S>(
    rules: SimulationRules<S>,
    config: WorldConfig,
    setup: JsonValue = null,
  ): SimulationKernel<S> {
    const kernel = new SimulationKernel(rules, config);
    const stage = new Stage(kernel.#nextSequence);
    const state = rules.initialState(kernel.#context(stage, 'genesis'), setup);
    for (const [type, periodic] of Object.entries(rules.periodic)) {
      kernel.#stageEvent(stage, type, periodic.phaseMs, LANE_PRIORITY[periodic.lane], null);
    }
    kernel.#commit(stage, state);
    // Anything due at time 0 runs now, so the invariant holds from the start
    // and a first command at time 0 always follows those events, as in replay.
    if (kernel.advanceTo(0n).stop === 'fault') {
      throw new Error(`World creation failed: ${kernel.#fault?.message ?? 'unknown fault'}`);
    }
    return kernel;
  }

  /** Rebuild a kernel from {@link checkpoint} output. Fails loudly on any inconsistency. */
  static restore<S>(rules: SimulationRules<S>, checkpoint: unknown): SimulationKernel<S> {
    const parsed = worldCheckpointSchema.safeParse(checkpoint);
    if (!parsed.success) {
      throw new Error(`Invalid world checkpoint: ${describeZodError(parsed.error)}`);
    }
    const { state, journal } = parsed.data;
    if (state.format !== KERNEL_FORMAT_VERSION) {
      throw new Error(`Unsupported checkpoint format ${state.format}`);
    }
    if (state.rules.id !== rules.id || state.rules.version !== rules.version) {
      throw new Error(
        `Checkpoint is for rules ${state.rules.id} v${state.rules.version}, not ${rules.id} v${rules.version}`,
      );
    }
    if (state.rng !== RNG_ALGORITHM) {
      throw new Error(`Checkpoint uses RNG ${state.rng}, not ${RNG_ALGORITHM}`);
    }
    const kernel = new SimulationKernel(rules, state.config);
    const nextSequence = BigInt(state.nextSequence);
    kernel.#now = BigInt(state.nowMs);
    kernel.#revision = state.worldRevision;
    kernel.#processedEvents = state.processedEvents;
    kernel.#nextSequence = nextSequence;
    for (const [kind, ordinal] of Object.entries(state.ids)) {
      if (!isEntityKind(kind)) {
        throw new Error(`Checkpoint has invalid entity kind ${kind}`);
      }
      kernel.#ids.set(kind, ordinal);
    }
    for (const [name, words] of Object.entries(state.rngStreams)) {
      if (!STREAM_NAME.test(name) || !isValidRngState(words)) {
        throw new Error(`Checkpoint has an invalid RNG stream ${name}`);
      }
      kernel.#streams.set(name, words);
    }
    kernel.#queue = EventQueue.from(
      state.queue.map((encoded) => {
        const event: ScheduledEvent = {
          ...encoded,
          timeMs: BigInt(encoded.timeMs),
          sequence: BigInt(encoded.sequence),
        };
        if (eventIdFor(event.sequence) !== event.id || event.sequence >= nextSequence) {
          throw new Error(`Checkpoint event ${event.id} has an inconsistent sequence`);
        }
        const lane = Object.hasOwn(rules.events, event.type)
          ? rules.events[event.type]?.lane
          : Object.hasOwn(rules.periodic, event.type)
            ? rules.periodic[event.type]?.lane
            : undefined;
        if (lane === undefined) {
          throw new Error(`Checkpoint event ${event.id} has unknown type ${event.type}`);
        }
        if (event.priority !== LANE_PRIORITY[lane]) {
          throw new Error(
            `Checkpoint event ${event.id} has priority ${event.priority}, not its lane's`,
          );
        }
        return event;
      }),
    );
    kernel.#state = rules.decodeState(state.domain);
    const entries = journal.map(decodeJournalEntry);
    for (const entry of entries) {
      if (
        entry.kind === 'command' &&
        entry.fingerprint !==
          commandFingerprint(entry.revision - 1, entry.type, canonicalJson(entry.payload))
      ) {
        throw new Error(`Checkpoint command ${entry.commandId} has an inconsistent fingerprint`);
      }
    }
    kernel.#journal = Journal.from(entries);
    const violations = kernel.checkInvariants();
    if (violations.length > 0) {
      throw new Error(`Checkpoint violates kernel invariants: ${violations.join('; ')}`);
    }
    return kernel;
  }

  // ------------------------------------------------------------ reads

  get nowMs(): SimTimeMs {
    return this.#now;
  }

  get worldRevision(): number {
    return this.#revision;
  }

  get processedEvents(): number {
    return this.#processedEvents;
  }

  get state(): S {
    return this.#state;
  }

  get fault(): KernelFault | null {
    return this.#fault;
  }

  get pendingEventCount(): number {
    return this.#queue.size;
  }

  get journal(): Pick<Journal, 'entries' | 'length' | 'commandCount' | 'eventCount' | 'command'> {
    return this.#journal;
  }

  calendar(): CalendarInstant {
    return calendarAt(this.config.epoch, this.#now);
  }

  nextEvent(): PendingEventView | null {
    const next = this.#queue.peek();
    return next ? this.#viewOf(next) : null;
  }

  pendingEvents(): PendingEventView[] {
    return this.#queue.toSortedArray().map((event) => this.#viewOf(event));
  }

  fingerprint(): WorldFingerprint {
    if (this.#stateHashCache?.version !== this.#version) {
      this.#stateHashCache = {
        version: this.#version,
        hash: sha256Hex(canonicalJson(this.#encodeState())),
      };
    }
    return { stateHash: this.#stateHashCache.hash, journalHash: this.#journal.hash() };
  }

  /** Complete world state and journal as plain JSON (restorable with {@link restore}). */
  checkpoint(): WorldCheckpoint {
    return {
      state: this.#encodeState(),
      journal: this.#journal.entries.map(encodeJournalEntry),
    };
  }

  /** The encoded world state alone (the checkpoint without its journal). */
  encodedState(): EncodedKernelState {
    return this.#encodeState();
  }

  /** Encoded journal entries with sequence ≥ `fromSeq` (1 = the whole journal). */
  encodedJournalFrom(fromSeq: number): EncodedJournalEntry[] {
    return this.#journal.entries.slice(Math.max(fromSeq, 1) - 1).map(encodeJournalEntry);
  }

  /** Kernel and domain invariants; returns violations (empty when consistent). */
  checkInvariants(): string[] {
    const violations: string[] = [];
    const pending = this.#queue.toSortedArray();
    const ids = new Set<string>();
    for (const event of pending) {
      if (event.timeMs <= this.#now) {
        violations.push(
          `event ${event.id} is due at ${event.timeMs}, not after now (${this.#now}), but unprocessed`,
        );
      }
      if (event.sequence >= this.#nextSequence) {
        violations.push(`event ${event.id} has a sequence not yet issued`);
      }
      if (ids.has(event.id)) {
        violations.push(`event ${event.id} is queued twice`);
      }
      ids.add(event.id);
    }
    for (const type of Object.keys(this.rules.periodic)) {
      const count = pending.filter((event) => event.type === type).length;
      if (count !== 1) {
        violations.push(`periodic process ${type} has ${count} pending occurrences, expected 1`);
      }
    }
    if (this.#journal.commandCount !== this.#revision) {
      violations.push(
        `revision ${this.#revision} differs from ${this.#journal.commandCount} journaled commands`,
      );
    }
    if (this.#journal.eventCount !== this.#processedEvents) {
      violations.push(
        `${this.#processedEvents} processed events but ${this.#journal.eventCount} journaled`,
      );
    }
    let previous = 0n;
    for (const entry of this.#journal.entries) {
      if (entry.atMs < previous || entry.atMs > this.#now) {
        violations.push(`journal entry ${entry.seq} is out of time order`);
        break;
      }
      previous = entry.atMs;
    }
    violations.push(...(this.rules.checkInvariants?.(this.#state) ?? []));
    return violations;
  }

  // -------------------------------------------------------- commands

  submit(input: CommandInput): SubmitResult {
    if (this.#fault) {
      return failure(
        'INVALID_STATE',
        `The simulation stopped after a fault: ${this.#fault.message}`,
      );
    }
    const definition = Object.hasOwn(this.rules.commands, input.type)
      ? this.rules.commands[input.type]
      : undefined;
    if (!definition) {
      return failure('UNKNOWN_COMMAND', `Unknown command type "${input.type}"`);
    }
    const payload = definition.payload.safeParse(input.payload);
    if (!payload.success) {
      return failure(
        'INVALID_PAYLOAD',
        `Invalid payload for "${input.type}": ${describeZodError(payload.error)}`,
      );
    }
    let payloadJson: string;
    try {
      payloadJson = canonicalJson(input.payload);
    } catch (error) {
      return failure('INVALID_PAYLOAD', `Payload is not plain JSON data: ${messageOf(error)}`);
    }
    const fingerprint = commandFingerprint(input.expectedWorldRevision, input.type, payloadJson);

    const previous = this.#journal.command(input.commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return failure(
          'COMMAND_ID_REUSED',
          `Command ID ${input.commandId} was already accepted with different contents`,
        );
      }
      return {
        ok: true,
        receipt: {
          commandId: previous.commandId,
          worldRevision: previous.revision,
          atMs: previous.atMs,
          duplicate: true,
        },
      };
    }
    if (input.expectedWorldRevision !== this.#revision) {
      return failure(
        'STALE_REVISION',
        `Command expected world revision ${input.expectedWorldRevision}, but the world is at ${this.#revision}`,
        { currentWorldRevision: this.#revision },
      );
    }

    const stage = new Stage(this.#nextSequence);
    let next: S | Rejection;
    try {
      next = definition.handle(this.#state, payload.data, this.#context(stage, 'command'));
    } catch (error) {
      return failure(
        'INTERNAL_ERROR',
        `Command "${input.type}" failed; world state is unchanged: ${messageOf(error)}`,
      );
    }
    if (next instanceof Rejection) {
      return failure('COMMAND_REJECTED', next.reason, next.details);
    }

    this.#commit(stage, next);
    this.#revision += 1;
    this.#journal.append({
      kind: 'command',
      atMs: this.#now,
      revision: this.#revision,
      commandId: input.commandId,
      type: input.type,
      payload: JSON.parse(payloadJson) as JsonValue,
      fingerprint,
      facts: stage.facts,
    });
    // Events the command scheduled for this very instant run now, keeping the
    // invariant that nothing at or before `nowMs` is left pending.
    this.advanceTo(this.#now);
    return {
      ok: true,
      receipt: {
        commandId: input.commandId,
        worldRevision: this.#revision,
        atMs: this.#now,
        duplicate: false,
      },
    };
  }

  // ------------------------------------------------------------ time

  /**
   * Process every event due at or before `targetMs`, in order, then set the
   * clock to `targetMs`. Splitting one advance into several (any sizes, any
   * budgets) gives the same result as doing it at once.
   */
  advanceTo(targetMs: SimTimeMs, options: AdvanceOptions = {}): AdvanceResult {
    if (this.#fault) {
      return { stop: 'fault', nowMs: this.#now, processed: 0 };
    }
    if (targetMs < this.#now) {
      throw new RangeError(
        `Cannot advance to ${targetMs} ms: the clock is already at ${this.#now} ms`,
      );
    }
    const maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
    let processed = 0;
    let instantEvents = 0;
    let notableSeen = false;
    for (;;) {
      const next = this.#queue.peek();
      // The current instant is complete once nothing more is due at `nowMs`.
      const instantComplete = processed > 0 && (!next || next.timeMs > this.#now);
      if (instantComplete && notableSeen && options.stopAfterNotable === true) {
        return { stop: 'notable', nowMs: this.#now, processed };
      }
      if (!next || next.timeMs > targetMs) {
        if (this.#now !== targetMs) {
          this.#now = targetMs;
          this.#version += 1;
        }
        return { stop: 'reached', nowMs: this.#now, processed };
      }
      if (instantComplete) {
        if (processed >= maxEvents) {
          return { stop: 'budget', nowMs: this.#now, processed };
        }
        instantEvents = 0;
      }
      instantEvents += 1;
      if (instantEvents > MAX_EVENTS_PER_INSTANT) {
        this.#fault = {
          atMs: next.timeMs,
          eventId: next.id,
          type: next.type,
          message: `More than ${MAX_EVENTS_PER_INSTANT} events at one instant (runaway rescheduling)`,
        };
        return { stop: 'fault', nowMs: this.#now, processed };
      }
      const notable = this.#processEvent(next);
      if (notable === null) {
        return { stop: 'fault', nowMs: this.#now, processed };
      }
      processed += 1;
      notableSeen ||= notable;
    }
  }

  // -------------------------------------------------------- internals

  /** Returns whether the event was notable, or null if its handler failed. */
  #processEvent(event: ScheduledEvent): boolean | null {
    const stage = new Stage(this.#nextSequence);
    const context = this.#context(stage, 'event', event.timeMs);
    const definition = Object.hasOwn(this.rules.events, event.type)
      ? this.rules.events[event.type]
      : undefined;
    const periodic = Object.hasOwn(this.rules.periodic, event.type)
      ? this.rules.periodic[event.type]
      : undefined;
    let next: S;
    try {
      if (definition) {
        next = definition.handle(this.#state, definition.payload.parse(event.payload), context);
      } else if (periodic) {
        next = periodic.handle(this.#state, context);
        this.#stageEvent(
          stage,
          event.type,
          event.timeMs + periodic.periodMs,
          LANE_PRIORITY[periodic.lane],
          null,
        );
      } else {
        throw new Error(`No handler for event type "${event.type}"`);
      }
      if ((next as unknown) instanceof Rejection) {
        throw new Error(`Event handler for "${event.type}" returned a rejection`);
      }
    } catch (error) {
      this.#fault = {
        atMs: event.timeMs,
        eventId: event.id,
        type: event.type,
        message: `Event ${event.id} (${event.type}) failed: ${messageOf(error)}`,
      };
      return null;
    }
    this.#queue.pop();
    this.#now = event.timeMs;
    this.#commit(stage, next);
    this.#processedEvents += 1;
    this.#journal.append({
      kind: 'event',
      atMs: event.timeMs,
      eventId: event.id,
      type: event.type,
      payload: event.payload,
      facts: stage.facts,
    });
    return definition?.notable ?? false;
  }

  #commit(stage: Stage, state: S): void {
    this.#state = state;
    for (const [kind, ordinal] of stage.ids) {
      this.#ids.set(kind, ordinal);
    }
    for (const [name, rng] of stage.streams) {
      this.#streams.set(name, rng.state);
    }
    for (const event of stage.scheduled) {
      this.#queue.push(event);
    }
    this.#nextSequence = stage.nextSequence;
    this.#version += 1;
  }

  #stageEvent(
    stage: Stage,
    type: string,
    timeMs: SimTimeMs,
    priority: number,
    payload: JsonValue,
  ): string {
    const sequence = stage.nextSequence;
    stage.nextSequence += 1n;
    const id = eventIdFor(sequence);
    stage.scheduled.push({ id, timeMs, priority, sequence, type, payload });
    return id;
  }

  #context(stage: Stage, phase: ContextPhase, nowMs: SimTimeMs = this.#now): KernelContext {
    return {
      nowMs,
      epoch: this.config.epoch,
      calendar: () => calendarAt(this.config.epoch, nowMs),
      random: (name) => {
        if (!STREAM_NAME.test(name)) {
          throw new RangeError(`Invalid random stream name ${JSON.stringify(name)}`);
        }
        let rng = stage.streams.get(name);
        if (!rng) {
          rng = new Rng(this.#streams.get(name) ?? seedStream(this.config.seed, name));
          stage.streams.set(name, rng);
        }
        return rng;
      },
      allocateId: <K extends string>(kind: K): EntityId<K> => {
        const ordinal = (stage.ids.get(kind) ?? this.#ids.get(kind) ?? 0) + 1;
        const id = formatEntityId(kind, ordinal);
        stage.ids.set(kind, ordinal);
        return id;
      },
      schedule: (request: ScheduleRequest) => this.#schedule(stage, nowMs, request),
      record: (type, data) => {
        if (phase === 'genesis') {
          throw new Error('Facts cannot be recorded while the world is being created');
        }
        canonicalJson(data); // throws unless plain JSON
        stage.facts.push({ type, data });
      },
    };
  }

  #schedule(stage: Stage, nowMs: SimTimeMs, request: ScheduleRequest): string {
    const definition = Object.hasOwn(this.rules.events, request.type)
      ? this.rules.events[request.type]
      : undefined;
    if (!definition) {
      throw new Error(`Cannot schedule unknown event type "${request.type}"`);
    }
    if ((request.atMs === undefined) === (request.delayMs === undefined)) {
      throw new Error('Schedule exactly one of atMs or delayMs');
    }
    if (request.delayMs !== undefined && request.delayMs < 0n) {
      throw new RangeError(`Event delay cannot be negative (${request.delayMs} ms)`);
    }
    const timeMs = request.atMs ?? nowMs + (request.delayMs ?? 0n);
    if (timeMs < nowMs) {
      throw new RangeError(`Cannot schedule "${request.type}" in the past (${timeMs} < ${nowMs})`);
    }
    canonicalJson(request.payload); // throws unless plain JSON
    const checked = definition.payload.safeParse(request.payload);
    if (!checked.success) {
      throw new Error(
        `Invalid payload for event "${request.type}": ${describeZodError(checked.error)}`,
      );
    }
    return this.#stageEvent(
      stage,
      request.type,
      timeMs,
      LANE_PRIORITY[definition.lane],
      request.payload,
    );
  }

  #viewOf(event: ScheduledEvent): PendingEventView {
    const definition = Object.hasOwn(this.rules.events, event.type)
      ? this.rules.events[event.type]
      : undefined;
    return {
      id: event.id,
      timeMs: event.timeMs,
      type: event.type,
      notable: definition?.notable ?? false,
    };
  }

  #encodeState(): EncodedKernelState {
    return {
      format: KERNEL_FORMAT_VERSION,
      rules: { id: this.rules.id, version: this.rules.version },
      rng: RNG_ALGORITHM,
      config: {
        seed: this.config.seed,
        epoch: {
          year: this.config.epoch.year,
          month: this.config.epoch.month,
          day: this.config.epoch.day,
        },
      },
      nowMs: encodeBigInt(this.#now),
      worldRevision: this.#revision,
      processedEvents: this.#processedEvents,
      nextSequence: encodeBigInt(this.#nextSequence),
      ids: Object.fromEntries(this.#ids),
      rngStreams: Object.fromEntries(
        [...this.#streams].map(([name, words]) => [name, [...words]] as const),
      ),
      queue: this.#queue.toSortedArray().map((event) => ({
        id: event.id,
        timeMs: encodeBigInt(event.timeMs),
        priority: event.priority,
        sequence: encodeBigInt(event.sequence),
        type: event.type,
        payload: event.payload,
      })),
      domain: this.rules.encodeState(this.#state),
    };
  }
}

function validateRules<S>(rules: SimulationRules<S>): void {
  for (const type of Object.keys(rules.periodic)) {
    if (Object.hasOwn(rules.events, type)) {
      throw new Error(`"${type}" is both an event type and a periodic process`);
    }
    const periodic = rules.periodic[type];
    if (
      !periodic ||
      periodic.periodMs <= 0n ||
      periodic.phaseMs < 0n ||
      periodic.phaseMs >= periodic.periodMs
    ) {
      throw new RangeError(`Periodic process "${type}" needs period > 0 and 0 ≤ phase < period`);
    }
  }
}

/**
 * Canonical JSON of a command's contents (`canonicalJson` of
 * `{ expectedWorldRevision, payload, type }`, keys in sorted order), used to
 * tell a harmless resubmission from a reused command ID.
 */
function commandFingerprint(
  expectedWorldRevision: number,
  type: string,
  payloadJson: string,
): string {
  return `{"expectedWorldRevision":${expectedWorldRevision},"payload":${payloadJson},"type":${JSON.stringify(type)}}`;
}

function failure(
  code: KernelErrorCode,
  message: string,
  details?: KernelError['details'],
): { readonly ok: false; readonly error: KernelError } {
  return { ok: false, error: details ? { code, message, details } : { code, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
