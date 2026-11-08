import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JsonValue } from '../shared/canonical-json';
import type { IpcError, SessionView } from '../shared/ipc/contract';
import {
  MAX_WORKSPACE_KEYS,
  type SaveKind,
  type SaveRequest,
  type SaveSummary,
  type WorkspaceUpdate,
} from '../shared/ipc/saves';
import type { LogFields, LogLevel } from '../shared/ipc/worker-protocol';
import { calendarAt, isValidCivilDate } from '../domain/time';
import type { FreeIndustryState } from '../domain/world-state';
import { SimulationKernel } from '../simulation/kernel';
import { readRecoveryLog, RecoveryLog } from '../persistence/recovery-log';
import { messageOf, SaveError } from '../persistence/save-error';
import type {
  AuditDetails,
  AuditEntry,
  SaveImage,
  SaveLabel,
  WorkspaceSettings,
  WorldIdentity,
} from '../persistence/save-image';
import { removeDatabaseFiles, type SaveListing, type SaveStore } from '../persistence/save-store';
import type { CommandHost } from './command-host';
import type { WorldSetup } from './world-setup';

/**
 * Connects the live world to its saves (spec §10.4, ADR-0028). Lives in the
 * worker beside the CommandHost; everything here is synchronous, so a save,
 * load or import can never interleave with a command or a clock tick.
 *
 * Durability policy (snapshot plus event log):
 * - **Manual saves** write the full world (snapshot and journal) to a slot.
 * - **Autosaves** rotate over three slots, every `autosaveIntervalMs` of wall
 *   time while the world has changed since it was last written, and once
 *   more on a clean shutdown.
 * - **Recovery log**: between saves, every accepted command is appended to a
 *   WAL log before its receipt is sent, on top of a periodically refreshed
 *   checkpoint, together with a clock mark. After a crash the next worker
 *   replays it into a "Recovered" save. A clean shutdown deletes it.
 *
 * Loading replaces the world only after the save has passed every check,
 * including a full kernel restore whose fingerprints must equal the saved
 * ones; a failed load leaves the running world untouched. A world with
 * changes not yet written anywhere is autosaved first, so loading never
 * silently discards play.
 */

export interface SaveCoordinatorOptions {
  readonly host: CommandHost;
  readonly store: SaveStore;
  /** Where the session recovery log lives, or null to run without one. */
  readonly recoveryPath: string | null;
  readonly appVersion: string;
  /** Wall clock, for informational timestamps only. */
  readonly wallClock: () => Date;
  /** A new UUID. */
  readonly newId: () => string;
  readonly autosaveIntervalMs: number;
  readonly log: (level: LogLevel, message: string, fields?: LogFields) => void;
  /** Refresh the recovery checkpoint after this many logged commands. */
  readonly recoveryCheckpointEvery?: number;
  /** Least wall time between clock marks in the recovery log. */
  readonly clockMarkIntervalMs?: number;
}

const AUTOSAVE_NAME = {
  interval: 'Autosave',
  shutdown: 'Autosave on exit',
  'before-load': 'Autosave before load',
  'before-new-world': 'Autosave before new world',
} as const;

/** What a tick did that the renderer should hear about. */
export interface TickReport {
  readonly savesChanged: boolean;
}

export class SaveCoordinator {
  readonly #host: CommandHost;
  readonly #store: SaveStore;
  readonly #recoveryPath: string | null;
  readonly #appVersion: string;
  readonly #wallClock: () => Date;
  readonly #newId: () => string;
  readonly #autosaveIntervalMs: number;
  readonly #log: SaveCoordinatorOptions['log'];
  readonly #checkpointEvery: number;
  readonly #clockMarkIntervalMs: number;

  #identity: WorldIdentity;
  #workspace = new Map<string, JsonValue>();
  #audit: AuditEntry[] = [];
  #savedAs: { readonly saveId: string; readonly name: string } | null = null;
  /** State hash when the world was last loaded or saved by the player. */
  #playerSavedHash = '';
  /** State hash when the world was last written anywhere (including autosave). */
  #writtenHash = '';
  #notice: string | null = null;

  #recovery: RecoveryLog | null = null;
  #recoveryJournalLength = 0;
  #recoveryCommands = 0;
  #lastClockMark = 0n;
  #lastClockMarkWall = Number.NEGATIVE_INFINITY;
  #lastAutosaveWall = 0;

  constructor(options: SaveCoordinatorOptions) {
    this.#host = options.host;
    this.#store = options.store;
    this.#recoveryPath = options.recoveryPath;
    this.#appVersion = options.appVersion;
    this.#wallClock = options.wallClock;
    this.#newId = options.newId;
    this.#autosaveIntervalMs = options.autosaveIntervalMs;
    this.#log = options.log;
    this.#checkpointEvery = options.recoveryCheckpointEvery ?? 200;
    this.#clockMarkIntervalMs = options.clockMarkIntervalMs ?? 2_000;
    this.#identity = { worldId: this.#newId(), createdAt: this.#iso(), contentVersion: null };
  }

  /**
   * Worker start-up: recover an earlier session's log if one was left, then
   * adopt the host's freshly created world and start logging it.
   */
  start(wallNow: number): void {
    this.#salvage();
    const kernel = this.#host.kernel;
    this.#identity = { worldId: this.#newId(), createdAt: this.#iso(), contentVersion: null };
    this.#workspace = new Map();
    this.#audit = [this.#auditEntry('world.created', { seed: kernel.config.seed })];
    this.#savedAs = null;
    this.#markWritten(true);
    this.#lastAutosaveWall = wallNow;
    this.#openRecovery();
  }

  sessionView(): SessionView {
    return {
      worldId: this.#identity.worldId,
      savedAs: this.#savedAs,
      unsavedChanges: this.#stateHash() !== this.#playerSavedHash,
      recoveryLog: this.#recovery ? 'active' : 'unavailable',
      notice: this.#notice,
    };
  }

  list(): SaveSummary[] {
    return this.#store.list().map((listing) => this.#summary(listing));
  }

  /** Save the current world as a new manual save, or over an existing manual save. */
  save(request: SaveRequest): SaveSummary {
    let saveId = request.saveId;
    if (saveId === null) {
      saveId = `save-${this.#newId()}`;
    } else {
      if (!this.#store.exists(saveId)) {
        throw new SaveError('NOT_FOUND', 'That save no longer exists.');
      }
      const kind = this.#store.inspect(saveId).header?.label.kind;
      if (kind !== 'manual') {
        throw new SaveError(
          'WRITE_FAILED',
          'Only your own saves can be overwritten; save under a new name instead.',
        );
      }
    }
    const listing = this.#write(saveId, request.name, 'manual', 'save.written');
    this.#savedAs = { saveId, name: request.name };
    this.#markWritten(true);
    this.#refreshRecovery();
    return this.#summary(listing);
  }

  /** Replace the running world with a save. Throws, leaving the world untouched, on any problem. */
  load(saveId: string): void {
    const holder: { kernel: SimulationKernel<FreeIndustryState> | null } = { kernel: null };
    const loaded = this.#store.read(saveId, (image) => {
      holder.kernel = this.#restore(image);
    });
    const kernel = holder.kernel;
    if (!kernel) {
      throw new Error('The save was read without being verified');
    }
    const { image, label, upgradedFrom } = loaded;
    if (this.#stateHash() !== this.#writtenHash) {
      this.#autosave('before-load');
    }
    this.#host.adopt(kernel, this.#newId());
    this.#identity = image.identity;
    this.#workspace = new Map(Object.entries(image.workspace));
    this.#audit = [
      ...image.audit,
      this.#auditEntry('save.loaded', { saveId, name: label.name, upgradedFrom }),
    ];
    this.#savedAs = { saveId, name: label.name };
    this.#markWritten(true);
    this.#notice =
      upgradedFrom === null
        ? null
        : `"${label.name}" was upgraded from save format ${upgradedFrom}; the original was kept as a backup.`;
    this.#closeRecovery();
    this.#openRecovery();
    this.#log('info', 'Save loaded', {
      saveId,
      upgradedFrom,
      worldRevision: kernel.worldRevision,
      nowMs: kernel.nowMs.toString(),
      stateHash: kernel.fingerprint().stateHash,
    });
  }

  /**
   * Replace the running world with a new one built from `setup` (New
   * Company, Quick Start, Scenarios). A world with changes not yet written
   * anywhere is autosaved first, so starting again never silently discards
   * play. The new world has no save yet, an empty workspace and a fresh
   * recovery log.
   */
  newWorld(setup: WorldSetup, seed: number): void {
    const kernel = this.#host.createWorld({ seed, epoch: setup.epoch }, setup.setup);
    if (this.#stateHash() !== this.#writtenHash) {
      this.#autosave('before-new-world');
    }
    this.#host.adopt(kernel, this.#newId());
    this.#identity = { worldId: this.#newId(), createdAt: this.#iso(), contentVersion: null };
    this.#workspace = new Map();
    this.#audit = [this.#auditEntry('world.created', { seed, scenario: setup.scenarioId })];
    this.#savedAs = null;
    this.#markWritten(true);
    this.#notice = null;
    this.#closeRecovery();
    this.#openRecovery();
    this.#log('info', 'New world created', {
      scenario: setup.scenarioId,
      seed,
      stateHash: kernel.fingerprint().stateHash,
    });
  }

  exportSave(saveId: string, destinationPath: string): void {
    this.#store.exportTo(saveId, destinationPath);
    this.#log('info', 'Save exported', { saveId });
  }

  importSave(sourcePath: string): SaveSummary {
    const saveId = `save-${this.#newId()}`;
    const listing = this.#store.importFrom(sourcePath, saveId, (image) => {
      this.#restore(image);
    });
    this.#log('info', 'Save imported', { saveId });
    return this.#summary(listing);
  }

  workspace(): WorkspaceSettings {
    return Object.fromEntries(this.#workspace);
  }

  /** Change one workspace setting (null removes it). Not world state: no revision, no fingerprint. */
  updateWorkspace(update: WorkspaceUpdate): WorkspaceSettings {
    if (update.value === null) {
      this.#workspace.delete(update.key);
    } else {
      if (!this.#workspace.has(update.key) && this.#workspace.size >= MAX_WORKSPACE_KEYS) {
        throw new SaveError('WRITE_FAILED', `At most ${MAX_WORKSPACE_KEYS} workspace settings`);
      }
      this.#workspace.set(update.key, update.value);
    }
    const settings = this.workspace();
    this.#withRecovery('write workspace settings', (log) => {
      log.writeWorkspace(settings);
    });
    return settings;
  }

  /**
   * Log an accepted command. Call before its receipt is sent, so a receipt
   * the renderer saw is never lost to a crash.
   */
  afterCommand(commandId: string): void {
    const record = this.#host.kernel.journal.command(commandId);
    if (!record) {
      throw new Error(`Accepted command ${commandId} is missing from the journal`);
    }
    this.#withRecovery('log a command', (log) => {
      log.appendCommand({
        atMs: record.atMs,
        revision: record.revision,
        commandId: record.commandId,
        type: record.type,
        payload: record.payload,
      });
      this.#recoveryCommands += 1;
    });
    if (this.#recoveryCommands >= this.#checkpointEvery) {
      this.#refreshRecovery();
    }
  }

  /** Called on the worker's pacing timer: clock marks and interval autosaves. */
  tick(wallNow: number): TickReport {
    const nowMs = this.#host.kernel.nowMs;
    if (
      nowMs > this.#lastClockMark &&
      wallNow - this.#lastClockMarkWall >= this.#clockMarkIntervalMs
    ) {
      this.#lastClockMarkWall = wallNow;
      this.#withRecovery('mark the clock', (log) => {
        log.markClock(nowMs);
        this.#lastClockMark = nowMs;
      });
    }
    if (wallNow - this.#lastAutosaveWall < this.#autosaveIntervalMs) {
      return { savesChanged: false };
    }
    this.#lastAutosaveWall = wallNow;
    if (this.#stateHash() === this.#writtenHash) {
      return { savesChanged: false };
    }
    try {
      this.#autosave('interval');
      return { savesChanged: true };
    } catch (error) {
      this.#notice = `Autosave failed: ${messageOf(error)}`;
      this.#log('error', 'Autosave failed', { reason: messageOf(error) });
      return { savesChanged: false };
    }
  }

  /**
   * Clean shutdown: autosave a changed world, then delete the recovery log.
   * If the autosave fails, the log is kept so the next start recovers the session.
   */
  shutdown(): void {
    try {
      if (this.#stateHash() !== this.#writtenHash) {
        this.#autosave('shutdown');
      }
      this.#recovery?.discard();
      this.#recovery = null;
    } catch (error) {
      this.#log('error', 'Shutdown autosave failed; the recovery log was kept', {
        reason: messageOf(error),
      });
      this.release();
    }
  }

  /**
   * Close the recovery log without deleting it, exactly as if the process
   * stopped here: the next start recovers the session from it.
   */
  release(): void {
    const log = this.#recovery;
    this.#recovery = null;
    log?.close();
  }

  // ------------------------------------------------------------ internals

  #autosave(reason: keyof typeof AUTOSAVE_NAME): void {
    const saveId = this.#store.nextAutosaveSlot();
    const name = AUTOSAVE_NAME[reason];
    this.#write(saveId, name, 'autosave', 'save.autosaved');
    this.#markWritten(false);
    this.#refreshRecovery();
    this.#log('info', 'Autosaved', { saveId, reason });
  }

  #write(saveId: string, name: string, kind: SaveKind, auditKind: string): SaveListing {
    const label: SaveLabel = { name, kind, savedAt: this.#iso(), appVersion: this.#appVersion };
    const entry = this.#auditEntry(auditKind, { saveId, name });
    this.#audit.push(entry);
    try {
      const listing = this.#store.write(
        saveId,
        this.#imageOf(this.#host.kernel),
        label,
        (image) => {
          this.#restore(image);
        },
      );
      this.#log('info', 'World saved', {
        saveId,
        kind,
        worldRevision: this.#host.kernel.worldRevision,
        nowMs: this.#host.kernel.nowMs.toString(),
        stateHash: this.#host.kernel.fingerprint().stateHash,
      });
      return listing;
    } catch (error) {
      this.#audit.splice(this.#audit.indexOf(entry), 1);
      throw error;
    }
  }

  /** Rebuild a kernel from an image and insist it is the very world that was saved. */
  #restore(image: SaveImage): SimulationKernel<FreeIndustryState> {
    const rules = this.#host.rules;
    const kernel = SimulationKernel.restore(rules, {
      state: { ...image.kernel, domain: rules.encodeState(image.domain) },
      journal: image.journal,
    });
    const fingerprint = kernel.fingerprint();
    if (fingerprint.stateHash !== image.fingerprint.stateHash) {
      throw new Error('the restored world does not match the saved state hash');
    }
    if (fingerprint.journalHash !== image.fingerprint.journalHash) {
      throw new Error('the restored journal does not match the saved journal hash');
    }
    return kernel;
  }

  #imageOf(
    kernel: SimulationKernel<FreeIndustryState>,
    journalFromSeq = 1,
    world: {
      readonly identity: WorldIdentity;
      readonly workspace: WorkspaceSettings;
      readonly audit: readonly AuditEntry[];
    } = { identity: this.#identity, workspace: this.workspace(), audit: this.#audit },
  ): SaveImage {
    const { domain: _encodedDomain, ...kernelImage } = kernel.encodedState();
    return {
      identity: world.identity,
      kernel: kernelImage,
      domain: kernel.state,
      journal: kernel.encodedJournalFrom(journalFromSeq),
      fingerprint: kernel.fingerprint(),
      workspace: world.workspace,
      audit: [...world.audit],
    };
  }

  #summary(listing: SaveListing): SaveSummary {
    const { header } = listing;
    return {
      saveId: listing.saveId,
      status: listing.status,
      problem: listing.problem,
      name: header?.label.name ?? null,
      kind: header?.label.kind ?? null,
      savedAt: header?.label.savedAt ?? null,
      world:
        header && isValidCivilDate(header.epoch)
          ? {
              worldId: header.worldId,
              seed: header.seed,
              nowMs: header.nowMs.toString(),
              calendar: (({ year, month, day, weekday, hour, minute, second }) => ({
                year,
                month,
                day,
                weekday,
                hour,
                minute,
                second,
              }))(calendarAt(header.epoch, header.nowMs)),
              worldRevision: header.worldRevision,
            }
          : null,
      current: listing.saveId === this.#savedAs?.saveId,
    };
  }

  #stateHash(): string {
    return this.#host.kernel.fingerprint().stateHash;
  }

  #markWritten(byPlayer: boolean): void {
    const hash = this.#stateHash();
    this.#writtenHash = hash;
    if (byPlayer) {
      this.#playerSavedHash = hash;
    }
  }

  #auditEntry(kind: string, details: AuditDetails): AuditEntry {
    const kernel = this.#host.kernel;
    return {
      occurredAt: this.#iso(),
      simTimeMs: kernel.nowMs,
      worldRevision: kernel.worldRevision,
      kind,
      details,
    };
  }

  #iso(): string {
    return this.#wallClock().toISOString();
  }

  // --------------------------------------------------------- recovery

  #recoveryLabel(): SaveLabel {
    return {
      name: 'Session recovery log',
      kind: 'recovered',
      savedAt: this.#iso(),
      appVersion: this.#appVersion,
    };
  }

  /** Start a recovery log for the current world with a full checkpoint. */
  #openRecovery(): void {
    if (this.#recoveryPath === null) {
      return;
    }
    try {
      mkdirSync(dirname(this.#recoveryPath), { recursive: true });
      const log = RecoveryLog.create(this.#recoveryPath, {
        appVersion: this.#appVersion,
        now: this.#wallClock,
      });
      this.#recovery = log;
      log.checkpoint(this.#imageOf(this.#host.kernel), this.#recoveryLabel(), 1);
      this.#recoveryJournalLength = this.#host.kernel.journal.length;
      this.#recoveryCommands = 0;
      this.#lastClockMark = this.#host.kernel.nowMs;
    } catch (error) {
      this.#recoveryUnavailable('start the recovery log', error);
    }
  }

  /** Append the journal since the last checkpoint and replace the snapshot. */
  #refreshRecovery(): void {
    const from = this.#recoveryJournalLength + 1;
    this.#withRecovery('refresh the recovery checkpoint', (log) => {
      log.checkpoint(this.#imageOf(this.#host.kernel, from), this.#recoveryLabel(), from);
      this.#recoveryJournalLength = this.#host.kernel.journal.length;
      this.#recoveryCommands = 0;
      this.#lastClockMark = this.#host.kernel.nowMs;
    });
  }

  #withRecovery(action: string, body: (log: RecoveryLog) => void): void {
    const log = this.#recovery;
    if (!log) {
      return;
    }
    try {
      body(log);
    } catch (error) {
      this.#recoveryUnavailable(action, error);
    }
  }

  #recoveryUnavailable(action: string, error: unknown): void {
    this.#notice = `Crash recovery is unavailable (could not ${action}: ${messageOf(error)}). Save your work regularly.`;
    this.#log('error', 'Recovery log unavailable', { action, reason: messageOf(error) });
    this.#closeRecovery();
  }

  #closeRecovery(): void {
    const log = this.#recovery;
    this.#recovery = null;
    if (log) {
      try {
        log.discard();
      } catch (error) {
        this.#log('warn', 'Could not remove the recovery log', { reason: messageOf(error) });
      }
    }
  }

  /** Rebuild an earlier session's recovery log, if any, into a "Recovered" save. */
  #salvage(): void {
    const path = this.#recoveryPath;
    if (path === null || !existsSync(path)) {
      return;
    }
    try {
      const contents = readRecoveryLog(path);
      const checkpointMs = BigInt(contents.image.kernel.nowMs);
      const clockMs = contents.clockMs ?? checkpointMs;
      if (contents.commands.length === 0 && clockMs <= checkpointMs) {
        this.#log('info', 'Previous session left a recovery log with nothing newer than its saves');
        removeDatabaseFiles(path);
        return;
      }
      const kernel = this.#restore(contents.image);
      for (const command of contents.commands) {
        if (command.atMs < kernel.nowMs) {
          throw new Error(`command ${command.commandId} is earlier than the world clock`);
        }
        kernel.advanceTo(command.atMs);
        const result = kernel.submit({
          commandId: command.commandId,
          expectedWorldRevision: command.revision - 1,
          type: command.type,
          payload: command.payload,
        });
        if (
          !result.ok ||
          result.receipt.duplicate ||
          result.receipt.worldRevision !== command.revision ||
          result.receipt.atMs !== command.atMs
        ) {
          throw new Error(`command ${command.commandId} did not replay as it was recorded`);
        }
      }
      if (clockMs > kernel.nowMs) {
        kernel.advanceTo(clockMs);
      }
      const saveId = `recovered-${this.#newId()}`;
      const name = 'Recovered session';
      const audit = [
        ...contents.image.audit,
        {
          occurredAt: this.#iso(),
          simTimeMs: kernel.nowMs,
          worldRevision: kernel.worldRevision,
          kind: 'session.recovered',
          details: { commandsReplayed: contents.commands.length },
        },
      ];
      this.#store.write(
        saveId,
        this.#imageOf(kernel, 1, {
          identity: contents.image.identity,
          workspace: contents.image.workspace,
          audit,
        }),
        { name, kind: 'recovered', savedAt: this.#iso(), appVersion: this.#appVersion },
        (image) => {
          this.#restore(image);
        },
      );
      removeDatabaseFiles(path);
      this.#notice =
        'The previous session ended unexpectedly. It was rebuilt up to its last accepted ' +
        `command and recorded time, and saved as "${name}".`;
      this.#log('warn', 'Recovered the previous session', {
        saveId,
        commandsReplayed: contents.commands.length,
        worldRevision: kernel.worldRevision,
        nowMs: kernel.nowMs.toString(),
        stateHash: kernel.fingerprint().stateHash,
      });
    } catch (error) {
      const kept = join(dirname(path), `failed-${this.#iso().replace(/[:.]/g, '-')}.fisave`);
      try {
        moveDatabaseFiles(path, kept);
      } catch {
        removeDatabaseFiles(path); // never let a stale log or WAL attach to the next one
      }
      this.#notice =
        'The previous session ended unexpectedly and could not be recovered ' +
        `(${messageOf(error)}). Its log was kept in the recovery folder.`;
      this.#log('error', 'Could not recover the previous session', { reason: messageOf(error) });
    }
  }
}

/** Move a database and its WAL side files together, so a stale WAL can never attach to a new log. */
function moveDatabaseFiles(from: string, to: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${from}${suffix}`)) {
      renameSync(`${from}${suffix}`, `${to}${suffix}`);
    }
  }
}

/** Map a persistence failure to an IPC error for the renderer. */
export function saveFailure(error: unknown): IpcError {
  if (error instanceof SaveError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return { code: 'SAVE_NOT_FOUND', message: error.message };
      case 'NOT_A_SAVE':
      case 'NEWER_FORMAT':
      case 'UNSUPPORTED_FORMAT':
      case 'INCOMPATIBLE_WORLD':
        return { code: 'SAVE_INCOMPATIBLE', message: error.message };
      case 'CORRUPT':
        return { code: 'SAVE_CORRUPT', message: error.message };
      case 'WRITE_FAILED':
      case 'MIGRATION_FAILED':
        return { code: 'SAVE_FAILED', message: error.message };
    }
  }
  return { code: 'INTERNAL_ERROR', message: `Unexpected persistence error: ${messageOf(error)}` };
}
