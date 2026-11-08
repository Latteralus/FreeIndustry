import type { z } from 'zod';
import {
  commandReceiptSchema,
  describeZodError,
  ipcFail,
  ipcOk,
  ipcResultSchema,
  worldSnapshotSchema,
  type CommandEnvelope,
  type CommandReceipt,
  type HostEvent,
  type IpcResult,
  type WorkerStatus,
  type WorldSnapshot,
} from '../shared/ipc/contract';
import type { ClockControl } from '../shared/ipc/clock';
import type { NewWorldRequest } from '../shared/ipc/real-estate';
import {
  saveListSchema,
  saveSummarySchema,
  workspaceViewSchema,
  type SaveRequest,
  type SaveSummary,
  type WorkspaceSettingsView,
  type WorkspaceUpdate,
} from '../shared/ipc/saves';
import {
  exportAckSchema,
  shutdownAckSchema,
  workerMessageSchema,
  type WorkerOptions,
  type WorkerRequest,
} from '../shared/ipc/worker-protocol';
import { describeError, type Logger } from './logger';

/**
 * Starts, watches and stops the simulation worker thread (ADR-0012,
 * ADR-0014). Holds no world state of its own: it correlates requests with
 * responses, validates everything the worker sends, and turns worker death
 * into explicit, recoverable failures instead of silent resets.
 *
 * Failure policy: when the worker dies, every unanswered request resolves
 * with WORKER_UNAVAILABLE, the status becomes `failed` with a reason, and
 * nothing restarts until `restart()` is called (the player decides).
 */

/** The parts of `node:worker_threads` `Worker` the supervisor uses. */
export interface WorkerHandle {
  postMessage(message: WorkerRequest): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'messageerror' | 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (exitCode: number) => void): unknown;
  terminate(): Promise<number>;
}

export type WorkerFactory = (options: WorkerOptions) => WorkerHandle;

export interface WorkerSupervisorOptions {
  readonly createWorker: WorkerFactory;
  readonly faultInjectionEnabled: boolean;
  /** Fixed seed for every new world (tests only), or null for a random seed. */
  readonly seed?: number | null;
  /** The user's data directory; the worker keeps saves and its recovery log there. */
  readonly dataDirectory: string;
  readonly appVersion: string;
  /** Wall time between autosaves of a changed world (default 5 minutes). */
  readonly autosaveIntervalMs?: number;
  readonly logger: Logger;
  readonly onEvent: (event: HostEvent) => void;
  readonly requestTimeoutMs?: number;
  /** Timeout for save, load, export and import, which do file I/O (default 60 s). */
  readonly persistenceTimeoutMs?: number;
  readonly now?: () => Date;
}

interface PendingRequest {
  readonly kind: WorkerRequest['kind'];
  readonly resolve: (result: IpcResult<unknown>) => void;
  readonly schema: z.ZodType;
  readonly timer: ReturnType<typeof setTimeout>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const UNANSWERED =
  'The simulation worker stopped before answering. The request was not confirmed, and any ' +
  'unsaved world state held by that worker was lost.';

export class WorkerSupervisor {
  readonly #createWorker: WorkerFactory;
  readonly #faultInjectionEnabled: boolean;
  readonly #seed: number | null;
  readonly #dataDirectory: string;
  readonly #appVersion: string;
  readonly #autosaveIntervalMs: number;
  readonly #logger: Logger;
  readonly #onEvent: (event: HostEvent) => void;
  readonly #timeoutMs: number;
  readonly #persistenceTimeoutMs: number;
  readonly #now: () => Date;

  #worker: WorkerHandle | null = null;
  #status: WorkerStatus = { state: 'stopped', generation: 0, failure: null };
  #generation = 0;
  #nextRequestId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  #exited: Promise<void> = Promise.resolve();
  #markExited: () => void = () => undefined;

  constructor(options: WorkerSupervisorOptions) {
    this.#createWorker = options.createWorker;
    this.#faultInjectionEnabled = options.faultInjectionEnabled;
    this.#seed = options.seed ?? null;
    this.#dataDirectory = options.dataDirectory;
    this.#appVersion = options.appVersion;
    this.#autosaveIntervalMs = options.autosaveIntervalMs ?? 5 * 60 * 1000;
    this.#logger = options.logger;
    this.#onEvent = options.onEvent;
    this.#timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#persistenceTimeoutMs = options.persistenceTimeoutMs ?? 60_000;
    this.#now = options.now ?? (() => new Date());
  }

  get status(): WorkerStatus {
    return this.#status;
  }

  /** Start the first worker. */
  start(): void {
    if (this.#worker) {
      throw new Error('Worker already started');
    }
    this.#spawn();
  }

  /** Start a fresh worker after a failure or stop. Refused while one is running. */
  restart(): IpcResult<WorkerStatus> {
    const { state } = this.#status;
    if (state !== 'failed' && state !== 'stopped') {
      return ipcFail(
        'INVALID_STATE',
        `The simulation worker is ${state}; restart is only allowed after it has stopped`,
      );
    }
    this.#logger.log('info', 'Restarting simulation worker', {
      previousGeneration: this.#generation,
    });
    this.#spawn();
    return ipcOk(this.#status);
  }

  getWorldSnapshot(): Promise<IpcResult<WorldSnapshot>> {
    return this.#request({ kind: 'getSnapshot' }, worldSnapshotSchema);
  }

  submitCommand(envelope: CommandEnvelope): Promise<IpcResult<CommandReceipt>> {
    return this.#request({ kind: 'submitCommand', envelope }, commandReceiptSchema);
  }

  /** Clock control (pause, speed, targeted advance); answered with a world snapshot. */
  control(control: ClockControl): Promise<IpcResult<WorldSnapshot>> {
    return this.#request({ kind: 'control', control }, worldSnapshotSchema);
  }

  /** Replace the world with a new one; slow, because the old world may be autosaved first. */
  newWorld(request: NewWorldRequest): Promise<IpcResult<WorldSnapshot>> {
    return this.#request({ kind: 'newWorld', world: request }, worldSnapshotSchema, { slow: true });
  }

  listSaves(): Promise<IpcResult<SaveSummary[]>> {
    return this.#request({ kind: 'listSaves' }, saveListSchema, { slow: true });
  }

  saveWorld(request: SaveRequest): Promise<IpcResult<SaveSummary>> {
    return this.#request({ kind: 'saveWorld', request }, saveSummarySchema, { slow: true });
  }

  loadSave(saveId: string): Promise<IpcResult<WorldSnapshot>> {
    return this.#request({ kind: 'loadSave', saveId }, worldSnapshotSchema, { slow: true });
  }

  /** `destinationPath` must come from main's own save dialog. */
  exportSave(saveId: string, destinationPath: string): Promise<IpcResult<{ exported: true }>> {
    return this.#request({ kind: 'exportSave', saveId, destinationPath }, exportAckSchema, {
      slow: true,
    });
  }

  /** `sourcePath` must come from main's own open dialog. */
  importSave(sourcePath: string): Promise<IpcResult<SaveSummary>> {
    return this.#request({ kind: 'importSave', sourcePath }, saveSummarySchema, { slow: true });
  }

  getWorkspace(): Promise<IpcResult<WorkspaceSettingsView>> {
    return this.#request({ kind: 'getWorkspace' }, workspaceViewSchema);
  }

  setWorkspace(update: WorkspaceUpdate): Promise<IpcResult<WorkspaceSettingsView>> {
    return this.#request({ kind: 'setWorkspace', update }, workspaceViewSchema);
  }

  /**
   * Graceful stop: ask the worker to shut down (it autosaves a changed world
   * and closes its recovery log first), wait for the thread to exit, and
   * terminate it if it does not within `timeoutMs`.
   */
  async stop(timeoutMs = 30_000): Promise<void> {
    const worker = this.#worker;
    if (!worker || (this.#status.state !== 'ready' && this.#status.state !== 'starting')) {
      return;
    }
    this.#setStatus({ state: 'stopping', generation: this.#generation, failure: null });
    const exited = this.#exited;
    const ack = this.#request({ kind: 'shutdown' }, shutdownAckSchema, {
      allowWhileStopping: true,
      slow: true,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });
    const outcome = await Promise.race([exited.then(() => 'exited' as const), deadline]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.#logger.log('warn', 'Simulation worker did not stop in time; terminating', {
        timeoutMs,
      });
      await worker.terminate();
      await exited;
    }
    const acknowledged = await ack;
    if (!acknowledged.ok) {
      this.#logger.log('warn', 'Simulation worker stopped without acknowledging shutdown', {
        code: acknowledged.error.code,
      });
    }
  }

  #spawn(): void {
    this.#generation += 1;
    const generation = this.#generation;
    const options: WorkerOptions = {
      generation,
      faultInjectionEnabled: this.#faultInjectionEnabled,
      seed: this.#seed,
      dataDirectory: this.#dataDirectory,
      appVersion: this.#appVersion,
      autosaveIntervalMs: this.#autosaveIntervalMs,
    };
    this.#exited = new Promise((resolve) => {
      this.#markExited = resolve;
    });
    this.#setStatus({ state: 'starting', generation, failure: null });
    let worker: WorkerHandle;
    try {
      worker = this.#createWorker(options);
    } catch (error) {
      this.#markExited();
      this.#fail(generation, `Could not start the simulation worker: ${messageOf(error)}`, error);
      return;
    }
    this.#worker = worker;
    const current = () => generation === this.#generation;

    worker.on('message', (raw) => {
      if (current()) {
        this.#onMessage(raw);
      }
    });
    worker.on('messageerror', (error) => {
      if (current()) {
        this.#logger.log('error', 'Undeserializable message from worker', describeError(error));
      }
    });
    worker.on('error', (error) => {
      if (current()) {
        this.#fail(generation, `Uncaught error in simulation worker: ${error.message}`, error);
      }
    });
    worker.on('exit', (exitCode) => {
      if (!current()) {
        return;
      }
      this.#worker = null;
      this.#markExited();
      if (this.#status.state === 'stopping') {
        this.#rejectAllPending();
        this.#setStatus({ state: 'stopped', generation, failure: null });
        this.#logger.log('info', 'Simulation worker stopped', { generation, exitCode });
      } else if (this.#status.state !== 'failed') {
        this.#fail(generation, `Simulation worker exited unexpectedly (exit code ${exitCode})`);
      }
    });
  }

  #onMessage(raw: unknown): void {
    const parsed = workerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.#logger.log('error', 'Discarded invalid message from worker', {
        issue: describeZodError(parsed.error),
      });
      return;
    }
    const message = parsed.data;
    switch (message.kind) {
      case 'ready':
        if (this.#status.state === 'starting') {
          this.#setStatus({ state: 'ready', generation: this.#generation, failure: null });
        }
        return;
      case 'log':
        this.#logger.log(message.level, message.message, message.fields, 'worker');
        return;
      case 'worldRevised':
        this.#onEvent({
          type: 'world.revised',
          worldInstanceId: message.worldInstanceId,
          worldRevision: message.worldRevision,
        });
        return;
      case 'worldClock':
        this.#onEvent({
          type: 'world.clock',
          worldInstanceId: message.worldInstanceId,
          nowMs: message.nowMs,
        });
        return;
      case 'savesChanged':
        this.#onEvent({ type: 'saves.changed' });
        return;
      case 'response': {
        const pending = this.#pending.get(message.requestId);
        if (!pending) {
          this.#logger.log('warn', 'Response for unknown or timed-out request', {
            requestId: message.requestId,
          });
          return;
        }
        this.#pending.delete(message.requestId);
        clearTimeout(pending.timer);
        const checked = ipcResultSchema(pending.schema).safeParse(message.result);
        if (checked.success) {
          pending.resolve(checked.data as IpcResult<unknown>);
        } else {
          this.#logger.log('error', 'Worker response failed validation', {
            requestKind: pending.kind,
            issue: describeZodError(checked.error),
          });
          pending.resolve(
            ipcFail('INTERNAL_ERROR', 'The simulation worker sent an invalid response'),
          );
        }
        return;
      }
      default: {
        const unreachable: never = message;
        this.#logger.log('error', 'Unhandled worker message', { kind: String(unreachable) });
      }
    }
  }

  #request<T>(
    request: DistributiveOmit<WorkerRequest, 'requestId'>,
    schema: z.ZodType<T>,
    options: { readonly allowWhileStopping?: boolean; readonly slow?: boolean } = {},
  ): Promise<IpcResult<T>> {
    const { state } = this.#status;
    const worker = this.#worker;
    const timeoutMs = options.slow === true ? this.#persistenceTimeoutMs : this.#timeoutMs;
    const accepting =
      state === 'ready' ||
      state === 'starting' ||
      (options.allowWhileStopping === true && state === 'stopping');
    if (!worker || !accepting) {
      return Promise.resolve(ipcFail('WORKER_UNAVAILABLE', `The simulation worker is ${state}`));
    }
    const requestId = this.#nextRequestId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        this.#logger.log('warn', 'Simulation worker request timed out', {
          requestId,
          kind: request.kind,
          timeoutMs,
        });
        resolve(
          ipcFail(
            'WORKER_TIMEOUT',
            'The simulation worker did not answer in time. The outcome is unknown; resubmitting ' +
              'the same command ID is safe and returns the original result if it was applied.',
          ),
        );
      }, timeoutMs);
      this.#pending.set(requestId, {
        kind: request.kind,
        resolve: resolve as (result: IpcResult<unknown>) => void,
        schema,
        timer,
      });
      try {
        worker.postMessage({ ...request, requestId });
      } catch (error) {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        this.#logger.log('error', 'Could not post to simulation worker', describeError(error));
        resolve(
          ipcFail(
            'INTERNAL_ERROR',
            `Could not send the request to the worker: ${messageOf(error)}`,
          ),
        );
      }
    });
  }

  #fail(generation: number, message: string, cause?: unknown): void {
    if (this.#status.state === 'failed') {
      return;
    }
    this.#logger.log('error', message, {
      generation,
      pendingRequests: this.#pending.size,
      ...(cause === undefined ? {} : describeError(cause)),
    });
    this.#rejectAllPending();
    this.#setStatus({
      state: 'failed',
      generation,
      failure: { message, occurredAt: this.#now().toISOString() },
    });
    const worker = this.#worker;
    this.#worker = null;
    if (worker) {
      // The thread is usually gone already; make sure it is.
      worker.terminate().catch((error: unknown) => {
        this.#logger.log('warn', 'Could not terminate failed worker', describeError(error));
      });
    }
  }

  #rejectAllPending(): void {
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#logger.log('warn', 'Request lost with simulation worker', {
        requestId,
        kind: pending.kind,
      });
      pending.resolve(ipcFail('WORKER_UNAVAILABLE', UNANSWERED));
    }
    this.#pending.clear();
  }

  #setStatus(status: WorkerStatus): void {
    this.#status = status;
    this.#onEvent({ type: 'worker.status', worker: status });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
