import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { saveIdSchema, type SaveStatus } from '../shared/ipc/saves';
import { compatibilityProblem, type RuntimeCompatibility } from './compatibility';
import {
  copyDatabase,
  replaceFile,
  SAVE_APPLICATION_ID,
  SAVE_FILE_EXTENSION,
  withDatabase,
  type SqliteDatabase,
} from './database';
import { checkIntegrity } from './integrity';
import {
  applyMigrations,
  latestVersion,
  newerFormatMessage,
  readSchemaStamp,
  SAVE_MIGRATIONS,
  type Migration,
  type SchemaStamp,
} from './migrations';
import { messageOf, SaveError, sqliteCodeOf, type SaveErrorCode } from './save-error';
import type { SaveImage, SaveLabel } from './save-image';
import { readHeader, readWorld, writeWorld, type SaveHeader } from './world-repository';

/**
 * The save slots on disk (spec §10.4, ADR-0026, ADR-0027): one SQLite file
 * per slot, `<directory>/<saveId>.fisave`.
 *
 * - **Atomic writes.** A save is written to a temporary file in the same
 *   directory in one transaction, checked (SQLite integrity, exact schema,
 *   structure, then the caller's full verification — the worker restores the
 *   world and compares fingerprints), closed, and only then renamed over the
 *   slot. A failure at any point deletes the temporary file; the previous
 *   save, if any, is untouched.
 * - **Upgrades.** An older save format is upgraded on load: the original is
 *   first copied to `backups/`, the upgrade runs on a temporary copy, and the
 *   copy replaces the slot only after it passes the integrity checks.
 * - **Copies** (export, import, backups) use `VACUUM INTO`, a transactionally
 *   consistent copy made by SQLite itself, never a raw file copy.
 * - Only the simulation worker uses this class; one worker per app, and one
 *   app per user profile (single-instance lock), so there is one writer.
 */

export interface SaveStoreOptions {
  readonly directory: string;
  readonly appVersion: string;
  readonly runtime: RuntimeCompatibility;
  readonly migrations?: readonly Migration[];
  /** Wall clock for informational timestamps (backup names, `schema_migrations`). */
  readonly now: () => Date;
  /** A unique token for temporary file names. */
  readonly uniqueToken: () => string;
}

export interface SaveListing {
  readonly saveId: string;
  readonly status: SaveStatus;
  readonly problem: string | null;
  /** Null when the file cannot be read far enough. */
  readonly header: SaveHeader | null;
}

export interface LoadedSave {
  readonly image: SaveImage;
  readonly label: SaveLabel;
  /** The save format it was upgraded from on this load, or null. */
  readonly upgradedFrom: number | null;
}

/** Throws when an image read back from a file does not restore to exactly the saved world. */
export type ImageVerifier = (image: SaveImage) => void;

/** Number of rolling autosave slots. */
const AUTOSAVE_SLOTS = 3;

const TEMP_PREFIX = '.~';

export class SaveStore {
  readonly directory: string;
  readonly #backups: string;
  readonly #appVersion: string;
  readonly #runtime: RuntimeCompatibility;
  readonly #migrations: readonly Migration[];
  readonly #latest: number;
  readonly #now: () => Date;
  readonly #uniqueToken: () => string;

  constructor(options: SaveStoreOptions) {
    this.directory = options.directory;
    this.#backups = join(options.directory, 'backups');
    this.#appVersion = options.appVersion;
    this.#runtime = options.runtime;
    this.#migrations = options.migrations ?? SAVE_MIGRATIONS;
    this.#latest = latestVersion(this.#migrations);
    this.#now = options.now;
    this.#uniqueToken = options.uniqueToken;
    mkdirSync(this.directory, { recursive: true });
    this.#removeTemporaries();
  }

  get latestFormat(): number {
    return this.#latest;
  }

  pathOf(saveId: string): string {
    if (!saveIdSchema.safeParse(saveId).success) {
      throw new SaveError('NOT_FOUND', `"${saveId}" is not a valid save ID`);
    }
    return join(this.directory, `${saveId}${SAVE_FILE_EXTENSION}`);
  }

  exists(saveId: string): boolean {
    return existsSync(this.pathOf(saveId));
  }

  /** Every slot, newest first; unreadable files are listed with the reason. */
  list(): SaveListing[] {
    const ids = readdirSync(this.directory)
      .filter((file) => file.endsWith(SAVE_FILE_EXTENSION))
      .map((file) => file.slice(0, -SAVE_FILE_EXTENSION.length))
      .filter((id) => saveIdSchema.safeParse(id).success);
    return ids
      .map((id) => this.inspect(id))
      .sort((a, b) => {
        const left = a.header?.label.savedAt ?? '';
        const right = b.header?.label.savedAt ?? '';
        return left === right ? a.saveId.localeCompare(b.saveId) : right.localeCompare(left);
      });
  }

  /** Read a slot's header and classify it without loading the journal. */
  inspect(saveId: string): SaveListing {
    const path = this.pathOf(saveId);
    try {
      return withDatabase(path, { mode: 'read' }, (db) => {
        const stamp = readSchemaStamp(db);
        const formatError = this.#formatError(stamp);
        if (formatError) {
          return {
            saveId,
            status: formatError.code === 'NEWER_FORMAT' ? 'incompatible' : 'unreadable',
            problem: formatError.message,
            header: null,
          };
        }
        if (stamp.userVersion < this.#latest) {
          // The header tables are part of every format, so an older save can be
          // judged before it is upgraded.
          const problem = compatibilityProblem(readHeader(db), this.#runtime);
          return {
            saveId,
            status: problem ? 'incompatible' : 'needs-upgrade',
            problem:
              problem ??
              `Saved in an older format (${stamp.userVersion}); it will be upgraded, with a backup, when loaded.`,
            header: null,
          };
        }
        const header = readHeader(db);
        const problem = compatibilityProblem(header, this.#runtime);
        return { saveId, status: problem ? 'incompatible' : 'ready', problem, header };
      });
    } catch (error) {
      const failure = toSaveError(error, 'CORRUPT', 'This save could not be read');
      return { saveId, status: 'unreadable', problem: failure.message, header: null };
    }
  }

  /** Write `image` to slot `saveId` atomically (see the class comment). */
  write(saveId: string, image: SaveImage, label: SaveLabel, verify?: ImageVerifier): SaveListing {
    const target = this.pathOf(saveId);
    const existed = existsSync(target);
    const temp = this.#tempPath(saveId);
    try {
      withDatabase(temp, { mode: 'create' }, (db) => {
        applyMigrations(db, this.#migrations, this.#migrationContext());
        writeWorld(db, image, label);
        this.#readVerified(db, this.#latest, verify);
      });
      replaceFile(temp, target);
    } catch (error) {
      removeDatabaseFiles(temp);
      throw new SaveError(
        'WRITE_FAILED',
        `The save could not be written, so ${existed ? 'the previous save is unchanged' : 'nothing was saved'}: ${messageOf(error)}`,
        { cause: error },
      );
    }
    return this.inspect(saveId);
  }

  /** Read and fully check a slot, upgrading an older format first (with a backup). */
  read(saveId: string, verify?: ImageVerifier): LoadedSave {
    const path = this.pathOf(saveId);
    if (!existsSync(path)) {
      throw new SaveError('NOT_FOUND', 'That save no longer exists.');
    }
    try {
      const stamp = withDatabase(path, { mode: 'read' }, (db) => {
        const accepted = this.#acceptedStamp(db);
        if (accepted.userVersion < this.#latest) {
          // Refuse a world this build cannot continue before upgrading (and
          // backing up) anything: the file is then left exactly as it was.
          this.#assertIntact(db, accepted.userVersion);
          const problem = compatibilityProblem(readHeader(db), this.#runtime);
          if (problem) {
            throw new SaveError('INCOMPATIBLE_WORLD', problem);
          }
        }
        return accepted;
      });
      const upgradedFrom = stamp.userVersion < this.#latest ? stamp.userVersion : null;
      if (upgradedFrom !== null) {
        this.#upgrade(saveId, upgradedFrom);
      }
      const loaded = withDatabase(path, { mode: 'read' }, (db) =>
        this.#readVerified(db, this.#latest, verify),
      );
      return { ...loaded, upgradedFrom };
    } catch (error) {
      throw toSaveError(error, 'CORRUPT', 'This save could not be read');
    }
  }

  /** Copy a slot to `destination` (a path chosen by the player in Electron main). */
  exportTo(saveId: string, destination: string): void {
    const path = this.pathOf(saveId);
    if (!existsSync(path)) {
      throw new SaveError('NOT_FOUND', 'That save no longer exists.');
    }
    const temp = join(
      dirname(destination),
      `${TEMP_PREFIX}${basename(destination)}.${this.#uniqueToken()}.tmp`,
    );
    try {
      withDatabase(path, { mode: 'read' }, (db) => {
        const stamp = this.#acceptedStamp(db);
        this.#assertIntact(db, stamp.userVersion);
        copyDatabase(db, temp);
      });
      replaceFile(temp, destination);
    } catch (error) {
      removeDatabaseFiles(temp);
      throw toSaveError(error, 'WRITE_FAILED', 'The save could not be exported');
    }
  }

  /**
   * Import a save file from `source` (chosen by the player) as new slot
   * `saveId`. The file is checked before anything runs against it, copied,
   * upgraded if older, fully verified, and only then added to the slots.
   */
  importFrom(source: string, saveId: string, verify?: ImageVerifier): SaveListing {
    const target = this.pathOf(saveId);
    if (existsSync(target)) {
      throw new SaveError('WRITE_FAILED', `A save with ID ${saveId} already exists`);
    }
    const temp = this.#tempPath(saveId);
    try {
      withDatabase(source, { mode: 'read' }, (db) => {
        const stamp = this.#acceptedStamp(db);
        this.#assertIntact(db, stamp.userVersion);
        copyDatabase(db, temp);
      });
      withDatabase(temp, { mode: 'write' }, (db) => {
        applyMigrations(db, this.#migrations, this.#migrationContext());
        this.#readVerified(db, this.#latest, verify);
      });
      replaceFile(temp, target);
    } catch (error) {
      removeDatabaseFiles(temp);
      throw toSaveError(error, 'WRITE_FAILED', 'The save could not be imported');
    }
    return this.inspect(saveId);
  }

  /** The autosave slot to write next: an unused one, else the oldest. */
  nextAutosaveSlot(): string {
    const slots = Array.from({ length: AUTOSAVE_SLOTS }, (_, index) => `autosave-${index + 1}`);
    const unused = slots.find((id) => !this.exists(id));
    if (unused) {
      return unused;
    }
    const savedAt = (id: string) => this.inspect(id).header?.label.savedAt ?? '';
    return slots.reduce((oldest, id) => (savedAt(id) < savedAt(oldest) ? id : oldest));
  }

  // ------------------------------------------------------------ internals

  #readVerified(
    db: SqliteDatabase,
    version: number,
    verify: ImageVerifier | undefined,
  ): { image: SaveImage; label: SaveLabel } {
    this.#assertIntact(db, version);
    const problem = compatibilityProblem(readHeader(db), this.#runtime);
    if (problem) {
      throw new SaveError('INCOMPATIBLE_WORLD', problem);
    }
    const loaded = readWorld(db);
    try {
      verify?.(loaded.image);
    } catch (error) {
      throw new SaveError('CORRUPT', `This save failed verification: ${messageOf(error)}`, {
        cause: error,
      });
    }
    return loaded;
  }

  #assertIntact(db: SqliteDatabase, version: number): void {
    const problems = checkIntegrity(db, this.#migrations, version);
    if (problems.length > 0) {
      throw new SaveError('CORRUPT', `This save is damaged: ${problems.slice(0, 5).join('; ')}`);
    }
  }

  /** The file's schema stamp if this build can read it (possibly after an upgrade). */
  #acceptedStamp(db: SqliteDatabase): SchemaStamp {
    const stamp = readSchemaStamp(db);
    const error = this.#formatError(stamp);
    if (error) {
      throw error;
    }
    return stamp;
  }

  #formatError(stamp: SchemaStamp): SaveError | null {
    if (stamp.applicationId !== SAVE_APPLICATION_ID) {
      return new SaveError('NOT_A_SAVE', 'This file is not a FreeIndustry save.');
    }
    if (stamp.userVersion === 0) {
      return new SaveError('CORRUPT', 'This save file is empty or was never finished.');
    }
    if (stamp.userVersion > this.#latest) {
      return new SaveError('NEWER_FORMAT', newerFormatMessage(stamp.userVersion, this.#latest));
    }
    return null;
  }

  #upgrade(saveId: string, fromVersion: number): void {
    const path = this.pathOf(saveId);
    mkdirSync(this.#backups, { recursive: true });
    const stamp = this.#now().toISOString().replace(/[:.]/g, '-');
    const backup = join(
      this.#backups,
      `${saveId}.format-${fromVersion}.${stamp}${SAVE_FILE_EXTENSION}`,
    );
    const temp = this.#tempPath(saveId);
    try {
      withDatabase(path, { mode: 'read' }, (db) => {
        this.#assertIntact(db, fromVersion);
        copyDatabase(db, backup);
        copyDatabase(db, temp);
      });
      withDatabase(temp, { mode: 'write' }, (db) => {
        applyMigrations(db, this.#migrations, this.#migrationContext());
        this.#assertIntact(db, this.#latest);
      });
      replaceFile(temp, path);
    } catch (error) {
      removeDatabaseFiles(temp);
      throw toSaveError(
        error,
        'MIGRATION_FAILED',
        'The save could not be upgraded; the original is unchanged',
      );
    }
  }

  #migrationContext() {
    return { appVersion: this.#appVersion, appliedAt: this.#now().toISOString() };
  }

  #tempPath(saveId: string): string {
    return join(this.directory, `${TEMP_PREFIX}${saveId}.${this.#uniqueToken()}.tmp`);
  }

  /** Leftovers of writes interrupted by a crash; never valid saves. */
  #removeTemporaries(): void {
    for (const file of readdirSync(this.directory)) {
      if (file.startsWith(TEMP_PREFIX)) {
        rmSync(join(this.directory, file), { force: true });
      }
    }
  }
}

/** Delete a database file and any journal SQLite left beside it. */
export function removeDatabaseFiles(path: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

function toSaveError(error: unknown, fallback: SaveErrorCode, context: string): SaveError {
  if (error instanceof SaveError) {
    return error;
  }
  // Extended result codes (SQLITE_CORRUPT_VTAB, …) share their base code's meaning.
  switch (sqliteCodeOf(error)?.split('_').slice(0, 2).join('_')) {
    case 'SQLITE_NOTADB':
      return new SaveError('NOT_A_SAVE', 'This file is not a FreeIndustry save.', { cause: error });
    case 'SQLITE_CORRUPT':
      return new SaveError('CORRUPT', `This save is damaged: ${messageOf(error)}`, {
        cause: error,
      });
    default:
      return new SaveError(fallback, `${context}: ${messageOf(error)}`, { cause: error });
  }
}
