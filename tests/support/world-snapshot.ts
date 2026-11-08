import type { WorldSnapshot } from '../../src/shared/ipc/contract';

/** A valid world read model at time 0 (paused, revision 0), for UI and gateway tests. */
export function sampleWorldSnapshot(
  worldInstanceId: string,
  overrides: Partial<WorldSnapshot> = {},
): WorldSnapshot {
  return {
    worldInstanceId,
    worldRevision: 0,
    seed: 42,
    clock: {
      nowMs: '0',
      calendar: { year: 1996, month: 1, day: 1, weekday: 1, hour: 0, minute: 0, second: 0 },
      speed: 'paused',
      advance: null,
      lastStop: null,
      fault: null,
    },
    queue: { pending: 0, nextEventAtMs: null },
    journal: { commands: 0, events: 0 },
    fingerprint: { stateHash: 'a'.repeat(64), journalHash: '0'.repeat(64) },
    session: {
      worldId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      savedAs: null,
      unsavedChanges: false,
      recoveryLog: 'active',
      notice: null,
    },
    company: null,
    realEstate: null,
    scenarios: [],
    diagnostics: {
      probeCount: 0,
      lastProbeLabel: null,
      pendingProbes: 0,
      firedProbes: 0,
      lastFiredProbe: null,
    },
    ...overrides,
  };
}
