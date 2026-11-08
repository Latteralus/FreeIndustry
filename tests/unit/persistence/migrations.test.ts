import Database from 'better-sqlite3';
import { SAVE_APPLICATION_ID, type SqliteDatabase } from '../../../src/persistence/database';
import {
  applyMigrations,
  readSchemaStamp,
  SAVE_MIGRATIONS,
  type Migration,
} from '../../../src/persistence/migrations';
import { SaveError } from '../../../src/persistence/save-error';

const CONTEXT = { appVersion: '0.1.0', appliedAt: '2026-11-07T12:00:00.000Z' };

/** The newest real save format, and the number a test-only later migration takes. */
const LATEST = SAVE_MIGRATIONS.length;
const NEXT = LATEST + 1;

function blank(): SqliteDatabase {
  const db = new Database(':memory:');
  db.defaultSafeIntegers(true);
  db.pragma('foreign_keys = ON');
  return db;
}

const tables = (db: SqliteDatabase) =>
  (
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

/** Test-only later migration: adds a column and fills it from existing data. */
const addProbeNote: Migration = {
  version: NEXT,
  description: 'Test: probe notes',
  precondition: (db) =>
    (db.prepare('PRAGMA table_info(diagnostics_state)').all() as { name: string }[]).some(
      (column) => column.name === 'note',
    )
      ? ['note already exists']
      : [],
  up: (db) => {
    db.exec("ALTER TABLE diagnostics_state ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE diagnostics_state SET note = 'probes: ' || probe_count");
  },
};

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'OK';
  } catch (error) {
    return error instanceof SaveError ? error.code : `other: ${String(error)}`;
  }
}

describe('save migrations', () => {
  it('creates the schema on a blank database and stamps it as a FreeIndustry save', () => {
    const db = blank();
    expect(applyMigrations(db, SAVE_MIGRATIONS, CONTEXT)).toBe(0);
    expect(readSchemaStamp(db)).toEqual({
      applicationId: SAVE_APPLICATION_ID,
      userVersion: LATEST,
    });
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        'audit_events',
        'diagnostics_state',
        'journal_entries',
        'journal_facts',
        'pending_events',
        'rng_streams',
        'save_metadata',
        'schema_migrations',
        'worlds',
        'world_snapshots',
        'workspace_settings',
        'company',
        'counterparties',
        'ledger_accounts',
        'ledger_entries',
        'ledger_lines',
        'invoices',
        'invoice_lines',
        'payments',
        'obligations',
      ]),
    );
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(
      SAVE_MIGRATIONS.map((migration) => ({
        version: BigInt(migration.version),
        description: migration.description,
        applied_at: CONTEXT.appliedAt,
        app_version: '0.1.0',
      })),
    );
  });

  it('does nothing to a database that is already current', () => {
    const db = blank();
    applyMigrations(db, SAVE_MIGRATIONS, CONTEXT);
    expect(applyMigrations(db, SAVE_MIGRATIONS, { ...CONTEXT, appliedAt: 'later' })).toBe(LATEST);
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({
      n: BigInt(LATEST),
    });
  });

  it('upgrades step by step, keeping data, and records each migration', () => {
    const db = blank();
    applyMigrations(db, SAVE_MIGRATIONS, CONTEXT);
    db.prepare(
      'INSERT INTO diagnostics_state (singleton, probe_count, last_probe_label, pending_probes, fired_probes) VALUES (1, 3, NULL, 0, 0)',
    ).run();
    expect(applyMigrations(db, [...SAVE_MIGRATIONS, addProbeNote], CONTEXT)).toBe(LATEST);
    expect(readSchemaStamp(db).userVersion).toBe(NEXT);
    expect(db.prepare('SELECT note FROM diagnostics_state').get()).toEqual({ note: 'probes: 3' });
    expect(
      (
        db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
          version: bigint;
        }[]
      ).map((row) => row.version),
    ).toEqual([...SAVE_MIGRATIONS, addProbeNote].map((migration) => BigInt(migration.version)));
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1n);
  });

  it('rolls back a migration that fails part-way and leaves the version unchanged', () => {
    const db = blank();
    applyMigrations(db, SAVE_MIGRATIONS, CONTEXT);
    const failing: Migration = {
      version: NEXT,
      description: 'Test: fails after creating a table',
      up: (inner) => {
        inner.exec('CREATE TABLE half_done (x INTEGER) STRICT');
        throw new Error('disk full');
      },
    };
    let error: unknown;
    try {
      applyMigrations(db, [...SAVE_MIGRATIONS, failing], CONTEXT);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SaveError);
    expect((error as SaveError).code).toBe('MIGRATION_FAILED');
    expect((error as SaveError).message).toMatch(new RegExp(`format ${NEXT} .*disk full`));
    expect(readSchemaStamp(db).userVersion).toBe(LATEST);
    expect(tables(db)).not.toContain('half_done');
  });

  it('refuses to run a migration whose precondition fails', () => {
    const db = blank();
    applyMigrations(db, SAVE_MIGRATIONS, CONTEXT);
    db.exec("ALTER TABLE diagnostics_state ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    expect(codeOf(() => applyMigrations(db, [...SAVE_MIGRATIONS, addProbeNote], CONTEXT))).toBe(
      'MIGRATION_FAILED',
    );
    expect(readSchemaStamp(db).userVersion).toBe(LATEST);
  });

  it('refuses a migration that leaves rows pointing at nothing', () => {
    const db = blank();
    applyMigrations(db, SAVE_MIGRATIONS, CONTEXT);
    const dangling: Migration = {
      version: NEXT,
      description: 'Test: orphan fact',
      up: (inner) => {
        inner.exec(
          `INSERT INTO journal_facts (seq, ordinal, type, data_json) VALUES (99, 0, 'x', 'null')`,
        );
      },
    };
    expect(codeOf(() => applyMigrations(db, [...SAVE_MIGRATIONS, dangling], CONTEXT))).toBe(
      'MIGRATION_FAILED',
    );
    expect(db.prepare('SELECT count(*) AS n FROM journal_facts').get()).toEqual({ n: 0n });
  });

  it('refuses a newer save format instead of downgrading it', () => {
    const db = blank();
    applyMigrations(db, SAVE_MIGRATIONS, CONTEXT);
    db.pragma('user_version = 7');
    let message = '';
    try {
      applyMigrations(db, SAVE_MIGRATIONS, CONTEXT);
    } catch (error) {
      expect((error as SaveError).code).toBe('NEWER_FORMAT');
      message = (error as Error).message;
    }
    expect(message).toBe(
      `This save was made by a newer version of FreeIndustry (save format 7; this build reads formats up to ${LATEST}). Update FreeIndustry to load it.`,
    );
  });

  it('refuses a database that belongs to another application', () => {
    const db = blank();
    db.exec('CREATE TABLE other (x)');
    db.pragma('application_id = 1234');
    db.pragma('user_version = 1');
    expect(codeOf(() => applyMigrations(db, SAVE_MIGRATIONS, CONTEXT))).toBe('NOT_A_SAVE');
  });

  it('refuses to create the schema over existing tables', () => {
    const db = blank();
    db.exec('CREATE TABLE stray (x)');
    expect(codeOf(() => applyMigrations(db, SAVE_MIGRATIONS, CONTEXT))).toBe('MIGRATION_FAILED');
  });

  it('insists migrations are numbered 1, 2, 3, … without gaps', () => {
    expect(() =>
      applyMigrations(
        blank(),
        [...SAVE_MIGRATIONS, { ...addProbeNote, version: NEXT + 1 }],
        CONTEXT,
      ),
    ).toThrow(new RegExp(`numbered ${NEXT + 1}`));
  });

  it('migration 2 adds the empty company tables to a format 1 save and keeps its data', () => {
    const db = blank();
    applyMigrations(db, SAVE_MIGRATIONS.slice(0, 1), CONTEXT);
    db.prepare(
      'INSERT INTO diagnostics_state (singleton, probe_count, last_probe_label, pending_probes, fired_probes) VALUES (1, 4, NULL, 2, 1)',
    ).run();
    expect(tables(db)).not.toContain('ledger_entries');
    expect(applyMigrations(db, SAVE_MIGRATIONS.slice(0, 2), CONTEXT)).toBe(1);
    expect(readSchemaStamp(db).userVersion).toBe(2);
    expect(db.prepare('SELECT probe_count FROM diagnostics_state').get()).toEqual({
      probe_count: 4n,
    });
    for (const table of ['company', 'ledger_entries', 'ledger_lines', 'invoices', 'payments']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0n });
    }
  });
});
