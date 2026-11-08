import { z } from 'zod';
import { clockControlSchema } from './clock';
import { newWorldRequestSchema } from './real-estate';
import { saveIdSchema, saveRequestSchema, workspaceUpdateSchema } from './saves';
import {
  commandEnvelopeSchema,
  ipcErrorSchema,
  worldInstanceIdSchema,
  worldRevisionSchema,
} from './contract';

/**
 * Electron main ↔ simulation worker message protocol (ADR-0012, ADR-0013).
 * Both directions are validated on receipt. Messages are plain structured-
 * clone data; no functions, ports or handles cross this boundary.
 */

/** Options main passes to a new worker as `workerData`. */
export const workerOptionsSchema = z.strictObject({
  generation: z.int().min(1),
  faultInjectionEnabled: z.boolean(),
  /**
   * World seed for the new world, or null to choose one at random. Only
   * unpackaged builds pass a fixed seed (`FREEINDUSTRY_WORLD_SEED`, tests).
   */
  seed: z.int().min(0).max(0xffff_ffff).nullable(),
  /**
   * The user's data directory (`app.getPath('userData')`). The worker keeps
   * save slots in `saves/` and the session recovery log in `recovery/` under it.
   */
  dataDirectory: z.string().min(1).max(4096),
  /** Application version, recorded in saves. */
  appVersion: z.string().min(1).max(64),
  /** Wall-clock interval between autosaves of a changed world. */
  autosaveIntervalMs: z
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1000),
});

export type WorkerOptions = z.infer<typeof workerOptionsSchema>;

const requestId = z.int().min(1);

/** main → worker */
export const workerRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('getSnapshot'), requestId }),
  z.strictObject({ kind: z.literal('submitCommand'), requestId, envelope: commandEnvelopeSchema }),
  /** Clock control: answered with a world snapshot. */
  z.strictObject({ kind: z.literal('control'), requestId, control: clockControlSchema }),
  /** Graceful stop: the worker autosaves a changed world and closes its recovery log first. */
  z.strictObject({ kind: z.literal('shutdown'), requestId }),
  z.strictObject({ kind: z.literal('listSaves'), requestId }),
  z.strictObject({ kind: z.literal('saveWorld'), requestId, request: saveRequestSchema }),
  z.strictObject({ kind: z.literal('loadSave'), requestId, saveId: saveIdSchema }),
  /** `destinationPath` comes from Electron main's save dialog, never from the renderer. */
  z.strictObject({
    kind: z.literal('exportSave'),
    requestId,
    saveId: saveIdSchema,
    destinationPath: z.string().min(1).max(4096),
  }),
  /** `sourcePath` comes from Electron main's open dialog, never from the renderer. */
  z.strictObject({
    kind: z.literal('importSave'),
    requestId,
    sourcePath: z.string().min(1).max(4096),
  }),
  /** Replace the world with a new one; the worker autosaves a changed world first. */
  z.strictObject({ kind: z.literal('newWorld'), requestId, world: newWorldRequestSchema }),
  z.strictObject({ kind: z.literal('getWorkspace'), requestId }),
  z.strictObject({ kind: z.literal('setWorkspace'), requestId, update: workspaceUpdateSchema }),
]);

export type WorkerRequest = z.infer<typeof workerRequestSchema>;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const logFieldValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

const logFieldsSchema = z.record(z.string().max(64), logFieldValue);
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/** worker → main */
export const workerMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), worldInstanceId: worldInstanceIdSchema }),
  z.strictObject({
    kind: z.literal('response'),
    requestId,
    /** Success values are validated by main against the schema for the request kind. */
    result: z.discriminatedUnion('ok', [
      z.strictObject({ ok: z.literal(true), value: z.unknown() }),
      z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('worldRevised'),
    worldInstanceId: worldInstanceIdSchema,
    worldRevision: worldRevisionSchema,
  }),
  z.strictObject({
    kind: z.literal('worldClock'),
    worldInstanceId: worldInstanceIdSchema,
    nowMs: z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/)
      .max(20),
  }),
  /** Save slots changed (autosave, recovery, import), so listings should refresh. */
  z.strictObject({ kind: z.literal('savesChanged') }),
  z.strictObject({
    kind: z.literal('log'),
    level: z.enum(LOG_LEVELS),
    message: z.string().max(2000),
    fields: logFieldsSchema,
  }),
]);

export type WorkerMessage = z.infer<typeof workerMessageSchema>;

/** Success value of a `shutdown` request. */
export const shutdownAckSchema = z.strictObject({ stopped: z.literal(true) });

/** Success value of an `exportSave` request. */
export const exportAckSchema = z.strictObject({ exported: z.literal(true) });
