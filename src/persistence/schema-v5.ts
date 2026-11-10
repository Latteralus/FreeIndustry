/**
 * Save schema version 5 (ADR-0052): floor-covering orders become the floor
 * contractor's jobs. An order records its level and material, when it
 * completes, whether it is still under way, how many of its cells replaced
 * an installed material, its installation and removal charges separately,
 * and exactly which cells change, as row runs in
 * `floor_covering_installation_runs`.
 *
 * Migration 5 rebuilds the two covering tables. No build before Step 09A
 * could create an installation or a covering, so its precondition requires
 * both tables to be empty, and nothing is copied.
 */
export const SCHEMA_V5 = `
DROP TABLE floor_cell_coverings;
DROP TABLE floor_covering_installations;

CREATE TABLE floor_covering_installations (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'floor-installation:' || ordinal),
  property_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  material_id TEXT NOT NULL REFERENCES floor_materials (id),
  firm_id TEXT NOT NULL REFERENCES company (firm_id),
  game_time_ms INTEGER NOT NULL CHECK (game_time_ms >= 0),
  completes_at_ms INTEGER NOT NULL CHECK (completes_at_ms > game_time_ms),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'complete')),
  kind TEXT NOT NULL CHECK (kind IN ('installation', 'replacement', 'mixed')),
  cells INTEGER NOT NULL CHECK (cells >= 1),
  area_mm2 INTEGER NOT NULL CHECK (area_mm2 > 0),
  replaced_cells INTEGER NOT NULL CHECK (replaced_cells BETWEEN 0 AND cells),
  replaced_area_mm2 INTEGER NOT NULL CHECK (replaced_area_mm2 BETWEEN 0 AND area_mm2),
  install_cents INTEGER NOT NULL CHECK (install_cents > 0),
  removal_cents INTEGER NOT NULL CHECK (removal_cents >= 0),
  cost_cents INTEGER NOT NULL CHECK (cost_cents = install_cents + removal_cents),
  journal_entry_id TEXT NOT NULL UNIQUE REFERENCES ledger_entries (id),
  FOREIGN KEY (property_id, level) REFERENCES building_levels (property_id, level)
) STRICT;

CREATE TABLE floor_covering_installation_runs (
  installation_id TEXT NOT NULL REFERENCES floor_covering_installations (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  row INTEGER NOT NULL CHECK (row >= 0),
  first_col INTEGER NOT NULL CHECK (first_col >= 0),
  end_col INTEGER NOT NULL CHECK (end_col > first_col),
  PRIMARY KEY (installation_id, position)
) STRICT;

CREATE TABLE floor_cell_coverings (
  property_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  col INTEGER NOT NULL CHECK (col >= 0),
  row INTEGER NOT NULL CHECK (row >= 0),
  material_id TEXT NOT NULL REFERENCES floor_materials (id),
  installation_id TEXT NOT NULL REFERENCES floor_covering_installations (id),
  PRIMARY KEY (property_id, level, col, row),
  FOREIGN KEY (property_id, level) REFERENCES building_levels (property_id, level)
) STRICT;
`;
