import type { JsonValue } from '../shared/canonical-json';
import type { SimTimeMs } from '../domain/time';
import type { JournalEntry } from './journal';
import {
  SimulationKernel,
  type KernelError,
  type WorldConfig,
  type WorldFingerprint,
} from './kernel';
import type { SimulationRules } from './rules';

/**
 * Headless scenario runner (plan Step 03). Runs rules + seed + an ordered
 * command script without Electron, a renderer or a wall clock, and reports
 * the resulting fingerprints. `pacing` cuts the clock advance into chunks
 * with an optional event budget, standing in for different frame rates,
 * speeds and pause patterns; the outcome must not depend on it.
 */

export interface ScriptedCommand {
  /** Simulation time at which the command is submitted. */
  readonly atMs: SimTimeMs;
  readonly commandId: string;
  readonly type: string;
  readonly payload: JsonValue;
}

export interface Pacing {
  /** Clock advance per call, cycled. Default: one call per target. */
  readonly chunksMs?: readonly SimTimeMs[];
  /** Event budget per call (stops only at instant boundaries). */
  readonly maxEventsPerCall?: number;
}

export interface Scenario<S> {
  readonly rules: SimulationRules<S>;
  readonly config: WorldConfig;
  /** Must be in non-decreasing `atMs` order. */
  readonly commands: readonly ScriptedCommand[];
  readonly untilMs: SimTimeMs;
  readonly pacing?: Pacing;
}

export interface ScenarioResult<S> {
  readonly kernel: SimulationKernel<S>;
  readonly fingerprint: WorldFingerprint;
  /** Commands the kernel refused, with the reason (they change nothing). */
  readonly rejected: readonly { readonly commandId: string; readonly error: KernelError }[];
  /** Number of `advanceTo` calls made. */
  readonly advanceCalls: number;
}

class Advancer {
  calls = 0;
  #chunk = 0;
  readonly #pacing: Pacing;

  constructor(pacing: Pacing) {
    this.#pacing = pacing;
  }

  advance<S>(kernel: SimulationKernel<S>, targetMs: SimTimeMs): void {
    const chunks = this.#pacing.chunksMs ?? [];
    const options =
      this.#pacing.maxEventsPerCall === undefined
        ? {}
        : { maxEvents: this.#pacing.maxEventsPerCall };
    while (kernel.nowMs < targetMs) {
      const chunk = chunks.length > 0 ? chunks[this.#chunk++ % chunks.length] : undefined;
      if (chunk !== undefined && chunk <= 0n) {
        throw new RangeError('Pacing chunks must be positive');
      }
      const stepTarget =
        chunk === undefined || kernel.nowMs + chunk > targetMs ? targetMs : kernel.nowMs + chunk;
      this.calls += 1;
      const result = kernel.advanceTo(stepTarget, options);
      if (result.stop === 'fault') {
        throw new Error(`Simulation fault: ${kernel.fault?.message ?? 'unknown'}`);
      }
    }
  }
}

export function runScenario<S>(scenario: Scenario<S>): ScenarioResult<S> {
  const kernel = SimulationKernel.create(scenario.rules, scenario.config);
  const advancer = new Advancer(scenario.pacing ?? {});
  const rejected: { commandId: string; error: KernelError }[] = [];
  for (const command of scenario.commands) {
    if (command.atMs < kernel.nowMs) {
      throw new RangeError(`Scripted command ${command.commandId} is out of time order`);
    }
    if (command.atMs > scenario.untilMs) {
      throw new RangeError(`Scripted command ${command.commandId} is after the scenario end`);
    }
    advancer.advance(kernel, command.atMs);
    const result = kernel.submit({
      commandId: command.commandId,
      expectedWorldRevision: kernel.worldRevision,
      type: command.type,
      payload: command.payload,
    });
    if (!result.ok) {
      rejected.push({ commandId: command.commandId, error: result.error });
    }
  }
  advancer.advance(kernel, scenario.untilMs);
  return { kernel, fingerprint: kernel.fingerprint(), rejected, advanceCalls: advancer.calls };
}

/**
 * Rebuild a world from its seed and the command entries of a journal,
 * re-submitting each command at its recorded simulation time and revision,
 * then advancing to `untilMs`. A faithful replay reproduces the original
 * state hash and, because events are regenerated, the journal hash too.
 */
export function replayJournal<S>(
  rules: SimulationRules<S>,
  config: WorldConfig,
  journal: readonly JournalEntry[],
  untilMs: SimTimeMs,
): SimulationKernel<S> {
  const kernel = SimulationKernel.create(rules, config);
  for (const entry of journal) {
    if (entry.kind !== 'command') {
      continue;
    }
    if (kernel.advanceTo(entry.atMs).stop === 'fault') {
      throw new Error(`Replay fault: ${kernel.fault?.message ?? 'unknown'}`);
    }
    const result = kernel.submit({
      commandId: entry.commandId,
      expectedWorldRevision: entry.revision - 1,
      type: entry.type,
      payload: entry.payload,
    });
    if (!result.ok || result.receipt.worldRevision !== entry.revision) {
      throw new Error(
        `Replay diverged at command ${entry.commandId}: ${result.ok ? `revision ${result.receipt.worldRevision}` : result.error.message}`,
      );
    }
  }
  if (kernel.advanceTo(untilMs).stop === 'fault') {
    throw new Error(`Replay fault: ${kernel.fault?.message ?? 'unknown'}`);
  }
  return kernel;
}
