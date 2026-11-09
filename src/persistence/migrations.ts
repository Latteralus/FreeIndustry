import { intCell, SAVE_APPLICATION_ID, type SqliteDatabase } from './database';
import { messageOf, SaveError } from './save-error';
import { SCHEMA_V1 } from './schema-v1';
import { SCHEMA_V2 } from './schema-v2';
import { SCHEMA_V3 } from './schema-v3';
import { SCHEMA_V4 } from './schema-v4';

/**
 * Save-schema migrations (spec §10.4, ADR-0027). The schema version is
 * SQLite's `PRAGMA user_version`; `PRAGMA application_id` marks the file as a
 * FreeIndustry save; `schema_migrations` records when and by which build each
 * migration ran.
 *
 * Rules:
 * - Versions are 1, 2, 3, … with no gaps; migration N takes version N − 1 to N.
 * - Each migration runs in its own IMMEDIATE transaction together with its
 *   precondition check, a foreign-key check and the version bump, so it
 *   applies completely or not at all. Foreign-key enforcement is off while
 *   migrating (SQLite cannot toggle it inside a transaction, and table
 *   rebuilds need it off) and `foreign_key_check` must be clean before commit.
 * - Callers migrate a *copy* and keep a backup of the original (SaveStore);
 *   a failed migration never touches the original file.
 * - A file whose version is newer than this build knows is refused, never
 *   "downgraded".
 */

export interface Migration {
  /** The schema version this migration produces. */
  readonly version: number;
  readonly description: string;
  /** Problems that make the migration unsafe to run; empty when it may proceed. */
  readonly precondition?: (db: SqliteDatabase) => readonly string[];
  readonly up: (db: SqliteDatabase) => void;
}

export const SAVE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Initial save schema: world, kernel state, journal, diagnostics, workspace, audit',
    precondition: (db) => {
      const objects = db
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
        .get() as { n: unknown };
      return intCell(objects.n, 'schema object count') === 0
        ? []
        : ['the database already contains tables'];
    },
    up: (db) => {
      db.exec(SCHEMA_V1);
    },
  },
  {
    version: 2,
    description: 'Company identity, counterparties and double-entry books (Step 05)',
    // Worlds saved before Step 05 have no company, so the new tables start empty.
    up: (db) => {
      db.exec(SCHEMA_V2);
    },
  },
  {
    version: 3,
    description: 'Cities, districts, properties, established businesses and leases (Step 07)',
    // Worlds saved before Step 07 have no real estate, so the new tables start empty.
    up: (db) => {
      db.exec(SCHEMA_V3);
    },
  },
  {
    version: 4,
    description: 'Building structure, floor materials, equipment and floor coverings (Step 08)',
    // Worlds saved before Step 08 have no facilities, so the new tables start empty.
    up: (db) => {
      db.exec(SCHEMA_V4);
    },
  },
];

export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.length;
}

export interface SchemaStamp {
  readonly applicationId: number;
  readonly userVersion: number;
}

export function readSchemaStamp(db: SqliteDatabase): SchemaStamp {
  return {
    applicationId: intCell(db.pragma('application_id', { simple: true }), 'application_id'),
    userVersion: intCell(db.pragma('user_version', { simple: true }), 'user_version'),
  };
}

export interface MigrationContext {
  readonly appVersion: string;
  /** Wall-clock ISO timestamp recorded in `schema_migrations`. */
  readonly appliedAt: string;
}

/**
 * Bring `db` from its current version to the latest in `migrations`. Returns
 * the version it started from. Throws `SaveError` (`NEWER_FORMAT`,
 * `NOT_A_SAVE`, `MIGRATION_FAILED`); a failed step is rolled back, and steps
 * already committed stay (callers work on a copy).
 */
export function applyMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[],
  context: MigrationContext,
): number {
  assertContiguous(migrations);
  const latest = latestVersion(migrations);
  const start = readSchemaStamp(db);
  if (start.userVersion > 0 && start.applicationId !== SAVE_APPLICATION_ID) {
    throw new SaveError('NOT_A_SAVE', 'This file is not a FreeIndustry save.');
  }
  if (start.userVersion > latest) {
    throw new SaveError('NEWER_FORMAT', newerFormatMessage(start.userVersion, latest));
  }
  if (start.userVersion === latest) {
    return start.userVersion;
  }
  db.pragma('foreign_keys = OFF');
  try {
    for (const migration of migrations.slice(start.userVersion)) {
      runMigration(db, migration, context);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return start.userVersion;
}

function runMigration(db: SqliteDatabase, migration: Migration, context: MigrationContext): void {
  const step = db.transaction(() => {
    const problems = migration.precondition?.(db) ?? [];
    if (problems.length > 0) {
      throw new Error(`precondition failed: ${problems.join('; ')}`);
    }
    migration.up(db);
    db.prepare(
      'INSERT INTO schema_migrations (version, description, applied_at, app_version) VALUES (?, ?, ?, ?)',
    ).run(migration.version, migration.description, context.appliedAt, context.appVersion);
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(`${violations.length} foreign-key violations after the migration`);
    }
    if (migration.version === 1) {
      db.pragma(`application_id = ${SAVE_APPLICATION_ID}`);
    }
    db.pragma(`user_version = ${migration.version}`);
  });
  try {
    step.immediate();
  } catch (error) {
    throw new SaveError(
      'MIGRATION_FAILED',
      `Could not upgrade the save to format ${migration.version} (${migration.description}): ${messageOf(error)}`,
      { cause: error },
    );
  }
}

function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration ${index + 1} is numbered ${migration.version}`);
    }
  });
}

export function newerFormatMessage(found: number, latest: number): string {
  return (
    `This save was made by a newer version of FreeIndustry (save format ${found}; this ` +
    `build reads formats up to ${latest}). Update FreeIndustry to load it.`
  );
}
