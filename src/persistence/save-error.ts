/**
 * Why a save could not be written, read, upgraded or imported. Every failure
 * leaves existing save files untouched (ADR-0026) and carries a message
 * written for the player, not a raw SQLite error.
 */
export type SaveErrorCode =
  /** No save with that ID. */
  | 'NOT_FOUND'
  /** Not a SQLite database, or not a FreeIndustry save. */
  | 'NOT_A_SAVE'
  /** Written by a newer FreeIndustry: its save format is beyond this build. */
  | 'NEWER_FORMAT'
  /** A save format this build has no upgrade path for. */
  | 'UNSUPPORTED_FORMAT'
  /** Readable, but its world needs different simulation rules, kernel or content. */
  | 'INCOMPATIBLE_WORLD'
  /** Damaged or inconsistent: integrity, schema or fingerprint checks failed. */
  | 'CORRUPT'
  /** The write was rolled back; the previous file (if any) is unchanged. */
  | 'WRITE_FAILED'
  /** An upgrade was rolled back; the original file is unchanged. */
  | 'MIGRATION_FAILED';

export class SaveError extends Error {
  readonly code: SaveErrorCode;

  constructor(code: SaveErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'SaveError';
    this.code = code;
  }
}

/**
 * Errors are read by shape, not `instanceof`: better-sqlite3 creates its
 * `SqliteError` class once per process, in whichever JavaScript realm loaded
 * the addon first, so `instanceof Error` can be false in another realm.
 */
function errorField(error: unknown, field: 'message' | 'code'): string | null {
  if (typeof error === 'object' && error !== null && field in error) {
    const value = (error as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

export function messageOf(error: unknown): string {
  return errorField(error, 'message') ?? String(error);
}

/** SQLite's result code name (`SQLITE_NOTADB`, …) when `error` is a SQLite error. */
export function sqliteCodeOf(error: unknown): string | null {
  const code = errorField(error, 'code');
  return code?.startsWith('SQLITE_') ? code : null;
}
