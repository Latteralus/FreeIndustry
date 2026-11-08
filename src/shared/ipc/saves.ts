import { z } from 'zod';
import { canonicalJson } from '../canonical-json';
import { calendarSchema, simTimeString } from './primitives';

/**
 * Save slots and per-save workspace settings over IPC (spec §11.2, ADR-0028).
 * The renderer sees save IDs, names and summaries only: never file paths,
 * which stay between Electron main (dialogs) and the worker (files).
 */

/** File stem of a save slot: `save-…`, `autosave-1`, `recovered-…`. */
export const saveIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'Expected a save ID');

/** A player-chosen save name: 1–60 characters, no control characters, not blank. */
const saveNameSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[^\p{Cc}]+$/u, 'Save names cannot contain control characters')
  .refine((name) => name.trim().length > 0, 'Save names cannot be blank');

export const SAVE_KINDS = ['manual', 'autosave', 'recovered'] as const;
export type SaveKind = (typeof SAVE_KINDS)[number];

/**
 * - `ready`: loads as is;
 * - `needs-upgrade`: an older save format, upgraded (with a backup) on load;
 * - `incompatible`: readable, but made for other rules/content, or by a newer build;
 * - `unreadable`: damaged, or not a FreeIndustry save.
 */
const SAVE_STATUSES = ['ready', 'needs-upgrade', 'incompatible', 'unreadable'] as const;
export type SaveStatus = (typeof SAVE_STATUSES)[number];

export const saveSummarySchema = z.strictObject({
  saveId: saveIdSchema,
  status: z.enum(SAVE_STATUSES),
  /** Why the save is not `ready`, in words for the player. */
  problem: z.string().max(1000).nullable(),
  name: z.string().max(60).nullable(),
  kind: z.enum(SAVE_KINDS).nullable(),
  /** Wall-clock ISO timestamp of the write (informational). */
  savedAt: z.string().max(64).nullable(),
  world: z
    .strictObject({
      worldId: z.uuid(),
      seed: z.int().min(0).max(0xffff_ffff),
      nowMs: simTimeString,
      calendar: calendarSchema,
      worldRevision: z.int().min(0),
    })
    .nullable(),
  /** True for the save the current world was last loaded from or saved to. */
  current: z.boolean(),
});

export type SaveSummary = z.infer<typeof saveSummarySchema>;

export const saveListSchema = z.array(saveSummarySchema).max(1000);

/** Save the current world: as a new manual save (`saveId` null) or over an existing manual one. */
export const saveRequestSchema = z.strictObject({
  name: saveNameSchema,
  saveId: saveIdSchema.nullable(),
});

export type SaveRequest = z.infer<typeof saveRequestSchema>;

/** Result of `saves.exportSave`, built by main after its dialog (no path is returned). */
export interface ExportResult {
  readonly status: 'exported' | 'cancelled';
}

/** Result of `saves.importSave`, built by main after its dialog. */
export type ImportResult =
  { readonly status: 'imported'; readonly save: SaveSummary } | { readonly status: 'cancelled' };

// ------------------------------------------------------------ workspace

/** `window.personnel`, `shell.panels`, … */
const workspaceKeySchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/, 'Expected a workspace key')
  .max(64);

/** Largest canonical-JSON size of one workspace value. */
const MAX_WORKSPACE_VALUE_BYTES = 16 * 1024;

/** Most keys one save's workspace may hold. */
export const MAX_WORKSPACE_KEYS = 256;

const workspaceValueSchema = z
  .json()
  .refine(
    (value) => canonicalJson(value).length <= MAX_WORKSPACE_VALUE_BYTES,
    `Workspace values are limited to ${MAX_WORKSPACE_VALUE_BYTES} characters of JSON`,
  );

const workspaceSettingsSchema = z
  .record(workspaceKeySchema, z.json())
  .refine((settings) => Object.keys(settings).length <= MAX_WORKSPACE_KEYS);

export const workspaceUpdateSchema = z.strictObject({
  key: workspaceKeySchema,
  /** null removes the key. */
  value: workspaceValueSchema,
});

export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;

/** What `workspace.get` and `workspace.set` return. */
export const workspaceViewSchema = z.strictObject({ settings: workspaceSettingsSchema });

export type WorkspaceSettingsView = z.infer<typeof workspaceViewSchema>;
