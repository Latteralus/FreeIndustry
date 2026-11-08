/**
 * Save schema version 1 (ADR-0026). One file holds exactly one world. Core
 * state is relational, not an opaque blob (spec §10.2): kernel state, the
 * pending event queue, random streams, ID counters, the journal and its facts,
 * and one table group per domain slice. JSON columns hold only free-form
 * payloads (command, event and fact data), which their own schemas validate.
 *
 * Logical names from spec §10.2: `worlds`, `world_snapshots` and
 * `schema_migrations` as written; `save_metadata` as written; the spec's
 * `command_log` and `simulation_events` are the two kinds of
 * `journal_entries`; the pending event queue is `pending_events`.
 *
 * All integers are SQLite 64-bit INTEGERs read as `bigint`. Times are
 * simulated milliseconds since the world epoch. Wall-clock timestamps
 * (`*_at` TEXT, ISO 8601) are informational only and never affect play.
 */
export const SCHEMA_V1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL
) STRICT;

CREATE TABLE save_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'autosave', 'recovered')),
  saved_at TEXT NOT NULL,
  app_version TEXT NOT NULL
) STRICT;

CREATE TABLE worlds (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  singleton INTEGER NOT NULL UNIQUE CHECK (singleton = 1),
  created_at TEXT NOT NULL,
  kernel_format INTEGER NOT NULL CHECK (kernel_format >= 1),
  rules_id TEXT NOT NULL,
  rules_version INTEGER NOT NULL CHECK (rules_version >= 1),
  rng_algorithm TEXT NOT NULL,
  content_version TEXT,
  seed INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  epoch_year INTEGER NOT NULL CHECK (epoch_year BETWEEN 1 AND 9999),
  epoch_month INTEGER NOT NULL CHECK (epoch_month BETWEEN 1 AND 12),
  epoch_day INTEGER NOT NULL CHECK (epoch_day BETWEEN 1 AND 31)
) STRICT;

CREATE TABLE world_snapshots (
  world_id TEXT PRIMARY KEY REFERENCES worlds (id),
  now_ms INTEGER NOT NULL CHECK (now_ms >= 0),
  world_revision INTEGER NOT NULL CHECK (world_revision >= 0),
  processed_events INTEGER NOT NULL CHECK (processed_events >= 0),
  next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
  journal_length INTEGER NOT NULL CHECK (journal_length = world_revision + processed_events),
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 64),
  journal_hash TEXT NOT NULL CHECK (length(journal_hash) = 64)
) STRICT;

CREATE TABLE id_counters (
  kind TEXT PRIMARY KEY CHECK (length(kind) BETWEEN 1 AND 32),
  last_ordinal INTEGER NOT NULL CHECK (last_ordinal >= 1)
) STRICT;

CREATE TABLE rng_streams (
  name TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 32),
  s0 INTEGER NOT NULL CHECK (s0 BETWEEN 0 AND 4294967295),
  s1 INTEGER NOT NULL CHECK (s1 BETWEEN 0 AND 4294967295),
  s2 INTEGER NOT NULL CHECK (s2 BETWEEN 0 AND 4294967295),
  s3 INTEGER NOT NULL CHECK (s3 BETWEEN 0 AND 4294967295),
  CHECK (s0 + s1 + s2 + s3 > 0)
) STRICT;

CREATE TABLE pending_events (
  sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),
  event_id TEXT NOT NULL UNIQUE,
  time_ms INTEGER NOT NULL CHECK (time_ms >= 0),
  priority INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX pending_events_by_order ON pending_events (time_ms, priority, sequence);

CREATE TABLE journal_entries (
  seq INTEGER PRIMARY KEY CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('command', 'event')),
  at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  revision INTEGER UNIQUE,
  command_id TEXT UNIQUE,
  fingerprint TEXT,
  event_id TEXT UNIQUE,
  CHECK (
    (kind = 'command' AND revision >= 1 AND command_id IS NOT NULL
      AND fingerprint IS NOT NULL AND event_id IS NULL)
    OR (kind = 'event' AND event_id IS NOT NULL
      AND revision IS NULL AND command_id IS NULL AND fingerprint IS NULL)
  )
) STRICT;

CREATE INDEX journal_entries_by_type ON journal_entries (type, seq);

CREATE TABLE journal_facts (
  seq INTEGER NOT NULL REFERENCES journal_entries (seq),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (seq, ordinal)
) STRICT;

CREATE INDEX journal_facts_by_type ON journal_facts (type, seq);

CREATE TABLE diagnostics_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  probe_count INTEGER NOT NULL CHECK (probe_count >= 0),
  last_probe_label TEXT,
  pending_probes INTEGER NOT NULL CHECK (pending_probes >= 0),
  fired_probes INTEGER NOT NULL CHECK (fired_probes >= 0)
) STRICT;

CREATE TABLE diagnostics_last_fired (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  probe_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token INTEGER NOT NULL CHECK (token BETWEEN 0 AND 4294967295),
  scheduled_at_ms INTEGER NOT NULL CHECK (scheduled_at_ms >= 0),
  fired_at_ms INTEGER NOT NULL CHECK (fired_at_ms >= scheduled_at_ms)
) STRICT;

CREATE TABLE workspace_settings (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value_json TEXT NOT NULL CHECK (json_valid(value_json))
) STRICT;

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY CHECK (id >= 1),
  occurred_at TEXT NOT NULL,
  sim_time_ms INTEGER NOT NULL CHECK (sim_time_ms >= 0),
  world_revision INTEGER NOT NULL CHECK (world_revision >= 0),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  details_json TEXT NOT NULL CHECK (json_valid(details_json))
) STRICT;

CREATE TABLE recovery_commands (
  revision INTEGER PRIMARY KEY CHECK (revision >= 1),
  at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
  command_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE TABLE recovery_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  now_ms INTEGER NOT NULL CHECK (now_ms >= 0)
) STRICT;
`;
