import { z } from 'zod';
import { IPC_PROTOCOL_VERSION } from './channels';
import { ADVANCE_STOPS, ADVANCE_TARGETS, clockControlSchema, SIMULATION_SPEEDS } from './clock';
import { companyViewSchema } from './company';
import { calendarSchema, simTimeString } from './primitives';
import { newWorldRequestSchema, realEstateViewSchema, scenarioSummarySchema } from './real-estate';
import { saveIdSchema, saveRequestSchema, workspaceUpdateSchema } from './saves';

/**
 * Renderer ↔ main IPC contract, protocol v1 (DECISIONS ADR-0013).
 *
 * Every request is validated with these schemas in Electron main, and every
 * command envelope is validated again by the simulation worker, which alone
 * decides revisions and idempotency. The renderer never receives database
 * handles, file paths or Node objects — only the plain data defined here.
 */

// ---------------------------------------------------------------- errors

const IPC_ERROR_CODES = [
  /** Request shape is invalid (missing/extra fields, wrong types). */
  'MALFORMED_REQUEST',
  /** `protocolVersion` is not the one this build speaks. */
  'UNSUPPORTED_PROTOCOL',
  /** Sender is not the app's own renderer, or lacks the command's permission. */
  'UNAUTHORIZED',
  /** Command `type` is not in the registry. */
  'UNKNOWN_COMMAND',
  /** Command payload fails its schema. */
  'INVALID_PAYLOAD',
  /** `worldInstanceId` or `expectedWorldRevision` does not match the worker's world. */
  'STALE_REVISION',
  /** A command ID already accepted is resubmitted with different contents. */
  'COMMAND_ID_REUSED',
  /** A valid, current command refused by a business rule. */
  'COMMAND_REJECTED',
  /** Too many requests in flight; nothing was done. */
  'BUSY',
  /** The worker is not running, or stopped before answering. */
  'WORKER_UNAVAILABLE',
  /** The worker did not answer in time; the outcome is unknown (retry with the same command ID). */
  'WORKER_TIMEOUT',
  /** The request is not valid in the host's current state (e.g. restarting a running worker). */
  'INVALID_STATE',
  /** An unexpected error; authoritative state was left unchanged. */
  'INTERNAL_ERROR',
  /** The save named does not exist. */
  'SAVE_NOT_FOUND',
  /** Not a FreeIndustry save, from a newer build, or for other rules/content; nothing was loaded. */
  'SAVE_INCOMPATIBLE',
  /** The save is damaged or failed verification; nothing was loaded and the file is untouched. */
  'SAVE_CORRUPT',
  /** Writing, upgrading or importing failed and was rolled back; existing saves are unchanged. */
  'SAVE_FAILED',
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

const errorDetailValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const ipcErrorSchema = z.strictObject({
  code: z.enum(IPC_ERROR_CODES),
  message: z.string().max(1000),
  details: z.record(z.string().max(64), errorDetailValue).optional(),
});

export type IpcErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface IpcError {
  readonly code: IpcErrorCode;
  readonly message: string;
  readonly details?: IpcErrorDetails;
}

export type IpcResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IpcError };

export function ipcOk<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

export function ipcFail(
  code: IpcErrorCode,
  message: string,
  details?: IpcErrorDetails,
): { readonly ok: false; readonly error: IpcError } {
  return { ok: false, error: details ? { code, message, details } : { code, message } };
}

/** Schema for an `IpcResult` whose success value matches `value`. */
export function ipcResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
  ]);
}

/** One-line summary of a Zod failure, for error messages and logs. */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return 'invalid value';
  }
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

// ---------------------------------------------------------- identifiers

/** Client-generated command identity (RFC 9562 UUID). */
const commandIdSchema = z.uuid();

/**
 * Identity of the world currently loaded in the worker. A new one is minted
 * each time a worker starts and each time a save is loaded, so a command
 * prepared against one world can never apply to another.
 */
export const worldInstanceIdSchema = z.uuid();

/** Count of accepted commands in the loaded world: 0, 1, 2, … */
export const worldRevisionSchema = z.int().min(0);

// -------------------------------------------------------------- commands

/**
 * Envelope around every state-changing command. `type` and `payload` are
 * checked against the command registry (`commands.ts`) in a second stage so
 * that an unknown type and a bad payload get distinct error codes.
 */
export const commandEnvelopeSchema = z.strictObject({
  commandId: commandIdSchema,
  worldInstanceId: worldInstanceIdSchema,
  expectedWorldRevision: worldRevisionSchema,
  type: z.string().min(1).max(64),
  payload: z.unknown(),
});

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** What the worker returns for an accepted command. */
export const commandReceiptSchema = z.strictObject({
  commandId: commandIdSchema,
  worldInstanceId: worldInstanceIdSchema,
  /** World revision after the command was applied. */
  worldRevision: worldRevisionSchema,
  /** Simulation time (ms since the world epoch, decimal string) at which it took effect. */
  atMs: z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/)
    .max(20),
  /** True when this ID was already accepted: the stored receipt is returned and nothing is re-applied. */
  duplicate: z.boolean(),
});

export type CommandReceipt = z.infer<typeof commandReceiptSchema>;

// ------------------------------------------------------- read models

const WORKER_STATES = ['starting', 'ready', 'failed', 'stopping', 'stopped'] as const;

export const workerStatusSchema = z.strictObject({
  state: z.enum(WORKER_STATES),
  /** Increments every time a worker thread is started; 0 before the first start. */
  generation: z.int().min(0),
  failure: z
    .strictObject({
      message: z.string().max(1000),
      /** Wall-clock ISO timestamp of the failure (diagnostic only, never simulation time). */
      occurredAt: z.string().max(64),
    })
    .nullable(),
});

export type WorkerStatus = z.infer<typeof workerStatusSchema>;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The loaded world's save state (ADR-0028). Wall-clock values are
 * informational and never part of any fingerprint.
 */
const sessionViewSchema = z.strictObject({
  /** Stable identity of the world across saves and loads. */
  worldId: z.uuid(),
  /** The save this world was last loaded from or written to, if any. */
  savedAs: z.strictObject({ saveId: saveIdSchema, name: z.string().max(60) }).nullable(),
  /** True when the world differs from what was last saved or loaded. */
  unsavedChanges: z.boolean(),
  /** Crash durability: `active` while every accepted command is logged before its receipt. */
  recoveryLog: z.enum(['active', 'unavailable']),
  /** The latest persistence notice for the player (recovery, autosave failure), if any. */
  notice: z.string().max(1000).nullable(),
});

export type SessionView = z.infer<typeof sessionViewSchema>;

/**
 * World read model sent to the renderer (Steps 03–04). Plain data computed by
 * the worker; the renderer displays it and never derives world state.
 */
export const worldSnapshotSchema = z.strictObject({
  worldInstanceId: worldInstanceIdSchema,
  worldRevision: worldRevisionSchema,
  seed: z.int().min(0).max(0xffff_ffff),
  clock: z.strictObject({
    /** Simulated milliseconds since the world epoch. */
    nowMs: simTimeString,
    calendar: calendarSchema,
    speed: z.enum(SIMULATION_SPEEDS),
    /** A targeted advance in progress, if any. */
    advance: z.strictObject({ until: z.enum(ADVANCE_TARGETS), targetMs: simTimeString }).nullable(),
    lastStop: z
      .strictObject({
        until: z.enum(ADVANCE_TARGETS),
        reason: z.enum(ADVANCE_STOPS),
        atMs: simTimeString,
      })
      .nullable(),
    /** Set when an event handler failed; the simulation then stays stopped. */
    fault: z.string().max(1000).nullable(),
  }),
  queue: z.strictObject({
    pending: z.int().min(0),
    nextEventAtMs: simTimeString.nullable(),
  }),
  journal: z.strictObject({ commands: z.int().min(0), events: z.int().min(0) }),
  fingerprint: z.strictObject({ stateHash: sha256HexSchema, journalHash: sha256HexSchema }),
  /** Null only when the worker runs without persistence (unit tests). */
  session: sessionViewSchema.nullable(),
  /** The player's company and its books; null until a company is founded (Step 05). */
  company: companyViewSchema.nullable(),
  /** Cities, property and leases; null in worlds created before Step 07 (ADR-0040). */
  realEstate: realEstateViewSchema.nullable(),
  /** The scenarios a new world can be started from (this build's content). */
  scenarios: z.array(scenarioSummarySchema).max(50),
  /** Kernel diagnostics (development only, ADR-0016/ADR-0024). */
  diagnostics: z.strictObject({
    probeCount: z.int().min(0),
    lastProbeLabel: z.string().nullable(),
    pendingProbes: z.int().min(0),
    firedProbes: z.int().min(0),
    lastFiredProbe: z
      .strictObject({
        probeId: z.string().max(40),
        label: z.string(),
        token: z.int().min(0).max(0xffff_ffff),
        firedAtMs: simTimeString,
      })
      .nullable(),
  }),
});

export type WorldSnapshot = z.infer<typeof worldSnapshotSchema>;

export interface HostSnapshot {
  readonly worker: WorkerStatus;
  /** Null whenever the worker is not ready to answer. */
  readonly world: WorldSnapshot | null;
}

/** Events pushed from main to the renderer on `IPC_EVENT_CHANNEL`. */
export type HostEvent =
  | { readonly type: 'worker.status'; readonly worker: WorkerStatus }
  | {
      readonly type: 'world.revised';
      readonly worldInstanceId: string;
      readonly worldRevision: number;
    }
  | {
      /** Simulated time moved, or the clock's speed or advance state changed. */
      readonly type: 'world.clock';
      readonly worldInstanceId: string;
      readonly nowMs: string;
    }
  | {
      /** Saves were written, imported or recovered, or a save was loaded. */
      readonly type: 'saves.changed';
    };

// -------------------------------------------------- renderer requests

const protocolVersion = z.literal(IPC_PROTOCOL_VERSION);

export const rendererRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ protocolVersion, method: z.literal('simulation.getSnapshot') }),
  z.strictObject({
    protocolVersion,
    method: z.literal('simulation.submitCommand'),
    envelope: commandEnvelopeSchema,
  }),
  z.strictObject({ protocolVersion, method: z.literal('simulation.restartWorker') }),
  z.strictObject({
    protocolVersion,
    method: z.literal('simulation.newWorld'),
    world: newWorldRequestSchema,
  }),
  z.strictObject({
    protocolVersion,
    method: z.literal('simulation.control'),
    control: clockControlSchema,
  }),
  z.strictObject({ protocolVersion, method: z.literal('saves.list') }),
  z.strictObject({ protocolVersion, method: z.literal('saves.save'), request: saveRequestSchema }),
  z.strictObject({ protocolVersion, method: z.literal('saves.load'), saveId: saveIdSchema }),
  z.strictObject({ protocolVersion, method: z.literal('saves.export'), saveId: saveIdSchema }),
  z.strictObject({ protocolVersion, method: z.literal('saves.import') }),
  z.strictObject({ protocolVersion, method: z.literal('workspace.get') }),
  z.strictObject({
    protocolVersion,
    method: z.literal('workspace.set'),
    update: workspaceUpdateSchema,
  }),
]);

export type RendererRequest = z.infer<typeof rendererRequestSchema>;
