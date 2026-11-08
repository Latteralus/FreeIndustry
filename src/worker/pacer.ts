import type { CivilDate, SimTimeMs } from '../domain/time';
import { MS_PER_DAY, MS_PER_MINUTE, startOfNextDay, startOfNextWeek } from '../domain/time';
import type { AdvanceOptions, AdvanceResult, KernelFault } from '../simulation/kernel';
import {
  SPEED_RATE,
  type AdvanceStopReason,
  type AdvanceTarget,
  type SimulationSpeed,
} from '../shared/ipc/clock';

/**
 * Feeds simulated time to the kernel against the wall clock (DECISIONS
 * ADR-0023). This is the only place wall time meets the simulation, and it
 * decides only *how far* to advance the clock — never what happens at a
 * given simulated time — so speed, pause, tick rate, machine load and the
 * renderer's frame rate cannot change any outcome.
 *
 * - Paused: zero simulation-time transitions.
 * - Running: each tick advances by wall time elapsed × speed rate. If the
 *   kernel cannot keep up within the tick's wall budget, simulated time
 *   lags rather than piling up debt (backpressure).
 * - Targeted advance (step / end of day / end of week / next event): runs
 *   as fast as the budget allows, across as many ticks as needed, then
 *   pauses. Choosing a speed (including Pause) interrupts it.
 */

export interface PacedKernel {
  readonly nowMs: SimTimeMs;
  readonly config: { readonly epoch: CivilDate };
  readonly fault: KernelFault | null;
  advanceTo(targetMs: SimTimeMs, options?: AdvanceOptions): AdvanceResult;
}

export interface PacerOptions {
  /** Monotonic wall clock in milliseconds (`performance.now` in the worker). */
  readonly wallNow: () => number;
  readonly rates?: Readonly<Record<SimulationSpeed, number>>;
  /** Wall time one tick may spend simulating before yielding. */
  readonly sliceBudgetMs?: number;
  /** Events per kernel call between wall-budget checks. */
  readonly eventsPerCall?: number;
  /** Longest wall gap a running tick converts into simulated time. */
  readonly maxCatchUpMs?: number;
}

export interface PacerAdvance {
  readonly until: AdvanceTarget;
  readonly targetMs: SimTimeMs;
}

export interface PacerStop {
  readonly until: AdvanceTarget;
  readonly reason: AdvanceStopReason;
  readonly atMs: SimTimeMs;
}

export interface PacerState {
  readonly speed: SimulationSpeed;
  readonly advance: PacerAdvance | null;
  readonly lastStop: PacerStop | null;
}

/** `idle`: nothing happened; `progress`: time moved; `stopped`: an advance ended or a fault paused the clock. */
export type TickOutcome = 'idle' | 'progress' | 'stopped';

/** "Advance until next event" gives up after this much simulated time. */
export const NEXT_EVENT_HORIZON_MS = 30n * MS_PER_DAY;
/** Single Step advances one simulated minute. */
export const STEP_MS = MS_PER_MINUTE;

export class SimulationPacer {
  readonly #kernel: PacedKernel;
  readonly #wallNow: () => number;
  readonly #rates: Readonly<Record<SimulationSpeed, number>>;
  readonly #sliceBudgetMs: number;
  readonly #eventsPerCall: number;
  readonly #maxCatchUpMs: number;

  #speed: SimulationSpeed = 'paused';
  #advance: PacerAdvance | null = null;
  #lastStop: PacerStop | null = null;
  #lastWall = 0;
  #carry = 0;

  constructor(kernel: PacedKernel, options: PacerOptions) {
    this.#kernel = kernel;
    this.#wallNow = options.wallNow;
    this.#rates = options.rates ?? SPEED_RATE;
    this.#sliceBudgetMs = options.sliceBudgetMs ?? 25;
    this.#eventsPerCall = options.eventsPerCall ?? 2_000;
    this.#maxCatchUpMs = options.maxCatchUpMs ?? 250;
  }

  get state(): PacerState {
    return { speed: this.#speed, advance: this.#advance, lastStop: this.#lastStop };
  }

  /** Run at a speed, or pause. Interrupts any targeted advance. */
  setSpeed(speed: SimulationSpeed): void {
    this.#interruptAdvance();
    this.#speed = this.#kernel.fault ? 'paused' : speed;
    this.#lastWall = this.#wallNow();
    this.#carry = 0;
  }

  /** Start a targeted advance; the clock pauses when it ends. */
  advance(until: AdvanceTarget): void {
    this.#interruptAdvance();
    this.#speed = 'paused';
    if (this.#kernel.fault) {
      this.#lastStop = { until, reason: 'fault', atMs: this.#kernel.nowMs };
      return;
    }
    this.#advance = { until, targetMs: this.#targetFor(until) };
  }

  tick(): TickOutcome {
    if (this.#advance) {
      return this.#tickAdvance(this.#advance);
    }
    if (this.#speed === 'paused') {
      return 'idle';
    }
    return this.#tickRunning(this.#rates[this.#speed]);
  }

  #tickRunning(rate: number): TickOutcome {
    const wall = this.#wallNow();
    const elapsed = Math.min(Math.max(wall - this.#lastWall, 0), this.#maxCatchUpMs);
    this.#lastWall = wall;
    const exact = elapsed * rate + this.#carry;
    const whole = Math.floor(exact);
    this.#carry = exact - whole;
    if (whole <= 0) {
      return 'idle';
    }
    const target = this.#kernel.nowMs + BigInt(whole);
    for (;;) {
      const result = this.#kernel.advanceTo(target, { maxEvents: this.#eventsPerCall });
      if (result.stop === 'fault') {
        this.#speed = 'paused';
        return 'stopped';
      }
      if (result.stop === 'reached') {
        return 'progress';
      }
      if (this.#wallNow() - wall >= this.#sliceBudgetMs) {
        this.#carry = 0; // lag rather than accumulate debt
        return 'progress';
      }
    }
  }

  #tickAdvance(advance: PacerAdvance): TickOutcome {
    const started = this.#wallNow();
    const before = this.#kernel.nowMs;
    for (;;) {
      const result = this.#kernel.advanceTo(advance.targetMs, {
        maxEvents: this.#eventsPerCall,
        stopAfterNotable: advance.until === 'nextEvent',
      });
      switch (result.stop) {
        case 'reached':
          return this.#finish(advance.until === 'nextEvent' ? 'horizon' : 'reached');
        case 'notable':
          return this.#finish('notable');
        case 'fault':
          return this.#finish('fault');
        case 'budget':
          if (this.#wallNow() - started >= this.#sliceBudgetMs) {
            return this.#kernel.nowMs === before ? 'idle' : 'progress';
          }
      }
    }
  }

  #finish(reason: AdvanceStopReason): TickOutcome {
    const advance = this.#advance;
    if (advance) {
      this.#lastStop = { until: advance.until, reason, atMs: this.#kernel.nowMs };
    }
    this.#advance = null;
    this.#speed = 'paused';
    return 'stopped';
  }

  #interruptAdvance(): void {
    if (this.#advance) {
      this.#lastStop = {
        until: this.#advance.until,
        reason: 'interrupted',
        atMs: this.#kernel.nowMs,
      };
      this.#advance = null;
    }
  }

  #targetFor(until: AdvanceTarget): SimTimeMs {
    const now = this.#kernel.nowMs;
    switch (until) {
      case 'step':
        return now + STEP_MS;
      case 'endOfDay':
        return startOfNextDay(now);
      case 'endOfWeek':
        return startOfNextWeek(this.#kernel.config.epoch, now);
      case 'nextEvent':
        return now + NEXT_EVENT_HORIZON_MS;
    }
  }
}
