import { renameSync } from 'node:fs';
import Database from 'better-sqlite3';

/**
 * SQLite connections for save files (spec §10.1, ADR-0026). Only the
 * simulation worker opens them; Electron main and the renderer never do.
 *
 * Every connection: foreign keys on, `trusted_schema` off (a save may come
 * from somewhere else, so schema objects may not call application-defined
 * functions), integers read as `bigint` so 64-bit values survive exactly,
 * and parameterized statements only.
 */

export type SqliteDatabase = Database.Database;

/** `PRAGMA application_id` of every FreeIndustry save: ASCII "FIND". */
export const SAVE_APPLICATION_ID = 0x4649_4e44;

/** Save files are self-contained SQLite databases with this extension. */
export const SAVE_FILE_EXTENSION = '.fisave';

export interface OpenOptions {
  /** `read`: read-only, must exist. `write`: must exist. `create`: created if missing. */
  readonly mode: 'read' | 'write' | 'create';
  /**
   * `rollback` (DELETE journal, synchronous FULL) for save slots, which are
   * written once and then closed, so the file is complete on its own at rest.
   * `wal` (synchronous NORMAL) for the long-lived session recovery log.
   */
  readonly journal?: 'rollback' | 'wal';
}

export function openDatabase(path: string, options: OpenOptions): SqliteDatabase {
  const readonly = options.mode === 'read';
  const db = new Database(path, {
    readonly,
    fileMustExist: options.mode !== 'create',
    timeout: 2_000,
  });
  try {
    db.defaultSafeIntegers(true);
    db.pragma('trusted_schema = OFF');
    db.pragma('foreign_keys = ON');
    if (!readonly) {
      const wal = options.journal === 'wal';
      db.pragma(`journal_mode = ${wal ? 'WAL' : 'DELETE'}`);
      db.pragma(`synchronous = ${wal ? 'NORMAL' : 'FULL'}`);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Run `body` with an open database and always close it. */
export function withDatabase<T>(
  path: string,
  options: OpenOptions,
  body: (db: SqliteDatabase) => T,
): T {
  const db = openDatabase(path, options);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/** A consistent, compacted copy of `db` in a new file (`VACUUM INTO`, ADR-0027). */
export function copyDatabase(db: SqliteDatabase, destination: string): void {
  db.prepare('VACUUM INTO ?').run(destination);
}

/**
 * Atomically replace `to` with `from` (same directory, so the same volume).
 * Windows reports EPERM/EBUSY/EACCES while another program (an indexer or
 * virus scanner) briefly holds the target, so retry a few times.
 */
export function replaceFile(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || attempt >= 8) {
        throw error;
      }
      sleepSync(25 * attempt);
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// -------------------------------------------------------- cell readers

/** A SQLite integer cell as a JavaScript safe integer. */
export function intCell(value: unknown, what: string): number {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${what} is outside the safe integer range`);
    }
    return Number(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throw new TypeError(`${what} is not an integer`);
}

export function bigCell(value: unknown, what: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new TypeError(`${what} is not an integer`);
}

export function textCell(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${what} is not text`);
  }
  return value;
}

export function nullableTextCell(value: unknown, what: string): string | null {
  return value === null ? null : textCell(value, what);
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A canonical decimal string or bigint, checked to fit SQLite's signed 64-bit INTEGER. */
export function int64(value: bigint | string, what: string): bigint {
  const result = typeof value === 'bigint' ? value : BigInt(value);
  if (result < INT64_MIN || result > INT64_MAX) {
    throw new RangeError(`${what} (${result}) does not fit a 64-bit integer`);
  }
  return result;
}
