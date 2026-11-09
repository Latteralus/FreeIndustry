import Database from 'better-sqlite3';
import { intCell, textCell, type SqliteDatabase } from './database';
import { companyStructureProblems, hasCompanyTables } from './company-repository';
import { facilitiesStructureProblems, hasFacilitiesTables } from './facilities-repository';
import { hasRealEstateTables, realEstateStructureProblems } from './real-estate-repository';
import { applyMigrations, type Migration } from './migrations';

/**
 * Save-file integrity checks (spec §10.4, ADR-0027). Run on every load and
 * import, and on every write before the file replaces a slot. They report
 * problems and never repair: a damaged save is refused with a diagnosis, and
 * the file is left exactly as it was.
 *
 * 1. SQLite's own `integrity_check` and `foreign_key_check`.
 * 2. The schema is exactly the one this build creates for the file's version:
 *    no missing, altered or extra tables, indexes, views or triggers. This
 *    also stops an imported file from smuggling in a trigger that would fire
 *    during an upgrade.
 * 3. Structural rules the DDL cannot express: one world, contiguous journal
 *    sequences, journal counts that agree with the snapshot, pending events
 *    with sequences already issued; from save format 2, books that balance
 *    (every entry, every account balance, every invoice and its payments,
 *    ADR-0033); from format 3, leases that agree with their properties and
 *    obligations (ADR-0039); from format 4, equipment standing only in leased
 *    premises and floor installations that agree with their entries (ADR-0049).
 *
 * Kernel-level consistency (fingerprints, invariants) is checked afterwards by
 * restoring the world in the simulation kernel.
 */

export function checkIntegrity(
  db: SqliteDatabase,
  migrations: readonly Migration[],
  schemaVersion: number,
): string[] {
  const sqlite = (db.pragma('integrity_check') as { integrity_check: unknown }[]).map((row) =>
    String(row.integrity_check),
  );
  if (sqlite.length !== 1 || sqlite[0] !== 'ok') {
    return sqlite.slice(0, 10).map((line) => `SQLite integrity check: ${line}`);
  }
  const problems: string[] = [];
  const foreignKeys = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeys.length > 0) {
    problems.push(`${foreignKeys.length} rows reference missing rows (foreign keys)`);
  }
  problems.push(...compareSchema(db, expectedSchema(migrations, schemaVersion)));
  if (problems.length > 0) {
    return problems;
  }
  return [...problems, ...checkStructure(db)];
}

function checkStructure(db: SqliteDatabase): string[] {
  const problems: string[] = [];
  const count = (sql: string): number => intCell((db.prepare(sql).get() as { n: unknown }).n, sql);
  for (const table of ['save_metadata', 'worlds', 'world_snapshots', 'diagnostics_state']) {
    const rows = count(`SELECT count(*) AS n FROM ${table}`);
    if (rows !== 1) {
      problems.push(`${table} has ${rows} rows, expected 1`);
    }
  }
  if (problems.length > 0) {
    return problems;
  }
  const snapshot = db
    .prepare(
      'SELECT world_revision, processed_events, journal_length, next_sequence FROM world_snapshots',
    )
    .get() as Record<string, unknown>;
  const journal = db
    .prepare(
      'SELECT count(*) AS n, coalesce(min(seq), 0) AS lo, coalesce(max(seq), 0) AS hi FROM journal_entries',
    )
    .get() as { n: unknown; lo: unknown; hi: unknown };
  const entries = intCell(journal.n, 'journal count');
  if (
    entries > 0 &&
    (intCell(journal.lo, 'first seq') !== 1 || intCell(journal.hi, 'last seq') !== entries)
  ) {
    problems.push('journal sequence numbers are not contiguous from 1');
  }
  if (entries !== intCell(snapshot['journal_length'], 'journal_length')) {
    problems.push(
      `journal holds ${entries} entries; the snapshot says ${String(snapshot['journal_length'])}`,
    );
  }
  const commands = count("SELECT count(*) AS n FROM journal_entries WHERE kind = 'command'");
  if (commands !== intCell(snapshot['world_revision'], 'world_revision')) {
    problems.push(
      `${commands} journaled commands; the world revision is ${String(snapshot['world_revision'])}`,
    );
  }
  const commandRevisions = db
    .prepare(
      "SELECT count(*) AS n FROM journal_entries WHERE kind = 'command' AND (revision < 1 OR revision > ?)",
    )
    .get(snapshot['world_revision']) as { n: unknown };
  if (intCell(commandRevisions.n, 'revision range') > 0) {
    problems.push('journaled command revisions are out of range');
  }
  const unissued = db
    .prepare('SELECT count(*) AS n FROM pending_events WHERE sequence >= ?')
    .get(snapshot['next_sequence']) as { n: unknown };
  if (intCell(unissued.n, 'pending sequences') > 0) {
    problems.push('pending events carry sequence numbers that were never issued');
  }
  if (hasCompanyTables(db)) {
    problems.push(...companyStructureProblems(db));
  }
  if (hasRealEstateTables(db)) {
    problems.push(...realEstateStructureProblems(db));
  }
  if (hasFacilitiesTables(db)) {
    problems.push(...facilitiesStructureProblems(db));
  }
  return problems;
}

// ----------------------------------------------------- expected schema

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly table: string;
  readonly sql: string | null;
}

const schemaCache = new WeakMap<readonly Migration[], Map<number, readonly SchemaObject[]>>();

/** The schema objects this build creates for `version`, built in a scratch in-memory database. */
function expectedSchema(
  migrations: readonly Migration[],
  version: number,
): readonly SchemaObject[] {
  let byVersion = schemaCache.get(migrations);
  if (!byVersion) {
    byVersion = new Map();
    schemaCache.set(migrations, byVersion);
  }
  const cached = byVersion.get(version);
  if (cached) {
    return cached;
  }
  const scratch = new Database(':memory:');
  try {
    scratch.defaultSafeIntegers(true);
    applyMigrations(scratch, migrations.slice(0, version), {
      appVersion: 'schema-reference',
      appliedAt: '1970-01-01T00:00:00.000Z',
    });
    const objects = readSchema(scratch);
    byVersion.set(version, objects);
    return objects;
  } finally {
    scratch.close();
  }
}

function readSchema(db: SqliteDatabase): SchemaObject[] {
  return (
    db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[]
  ).map((row) => ({
    type: textCell(row['type'], 'schema type'),
    name: textCell(row['name'], 'schema name'),
    table: textCell(row['tbl_name'], 'schema table'),
    sql: row['sql'] === null ? null : normalizeSql(textCell(row['sql'], 'schema sql')),
  }));
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function compareSchema(db: SqliteDatabase, expected: readonly SchemaObject[]): string[] {
  const actual = new Map(readSchema(db).map((item) => [`${item.type} ${item.name}`, item]));
  const problems: string[] = [];
  for (const item of expected) {
    const key = `${item.type} ${item.name}`;
    const found = actual.get(key);
    if (!found) {
      problems.push(`schema is missing ${key}`);
    } else if (found.sql !== item.sql || found.table !== item.table) {
      problems.push(`schema object ${key} differs from this build's definition`);
    }
    actual.delete(key);
  }
  for (const key of actual.keys()) {
    problems.push(`schema has an unexpected ${key}`);
  }
  return problems;
}
