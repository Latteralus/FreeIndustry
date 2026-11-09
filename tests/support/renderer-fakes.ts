import type { QueryResult, SimulationQuery } from '../../src/shared/ipc/facilities';
import type { SavesBridge, SimulationBridge, WorkspaceBridge } from '../../src/shared/bridge';
import type { ClockControl } from '../../src/shared/ipc/clock';
import type { NewWorldRequest } from '../../src/shared/ipc/real-estate';
import type {
  CommandEnvelope,
  HostEvent,
  HostSnapshot,
  IpcResult,
} from '../../src/shared/ipc/contract';
import type {
  ExportResult,
  ImportResult,
  SaveRequest,
  SaveSummary,
  WorkspaceSettingsView,
  WorkspaceUpdate,
} from '../../src/shared/ipc/saves';
import { sampleWorldSnapshot } from './world-snapshot';

/** A deep copy of JSON data (jsdom has no structuredClone). */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * In-memory stand-ins for the preload bridge, for renderer tests. Each
 * records what the UI asked for, so tests can prove what was (and was not)
 * sent to the worker.
 */

export const WORLD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
export const OTHER_WORLD = '7a2e3d4c-5b6f-4071-9b8c-0d1e2f3a4b5c';
export const COMMAND = '0b9f1c2e-7a4d-4e5f-9a6b-1c2d3e4f5a6b';

export class FakeSimulation implements SimulationBridge {
  snapshot: HostSnapshot = {
    worker: { state: 'ready', generation: 1, failure: null },
    world: sampleWorldSnapshot(WORLD),
  };
  readonly submitted: CommandEnvelope[] = [];
  readonly controls: ClockControl[] = [];
  readonly listeners = new Set<(event: HostEvent) => void>();
  nextSubmit: IpcResult<never> | null = null;
  restarts = 0;
  readonly queries: SimulationQuery[] = [];
  /** How placement queries are answered; allowed with no problems by default. */
  answer: (query: SimulationQuery) => QueryResult = (query) => ({
    kind: 'placement',
    allowed: true,
    refusal: null,
    problems: [],
    footprint: { x: query.xMm, y: query.yMm, width: 1000, depth: 1000 },
    zones: [],
    chargeCents: '0',
  });

  query(query: SimulationQuery): Promise<IpcResult<QueryResult>> {
    this.queries.push(query);
    return Promise.resolve({ ok: true, value: this.answer(query) });
  }

  getSnapshot(): Promise<IpcResult<HostSnapshot>> {
    return Promise.resolve({ ok: true, value: this.snapshot });
  }
  submitCommand(envelope: CommandEnvelope) {
    this.submitted.push(envelope);
    if (this.nextSubmit) {
      return Promise.resolve(this.nextSubmit);
    }
    const world = this.snapshot.world;
    if (!world) {
      throw new Error('no world');
    }
    const label = (envelope.payload as { label?: string }).label ?? null;
    this.snapshot = {
      ...this.snapshot,
      world: {
        ...world,
        worldRevision: world.worldRevision + 1,
        diagnostics: {
          ...world.diagnostics,
          probeCount: world.diagnostics.probeCount + 1,
          lastProbeLabel: label,
        },
      },
    };
    return Promise.resolve({
      ok: true as const,
      value: {
        commandId: envelope.commandId,
        worldInstanceId: world.worldInstanceId,
        worldRevision: world.worldRevision + 1,
        atMs: world.clock.nowMs,
        duplicate: false,
      },
    });
  }
  control(control: ClockControl): Promise<IpcResult<HostSnapshot>> {
    this.controls.push(control);
    const world = this.snapshot.world;
    if (world) {
      const clock =
        control.action === 'setSpeed'
          ? { ...world.clock, speed: control.speed, advance: null }
          : {
              ...world.clock,
              speed: 'paused' as const,
              advance: { until: control.until, targetMs: '86400000' },
            };
      this.snapshot = { ...this.snapshot, world: { ...world, clock } };
    }
    return Promise.resolve({ ok: true, value: this.snapshot });
  }
  readonly newWorlds: NewWorldRequest[] = [];
  /** The world a new-world request produces (a fresh instance at revision 0). */
  nextWorld: (request: NewWorldRequest) => HostSnapshot = () => ({
    worker: { state: 'ready', generation: 1, failure: null },
    world: sampleWorldSnapshot(OTHER_WORLD),
  });
  newWorld(request: NewWorldRequest): Promise<IpcResult<HostSnapshot>> {
    this.newWorlds.push(request);
    this.snapshot = this.nextWorld(request);
    return Promise.resolve({ ok: true, value: this.snapshot });
  }
  restartWorker(): Promise<IpcResult<HostSnapshot>> {
    this.restarts += 1;
    this.snapshot = {
      worker: { state: 'ready', generation: 2, failure: null },
      world: sampleWorldSnapshot(OTHER_WORLD),
    };
    return Promise.resolve({ ok: true, value: this.snapshot });
  }
  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: HostEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export function saveSummary(overrides: Partial<SaveSummary> = {}): SaveSummary {
  return {
    saveId: 'save-1',
    status: 'ready',
    problem: null,
    name: 'Shop',
    kind: 'manual',
    savedAt: '2026-11-07T12:00:00.000Z',
    world: {
      worldId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      seed: 42,
      nowMs: '600000',
      calendar: { year: 1996, month: 1, day: 1, weekday: 1, hour: 0, minute: 10, second: 0 },
      worldRevision: 4,
    },
    current: false,
    ...overrides,
  };
}

/** Records save requests; `log` interleaves them with workspace writes when shared. */
export class FakeSaves implements SavesBridge {
  saves: SaveSummary[] = [];
  readonly requests: (SaveRequest | string)[] = [];
  lists = 0;
  nextExport: IpcResult<ExportResult> = { ok: true, value: { status: 'exported' } };
  nextImport: IpcResult<ImportResult> = { ok: true, value: { status: 'cancelled' } };
  nextLoad: IpcResult<never> | null = null;
  nextSave: IpcResult<never> | null = null;

  constructor(readonly log: string[] = []) {}

  list(): Promise<IpcResult<SaveSummary[]>> {
    this.lists += 1;
    return Promise.resolve({ ok: true, value: this.saves });
  }
  save(request: SaveRequest): Promise<IpcResult<SaveSummary>> {
    this.requests.push(request);
    this.log.push(`save ${request.name}`);
    if (this.nextSave) {
      return Promise.resolve(this.nextSave);
    }
    const saved = saveSummary({
      saveId: request.saveId ?? `save-${this.saves.length + 2}`,
      name: request.name,
    });
    this.saves = [saved, ...this.saves.filter((item) => item.saveId !== saved.saveId)];
    return Promise.resolve({ ok: true, value: saved });
  }
  load(saveId: string) {
    this.requests.push(`load ${saveId}`);
    this.log.push(`load ${saveId}`);
    return Promise.resolve(
      this.nextLoad ?? {
        ok: true as const,
        value: {
          worker: { state: 'ready' as const, generation: 1, failure: null },
          world: sampleWorldSnapshot(WORLD),
        },
      },
    );
  }
  exportSave(saveId: string): Promise<IpcResult<ExportResult>> {
    this.requests.push(`export ${saveId}`);
    return Promise.resolve(this.nextExport);
  }
  importSave(): Promise<IpcResult<ImportResult>> {
    this.requests.push('import');
    return Promise.resolve(this.nextImport);
  }
}

/** The worker's per-world workspace settings, keyed by world instance. */
export class FakeWorkspace implements WorkspaceBridge {
  settings: Record<string, unknown> = {};
  readonly writes: WorkspaceUpdate[] = [];
  gets = 0;

  constructor(readonly log: string[] = []) {}

  get(): Promise<IpcResult<WorkspaceSettingsView>> {
    this.gets += 1;
    return Promise.resolve({
      ok: true,
      value: { settings: copy(this.settings) as WorkspaceSettingsView['settings'] },
    });
  }
  set(update: WorkspaceUpdate): Promise<IpcResult<WorkspaceSettingsView>> {
    this.writes.push(copy(update));
    this.log.push(`workspace ${update.key}`);
    this.settings = Object.fromEntries([
      ...Object.entries(this.settings).filter(([key]) => key !== update.key),
      ...(update.value === null ? [] : [[update.key, copy(update.value)]]),
    ]) as Record<string, unknown>;
    return Promise.resolve({
      ok: true,
      value: { settings: copy(this.settings) as WorkspaceSettingsView['settings'] },
    });
  }
}
