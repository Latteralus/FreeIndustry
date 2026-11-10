import { canonicalJson, type JsonValue } from '../shared/canonical-json';
import { SAVE_KINDS, type SaveKind } from '../shared/ipc/saves';
import type { EncodedEvent, EncodedJournalEntry } from '../shared/world-checkpoint';
import type { DiagnosticsState, FiredProbe } from '../domain/diagnostics';
import { isEntityIdOf } from '../domain/ids';
import type { CivilDate } from '../domain/time';
import {
  bigCell,
  int64,
  intCell,
  nullableTextCell,
  textCell,
  type SqliteDatabase,
} from './database';
import { COMPANY_TABLES, readCompany, writeCompany } from './company-repository';
import { FACILITIES_TABLES, readFacilities, writeFacilities } from './facilities-repository';
import { readStock, STOCK_TABLES, writeStock } from './stock-repository';
import { readRealEstate, REAL_ESTATE_TABLES, writeRealEstate } from './real-estate-repository';
import type { AuditDetails, AuditEntry, KernelImage, SaveImage, SaveLabel } from './save-image';

/**
 * Maps a {@link SaveImage} to save-schema tables and back (ADR-0026).
 *
 * `writeWorld` replaces the world's state rows and appends journal entries in
 * one IMMEDIATE transaction: it commits completely or leaves the file exactly
 * as it was. The journal is append-only; a full write (from sequence 1)
 * replaces it, an incremental write (the recovery log) appends a tail that
 * must continue the stored journal exactly.
 */

const STATE_TABLES = [
  ...STOCK_TABLES,
  ...FACILITIES_TABLES,
  ...REAL_ESTATE_TABLES,
  ...COMPANY_TABLES,
  'save_metadata',
  'world_snapshots',
  'worlds',
  'id_counters',
  'rng_streams',
  'pending_events',
  'diagnostics_last_fired',
  'diagnostics_state',
  'workspace_settings',
  'audit_events',
] as const;

export function writeWorld(
  db: SqliteDatabase,
  image: SaveImage,
  label: SaveLabel,
  journalFromSeq = 1,
): void {
  db.transaction(() => {
    writeState(db, image, label);
    writeJournal(db, image, journalFromSeq);
  }).immediate();
}

function writeState(db: SqliteDatabase, image: SaveImage, label: SaveLabel): void {
  const { kernel, identity } = image;
  for (const table of STATE_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare(
    'INSERT INTO save_metadata (singleton, name, kind, saved_at, app_version) VALUES (1, ?, ?, ?, ?)',
  ).run(label.name, label.kind, label.savedAt, label.appVersion);
  db.prepare(
    `INSERT INTO worlds (id, singleton, created_at, kernel_format, rules_id, rules_version,
       rng_algorithm, content_version, seed, epoch_year, epoch_month, epoch_day)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    identity.worldId,
    identity.createdAt,
    kernel.format,
    kernel.rules.id,
    kernel.rules.version,
    kernel.rng,
    identity.contentVersion,
    kernel.config.seed,
    kernel.config.epoch.year,
    kernel.config.epoch.month,
    kernel.config.epoch.day,
  );
  db.prepare(
    `INSERT INTO world_snapshots (world_id, now_ms, world_revision, processed_events,
       next_sequence, journal_length, state_hash, journal_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    identity.worldId,
    int64(kernel.nowMs, 'Simulation time'),
    kernel.worldRevision,
    kernel.processedEvents,
    int64(kernel.nextSequence, 'Next event sequence'),
    kernel.worldRevision + kernel.processedEvents,
    image.fingerprint.stateHash,
    image.fingerprint.journalHash,
  );
  const counter = db.prepare('INSERT INTO id_counters (kind, last_ordinal) VALUES (?, ?)');
  for (const [kind, ordinal] of Object.entries(kernel.ids)) {
    counter.run(kind, ordinal);
  }
  const stream = db.prepare(
    'INSERT INTO rng_streams (name, s0, s1, s2, s3) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [name, words] of Object.entries(kernel.rngStreams)) {
    if (words.length !== 4) {
      throw new RangeError(`Random stream ${name} has ${words.length} state words, not 4`);
    }
    stream.run(name, ...words);
  }
  const event = db.prepare(
    `INSERT INTO pending_events (sequence, event_id, time_ms, priority, type, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const pending of kernel.queue) {
    event.run(
      int64(pending.sequence, 'Event sequence'),
      pending.id,
      int64(pending.timeMs, 'Event time'),
      pending.priority,
      pending.type,
      canonicalJson(pending.payload),
    );
  }
  writeDiagnostics(db, image.domain.diagnostics);
  writeCompany(db, image.domain.company);
  writeRealEstate(db, image.domain.realEstate);
  writeFacilities(db, image.domain.facilities);
  writeStock(db, image.domain.stock);
  const setting = db.prepare('INSERT INTO workspace_settings (key, value_json) VALUES (?, ?)');
  for (const [key, value] of Object.entries(image.workspace)) {
    setting.run(key, canonicalJson(value));
  }
  const audit = db.prepare(
    `INSERT INTO audit_events (id, occurred_at, sim_time_ms, world_revision, kind, details_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  image.audit.forEach((entry, index) => {
    audit.run(
      index + 1,
      entry.occurredAt,
      int64(entry.simTimeMs, 'Audit time'),
      entry.worldRevision,
      entry.kind,
      canonicalJson(entry.details),
    );
  });
}

function writeJournal(db: SqliteDatabase, image: SaveImage, fromSeq: number): void {
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) {
    throw new RangeError(`Journal write must start at a sequence ≥ 1, not ${fromSeq}`);
  }
  if (fromSeq === 1) {
    db.prepare('DELETE FROM journal_facts').run();
    db.prepare('DELETE FROM journal_entries').run();
  } else {
    const stored = journalLength(db);
    if (stored !== fromSeq - 1) {
      throw new Error(
        `Journal append from ${fromSeq} does not continue the ${stored} stored entries`,
      );
    }
  }
  const total = image.kernel.worldRevision + image.kernel.processedEvents;
  if (fromSeq - 1 + image.journal.length !== total) {
    throw new Error(
      `Journal would hold ${fromSeq - 1 + image.journal.length} entries; the world has ${total}`,
    );
  }
  const insert = db.prepare(
    `INSERT INTO journal_entries (seq, kind, at_ms, type, payload_json, revision, command_id,
       fingerprint, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const fact = db.prepare(
    'INSERT INTO journal_facts (seq, ordinal, type, data_json) VALUES (?, ?, ?, ?)',
  );
  image.journal.forEach((entry, index) => {
    if (entry.seq !== fromSeq + index) {
      throw new Error(`Journal entry ${fromSeq + index} has sequence ${entry.seq}`);
    }
    const command = entry.kind === 'command' ? entry : null;
    insert.run(
      entry.seq,
      entry.kind,
      int64(entry.atMs, 'Journal time'),
      entry.type,
      canonicalJson(entry.payload),
      command?.revision ?? null,
      command?.commandId ?? null,
      command?.fingerprint ?? null,
      entry.kind === 'event' ? entry.eventId : null,
    );
    entry.facts.forEach((item, ordinal) => {
      fact.run(entry.seq, ordinal, item.type, canonicalJson(item.data));
    });
  });
}

function writeDiagnostics(db: SqliteDatabase, state: DiagnosticsState): void {
  db.prepare(
    `INSERT INTO diagnostics_state (singleton, probe_count, last_probe_label, pending_probes,
       fired_probes) VALUES (1, ?, ?, ?, ?)`,
  ).run(state.probeCount, state.lastProbeLabel, state.pendingProbes, state.firedProbes);
  const fired = state.lastFiredProbe;
  if (fired) {
    db.prepare(
      `INSERT INTO diagnostics_last_fired (singleton, probe_id, label, token, scheduled_at_ms,
         fired_at_ms) VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(
      fired.probeId,
      fired.label,
      fired.token,
      int64(fired.scheduledAtMs, 'Probe time'),
      int64(fired.firedAtMs, 'Probe time'),
    );
  }
}

export function journalLength(db: SqliteDatabase): number {
  const row = db.prepare('SELECT count(*) AS n FROM journal_entries').get() as { n: unknown };
  return intCell(row.n, 'journal length');
}

// ------------------------------------------------------------------ reads

/** The summary fields a save listing needs, without reading the journal. */
export interface SaveHeader {
  readonly label: SaveLabel;
  readonly worldId: string;
  readonly kernelFormat: number;
  readonly rulesId: string;
  readonly rulesVersion: number;
  readonly rngAlgorithm: string;
  readonly contentVersion: string | null;
  readonly seed: number;
  readonly epoch: CivilDate;
  readonly nowMs: bigint;
  readonly worldRevision: number;
}

type Row = Record<string, unknown>;

function single(db: SqliteDatabase, sql: string, what: string): Row {
  const rows = db.prepare(sql).all() as Row[];
  const [row] = rows;
  if (rows.length !== 1 || !row) {
    throw new Error(`Expected exactly one ${what} row, found ${rows.length}`);
  }
  return row;
}

function readLabel(db: SqliteDatabase): SaveLabel {
  const row = single(db, 'SELECT * FROM save_metadata', 'save metadata');
  return {
    name: textCell(row['name'], 'save name'),
    kind: saveKindOf(row['kind']),
    savedAt: textCell(row['saved_at'], 'saved_at'),
    appVersion: textCell(row['app_version'], 'app_version'),
  };
}

export function readHeader(db: SqliteDatabase): SaveHeader {
  const world = single(db, 'SELECT * FROM worlds', 'world');
  const snapshot = single(db, 'SELECT * FROM world_snapshots', 'world snapshot');
  return {
    label: readLabel(db),
    worldId: textCell(world['id'], 'world id'),
    kernelFormat: intCell(world['kernel_format'], 'kernel_format'),
    rulesId: textCell(world['rules_id'], 'rules_id'),
    rulesVersion: intCell(world['rules_version'], 'rules_version'),
    rngAlgorithm: textCell(world['rng_algorithm'], 'rng_algorithm'),
    contentVersion: nullableTextCell(world['content_version'], 'content_version'),
    seed: intCell(world['seed'], 'seed'),
    epoch: {
      year: intCell(world['epoch_year'], 'epoch_year'),
      month: intCell(world['epoch_month'], 'epoch_month'),
      day: intCell(world['epoch_day'], 'epoch_day'),
    },
    nowMs: bigCell(snapshot['now_ms'], 'now_ms'),
    worldRevision: intCell(snapshot['world_revision'], 'world_revision'),
  };
}

export function readWorld(db: SqliteDatabase): { image: SaveImage; label: SaveLabel } {
  return db.transaction(() => readWorldRows(db)).deferred();
}

function readWorldRows(db: SqliteDatabase): { image: SaveImage; label: SaveLabel } {
  const world = single(db, 'SELECT * FROM worlds', 'world');
  const snapshot = single(db, 'SELECT * FROM world_snapshots', 'world snapshot');
  const kernel: KernelImage = {
    format: intCell(world['kernel_format'], 'kernel_format'),
    rules: {
      id: textCell(world['rules_id'], 'rules_id'),
      version: intCell(world['rules_version'], 'rules_version'),
    },
    rng: textCell(world['rng_algorithm'], 'rng_algorithm'),
    config: {
      seed: intCell(world['seed'], 'seed'),
      epoch: {
        year: intCell(world['epoch_year'], 'epoch_year'),
        month: intCell(world['epoch_month'], 'epoch_month'),
        day: intCell(world['epoch_day'], 'epoch_day'),
      },
    },
    nowMs: bigCell(snapshot['now_ms'], 'now_ms').toString(),
    worldRevision: intCell(snapshot['world_revision'], 'world_revision'),
    processedEvents: intCell(snapshot['processed_events'], 'processed_events'),
    nextSequence: bigCell(snapshot['next_sequence'], 'next_sequence').toString(),
    ids: Object.fromEntries(
      (db.prepare('SELECT kind, last_ordinal FROM id_counters ORDER BY kind').all() as Row[]).map(
        (row) => [textCell(row['kind'], 'id kind'), intCell(row['last_ordinal'], 'last_ordinal')],
      ),
    ),
    rngStreams: Object.fromEntries(
      (db.prepare('SELECT * FROM rng_streams ORDER BY name').all() as Row[]).map((row) => [
        textCell(row['name'], 'stream name'),
        (['s0', 's1', 's2', 's3'] as const).map((word) => intCell(row[word], `stream ${word}`)),
      ]),
    ),
    queue: (
      db.prepare('SELECT * FROM pending_events ORDER BY time_ms, priority, sequence').all() as Row[]
    ).map((row): EncodedEvent => ({
      id: textCell(row['event_id'], 'event_id'),
      timeMs: bigCell(row['time_ms'], 'time_ms').toString(),
      priority: intCell(row['priority'], 'priority'),
      sequence: bigCell(row['sequence'], 'sequence').toString(),
      type: textCell(row['type'], 'event type'),
      payload: jsonCell(row['payload_json'], 'event payload'),
    })),
  };
  return {
    label: readLabel(db),
    image: {
      identity: {
        worldId: textCell(world['id'], 'world id'),
        createdAt: textCell(world['created_at'], 'created_at'),
        contentVersion: nullableTextCell(world['content_version'], 'content_version'),
      },
      kernel,
      domain: {
        diagnostics: readDiagnostics(db),
        company: readCompany(db),
        realEstate: readRealEstate(db),
        facilities: readFacilities(db),
        stock: readStock(db),
      },
      journal: readJournal(db),
      fingerprint: {
        stateHash: textCell(snapshot['state_hash'], 'state_hash'),
        journalHash: textCell(snapshot['journal_hash'], 'journal_hash'),
      },
      workspace: Object.fromEntries(
        (
          db.prepare('SELECT key, value_json FROM workspace_settings ORDER BY key').all() as Row[]
        ).map((row) => [
          textCell(row['key'], 'workspace key'),
          jsonCell(row['value_json'], 'setting'),
        ]),
      ),
      audit: (db.prepare('SELECT * FROM audit_events ORDER BY id').all() as Row[]).map(
        (row): AuditEntry => ({
          occurredAt: textCell(row['occurred_at'], 'occurred_at'),
          simTimeMs: bigCell(row['sim_time_ms'], 'sim_time_ms'),
          worldRevision: intCell(row['world_revision'], 'world_revision'),
          kind: textCell(row['kind'], 'audit kind'),
          details: auditDetailsOf(jsonCell(row['details_json'], 'audit details')),
        }),
      ),
    },
  };
}

function readJournal(db: SqliteDatabase): EncodedJournalEntry[] {
  const facts = new Map<number, { type: string; data: JsonValue }[]>();
  for (const row of db
    .prepare('SELECT seq, type, data_json FROM journal_facts ORDER BY seq, ordinal')
    .iterate() as Iterable<Row>) {
    const seq = intCell(row['seq'], 'fact seq');
    const list = facts.get(seq) ?? [];
    list.push({
      type: textCell(row['type'], 'fact type'),
      data: jsonCell(row['data_json'], 'fact'),
    });
    facts.set(seq, list);
  }
  const entries: EncodedJournalEntry[] = [];
  for (const row of db
    .prepare('SELECT * FROM journal_entries ORDER BY seq')
    .iterate() as Iterable<Row>) {
    const seq = intCell(row['seq'], 'journal seq');
    const common = {
      seq,
      atMs: bigCell(row['at_ms'], 'at_ms').toString(),
      type: textCell(row['type'], 'journal type'),
      payload: jsonCell(row['payload_json'], 'journal payload'),
      facts: facts.get(seq) ?? [],
    };
    entries.push(
      row['kind'] === 'command'
        ? {
            kind: 'command',
            ...common,
            revision: intCell(row['revision'], 'revision'),
            commandId: textCell(row['command_id'], 'command_id'),
            fingerprint: textCell(row['fingerprint'], 'fingerprint'),
          }
        : { kind: 'event', ...common, eventId: textCell(row['event_id'], 'event_id') },
    );
  }
  return entries;
}

function readDiagnostics(db: SqliteDatabase): DiagnosticsState {
  const row = single(db, 'SELECT * FROM diagnostics_state', 'diagnostics state');
  const firedRows = db.prepare('SELECT * FROM diagnostics_last_fired').all() as Row[];
  const [fired] = firedRows;
  if (firedRows.length > 1) {
    throw new Error(`Expected at most one last fired probe, found ${firedRows.length}`);
  }
  return {
    probeCount: intCell(row['probe_count'], 'probe_count'),
    lastProbeLabel: nullableTextCell(row['last_probe_label'], 'last_probe_label'),
    pendingProbes: intCell(row['pending_probes'], 'pending_probes'),
    firedProbes: intCell(row['fired_probes'], 'fired_probes'),
    lastFiredProbe: fired ? firedProbeOf(fired) : null,
  };
}

function firedProbeOf(row: Row): FiredProbe {
  const probeId = textCell(row['probe_id'], 'probe_id');
  if (!isEntityIdOf('probe', probeId)) {
    throw new Error(`Last fired probe has an invalid ID ${JSON.stringify(probeId)}`);
  }
  return {
    probeId,
    label: textCell(row['label'], 'probe label'),
    token: intCell(row['token'], 'token'),
    scheduledAtMs: bigCell(row['scheduled_at_ms'], 'scheduled_at_ms'),
    firedAtMs: bigCell(row['fired_at_ms'], 'fired_at_ms'),
  };
}

export function jsonCell(value: unknown, what: string): JsonValue {
  return JSON.parse(textCell(value, what)) as JsonValue;
}

function saveKindOf(value: unknown): SaveKind {
  const kind = SAVE_KINDS.find((candidate) => candidate === value);
  if (!kind) {
    throw new Error(`Unknown save kind ${JSON.stringify(value)}`);
  }
  return kind;
}

function auditDetailsOf(value: JsonValue): AuditDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Audit details must be an object');
  }
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'object' && item !== null) {
      throw new Error(`Audit detail ${key} must be a scalar`);
    }
    details[key] = item;
  }
  return details;
}
