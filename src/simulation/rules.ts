import type { z } from 'zod';
import type { JsonValue } from '../shared/canonical-json';
import type { EntityId } from '../domain/ids';
import type { Rejection } from '../domain/rejection';
import type { CalendarInstant, CivilDate, SimTimeMs } from '../domain/time';
import type { Rng } from './rng';

/**
 * How a body of simulation rules plugs into the kernel (DECISIONS ADR-0020).
 * The kernel is generic: it owns time, ordering, randomness, IDs, the
 * journal and atomicity; a `SimulationRules` value supplies the domain
 * state and the handlers that change it. Production uses
 * `FREEINDUSTRY_RULES`; tests also use fixture rules.
 */

/**
 * Processing lanes (spec §9.1, plan Step 03). At one instant, events run in
 * lane order, then in the order they were scheduled. High-frequency physical
 * work (movement, handling, machine cycles) runs at exact event times and
 * comes first, so lower-frequency economic, management and accounting
 * decisions taken at the same instant see the physical outcome.
 */
export const LANE_PRIORITY = {
  physical: 100,
  economic: 200,
  management: 300,
  accounting: 400,
  diagnostic: 900,
} as const;

export type Lane = keyof typeof LANE_PRIORITY;

/** A domain fact recorded in the journal by a handler ("domain event"). */
export interface Fact {
  readonly type: string;
  readonly data: JsonValue;
}

export interface ScheduleRequest {
  readonly type: string;
  readonly payload: JsonValue;
  /** Absolute simulation time, not earlier than now. Give this or `delayMs`. */
  readonly atMs?: SimTimeMs;
  /** Delay from now, ≥ 0. Give this or `atMs`. */
  readonly delayMs?: SimTimeMs;
}

/**
 * What a handler may use. Everything it changes through the context
 * (random draws, new IDs, scheduled events, facts) is staged and committed
 * together with the handler's returned state, or discarded with it.
 */
export interface KernelContext {
  /** Simulation time of this command or event. */
  readonly nowMs: SimTimeMs;
  readonly epoch: CivilDate;
  calendar(): CalendarInstant;
  /** The world's seeded stream `name` (created from the seed on first use). */
  random(name: string): Rng;
  allocateId<K extends string>(kind: K): EntityId<K>;
  /** Schedule a future event; returns its event ID. */
  schedule(request: ScheduleRequest): string;
  /** Record a fact in the journal entry of this command or event. */
  record(type: string, data: JsonValue): void;
}

export interface CommandDefinition<S> {
  readonly payload: z.ZodType;
  readonly handle: (state: S, payload: unknown, context: KernelContext) => S | Rejection;
}

export interface EventDefinition<S> {
  readonly lane: Lane;
  /** A stop point for "advance until next event". */
  readonly notable: boolean;
  readonly payload: z.ZodType;
  readonly handle: (state: S, payload: unknown, context: KernelContext) => S;
}

/**
 * A recurring decision cycle (economic, management, accounting) that fires
 * at `phaseMs + k × periodMs` for k = 0, 1, 2, … — aligned to the epoch, so
 * when or how the clock is advanced cannot move it.
 */
interface PeriodicDefinition<S> {
  readonly lane: Lane;
  readonly periodMs: SimTimeMs;
  readonly phaseMs: SimTimeMs;
  readonly handle: (state: S, context: KernelContext) => S;
}

export interface SimulationRules<S> {
  /** Stable identifier recorded in fingerprints and checkpoints. */
  readonly id: string;
  /** Bump whenever a change would make old checkpoints play out differently. */
  readonly version: number;
  /**
   * Builds the starting domain state at time 0 (may draw random numbers and
   * schedule events). `setup` is the plain-JSON world setup given to
   * `SimulationKernel.create` (null when none was given): content the new
   * world is built from. It is used once; the state it produces is what
   * fingerprints and checkpoints cover (ADR-0037).
   */
  readonly initialState: (context: KernelContext, setup: JsonValue) => S;
  /** Plain-JSON form of the state: the fingerprint input and the checkpoint format. */
  readonly encodeState: (state: S) => JsonValue;
  readonly decodeState: (json: JsonValue) => S;
  /** Extra domain invariants; returns human-readable violations. */
  readonly checkInvariants?: (state: S) => readonly string[];
  readonly commands: Readonly<Record<string, CommandDefinition<S>>>;
  readonly events: Readonly<Record<string, EventDefinition<S>>>;
  readonly periodic: Readonly<Record<string, PeriodicDefinition<S>>>;
}

export function defineCommand<S, P extends z.ZodType>(
  payload: P,
  handle: (state: S, payload: z.output<P>, context: KernelContext) => S | Rejection,
): CommandDefinition<S> {
  return {
    payload,
    handle: (state, value, context) => handle(state, value as z.output<P>, context),
  };
}

export function defineEvent<S, P extends z.ZodType>(definition: {
  readonly lane: Lane;
  readonly notable?: boolean;
  readonly payload: P;
  readonly handle: (state: S, payload: z.output<P>, context: KernelContext) => S;
}): EventDefinition<S> {
  const { handle } = definition;
  return {
    lane: definition.lane,
    notable: definition.notable ?? false,
    payload: definition.payload,
    handle: (state, value, context) => handle(state, value as z.output<P>, context),
  };
}
