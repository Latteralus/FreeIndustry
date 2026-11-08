import { z } from 'zod';

/**
 * Simulation clock control (spec §9.1, DECISIONS ADR-0023). Clock control
 * changes how fast simulated time is fed to the kernel; it never changes
 * what happens at a given simulated time. It is therefore not a world
 * command: it has no revision, is not journaled and is not part of any
 * fingerprint, so different pause/speed patterns cannot alter the outcome.
 */

export const SIMULATION_SPEEDS = ['paused', 'normal', 'faster', 'fastest'] as const;
export type SimulationSpeed = (typeof SIMULATION_SPEEDS)[number];

/**
 * Simulated milliseconds per wall-clock millisecond while running.
 * Provisional values (ADR-0023): Normal 20× (an 8-hour shift in 24 minutes),
 * Faster 100×, Fastest 600× (a day in 2.4 minutes).
 */
export const SPEED_RATE: Readonly<Record<SimulationSpeed, number>> = {
  paused: 0,
  normal: 20,
  faster: 100,
  fastest: 600,
};

/**
 * Targeted advances, run as fast as the machine allows, then pause:
 * - `step`: one simulated minute (Single Step);
 * - `endOfDay`: to the next midnight;
 * - `endOfWeek`: to the next Monday 00:00;
 * - `nextEvent`: until a notable event has happened (at most 30 days).
 */
export const ADVANCE_TARGETS = ['step', 'endOfDay', 'endOfWeek', 'nextEvent'] as const;
export type AdvanceTarget = (typeof ADVANCE_TARGETS)[number];

/** Why the last targeted advance stopped. */
export const ADVANCE_STOPS = ['reached', 'notable', 'horizon', 'interrupted', 'fault'] as const;
export type AdvanceStopReason = (typeof ADVANCE_STOPS)[number];

export const clockControlSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('setSpeed'), speed: z.enum(SIMULATION_SPEEDS) }),
  z.strictObject({ action: z.literal('advance'), until: z.enum(ADVANCE_TARGETS) }),
]);

export type ClockControl = z.infer<typeof clockControlSchema>;
