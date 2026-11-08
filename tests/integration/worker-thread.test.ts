import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Logger } from '../../src/main/logger';
import { WorkerSupervisor } from '../../src/main/worker-supervisor';
import type { HostEvent, WorkerStatus } from '../../src/shared/ipc/contract';

/**
 * The real worker entry (src/worker/index.ts) in a real worker thread, driven
 * by the real supervisor, with real SQLite saves in a temporary data
 * directory. No Electron: the TypeScript source is loaded via tsx.
 */

const WORKER_ENTRY = join(__dirname, '../../src/worker/index.ts');

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

const dataDirectories: string[] = [];

function newDataDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'freeindustry-worker-'));
  dataDirectories.push(path);
  return path;
}

afterAll(() => {
  for (const path of dataDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
});

function startSupervisor(
  faultInjectionEnabled: boolean,
  options: { dataDirectory?: string; seed?: number } = {},
) {
  const events: HostEvent[] = [];
  const logs: { level: string; message: string; source: string | undefined }[] = [];
  const logger: Logger = {
    log: (level, message, _fields, source) => logs.push({ level, message, source }),
  };
  const waiters: { predicate: (status: WorkerStatus) => boolean; resolve: () => void }[] = [];
  const supervisor = new WorkerSupervisor({
    createWorker: (workerData) =>
      new Worker(WORKER_ENTRY, { workerData, execArgv: ['--import', 'tsx'] }),
    faultInjectionEnabled,
    seed: options.seed ?? null,
    dataDirectory: options.dataDirectory ?? newDataDirectory(),
    appVersion: '0.1.0-test',
    logger,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'worker.status') {
        for (const waiter of waiters.filter((item) => item.predicate(event.worker))) {
          waiter.resolve();
        }
      }
    },
    requestTimeoutMs: 15_000,
  });
  const until = (state: WorkerStatus['state']) =>
    supervisor.status.state === state
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiters.push({ predicate: (status) => status.state === state, resolve });
        });
  return { supervisor, events, logs, until };
}

async function ready(
  faultInjectionEnabled = false,
  options: { dataDirectory?: string; seed?: number } = {},
) {
  const harness = startSupervisor(faultInjectionEnabled, options);
  harness.supervisor.start();
  await harness.until('ready');
  const world = await harness.supervisor.getWorldSnapshot();
  if (!world.ok) {
    throw new Error(world.error.message);
  }
  return { ...harness, world: world.value };
}

jest.setTimeout(30_000);

describe('simulation worker thread', () => {
  it('starts, answers snapshots and applies commands with revision events', async () => {
    const { supervisor, events, logs, world } = await ready();
    try {
      expect(world).toMatchObject({ worldRevision: 0, diagnostics: { probeCount: 0 } });
      const receipt = await supervisor.submitCommand({
        commandId: uuid(1),
        worldInstanceId: world.worldInstanceId,
        expectedWorldRevision: 0,
        type: 'diagnostics.recordProbe',
        payload: { label: 'integration' },
      });
      expect(receipt).toEqual({
        ok: true,
        value: {
          commandId: uuid(1),
          worldInstanceId: world.worldInstanceId,
          worldRevision: 1,
          atMs: '0',
          duplicate: false,
        },
      });
      await expect(supervisor.getWorldSnapshot()).resolves.toMatchObject({
        ok: true,
        value: { worldRevision: 1, diagnostics: { probeCount: 1, lastProbeLabel: 'integration' } },
      });
      expect(events).toContainEqual({
        type: 'world.revised',
        worldInstanceId: world.worldInstanceId,
        worldRevision: 1,
      });
      expect(logs).toContainEqual({ level: 'info', message: 'Command accepted', source: 'worker' });
    } finally {
      await supervisor.stop();
    }
  });

  it('runs the clock in real time, fires a scheduled event and pauses on request', async () => {
    const { supervisor, events, world } = await ready();
    try {
      const scheduled = await supervisor.submitCommand({
        commandId: uuid(10),
        worldInstanceId: world.worldInstanceId,
        expectedWorldRevision: 0,
        type: 'diagnostics.scheduleProbe',
        payload: { label: 'in ten minutes', delayMs: 600_000 },
      });
      expect(scheduled).toMatchObject({ ok: true, value: { worldRevision: 1, atMs: '0' } });

      // Fastest is 600x: ten simulated minutes take about one wall second.
      const running = await supervisor.control({ action: 'setSpeed', speed: 'fastest' });
      expect(running).toMatchObject({ ok: true, value: { clock: { speed: 'fastest' } } });
      const deadline = Date.now() + 15_000;
      let fired = false;
      while (!fired && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const snapshot = await supervisor.getWorldSnapshot();
        fired = snapshot.ok && snapshot.value.diagnostics.firedProbes === 1;
      }
      expect(fired).toBe(true);
      expect(events.some((event) => event.type === 'world.clock')).toBe(true);

      const paused = await supervisor.control({ action: 'setSpeed', speed: 'paused' });
      if (!paused.ok) {
        throw new Error(paused.error.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const later = await supervisor.getWorldSnapshot();
      // Paused: zero simulated-time transitions.
      expect(later).toMatchObject({
        ok: true,
        value: { clock: { nowMs: paused.value.clock.nowMs } },
      });
      expect(BigInt(paused.value.clock.nowMs)).toBeGreaterThanOrEqual(600_000n);
      expect(paused.value.diagnostics.lastFiredProbe).toMatchObject({
        label: 'in ten minutes',
        firedAtMs: '600000',
      });
      expect(paused.value.worldRevision).toBe(1);
    } finally {
      await supervisor.stop();
    }
  });

  it('completes a targeted advance to the end of the day and pauses', async () => {
    const { supervisor, events, world } = await ready();
    try {
      const started = await supervisor.control({ action: 'advance', until: 'endOfDay' });
      expect(started).toMatchObject({ ok: true });
      const deadline = Date.now() + 10_000;
      let snapshot = await supervisor.getWorldSnapshot();
      while (snapshot.ok && snapshot.value.clock.advance !== null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        snapshot = await supervisor.getWorldSnapshot();
      }
      expect(snapshot).toMatchObject({
        ok: true,
        value: {
          worldInstanceId: world.worldInstanceId,
          clock: {
            nowMs: '86400000',
            calendar: { year: 1996, month: 1, day: 2, weekday: 2, hour: 0 },
            speed: 'paused',
            advance: null,
            lastStop: { until: 'endOfDay', reason: 'reached', atMs: '86400000' },
          },
        },
      });
      expect(events).toContainEqual({
        type: 'world.clock',
        worldInstanceId: world.worldInstanceId,
        nowMs: '86400000',
      });
    } finally {
      await supervisor.stop();
    }
  });

  it('re-validates commands in the worker, independent of main', async () => {
    const { supervisor, world } = await ready();
    try {
      // Main's gateway would refuse this; the worker must refuse it too.
      const result = await supervisor.submitCommand({
        commandId: uuid(2),
        worldInstanceId: world.worldInstanceId,
        expectedWorldRevision: 0,
        type: 'diagnostics.injectFault',
        payload: { fault: 'thread-exit' },
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      expect(supervisor.status.state).toBe('ready');
    } finally {
      await supervisor.stop();
    }
  });

  it('stops gracefully with an acknowledged shutdown', async () => {
    const { supervisor, logs } = await ready();
    await supervisor.stop();
    expect(supervisor.status.state).toBe('stopped');
    expect(logs).toContainEqual({
      level: 'info',
      message: 'Worker shutting down',
      source: 'worker',
    });
    expect(logs.some((entry) => entry.message.includes('did not stop in time'))).toBe(false);
  });

  it.each([
    ['thread-exit', 'Simulation worker exited unexpectedly (exit code 70)'],
    [
      'uncaught-exception',
      'Uncaught error in simulation worker: Injected uncaught worker exception',
    ],
  ])('reports a %s fault as a recoverable failure', async (fault, message) => {
    const { supervisor, until, world } = await ready(true);
    await supervisor.submitCommand({
      commandId: uuid(3),
      worldInstanceId: world.worldInstanceId,
      expectedWorldRevision: 0,
      type: 'diagnostics.injectFault',
      payload: { fault },
    });
    await until('failed');
    expect(supervisor.status.failure?.message).toBe(message);

    expect(supervisor.restart().ok).toBe(true);
    await until('ready');
    const fresh = await supervisor.getWorldSnapshot();
    expect(fresh).toMatchObject({ ok: true, value: { worldRevision: 0 } });
    expect(fresh.ok && fresh.value.worldInstanceId).not.toBe(world.worldInstanceId);
    await supervisor.stop();
  });

  describe('saves in a real worker thread', () => {
    async function play(supervisor: WorkerSupervisor, worldInstanceId: string, first: number) {
      const plan = [
        { type: 'diagnostics.recordProbe', payload: { label: 'plan' } },
        { type: 'diagnostics.scheduleProbe', payload: { label: 'a', delayMs: 600_000 } },
        { type: 'diagnostics.scheduleProbe', payload: { label: 'b', delayMs: 7_200_000 } },
      ];
      for (const [index, item] of plan.entries()) {
        const result = await supervisor.submitCommand({
          commandId: uuid(first + index),
          worldInstanceId,
          expectedWorldRevision: index,
          ...item,
        });
        expect(result).toMatchObject({ ok: true });
      }
    }

    async function advance(supervisor: WorkerSupervisor, until: 'endOfDay' | 'nextEvent') {
      await supervisor.control({ action: 'advance', until });
      const deadline = Date.now() + 15_000;
      let snapshot = await supervisor.getWorldSnapshot();
      while (snapshot.ok && snapshot.value.clock.advance !== null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        snapshot = await supervisor.getWorldSnapshot();
      }
      if (!snapshot.ok) {
        throw new Error(snapshot.error.message);
      }
      return snapshot.value;
    }

    it('save with an event pending, stop, start a new worker, load and resume = uninterrupted', async () => {
      const seed = 31_337;
      const straight = await ready(false, { seed });
      await play(straight.supervisor, straight.world.worldInstanceId, 100);
      const expected = await advance(straight.supervisor, 'endOfDay');
      await straight.supervisor.stop();

      const dataDirectory = newDataDirectory();
      const first = await ready(false, { seed, dataDirectory });
      await play(first.supervisor, first.world.worldInstanceId, 100);
      const midway = await advance(first.supervisor, 'nextEvent'); // probe a fired at 00:10
      expect(midway).toMatchObject({ queue: { pending: 1 }, diagnostics: { firedProbes: 1 } });
      const saved = await first.supervisor.saveWorld({ name: 'Midway', saveId: null });
      expect(saved).toMatchObject({
        ok: true,
        value: { name: 'Midway', status: 'ready', current: true },
      });
      await first.supervisor.stop();
      expect(first.events).toContainEqual({ type: 'saves.changed' });

      const second = await ready(false, { seed: 1, dataDirectory });
      const listed = await second.supervisor.listSaves();
      expect(listed).toMatchObject({ ok: true, value: [{ name: 'Midway', kind: 'manual' }] });
      const saveId = saved.ok ? saved.value.saveId : '';
      const loaded = await second.supervisor.loadSave(saveId);
      expect(loaded).toMatchObject({
        ok: true,
        value: {
          fingerprint: midway.fingerprint,
          clock: { nowMs: midway.clock.nowMs, speed: 'paused' },
        },
      });
      expect(loaded.ok && loaded.value.worldInstanceId).not.toBe(second.world.worldInstanceId);
      const resumed = await advance(second.supervisor, 'endOfDay');
      expect(resumed.fingerprint).toEqual(expected.fingerprint);
      expect(resumed.diagnostics).toEqual(expected.diagnostics);
      await second.supervisor.stop();
    });

    it('rebuilds the session after the worker thread dies, into a save the player can load', async () => {
      const dataDirectory = newDataDirectory();
      const crashed = await ready(true, { seed: 2024, dataDirectory });
      await play(crashed.supervisor, crashed.world.worldInstanceId, 200);
      const before = await crashed.supervisor.getWorldSnapshot();
      await crashed.supervisor.submitCommand({
        commandId: uuid(299),
        worldInstanceId: crashed.world.worldInstanceId,
        expectedWorldRevision: 3,
        type: 'diagnostics.injectFault',
        payload: { fault: 'thread-exit' },
      });
      await crashed.until('failed');

      // The player restarts the worker; the new thread finds the dead one's recovery log.
      expect(crashed.supervisor.restart().ok).toBe(true);
      await crashed.until('ready');
      const fresh = await crashed.supervisor.getWorldSnapshot();
      expect(fresh).toMatchObject({
        ok: true,
        value: {
          worldRevision: 0,
          session: {
            notice:
              'The previous session ended unexpectedly. It was rebuilt up to its last accepted command and recorded time, and saved as "Recovered session".',
          },
        },
      });
      const saves = await crashed.supervisor.listSaves();
      const recovered = saves.ok
        ? saves.value.find((save) => save.kind === 'recovered')
        : undefined;
      expect(recovered).toMatchObject({
        name: 'Recovered session',
        status: 'ready',
        world: { worldRevision: 3 },
      });
      const loaded = await crashed.supervisor.loadSave(recovered?.saveId ?? '');
      expect(loaded.ok && before.ok && loaded.value.fingerprint).toEqual(
        before.ok && before.value.fingerprint,
      );
      await crashed.supervisor.stop();
    });

    it('reports a missing save as a typed error and keeps the world', async () => {
      const { supervisor, world } = await ready();
      await expect(supervisor.loadSave('save-missing')).resolves.toMatchObject({
        ok: false,
        error: { code: 'SAVE_NOT_FOUND' },
      });
      await expect(supervisor.getWorldSnapshot()).resolves.toMatchObject({
        ok: true,
        value: { worldInstanceId: world.worldInstanceId },
      });
      await supervisor.stop();
    });
  });
});
