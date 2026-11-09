import type { ClockControl } from './ipc/clock';
import type { QueryResult, SimulationQuery } from './ipc/facilities';
import type { NewWorldRequest } from './ipc/real-estate';
import type {
  ExportResult,
  ImportResult,
  SaveRequest,
  SaveSummary,
  WorkspaceSettingsView,
  WorkspaceUpdate,
} from './ipc/saves';
import type {
  CommandEnvelope,
  CommandReceipt,
  HostEvent,
  HostSnapshot,
  IpcResult,
} from './ipc/contract';

/**
 * The simulation API the preload exposes (spec §11.2). Every call goes
 * through one validated IPC channel to Electron main and, for world state,
 * on to the simulation worker. Results are plain data; failures are typed
 * `IpcResult` errors, never thrown exceptions.
 */
export interface SimulationBridge {
  getSnapshot(): Promise<IpcResult<HostSnapshot>>;
  submitCommand(envelope: CommandEnvelope): Promise<IpcResult<CommandReceipt>>;
  /**
   * Ask the worker a read-only question about the current world (whether a
   * placement would be allowed, and why not). Changes nothing (ADR-0050).
   */
  query(query: SimulationQuery): Promise<IpcResult<QueryResult>>;
  /**
   * Pause, run at a speed, or make a targeted advance (step, end of day,
   * end of week, next event). Changes pacing only, never the world.
   */
  control(control: ClockControl): Promise<IpcResult<HostSnapshot>>;
  /**
   * Replace the world with a new one from a scenario (New Company, Quick
   * Start, Scenarios). A changed world is autosaved first.
   */
  newWorld(request: NewWorldRequest): Promise<IpcResult<HostSnapshot>>;
  /** Start a new worker after a failure. Refused while a worker is running. */
  restartWorker(): Promise<IpcResult<HostSnapshot>>;
  /** Receive host events; returns an unsubscribe function. */
  subscribe(listener: (event: HostEvent) => void): () => void;
}

/**
 * Save slots (spec §11.2, ADR-0028). The renderer names saves by ID; file
 * paths for export and import are chosen in native dialogs owned by Electron
 * main and never reach the renderer.
 */
export interface SavesBridge {
  list(): Promise<IpcResult<SaveSummary[]>>;
  /** Save the current world as a new save, or over one of the player's own saves. */
  save(request: SaveRequest): Promise<IpcResult<SaveSummary>>;
  /** Replace the current world with a save (a new world instance, paused). */
  load(saveId: string): Promise<IpcResult<HostSnapshot>>;
  /** Copy a save to a file the player picks. */
  exportSave(saveId: string): Promise<IpcResult<ExportResult>>;
  /** Add a save from a file the player picks. */
  importSave(): Promise<IpcResult<ImportResult>>;
}

/** Per-save presentation settings (window layout from Step 06); not world state. */
export interface WorkspaceBridge {
  get(): Promise<IpcResult<WorkspaceSettingsView>>;
  set(update: WorkspaceUpdate): Promise<IpcResult<WorkspaceSettingsView>>;
}

/** Shape of the frozen API on `window.freeIndustry`. */
export interface FreeIndustryBridge {
  readonly protocolVersion: number;
  readonly runtime: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
    /**
     * Whether the factory scene exposes its read-only measurement probe
     * (`FREEINDUSTRY_SCENE_PROBE=1`, unpackaged runs only; ADR-0051).
     */
    readonly sceneProbe?: boolean;
  };
  readonly simulation: SimulationBridge;
  readonly saves: SavesBridge;
  readonly workspace: WorkspaceBridge;
}
