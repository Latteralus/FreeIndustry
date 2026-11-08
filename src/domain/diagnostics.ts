import type { EntityId } from './ids';
import { reject, type Rejection } from './rejection';
import type { SimTimeMs } from './time';

/**
 * Kernel diagnostics (DECISIONS ADR-0016, ADR-0024). Not game features: they
 * exist so the real application can demonstrate the command → scheduled
 * event → seeded randomness path before the first business rules arrive in
 * Step 05. A recorded probe changes state immediately; a scheduled probe
 * becomes a future simulation event that, when it fires, draws a token from
 * the seeded random stream.
 */

export interface FiredProbe {
  readonly probeId: EntityId<'probe'>;
  readonly label: string;
  /** Unsigned 32-bit value drawn from the world's seeded `diagnostics` stream. */
  readonly token: number;
  readonly scheduledAtMs: SimTimeMs;
  readonly firedAtMs: SimTimeMs;
}

export interface DiagnosticsState {
  readonly probeCount: number;
  readonly lastProbeLabel: string | null;
  readonly pendingProbes: number;
  readonly firedProbes: number;
  readonly lastFiredProbe: FiredProbe | null;
}

/** Keeps a diagnostic from flooding the event queue. */
export const MAX_PENDING_PROBES = 100;

export const INITIAL_DIAGNOSTICS: DiagnosticsState = {
  probeCount: 0,
  lastProbeLabel: null,
  pendingProbes: 0,
  firedProbes: 0,
  lastFiredProbe: null,
};

export function recordProbe(state: DiagnosticsState, label: string): DiagnosticsState {
  return { ...state, probeCount: state.probeCount + 1, lastProbeLabel: label };
}

export function scheduleProbe(state: DiagnosticsState): DiagnosticsState | Rejection {
  if (state.pendingProbes >= MAX_PENDING_PROBES) {
    return reject(`At most ${MAX_PENDING_PROBES} probes may be pending at once`, {
      pendingProbes: state.pendingProbes,
    });
  }
  return { ...state, pendingProbes: state.pendingProbes + 1 };
}

export function probeFired(state: DiagnosticsState, fired: FiredProbe): DiagnosticsState {
  if (state.pendingProbes < 1) {
    throw new Error(`Probe ${fired.probeId} fired but no probe was pending`);
  }
  return {
    ...state,
    pendingProbes: state.pendingProbes - 1,
    firedProbes: state.firedProbes + 1,
    lastFiredProbe: fired,
  };
}
