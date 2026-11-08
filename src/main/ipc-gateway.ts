import type { ClockControl } from '../shared/ipc/clock';
import type { NewWorldRequest } from '../shared/ipc/real-estate';
import type {
  ExportResult,
  ImportResult,
  SaveRequest,
  SaveSummary,
  WorkspaceSettingsView,
  WorkspaceUpdate,
} from '../shared/ipc/saves';
import { COMMANDS, isCommandType } from '../shared/ipc/commands';
import { IPC_PROTOCOL_VERSION } from '../shared/ipc/channels';
import {
  describeZodError,
  ipcFail,
  ipcOk,
  rendererRequestSchema,
  type CommandEnvelope,
  type CommandReceipt,
  type HostSnapshot,
  type IpcResult,
  type RendererRequest,
  type WorkerStatus,
  type WorldSnapshot,
} from '../shared/ipc/contract';
import { describeError, type Logger } from './logger';

/**
 * Electron main's renderer-facing IPC gate (spec §4.3, ADR-0013). It runs
 * before anything reaches the worker:
 *
 *  1. sender is the app's own top-level renderer      → else UNAUTHORIZED
 *  2. protocol version matches                         → else UNSUPPORTED_PROTOCOL
 *  3. request shape (Zod, strict)                      → else MALFORMED_REQUEST
 *  4. in-flight limit                                  → else BUSY
 *  5. command type, permission, payload (early check)  → UNKNOWN_COMMAND / UNAUTHORIZED / INVALID_PAYLOAD
 *
 * The worker repeats step 5 and alone decides revision and idempotency.
 * `handle` never throws: every outcome is an `IpcResult`.
 *
 * Saves (ADR-0028): at most one save, load, export, import or new world runs
 * at a time (else BUSY). Export and import paths come from main's own file dialogs and
 * go straight to the worker; the renderer only ever names a save ID.
 */

/** The supervisor operations the gateway needs. */
export interface WorkerPort {
  readonly status: WorkerStatus;
  getWorldSnapshot(): Promise<IpcResult<WorldSnapshot>>;
  submitCommand(envelope: CommandEnvelope): Promise<IpcResult<CommandReceipt>>;
  control(control: ClockControl): Promise<IpcResult<WorldSnapshot>>;
  restart(): IpcResult<WorkerStatus>;
  newWorld(request: NewWorldRequest): Promise<IpcResult<WorldSnapshot>>;
  listSaves(): Promise<IpcResult<SaveSummary[]>>;
  saveWorld(request: SaveRequest): Promise<IpcResult<SaveSummary>>;
  loadSave(saveId: string): Promise<IpcResult<WorldSnapshot>>;
  exportSave(saveId: string, destinationPath: string): Promise<IpcResult<{ exported: true }>>;
  importSave(sourcePath: string): Promise<IpcResult<SaveSummary>>;
  getWorkspace(): Promise<IpcResult<WorkspaceSettingsView>>;
  setWorkspace(update: WorkspaceUpdate): Promise<IpcResult<WorkspaceSettingsView>>;
}

/** Native file dialogs, owned by Electron main. Null means the player cancelled. */
export interface DialogPort {
  chooseExportPath(suggestedFileName: string): Promise<string | null>;
  chooseImportPath(): Promise<string | null>;
}

export interface RequestSender {
  /** URL of the frame that sent the request, if it still exists. */
  readonly frameUrl: string | undefined;
  /** True when the sender is the top-level frame of the app's main window. */
  readonly isAppMainFrame: boolean;
}

export interface IpcGatewayOptions {
  readonly worker: WorkerPort;
  readonly dialogs: DialogPort;
  readonly isTrustedUrl: (url: string) => boolean;
  readonly faultInjectionEnabled: boolean;
  readonly logger: Logger;
  readonly maxInFlight?: number;
}

export class IpcGateway {
  readonly #worker: WorkerPort;
  readonly #dialogs: DialogPort;
  readonly #isTrustedUrl: (url: string) => boolean;
  readonly #faultInjectionEnabled: boolean;
  readonly #logger: Logger;
  readonly #maxInFlight: number;
  #inFlight = 0;
  #persistenceBusy = false;

  constructor(options: IpcGatewayOptions) {
    this.#worker = options.worker;
    this.#dialogs = options.dialogs;
    this.#isTrustedUrl = options.isTrustedUrl;
    this.#faultInjectionEnabled = options.faultInjectionEnabled;
    this.#logger = options.logger;
    this.#maxInFlight = options.maxInFlight ?? 32;
  }

  async handle(sender: RequestSender, raw: unknown): Promise<IpcResult<unknown>> {
    try {
      const refusal = this.#screen(sender, raw);
      if (refusal) {
        this.#logger.log('warn', 'Renderer request refused', {
          code: refusal.error.code,
          reason: refusal.error.message,
        });
        return refusal;
      }
      if (this.#inFlight >= this.#maxInFlight) {
        return ipcFail(
          'BUSY',
          `Too many requests in flight (limit ${this.#maxInFlight}); nothing was done`,
        );
      }
      const request = rendererRequestSchema.parse(raw);
      const persistence = PERSISTENCE_METHODS.has(request.method);
      if (persistence && this.#persistenceBusy) {
        return ipcFail(
          'BUSY',
          'Another save, load, export or import is in progress; nothing was done',
        );
      }
      this.#inFlight += 1;
      this.#persistenceBusy ||= persistence;
      try {
        return await this.#dispatch(request);
      } finally {
        this.#inFlight -= 1;
        if (persistence) {
          this.#persistenceBusy = false;
        }
      }
    } catch (error) {
      this.#logger.log('error', 'Unexpected error handling renderer request', describeError(error));
      return ipcFail('INTERNAL_ERROR', 'Unexpected error in the IPC gateway; nothing was changed');
    }
  }

  /** Steps 1–3 and 5: everything decidable without the worker. */
  #screen(sender: RequestSender, raw: unknown): ReturnType<typeof ipcFail> | null {
    if (
      !sender.isAppMainFrame ||
      sender.frameUrl === undefined ||
      !this.#isTrustedUrl(sender.frameUrl)
    ) {
      return ipcFail('UNAUTHORIZED', 'Request did not come from the FreeIndustry renderer');
    }
    if (typeof raw !== 'object' || raw === null) {
      return ipcFail('MALFORMED_REQUEST', 'Request must be an object');
    }
    const version = (raw as { protocolVersion?: unknown }).protocolVersion;
    if (version !== IPC_PROTOCOL_VERSION) {
      return ipcFail(
        'UNSUPPORTED_PROTOCOL',
        `Expected IPC protocol version ${IPC_PROTOCOL_VERSION}`,
        {
          received: typeof version === 'number' ? version : null,
        },
      );
    }
    const parsed = rendererRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return ipcFail('MALFORMED_REQUEST', `Malformed request: ${describeZodError(parsed.error)}`);
    }
    if (parsed.data.method !== 'simulation.submitCommand') {
      return null;
    }
    const { type, payload } = parsed.data.envelope;
    if (!isCommandType(type)) {
      return ipcFail('UNKNOWN_COMMAND', `Unknown command type "${type}"`);
    }
    const definition = COMMANDS[type];
    if (definition.permission === 'fault-injection' && !this.#faultInjectionEnabled) {
      return ipcFail('UNAUTHORIZED', `Command "${type}" requires fault injection to be enabled`);
    }
    const checked = definition.payload.safeParse(payload);
    if (!checked.success) {
      return ipcFail(
        'INVALID_PAYLOAD',
        `Invalid payload for "${type}": ${describeZodError(checked.error)}`,
      );
    }
    return null;
  }

  async #dispatch(request: RendererRequest): Promise<IpcResult<unknown>> {
    switch (request.method) {
      case 'simulation.getSnapshot':
        return this.#snapshot();
      case 'simulation.submitCommand':
        return this.#worker.submitCommand(request.envelope);
      case 'simulation.control': {
        const world = await this.#worker.control(request.control);
        return world.ok ? ipcOk({ worker: this.#worker.status, world: world.value }) : world;
      }
      case 'simulation.newWorld': {
        const world = await this.#worker.newWorld(request.world);
        return world.ok ? ipcOk({ worker: this.#worker.status, world: world.value }) : world;
      }
      case 'simulation.restartWorker': {
        const restarted = this.#worker.restart();
        return restarted.ok ? this.#snapshot() : restarted;
      }
      case 'saves.list':
        return this.#worker.listSaves();
      case 'saves.save':
        return this.#worker.saveWorld(request.request);
      case 'saves.load': {
        const world = await this.#worker.loadSave(request.saveId);
        return world.ok ? ipcOk({ worker: this.#worker.status, world: world.value }) : world;
      }
      case 'saves.export':
        return this.#export(request.saveId);
      case 'saves.import':
        return this.#import();
      case 'workspace.get':
        return this.#worker.getWorkspace();
      case 'workspace.set':
        return this.#worker.setWorkspace(request.update);
      default: {
        const unreachable: never = request;
        return ipcFail('MALFORMED_REQUEST', `Unknown method ${String(unreachable)}`);
      }
    }
  }

  async #export(saveId: string): Promise<IpcResult<ExportResult>> {
    const saves = await this.#worker.listSaves();
    if (!saves.ok) {
      return saves;
    }
    const save = saves.value.find((item) => item.saveId === saveId);
    if (!save) {
      return ipcFail('SAVE_NOT_FOUND', 'That save no longer exists.');
    }
    const destination = await this.#dialogs.chooseExportPath(exportFileName(save.name));
    if (destination === null) {
      return ipcOk({ status: 'cancelled' });
    }
    const exported = await this.#worker.exportSave(saveId, destination);
    return exported.ok ? ipcOk({ status: 'exported' }) : exported;
  }

  async #import(): Promise<IpcResult<ImportResult>> {
    const source = await this.#dialogs.chooseImportPath();
    if (source === null) {
      return ipcOk({ status: 'cancelled' });
    }
    const imported = await this.#worker.importSave(source);
    return imported.ok ? ipcOk({ status: 'imported', save: imported.value }) : imported;
  }

  async #snapshot(): Promise<IpcResult<HostSnapshot>> {
    if (this.#worker.status.state !== 'ready') {
      return ipcOk({ worker: this.#worker.status, world: null });
    }
    const world = await this.#worker.getWorldSnapshot();
    if (world.ok) {
      return ipcOk({ worker: this.#worker.status, world: world.value });
    }
    if (world.error.code === 'WORKER_UNAVAILABLE') {
      return ipcOk({ worker: this.#worker.status, world: null });
    }
    return world;
  }
}

const PERSISTENCE_METHODS: ReadonlySet<RendererRequest['method']> = new Set([
  // A new world may autosave the one it replaces.
  'simulation.newWorld',
  'saves.save',
  'saves.load',
  'saves.export',
  'saves.import',
]);

/** A Windows-safe file name for exporting a save called `name`. */
export function exportFileName(name: string | null): string {
  const stem = (name ?? '')
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '_')
    .replace(/[. ]+$/u, '')
    .trim();
  const safe = /^(?:con|prn|aux|nul|com\d|lpt\d)$/iu.test(stem) ? `${stem}_` : stem;
  return `${safe.length > 0 ? safe : 'FreeIndustry save'}.fisave`;
}
