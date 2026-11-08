import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandEnvelope } from '../../../src/shared/ipc/contract';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../../../src/domain/time';
import { SaveError } from '../../../src/persistence/save-error';
import { CommandHost } from '../../../src/worker/command-host';
import { SaveCoordinator, saveFailure } from '../../../src/worker/save-coordinator';
import { makeStore, tempDir, type TempDir } from '../../support/save-world';
import { testUuid } from '../../support/toy-workshop';

let dir: TempDir;
let ids = 0;
const newId = () => {
  ids += 1;
  return `00000000-0000-4000-9000-${ids.toString(16).padStart(12, '0')}`;
};

const started: SaveCoordinator[] = [];

beforeEach(() => {
  dir = tempDir();
});

afterEach(() => {
  // Close every recovery log (Windows cannot delete open files).
  for (const coordinator of started.splice(0)) {
    coordinator.release();
  }
  dir.remove();
});

interface Harness {
  readonly host: CommandHost;
  readonly saves: SaveCoordinator;
  readonly logs: { level: string; message: string }[];
  submit(type: string, payload: unknown): void;
}

let commandNumber = 0;

function start(
  options: { dataDir?: string; seed?: number; autosaveIntervalMs?: number; wallNow?: number } = {},
): Harness {
  const dataDir = options.dataDir ?? dir.path;
  const logs: { level: string; message: string }[] = [];
  const session: { view: () => ReturnType<SaveCoordinator['sessionView']> | null } = {
    view: () => null,
  };
  const host = new CommandHost({
    worldInstanceId: newId(),
    seed: options.seed ?? 11,
    faultInjectionEnabled: false,
    onThreadFault: () => undefined,
    pacer: { wallNow: () => 0 },
    session: () => session.view(),
  });
  const saves = new SaveCoordinator({
    host,
    store: makeStore(join(dataDir, 'saves'), { uniqueToken: newId }),
    recoveryPath: join(dataDir, 'recovery', 'session.fisave'),
    appVersion: '0.1.0',
    wallClock: () => new Date('2026-11-07T12:00:00.000Z'),
    newId,
    autosaveIntervalMs: options.autosaveIntervalMs ?? 60_000,
    log: (level, message) => logs.push({ level, message }),
    clockMarkIntervalMs: 0,
  });
  session.view = () => saves.sessionView();
  saves.start(options.wallNow ?? 0);
  started.push(saves);
  return {
    host,
    saves,
    logs,
    submit(type, payload) {
      commandNumber += 1;
      const envelope: CommandEnvelope = {
        commandId: testUuid(commandNumber),
        worldInstanceId: host.worldInstanceId,
        expectedWorldRevision: host.kernel.worldRevision,
        type,
        payload,
      };
      const { result, revised } = host.submit(envelope);
      if (!result.ok) {
        throw new Error(`${type}: ${result.error.message}`);
      }
      if (revised) {
        saves.afterCommand(result.value.commandId);
      }
    },
  };
}

function play(harness: Harness) {
  harness.submit('diagnostics.recordProbe', { label: 'opening' });
  harness.submit('diagnostics.scheduleProbe', { label: 'lunch', delayMs: 4 * 60 * 60_000 });
  harness.submit('diagnostics.scheduleProbe', { label: 'close', delayMs: 9 * 60 * 60_000 });
  harness.host.kernel.advanceTo(30n * MS_PER_MINUTE);
}

/** Copy the live recovery log as a crashed process would leave it (main file + WAL). */
function crashCopy(from: string, to: string) {
  mkdirSync(join(to, 'recovery'), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = join(from, 'recovery', `session.fisave${suffix}`);
    if (existsSync(source)) {
      copyFileSync(source, join(to, 'recovery', `session.fisave${suffix}`));
    }
  }
}

describe('SaveCoordinator', () => {
  it('starts a new, unsaved world with crash recovery active', () => {
    const { host, saves } = start();
    expect(saves.sessionView()).toEqual({
      worldId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      savedAs: null,
      unsavedChanges: false,
      recoveryLog: 'active',
      notice: null,
    });
    expect(host.snapshot().session).toEqual(saves.sessionView());
    expect(saves.list()).toEqual([]);
    expect(existsSync(join(dir.path, 'recovery', 'session.fisave'))).toBe(true);
  });

  it('saves the world, tracks unsaved changes, and lists the save as current', () => {
    const harness = start();
    play(harness);
    expect(harness.saves.sessionView().unsavedChanges).toBe(true);
    const summary = harness.saves.save({ name: 'Morning', saveId: null });
    expect(summary).toMatchObject({
      status: 'ready',
      name: 'Morning',
      kind: 'manual',
      current: true,
      world: {
        seed: 11,
        nowMs: String(30n * MS_PER_MINUTE),
        calendar: { year: 1996, month: 1, day: 1, hour: 0, minute: 30 },
        worldRevision: 3,
      },
    });
    expect(harness.saves.sessionView()).toMatchObject({
      savedAs: { saveId: summary.saveId, name: 'Morning' },
      unsavedChanges: false,
    });
    harness.host.kernel.advanceTo(31n * MS_PER_MINUTE);
    expect(harness.saves.sessionView().unsavedChanges).toBe(true);
  });

  it('loads a save as a new, paused world instance that continues exactly like the original', () => {
    const original = start();
    play(original);
    const { saveId } = original.saves.save({ name: 'Morning', saveId: null });
    const before = original.host.snapshot();
    const originalWorldId = original.saves.sessionView().worldId;
    original.host.kernel.advanceTo(MS_PER_HOUR * 24n);
    const uninterrupted = original.host.kernel.fingerprint();
    original.saves.shutdown(); // quit the app…

    const reopened = start({ seed: 999 }); // …and start it again
    reopened.saves.load(saveId);
    const loaded = reopened.host.snapshot();
    expect(loaded.worldInstanceId).not.toBe(before.worldInstanceId);
    expect(loaded.fingerprint).toEqual(before.fingerprint);
    expect(loaded).toMatchObject({
      worldRevision: 3,
      seed: 11,
      clock: { nowMs: before.clock.nowMs, speed: 'paused' },
      queue: before.queue,
      diagnostics: before.diagnostics,
      session: {
        worldId: originalWorldId,
        savedAs: { saveId, name: 'Morning' },
        unsavedChanges: false,
      },
    });
    reopened.host.kernel.advanceTo(MS_PER_HOUR * 24n);
    expect(reopened.host.kernel.fingerprint()).toEqual(uninterrupted);
  });

  it('refuses commands prepared for the world that a load replaced', () => {
    const harness = start();
    const { saveId } = harness.saves.save({ name: 'Empty', saveId: null });
    const staleInstance = harness.host.worldInstanceId;
    harness.saves.load(saveId);
    const outcome = harness.host.submit({
      commandId: testUuid(9_000),
      worldInstanceId: staleInstance,
      expectedWorldRevision: 0,
      type: 'diagnostics.recordProbe',
      payload: { label: 'late' },
    });
    expect(outcome.result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
  });

  it('leaves the running world untouched when a load fails', () => {
    const harness = start();
    play(harness);
    const { saveId } = harness.saves.save({ name: 'Morning', saveId: null });
    writeFileSync(join(dir.path, 'saves', `${saveId}.fisave`), 'scrambled');
    const before = harness.host.snapshot();
    expect(() => {
      harness.saves.load(saveId);
    }).toThrow(SaveError);
    expect(harness.host.snapshot()).toEqual(before);
  });

  it('autosaves a changed world before loading another, so nothing is silently discarded', () => {
    const harness = start();
    const { saveId } = harness.saves.save({ name: 'Empty', saveId: null });
    play(harness);
    const progress = harness.host.kernel.fingerprint();
    harness.saves.load(saveId);
    const autosave = harness.saves.list().find((save) => save.kind === 'autosave');
    expect(autosave).toMatchObject({ name: 'Autosave before load', world: { worldRevision: 3 } });
    harness.saves.load(autosave?.saveId ?? '');
    expect(harness.host.kernel.fingerprint()).toEqual(progress);
  });

  it('overwrites only the player’s own saves', () => {
    const harness = start();
    const first = harness.saves.save({ name: 'Shop', saveId: null });
    play(harness);
    const second = harness.saves.save({ name: 'Shop, later', saveId: first.saveId });
    expect(second).toMatchObject({
      saveId: first.saveId,
      name: 'Shop, later',
      world: { worldRevision: 3 },
    });
    harness.saves.tick(120_000); // interval autosave of… nothing new: refused below
    harness.host.kernel.advanceTo(MS_PER_HOUR);
    harness.saves.tick(240_000);
    const autosave = harness.saves.list().find((save) => save.kind === 'autosave');
    expect(autosave).toBeDefined();
    let error: unknown;
    try {
      harness.saves.save({ name: 'Mine now', saveId: autosave?.saveId ?? '' });
    } catch (caught) {
      error = caught;
    }
    expect(saveFailure(error)).toEqual({
      code: 'SAVE_FAILED',
      message: 'Only your own saves can be overwritten; save under a new name instead.',
    });
  });

  it('autosaves on its interval only when the world has changed since it was last written', () => {
    const harness = start({ wallNow: 0 });
    expect(harness.saves.tick(30_000)).toEqual({ savesChanged: false }); // not due yet
    expect(harness.saves.tick(60_000)).toEqual({ savesChanged: false }); // due, but unchanged
    play(harness);
    expect(harness.saves.tick(90_000)).toEqual({ savesChanged: false }); // not due again yet
    expect(harness.saves.tick(120_000)).toEqual({ savesChanged: true });
    expect(harness.saves.list()).toMatchObject([
      { saveId: 'autosave-1', name: 'Autosave', kind: 'autosave', world: { worldRevision: 3 } },
    ]);
    // An autosave does not make the player's own save current or clear "unsaved changes".
    expect(harness.saves.sessionView()).toMatchObject({ savedAs: null, unsavedChanges: true });
    expect(harness.saves.tick(180_000)).toEqual({ savesChanged: false });
  });

  it('autosaves a changed world on shutdown and removes the recovery log', () => {
    const harness = start();
    play(harness);
    harness.saves.shutdown();
    expect(harness.saves.list()).toMatchObject([
      { name: 'Autosave on exit', world: { worldRevision: 3 } },
    ]);
    expect(readdirSync(join(dir.path, 'recovery'))).toEqual([]);
  });

  it('writes nothing on shutdown when nothing changed', () => {
    const harness = start();
    harness.saves.shutdown();
    expect(harness.saves.list()).toEqual([]);
    expect(readdirSync(join(dir.path, 'recovery'))).toEqual([]);
  });

  it('keeps per-save workspace settings outside the world state', () => {
    const harness = start();
    const hash = harness.host.kernel.fingerprint();
    expect(
      harness.saves.updateWorkspace({ key: 'window.personnel', value: { x: 10, open: true } }),
    ).toEqual({
      'window.personnel': { x: 10, open: true },
    });
    harness.saves.updateWorkspace({ key: 'shell.theme', value: 'classic' });
    harness.saves.updateWorkspace({ key: 'shell.theme', value: null });
    expect(harness.host.kernel.fingerprint()).toEqual(hash);
    expect(harness.saves.sessionView().unsavedChanges).toBe(false);
    const { saveId } = harness.saves.save({ name: 'Layout', saveId: null });
    harness.saves.shutdown();
    const other = start();
    other.saves.load(saveId);
    expect(other.saves.workspace()).toEqual({ 'window.personnel': { x: 10, open: true } });
  });

  describe('crash recovery', () => {
    it('rebuilds a crashed session from its recovery log into a "Recovered" save', () => {
      const crashed = start();
      play(crashed);
      crashed.submit('diagnostics.recordProbe', { label: 'after the clock ran' });
      crashed.host.kernel.advanceTo(2n * MS_PER_HOUR + 5n * MS_PER_MINUTE);
      crashed.saves.tick(1); // records a clock mark
      const lost = crashed.host.snapshot();
      crashed.saves.release(); // the process dies here
      const after = tempDir();
      try {
        crashCopy(dir.path, after.path);
        const next = start({ dataDir: after.path });
        expect(next.saves.sessionView().notice).toBe(
          'The previous session ended unexpectedly. It was rebuilt up to its last accepted command and recorded time, and saved as "Recovered session".',
        );
        const [recovered] = next.saves.list();
        expect(recovered).toMatchObject({
          name: 'Recovered session',
          kind: 'recovered',
          status: 'ready',
          world: { worldRevision: 4, nowMs: lost.clock.nowMs },
        });
        next.saves.load(recovered?.saveId ?? '');
        expect(next.host.snapshot().fingerprint).toEqual(lost.fingerprint);
        expect(next.host.snapshot().diagnostics).toEqual(lost.diagnostics);
        // The old log was consumed; the new session has its own.
        expect(next.saves.sessionView().recoveryLog).toBe('active');
      } finally {
        for (const coordinator of started.splice(0)) {
          coordinator.release();
        }
        after.remove();
      }
    });

    it('replays across a refreshed checkpoint (incremental journal)', () => {
      const crashed = start();
      play(crashed);
      crashed.saves.save({ name: 'Checkpoint', saveId: null }); // refreshes the recovery checkpoint
      crashed.host.kernel.advanceTo(5n * MS_PER_HOUR);
      crashed.submit('diagnostics.scheduleProbe', { label: 'evening', delayMs: 60_000 });
      crashed.submit('diagnostics.recordProbe', { label: 'last' });
      const lost = crashed.host.kernel.fingerprint();
      crashed.saves.release(); // the process dies here
      const after = tempDir();
      try {
        crashCopy(dir.path, after.path);
        const next = start({ dataDir: after.path });
        const recovered = next.saves.list().find((save) => save.kind === 'recovered');
        next.saves.load(recovered?.saveId ?? '');
        expect(next.host.kernel.fingerprint()).toEqual(lost);
      } finally {
        for (const coordinator of started.splice(0)) {
          coordinator.release();
        }
        after.remove();
      }
    });

    it('makes no recovered save when the log holds nothing newer than its checkpoint', () => {
      const crashed = start();
      crashed.saves.save({ name: 'Fresh', saveId: null });
      crashed.saves.release(); // the process dies here
      const after = tempDir();
      try {
        crashCopy(dir.path, after.path);
        const next = start({ dataDir: after.path });
        expect(next.saves.list()).toEqual([]);
        expect(next.saves.sessionView().notice).toBeNull();
      } finally {
        for (const coordinator of started.splice(0)) {
          coordinator.release();
        }
        after.remove();
      }
    });

    it('keeps a log it cannot use and says so, without blocking the new session', () => {
      mkdirSync(join(dir.path, 'recovery'), { recursive: true });
      writeFileSync(join(dir.path, 'recovery', 'session.fisave'), 'not a database');
      const next = start();
      expect(next.saves.sessionView()).toMatchObject({
        recoveryLog: 'active',
        notice: expect.stringMatching(
          /^The previous session ended unexpectedly and could not be recovered \(.+\)\. Its log was kept in the recovery folder\.$/,
        ) as unknown,
      });
      expect(readdirSync(join(dir.path, 'recovery')).sort()).toEqual([
        'failed-2026-11-07T12-00-00-000Z.fisave',
        'session.fisave',
        'session.fisave-shm',
        'session.fisave-wal',
      ]);
      expect(next.saves.list()).toEqual([]);
    });
  });

  it('maps persistence failures to typed IPC errors', () => {
    expect(saveFailure(new SaveError('NOT_FOUND', 'gone'))).toEqual({
      code: 'SAVE_NOT_FOUND',
      message: 'gone',
    });
    expect(saveFailure(new SaveError('NEWER_FORMAT', 'newer')).code).toBe('SAVE_INCOMPATIBLE');
    expect(saveFailure(new SaveError('INCOMPATIBLE_WORLD', 'rules')).code).toBe(
      'SAVE_INCOMPATIBLE',
    );
    expect(saveFailure(new SaveError('CORRUPT', 'bad')).code).toBe('SAVE_CORRUPT');
    expect(saveFailure(new SaveError('MIGRATION_FAILED', 'no')).code).toBe('SAVE_FAILED');
    expect(saveFailure(new Error('boom'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected persistence error: boom',
    });
  });
});
