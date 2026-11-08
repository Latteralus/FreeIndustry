import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import {
  describeZodError,
  ipcFail,
  ipcOk,
  type IpcResult,
  type SessionView,
} from '../shared/ipc/contract';
import {
  workerOptionsSchema,
  workerRequestSchema,
  type LogFields,
  type LogLevel,
  type WorkerMessage,
} from '../shared/ipc/worker-protocol';
import { FREEINDUSTRY_RULES } from '../simulation/freeindustry-rules';
import { KERNEL_FORMAT_VERSION } from '../simulation/kernel';
import { RNG_ALGORITHM } from '../simulation/rng';
import { SaveStore } from '../persistence/save-store';
import { baseContent } from '../catalog/base-content';
import { CommandHost } from './command-host';
import { SaveCoordinator, saveFailure } from './save-coordinator';
import { DEFAULT_SCENARIO_ID, scenarioSummaries, worldSetupFor } from './world-setup';

/**
 * Simulation worker thread entry (spec §4.2, ADR-0012). It owns the
 * authoritative world state — the simulation kernel — and the only SQLite
 * connections (save slots and the session recovery log, ADR-0026 – ADR-0028).
 * It talks to Electron main only through validated messages and never
 * touches Electron, the renderer or the network.
 *
 * A fixed-interval timer drives the wall-clock pacer (ADR-0023). It runs
 * independently of the renderer, so frame rate, window visibility and React
 * renders cannot influence simulated outcomes. Every request is handled
 * synchronously, so a save or load can never interleave with a command or a
 * clock tick.
 */

/** Pacing timer interval (wall ms). */
const TICK_INTERVAL_MS = 50;
/** Minimum wall time between clock notifications while time is running. */
const CLOCK_EVENT_INTERVAL_MS = 200;

if (!parentPort) {
  throw new Error('The simulation worker must be started as a worker thread');
}
const port = parentPort;
const options = workerOptionsSchema.parse(workerData);

function post(message: WorkerMessage): void {
  port.postMessage(message);
}

function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  post({ kind: 'log', level, message, fields });
}

const store = new SaveStore({
  directory: join(options.dataDirectory, 'saves'),
  appVersion: options.appVersion,
  runtime: {
    kernelFormat: KERNEL_FORMAT_VERSION,
    rulesId: FREEINDUSTRY_RULES.id,
    rulesVersion: FREEINDUSTRY_RULES.version,
    rngAlgorithm: RNG_ALGORITHM,
    contentVersion: null,
  },
  now: () => new Date(),
  uniqueToken: () => randomUUID(),
});

// The bundled content is validated once; an invalid build fails here, loudly.
const content = baseContent();
const firstWorld = worldSetupFor(content, DEFAULT_SCENARIO_ID);
if (!firstWorld) {
  throw new Error(`The content has no "${DEFAULT_SCENARIO_ID}" scenario`);
}
/** A new world's seed: the test override if any, otherwise chosen at random. */
const newSeed = () => options.seed ?? randomInt(0, 0x1_0000_0000);

/** Bound to the SaveCoordinator once it exists; the host reads it lazily for snapshots. */
const session: { view: () => SessionView | null } = { view: () => null };

const host = new CommandHost({
  worldInstanceId: randomUUID(),
  // The seed is chosen once, when the world is created, and kept with it.
  seed: newSeed(),
  epoch: firstWorld.epoch,
  setup: firstWorld.setup,
  scenarios: scenarioSummaries(content),
  faultInjectionEnabled: options.faultInjectionEnabled,
  pacer: { wallNow: () => performance.now() },
  session: () => session.view(),
  onThreadFault: (fault) => {
    log('warn', 'Injected worker fault', { fault });
    if (fault === 'thread-exit') {
      process.exit(70); // In a worker thread this ends the thread, not the app.
    }
    setImmediate(() => {
      throw new Error('Injected uncaught worker exception');
    });
  },
});

const saves = new SaveCoordinator({
  host,
  store,
  recoveryPath: join(options.dataDirectory, 'recovery', 'session.fisave'),
  appVersion: options.appVersion,
  wallClock: () => new Date(),
  newId: () => randomUUID(),
  autosaveIntervalMs: options.autosaveIntervalMs,
  log,
});
session.view = () => saves.sessionView();
saves.start(performance.now());

let lastClockEvent = Number.NEGATIVE_INFINITY;
let faultLogged = false;

function postClock(): void {
  lastClockEvent = performance.now();
  post({
    kind: 'worldClock',
    worldInstanceId: host.worldInstanceId,
    nowMs: host.snapshot().clock.nowMs,
  });
}

const pacingTimer = setInterval(() => {
  const outcome = host.tick();
  if (saves.tick(performance.now()).savesChanged) {
    post({ kind: 'savesChanged' });
  }
  if (outcome === 'idle') {
    return;
  }
  const fault = host.fault;
  if (fault && !faultLogged) {
    faultLogged = true;
    log('error', 'Simulation stopped after an event handler failed', { fault });
  }
  if (outcome === 'stopped' || performance.now() - lastClockEvent >= CLOCK_EVENT_INTERVAL_MS) {
    postClock();
  }
}, TICK_INTERVAL_MS);

/** Run a persistence operation, turning failures into typed IPC errors. */
function persistence<T>(operation: string, body: () => T): IpcResult<T> {
  try {
    return ipcOk(body());
  } catch (error) {
    const failure = saveFailure(error);
    log('warn', `${operation} failed`, { code: failure.code, reason: failure.message });
    return { ok: false, error: failure };
  }
}

port.on('message', (raw: unknown) => {
  const parsed = workerRequestSchema.safeParse(raw);
  if (!parsed.success) {
    log('error', 'Discarded malformed message from main', {
      issue: describeZodError(parsed.error),
    });
    return;
  }
  const request = parsed.data;
  const respond = (result: IpcResult<unknown>) => {
    post({ kind: 'response', requestId: request.requestId, result });
  };
  switch (request.kind) {
    case 'getSnapshot':
      respond(ipcOk(host.snapshot()));
      return;
    case 'submitCommand': {
      const { result, revised } = host.submit(request.envelope);
      if (revised && result.ok) {
        // Write-ahead: the command is in the recovery log before its receipt leaves.
        saves.afterCommand(result.value.commandId);
      }
      respond(result);
      if (result.ok) {
        log('info', revised ? 'Command accepted' : 'Duplicate command answered from receipt', {
          commandId: result.value.commandId,
          type: request.envelope.type,
          worldRevision: result.value.worldRevision,
        });
      } else {
        log('warn', 'Command rejected', {
          commandId: request.envelope.commandId,
          type: request.envelope.type,
          code: result.error.code,
          reason: result.error.message,
        });
      }
      if (revised && result.ok) {
        post({
          kind: 'worldRevised',
          worldInstanceId: host.worldInstanceId,
          worldRevision: result.value.worldRevision,
        });
      }
      return;
    }
    case 'control': {
      const { control } = request;
      const result = host.control(control);
      respond(result);
      log('info', 'Clock control', {
        action: control.action,
        setting: control.action === 'setSpeed' ? control.speed : control.until,
        nowMs: result.ok ? result.value.clock.nowMs : null,
      });
      return;
    }
    case 'listSaves':
      respond(persistence('Listing saves', () => saves.list()));
      return;
    case 'saveWorld': {
      const result = persistence('Save', () => saves.save(request.request));
      respond(result);
      if (result.ok) {
        post({ kind: 'savesChanged' });
      }
      return;
    }
    case 'loadSave': {
      const result = persistence('Load', () => {
        saves.load(request.saveId);
        return host.snapshot();
      });
      respond(result);
      if (result.ok) {
        post({
          kind: 'worldRevised',
          worldInstanceId: host.worldInstanceId,
          worldRevision: result.value.worldRevision,
        });
        post({ kind: 'savesChanged' });
      }
      return;
    }
    case 'exportSave':
      respond(
        persistence('Export', () => {
          saves.exportSave(request.saveId, request.destinationPath);
          return { exported: true as const };
        }),
      );
      return;
    case 'importSave': {
      const result = persistence('Import', () => saves.importSave(request.sourcePath));
      respond(result);
      if (result.ok) {
        post({ kind: 'savesChanged' });
      }
      return;
    }
    case 'newWorld': {
      const setup = worldSetupFor(content, request.world.scenarioId);
      if (!setup) {
        respond(ipcFail('INVALID_PAYLOAD', `There is no scenario "${request.world.scenarioId}"`));
        return;
      }
      const result = persistence('New world', () => {
        saves.newWorld(setup, request.world.seed ?? newSeed());
        return host.snapshot();
      });
      respond(result);
      if (result.ok) {
        post({
          kind: 'worldRevised',
          worldInstanceId: host.worldInstanceId,
          worldRevision: result.value.worldRevision,
        });
        post({ kind: 'savesChanged' });
      }
      return;
    }
    case 'getWorkspace':
      respond(ipcOk({ settings: saves.workspace() }));
      return;
    case 'setWorkspace':
      respond(
        persistence('Workspace update', () => ({
          settings: saves.updateWorkspace(request.update),
        })),
      );
      return;
    case 'shutdown': {
      clearInterval(pacingTimer);
      saves.shutdown();
      const world = host.snapshot();
      log('info', 'Worker shutting down', {
        worldRevision: world.worldRevision,
        nowMs: world.clock.nowMs,
        stateHash: world.fingerprint.stateHash,
      });
      respond(ipcOk({ stopped: true }));
      port.close();
      return;
    }
    default: {
      const unreachable: never = request;
      post({
        kind: 'response',
        requestId: (unreachable as { requestId: number }).requestId,
        result: ipcFail('MALFORMED_REQUEST', 'Unknown worker request'),
      });
    }
  }
});

post({ kind: 'ready', worldInstanceId: host.worldInstanceId });
log('info', 'Simulation worker started', {
  generation: options.generation,
  worldInstanceId: host.worldInstanceId,
  seed: host.snapshot().seed,
  faultInjectionEnabled: options.faultInjectionEnabled,
  saveFormat: store.latestFormat,
  recoveryLog: saves.sessionView().recoveryLog,
});
