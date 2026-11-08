import fc from 'fast-check';
import { join } from 'node:path';
import type { CommandEnvelope } from '../../src/shared/ipc/contract';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../../src/domain/time';
import { CommandHost } from '../../src/worker/command-host';
import { SaveCoordinator } from '../../src/worker/save-coordinator';
import { makeStore, tempDir, type TempDir } from '../support/save-world';
import { testUuid } from '../support/toy-workshop';

/**
 * Step 04 acceptance gate (spec §10.4, §14.2 S08 at kernel level, ledger
 * T-SAVE-01 / T-TIME-01): save while events are pending, shut down, reopen
 * in a new host, load and resume — the domain hashes must equal an
 * uninterrupted run with the same seed and commands. Everything here is the
 * worker's real code (CommandHost, SaveCoordinator, SaveStore, SQLite files);
 * only the thread and Electron are absent (they are covered by the
 * integration and E2E tests).
 */

let dir: TempDir;
let ids = 0;
const newId = () => {
  ids += 1;
  return `00000000-0000-4000-a000-${ids.toString(16).padStart(12, '0')}`;
};

beforeEach(() => {
  dir = tempDir('freeindustry-s08-');
});

afterEach(() => {
  dir.remove();
});

interface App {
  readonly host: CommandHost;
  readonly saves: SaveCoordinator;
  readonly wall: { now: number };
}

/** One "launch" of the worker against a data directory. */
function launch(seed: number, dataDir: string = dir.path): App {
  const wall = { now: 0 };
  const session: { view: () => ReturnType<SaveCoordinator['sessionView']> | null } = {
    view: () => null,
  };
  const host = new CommandHost({
    worldInstanceId: newId(),
    seed,
    faultInjectionEnabled: false,
    onThreadFault: () => undefined,
    pacer: { wallNow: () => wall.now },
    session: () => session.view(),
  });
  const saves = new SaveCoordinator({
    host,
    store: makeStore(join(dataDir, 'saves'), { uniqueToken: newId }),
    recoveryPath: join(dataDir, 'recovery', 'session.fisave'),
    appVersion: '0.1.0',
    wallClock: () => new Date('2026-11-07T12:00:00.000Z'),
    newId,
    autosaveIntervalMs: 3_600_000,
    log: () => undefined,
  });
  session.view = () => saves.sessionView();
  saves.start(0);
  return { host, saves, wall };
}

type Step =
  | { readonly kind: 'record'; readonly label: string }
  | { readonly kind: 'schedule'; readonly label: string; readonly minutes: number }
  | { readonly kind: 'advance'; readonly minutes: number };

let commandNumber = 0;

function apply(app: App, step: Step, commandIds: Map<number, string>, index: number): void {
  if (step.kind === 'advance') {
    app.host.kernel.advanceTo(app.host.kernel.nowMs + BigInt(step.minutes) * MS_PER_MINUTE);
    return;
  }
  if (step.kind === 'schedule' && app.host.kernel.state.diagnostics.pendingProbes >= 100) {
    return;
  }
  // The same step gets the same command ID in every run, as a replayed player would send.
  let commandId = commandIds.get(index);
  if (!commandId) {
    commandNumber += 1;
    commandId = testUuid(commandNumber);
    commandIds.set(index, commandId);
  }
  const envelope: CommandEnvelope = {
    commandId,
    worldInstanceId: app.host.worldInstanceId,
    expectedWorldRevision: app.host.kernel.worldRevision,
    type: step.kind === 'record' ? 'diagnostics.recordProbe' : 'diagnostics.scheduleProbe',
    payload:
      step.kind === 'record'
        ? { label: step.label }
        : { label: step.label, delayMs: step.minutes * 60_000 },
  };
  const { result, revised } = app.host.submit(envelope);
  if (!result.ok) {
    throw new Error(`${envelope.type}: ${result.error.message}`);
  }
  if (revised) {
    app.saves.afterCommand(commandId);
  }
}

const PLAN: readonly Step[] = [
  { kind: 'record', label: 'plan' },
  { kind: 'schedule', label: 'a', minutes: 10 },
  { kind: 'schedule', label: 'b', minutes: 120 },
  { kind: 'schedule', label: 'c', minutes: 300 },
  { kind: 'advance', minutes: 60 },
  // ← saved here: probe a has fired, b and c are pending
  { kind: 'record', label: 'after lunch' },
  { kind: 'schedule', label: 'd', minutes: 600 },
];

describe('S08 / Step 04 gate: save, shut down, reopen, resume', () => {
  it('a save made while events are pending resumes to the same domain hashes as an uninterrupted run', () => {
    const ids = new Map<number, string>();
    // Uninterrupted: one session from start to the end of the day.
    const straight = launch(4242);
    PLAN.forEach((step, index) => {
      apply(straight, step, ids, index);
    });
    straight.host.kernel.advanceTo(MS_PER_DAY);
    const expected = straight.host.snapshot();
    straight.saves.release();

    // Interrupted: play to 01:00, save, shut down.
    const first = launch(4242, join(dir.path, 'profile'));
    PLAN.slice(0, 5).forEach((step, index) => {
      apply(first, step, ids, index);
    });
    expect(first.host.snapshot()).toMatchObject({
      clock: { nowMs: String(MS_PER_HOUR) },
      queue: { pending: 2, nextEventAtMs: String(2n * MS_PER_HOUR) },
      diagnostics: { pendingProbes: 2, firedProbes: 1 },
    });
    const saved = first.saves.save({ name: 'Midway', saveId: null });
    const atSave = first.host.snapshot();
    first.saves.shutdown();

    // Reopen: a new worker with a different seed and a fresh world, then load.
    const second = launch(1, join(dir.path, 'profile'));
    expect(second.saves.list().map((save) => save.name)).toEqual(['Midway']);
    second.saves.load(saved.saveId);
    const loaded = second.host.snapshot();
    expect(loaded.fingerprint).toEqual(atSave.fingerprint);
    expect(loaded.queue).toEqual(atSave.queue);
    PLAN.slice(5).forEach((step, offset) => {
      apply(second, step, ids, 5 + offset);
    });
    second.host.kernel.advanceTo(MS_PER_DAY);
    const resumed = second.host.snapshot();

    expect(resumed.fingerprint).toEqual(expected.fingerprint);
    expect(resumed.diagnostics).toEqual(expected.diagnostics);
    expect(resumed.journal).toEqual(expected.journal);
    // T-SAVE-01: pending events fired exactly once across the reload; nothing duplicated or lost.
    expect(resumed.diagnostics).toMatchObject({ firedProbes: 4, pendingProbes: 0, probeCount: 2 });
    second.saves.release();
  });

  it('saving while the clock runs is safe: the restored world continues identically under any pacing', () => {
    const app = launch(77);
    const ids = new Map<number, string>();
    PLAN.slice(0, 4).forEach((step, index) => {
      apply(app, step, ids, index);
    });
    // Run at Fastest on the real pacer; save between two ticks, mid-run.
    app.host.control({ action: 'setSpeed', speed: 'fastest' });
    for (let tick = 0; tick < 37; tick += 1) {
      app.wall.now += 50;
      app.host.tick();
    }
    const saved = app.saves.save({ name: 'Running', saveId: null });
    for (let tick = 0; tick < 400; tick += 1) {
      app.wall.now += 50;
      app.host.tick();
    }
    app.host.control({ action: 'setSpeed', speed: 'paused' });
    const end = app.host.kernel.nowMs;
    const original = app.host.kernel.fingerprint();
    app.saves.shutdown();

    const reopened = launch(5);
    reopened.saves.load(saved.saveId);
    // Different pacing: advance in uneven chunks with tiny event budgets.
    while (reopened.host.kernel.nowMs < end) {
      const target = reopened.host.kernel.nowMs + 7_919n;
      reopened.host.kernel.advanceTo(target < end ? target : end, { maxEvents: 1 });
    }
    expect(reopened.host.kernel.fingerprint()).toEqual(original);
    reopened.saves.release();
  });

  it('property: wherever the save happens, resuming from disk equals the uninterrupted run', () => {
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({
        kind: fc.constant('record' as const),
        label: fc.string({ minLength: 1, maxLength: 10 }),
      }),
      fc.record({
        kind: fc.constant('schedule' as const),
        label: fc.string({ minLength: 1, maxLength: 10 }),
        minutes: fc.integer({ min: 1, max: 900 }),
      }),
      fc.record({
        kind: fc.constant('advance' as const),
        minutes: fc.integer({ min: 0, max: 240 }),
      }),
    );
    let run = 0;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.array(step, { minLength: 1, maxLength: 20 }),
        fc.nat(),
        (seed, steps, cutSeed) => {
          run += 1;
          const profile = join(dir.path, `run-${run}`);
          const cut = cutSeed % (steps.length + 1);
          const ids = new Map<number, string>();

          const straight = launch(seed, join(profile, 'straight'));
          steps.forEach((item, index) => {
            apply(straight, item, ids, index);
          });
          straight.host.kernel.advanceTo(straight.host.kernel.nowMs + MS_PER_DAY);
          const expected = straight.host.kernel.fingerprint();
          const endMs = straight.host.kernel.nowMs;
          straight.saves.release();

          const first = launch(seed, join(profile, 'saved'));
          steps.slice(0, cut).forEach((item, index) => {
            apply(first, item, ids, index);
          });
          const { saveId } = first.saves.save({ name: 'Cut', saveId: null });
          first.saves.shutdown();

          const second = launch((seed ^ 0x5a5a) >>> 0, join(profile, 'saved'));
          second.saves.load(saveId);
          steps.slice(cut).forEach((item, offset) => {
            apply(second, item, ids, cut + offset);
          });
          second.host.kernel.advanceTo(endMs);
          expect(second.host.kernel.fingerprint()).toEqual(expected);
          second.saves.release();
        },
      ),
      { numRuns: 30 },
    );
  });
});
