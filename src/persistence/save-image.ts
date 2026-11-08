import type { JsonValue } from '../shared/canonical-json';
import type { SaveKind } from '../shared/ipc/saves';
import type { EncodedJournalEntry, EncodedKernelState } from '../shared/world-checkpoint';
import type { FreeIndustryState } from '../domain/world-state';

/**
 * Everything a save file holds, as plain typed data (ADR-0026). The worker
 * builds it from the live kernel; persistence maps it to tables and back.
 */

/** Identity of a world across saves and loads (stable, unlike the per-load world instance ID). */
export interface WorldIdentity {
  /** UUID minted when the world was created. */
  readonly worldId: string;
  /** Wall-clock ISO timestamp of creation (informational). */
  readonly createdAt: string;
  /** Version of the content packs the world was built from; null until content exists (Step 29). */
  readonly contentVersion: string | null;
}

/** The kernel's encoded state without its domain part, which is stored relationally. */
export type KernelImage = Omit<EncodedKernelState, 'domain'>;

export type AuditDetails = Readonly<Record<string, string | number | boolean | null>>;

/**
 * One entry of the world's persistence history: created, saved, loaded,
 * upgraded, imported, recovered. Outside the fingerprints, like all wall-clock data.
 */
export interface AuditEntry {
  readonly occurredAt: string;
  readonly simTimeMs: bigint;
  readonly worldRevision: number;
  readonly kind: string;
  readonly details: AuditDetails;
}

/** Per-save presentation settings (window layout from Step 06). Not world state. */
export type WorkspaceSettings = Readonly<Record<string, JsonValue>>;

export interface SaveImage {
  readonly identity: WorldIdentity;
  readonly kernel: KernelImage;
  readonly domain: FreeIndustryState;
  /**
   * Journal entries in sequence order. A complete image starts at 1; the
   * recovery log's incremental checkpoints pass only the new tail.
   */
  readonly journal: readonly EncodedJournalEntry[];
  /** The kernel's fingerprints for this state; checked again on every load. */
  readonly fingerprint: { readonly stateHash: string; readonly journalHash: string };
  readonly workspace: WorkspaceSettings;
  readonly audit: readonly AuditEntry[];
}

export interface SaveLabel {
  readonly name: string;
  readonly kind: SaveKind;
  /** Wall-clock ISO timestamp of the write (informational). */
  readonly savedAt: string;
  readonly appVersion: string;
}
