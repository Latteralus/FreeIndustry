import { EventEmitter } from 'node:events';
import type { Logger } from '../../../src/main/logger';
import { WorkerSupervisor, type WorkerHandle } from '../../../src/main/worker-supervisor';
import type { HostEvent } from '../../../src/shared/ipc/contract';
import type { WorkerOptions, WorkerRequest } from '../../../src/shared/ipc/worker-protocol';
import { sampleWorldSnapshot } from '../../support/world-snapshot';

const WORLD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const COMMAND = '0b9f1c2e-7a4d-4e5f-9a6b-1c2d3e4f5a6b';

class FakeWorker extends EventEmitter implements WorkerHandle {
  readonly sent: WorkerRequest[] = [];
  terminated = false;
  constructor(readonly options: WorkerOptions) {
    super();
  }
  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
  }
  terminate(): Promise<number> {
    if (!this.terminated) {
      this.terminated = true;
      queueMicrotask(() => this.emit('exit', 1));
    }
    return Promise.resolve(1);
  }
  /** Simulate the worker sending a message. */
  send(message: unknown): void {
    this.emit('message', message);
  }
  ready(): void {
    this.send({ kind: 'ready', worldInstanceId: WORLD });
  }
  lastRequestId(): number {
    const last = this.sent.at(-1);
    if (!last) {
      throw new Error('nothing sent');
    }
    return last.requestId;
  }
}

function setup(options: { timeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const events: HostEvent[] = [];
  const logs: { level: string; message: string }[] = [];
  const logger: Logger = { log: (level, message) => logs.push({ level, message }) };
  const supervisor = new WorkerSupervisor({
    createWorker: (workerOptions) => {
      const worker = new FakeWorker(workerOptions);
      workers.push(worker);
      return worker;
    },
    faultInjectionEnabled: false,
    dataDirectory: 'C:/Users/Test/AppData/Roaming/FreeIndustry',
    appVersion: '0.1.0',
    logger,
    onEvent: (event) => events.push(event),
    requestTimeoutMs: options.timeoutMs ?? 1_000,
    now: () => new Date('2026-11-07T12:00:00.000Z'),
  });
  const current = () => {
    const worker = workers.at(-1);
    if (!worker) {
      throw new Error('no worker');
    }
    return worker;
  };
  return { supervisor, workers, events, logs, current };
}

const envelope = {
  commandId: COMMAND,
  worldInstanceId: WORLD,
  expectedWorldRevision: 0,
  type: 'diagnostics.recordProbe',
  payload: { label: 'x' },
};

const receipt = {
  commandId: COMMAND,
  worldInstanceId: WORLD,
  worldRevision: 1,
  atMs: '0',
  duplicate: false,
};

describe('WorkerSupervisor', () => {
  it('moves from starting to ready when the worker reports ready', () => {
    const { supervisor, current, events } = setup();
    supervisor.start();
    expect(supervisor.status).toEqual({ state: 'starting', generation: 1, failure: null });
    expect(current().options).toEqual({
      generation: 1,
      faultInjectionEnabled: false,
      seed: null,
      dataDirectory: 'C:/Users/Test/AppData/Roaming/FreeIndustry',
      appVersion: '0.1.0',
      autosaveIntervalMs: 300_000,
    });
    current().ready();
    expect(supervisor.status.state).toBe('ready');
    expect(events.map((event) => event.type === 'worker.status' && event.worker.state)).toEqual([
      'starting',
      'ready',
    ]);
  });

  it('correlates responses with requests and validates them', async () => {
    const { supervisor, current } = setup();
    supervisor.start();
    current().ready();
    const pending = supervisor.submitCommand(envelope);
    expect(current().sent).toEqual([{ kind: 'submitCommand', requestId: 1, envelope }]);
    current().send({ kind: 'response', requestId: 1, result: { ok: true, value: receipt } });
    await expect(pending).resolves.toEqual({ ok: true, value: receipt });
  });

  it('turns an invalid worker response into INTERNAL_ERROR', async () => {
    const { supervisor, current, logs } = setup();
    supervisor.start();
    current().ready();
    const pending = supervisor.submitCommand(envelope);
    current().send({
      kind: 'response',
      requestId: current().lastRequestId(),
      result: { ok: true, value: { worldRevision: 'one' } },
    });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(logs.some((entry) => entry.message === 'Worker response failed validation')).toBe(true);
  });

  it('discards malformed worker messages without failing', () => {
    const { supervisor, current, logs } = setup();
    supervisor.start();
    current().ready();
    current().send({ kind: 'teleport', stock: 1_000_000 });
    current().send('garbage');
    expect(supervisor.status.state).toBe('ready');
    expect(
      logs.filter((entry) => entry.message === 'Discarded invalid message from worker'),
    ).toHaveLength(2);
  });

  it('forwards worker logs and world revisions', () => {
    const { supervisor, current, events, logs } = setup();
    supervisor.start();
    current().ready();
    current().send({ kind: 'log', level: 'info', message: 'hello from worker', fields: {} });
    current().send({ kind: 'worldRevised', worldInstanceId: WORLD, worldRevision: 4 });
    expect(logs).toContainEqual({ level: 'info', message: 'hello from worker' });
    expect(events.at(-1)).toEqual({
      type: 'world.revised',
      worldInstanceId: WORLD,
      worldRevision: 4,
    });
  });

  it('forwards save changes as saves.changed events', () => {
    const { supervisor, current, events } = setup();
    supervisor.start();
    current().ready();
    current().send({ kind: 'savesChanged' });
    expect(events.at(-1)).toEqual({ type: 'saves.changed' });
  });

  it('sends save requests and validates their answers', async () => {
    const { supervisor, current } = setup();
    supervisor.start();
    current().ready();
    const saved = supervisor.saveWorld({ name: 'Shop', saveId: null });
    expect(current().sent.at(-1)).toMatchObject({
      kind: 'saveWorld',
      request: { name: 'Shop', saveId: null },
    });
    current().send({
      kind: 'response',
      requestId: current().lastRequestId(),
      result: { ok: true, value: { saveId: 'C:/Windows/evil', status: 'ready' } },
    });
    await expect(saved).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    const exported = supervisor.exportSave('save-1', 'D:/Exports/Shop.fisave');
    expect(current().sent.at(-1)).toMatchObject({
      kind: 'exportSave',
      saveId: 'save-1',
      destinationPath: 'D:/Exports/Shop.fisave',
    });
    current().send({
      kind: 'response',
      requestId: current().lastRequestId(),
      result: { ok: false, error: { code: 'SAVE_FAILED', message: 'disk full' } },
    });
    await expect(exported).resolves.toEqual({
      ok: false,
      error: { code: 'SAVE_FAILED', message: 'disk full' },
    });
  });

  it('gives file operations the longer persistence timeout', async () => {
    jest.useFakeTimers();
    try {
      const { supervisor, current } = setup({ timeoutMs: 1_000 });
      supervisor.start();
      current().ready();
      let settled = false;
      const loading = supervisor.loadSave('save-1').then((result) => {
        settled = true;
        return result;
      });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false); // a normal request would have timed out after 1 s
      await jest.advanceTimersByTimeAsync(60_000);
      await expect(loading).resolves.toMatchObject({
        ok: false,
        error: { code: 'WORKER_TIMEOUT' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('forwards clock notifications as world.clock events', () => {
    const { supervisor, current, events } = setup();
    supervisor.start();
    current().ready();
    current().send({ kind: 'worldClock', worldInstanceId: WORLD, nowMs: '3600000' });
    expect(events.at(-1)).toEqual({
      type: 'world.clock',
      worldInstanceId: WORLD,
      nowMs: '3600000',
    });
    current().send({ kind: 'worldClock', worldInstanceId: WORLD, nowMs: '-5' });
    expect(events).toHaveLength(3); // the invalid one is discarded
  });

  it('sends clock control and validates the snapshot it gets back', async () => {
    const { supervisor, current } = setup();
    supervisor.start();
    current().ready();
    const control = { action: 'advance', until: 'endOfDay' } as const;
    const pending = supervisor.control(control);
    expect(current().sent).toEqual([{ kind: 'control', requestId: 1, control }]);
    const world = sampleWorldSnapshot(WORLD);
    current().send({ kind: 'response', requestId: 1, result: { ok: true, value: world } });
    await expect(pending).resolves.toEqual({ ok: true, value: world });

    const invalid = supervisor.control(control);
    current().send({
      kind: 'response',
      requestId: 2,
      result: { ok: true, value: { ...world, clock: { ...world.clock, speed: 'warp' } } },
    });
    await expect(invalid).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('asks for a new world with the persistence timeout and validates the snapshot', async () => {
    const { supervisor, current } = setup();
    supervisor.start();
    current().ready();
    const pending = supervisor.newWorld({ scenarioId: 'backed', seed: 7 });
    expect(current().sent).toEqual([
      { kind: 'newWorld', requestId: 1, world: { scenarioId: 'backed', seed: 7 } },
    ]);
    const world = sampleWorldSnapshot(WORLD);
    current().send({ kind: 'response', requestId: 1, result: { ok: true, value: world } });
    await expect(pending).resolves.toEqual({ ok: true, value: world });
    const invalid = supervisor.newWorld({ scenarioId: 'backed', seed: null });
    current().send({
      kind: 'response',
      requestId: 2,
      result: { ok: true, value: { ...world, scenarios: 'many' } },
    });
    await expect(invalid).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('passes a fixed seed to every new worker when configured', () => {
    const workers: WorkerOptions[] = [];
    const supervisor = new WorkerSupervisor({
      createWorker: (options) => {
        workers.push(options);
        return new FakeWorker(options);
      },
      faultInjectionEnabled: false,
      seed: 1234,
      dataDirectory: 'D:/data',
      appVersion: '0.1.0',
      autosaveIntervalMs: 60_000,
      logger: { log: () => undefined },
      onEvent: () => undefined,
    });
    supervisor.start();
    expect(workers).toEqual([
      {
        generation: 1,
        faultInjectionEnabled: false,
        seed: 1234,
        dataDirectory: 'D:/data',
        appVersion: '0.1.0',
        autosaveIntervalMs: 60_000,
      },
    ]);
  });

  it.each([
    [
      'an uncaught error',
      (worker: FakeWorker) => worker.emit('error', new Error('boom')),
      'Uncaught error in simulation worker: boom',
    ],
    [
      'an unexpected exit',
      (worker: FakeWorker) => worker.emit('exit', 70),
      'Simulation worker exited unexpectedly (exit code 70)',
    ],
  ])(
    'fails every pending request explicitly on %s and does not restart',
    async (_name, kill, message) => {
      const { supervisor, current, workers, events } = setup();
      supervisor.start();
      current().ready();
      const first = supervisor.submitCommand(envelope);
      const second = supervisor.getWorldSnapshot();
      kill(current());
      await expect(first).resolves.toMatchObject({
        ok: false,
        error: { code: 'WORKER_UNAVAILABLE' },
      });
      await expect(second).resolves.toMatchObject({
        ok: false,
        error: { code: 'WORKER_UNAVAILABLE' },
      });
      expect(supervisor.status).toEqual({
        state: 'failed',
        generation: 1,
        failure: { message, occurredAt: '2026-11-07T12:00:00.000Z' },
      });
      expect(events.at(-1)).toEqual({ type: 'worker.status', worker: supervisor.status });
      expect(workers).toHaveLength(1);
      await expect(supervisor.submitCommand(envelope)).resolves.toMatchObject({
        ok: false,
        error: { code: 'WORKER_UNAVAILABLE' },
      });
    },
  );

  it('reports a failure once even though Node emits error then exit', () => {
    const { supervisor, current, logs } = setup();
    supervisor.start();
    current().ready();
    current().emit('error', new Error('boom'));
    current().emit('exit', 1);
    expect(supervisor.status.failure?.message).toBe('Uncaught error in simulation worker: boom');
    expect(logs.filter((entry) => entry.level === 'error')).toHaveLength(1);
  });

  it('restarts only after a failure, with a new generation', () => {
    const { supervisor, current, workers } = setup();
    supervisor.start();
    current().ready();
    expect(supervisor.restart()).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    current().emit('exit', 70);
    const restarted = supervisor.restart();
    expect(restarted).toEqual({
      ok: true,
      value: { state: 'starting', generation: 2, failure: null },
    });
    expect(workers).toHaveLength(2);
    expect(current().options.generation).toBe(2);
  });

  it('ignores messages and exits from a previous worker generation', () => {
    const { supervisor, workers, current } = setup();
    supervisor.start();
    const old = current();
    old.ready();
    old.emit('exit', 70);
    supervisor.restart();
    current().ready();
    old.send({ kind: 'worldRevised', worldInstanceId: WORLD, worldRevision: 9 });
    old.emit('exit', 1);
    expect(supervisor.status).toEqual({ state: 'ready', generation: 2, failure: null });
    expect(workers).toHaveLength(2);
  });

  it('times out an unanswered request and ignores the late answer', async () => {
    jest.useFakeTimers();
    try {
      const { supervisor, current, logs } = setup({ timeoutMs: 50 });
      supervisor.start();
      current().ready();
      const pending = supervisor.submitCommand(envelope);
      const requestId = current().lastRequestId();
      jest.advanceTimersByTime(50);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'WORKER_TIMEOUT' },
      });
      current().send({ kind: 'response', requestId, result: { ok: true, value: receipt } });
      expect(
        logs.some((entry) => entry.message === 'Response for unknown or timed-out request'),
      ).toBe(true);
      expect(supervisor.status.state).toBe('ready');
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops gracefully: shutdown request, acknowledgement, clean exit', async () => {
    const { supervisor, current } = setup();
    supervisor.start();
    const worker = current();
    worker.ready();
    const stopped = supervisor.stop(1_000);
    expect(supervisor.status.state).toBe('stopping');
    const shutdown = worker.sent.at(-1);
    expect(shutdown?.kind).toBe('shutdown');
    worker.send({
      kind: 'response',
      requestId: worker.lastRequestId(),
      result: { ok: true, value: { stopped: true } },
    });
    worker.emit('exit', 0);
    await stopped;
    expect(supervisor.status).toEqual({ state: 'stopped', generation: 1, failure: null });
    expect(worker.terminated).toBe(false);
  });

  it('terminates a worker that does not stop in time', async () => {
    const { supervisor, current, logs } = setup();
    supervisor.start();
    const worker = current();
    worker.ready();
    await supervisor.stop(10);
    expect(worker.terminated).toBe(true);
    expect(supervisor.status.state).toBe('stopped');
    expect(logs.some((entry) => entry.message.includes('did not stop in time'))).toBe(true);
  });

  it('refuses new requests while stopping', async () => {
    const { supervisor, current } = setup();
    supervisor.start();
    current().ready();
    const stopping = supervisor.stop(10);
    await expect(supervisor.submitCommand(envelope)).resolves.toMatchObject({
      ok: false,
      error: { code: 'WORKER_UNAVAILABLE' },
    });
    await stopping;
  });

  it('reports a worker that cannot be created as a failure', () => {
    const supervisor = new WorkerSupervisor({
      createWorker: () => {
        throw new Error('no such file');
      },
      faultInjectionEnabled: false,
      dataDirectory: 'D:/data',
      appVersion: '0.1.0',
      logger: { log: () => undefined },
      onEvent: () => undefined,
    });
    supervisor.start();
    expect(supervisor.status.state).toBe('failed');
    expect(supervisor.status.failure?.message).toContain('no such file');
  });
});
