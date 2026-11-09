/**
 * Save schema version 4 (ADR-0049): the world's facilities — the floor
 * materials and equipment catalog it was built with, every building's
 * structure (levels, columns, walls, obstacles, forbidden zones, utility
 * points, stairs, parcel), the equipment the company owns and where it
 * stands, and the sparse floor-covering layer with its installation records
 * (ADR-0046). Added to the version 3 tables by migration 4; worlds saved
 * before Step 08 have no facilities, so the tables start empty.
 *
 * Catalog rows keep their content order in `position`. Coordinates are
 * integer millimetres; rectangles are (x, y, width, depth). A placed item
 * has all of its placement columns set, or none (held by its dealer). A
 * covering row exists only for a cell whose material differs from the
 * building's starting surface by an installation.
 */
export const SCHEMA_V4 = `
CREATE TABLE facilities (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
) STRICT;

CREATE TABLE floor_materials (
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 48),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  category TEXT NOT NULL CHECK (category IN ('concrete', 'polished-concrete', 'painted-concrete',
    'epoxy', 'steel-plate', 'diamond-plate', 'anti-slip', 'safety-marking', 'office')),
  description TEXT NOT NULL CHECK (length(description) <= 240),
  install_cents_per_m2 INTEGER CHECK (install_cents_per_m2 IS NULL OR install_cents_per_m2 > 0),
  removal_cents_per_m2 INTEGER NOT NULL CHECK (removal_cents_per_m2 >= 0),
  colour TEXT NOT NULL CHECK (length(colour) = 7),
  texture_set TEXT NOT NULL CHECK (length(texture_set) BETWEEN 1 AND 48),
  texture_variants INTEGER NOT NULL CHECK (texture_variants BETWEEN 1 AND 16),
  pattern_x_mm INTEGER NOT NULL CHECK (pattern_x_mm >= 1),
  pattern_y_mm INTEGER NOT NULL CHECK (pattern_y_mm >= 1)
) STRICT;

CREATE TABLE equipment_types (
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 48),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  category TEXT NOT NULL CHECK (category IN ('machining', 'fabrication', 'woodworking', 'plastics',
    'finishing', 'assembly', 'material-handling', 'storage', 'office', 'utility')),
  description TEXT NOT NULL CHECK (length(description) <= 240),
  supplier TEXT NOT NULL CHECK (length(supplier) BETWEEN 1 AND 60),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  relocation_cents INTEGER NOT NULL CHECK (relocation_cents >= 0),
  width_mm INTEGER NOT NULL CHECK (width_mm >= 1),
  depth_mm INTEGER NOT NULL CHECK (depth_mm >= 1),
  height_mm INTEGER NOT NULL CHECK (height_mm >= 1),
  weight_kg INTEGER NOT NULL CHECK (weight_kg >= 1),
  power_va INTEGER NOT NULL CHECK (power_va >= 0),
  three_phase INTEGER NOT NULL CHECK (three_phase IN (0, 1)),
  water INTEGER NOT NULL CHECK (water IN (0, 1)),
  gas INTEGER NOT NULL CHECK (gas IN (0, 1))
) STRICT;

CREATE TABLE equipment_type_uses (
  type_id TEXT NOT NULL REFERENCES equipment_types (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  use TEXT NOT NULL CHECK (use IN ('light-manufacturing', 'general-manufacturing', 'assembly',
    'storage', 'distribution', 'offices')),
  PRIMARY KEY (type_id, position),
  UNIQUE (type_id, use)
) STRICT;

CREATE TABLE equipment_type_zones (
  type_id TEXT NOT NULL REFERENCES equipment_types (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('operator', 'maintenance', 'clearance', 'input', 'output')),
  side TEXT NOT NULL CHECK (side IN ('front', 'back', 'left', 'right')),
  offset_mm INTEGER NOT NULL CHECK (offset_mm >= 0),
  width_mm INTEGER NOT NULL CHECK (width_mm >= 1),
  depth_mm INTEGER NOT NULL CHECK (depth_mm >= 1),
  PRIMARY KEY (type_id, position)
) STRICT;

CREATE TABLE buildings (
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  property_id TEXT NOT NULL UNIQUE REFERENCES properties (id),
  surface_material_id TEXT NOT NULL REFERENCES floor_materials (id),
  parcel_x_mm INTEGER NOT NULL,
  parcel_y_mm INTEGER NOT NULL,
  parcel_width_mm INTEGER NOT NULL CHECK (parcel_width_mm >= 1),
  parcel_depth_mm INTEGER NOT NULL CHECK (parcel_depth_mm >= 1)
) STRICT;

CREATE TABLE building_levels (
  property_id TEXT NOT NULL REFERENCES buildings (property_id),
  level INTEGER NOT NULL CHECK (level >= 0),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  elevation_mm INTEGER NOT NULL CHECK (elevation_mm >= 0),
  deck_depth_mm INTEGER NOT NULL CHECK (deck_depth_mm >= 0),
  clear_height_mm INTEGER NOT NULL CHECK (clear_height_mm > 0),
  floor_load_kg_m2 INTEGER NOT NULL CHECK (floor_load_kg_m2 > 0),
  PRIMARY KEY (property_id, level)
) STRICT;

CREATE TABLE building_level_points (
  property_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  x_mm INTEGER NOT NULL CHECK (x_mm BETWEEN 0 AND 1000000),
  y_mm INTEGER NOT NULL CHECK (y_mm BETWEEN 0 AND 1000000),
  PRIMARY KEY (property_id, level, position),
  FOREIGN KEY (property_id, level) REFERENCES building_levels (property_id, level)
) STRICT;

CREATE TABLE building_features (
  property_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('column', 'wall', 'obstacle', 'forbidden')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  x_mm INTEGER NOT NULL,
  y_mm INTEGER NOT NULL,
  width_mm INTEGER NOT NULL CHECK (width_mm >= 1),
  depth_mm INTEGER NOT NULL CHECK (depth_mm >= 1),
  PRIMARY KEY (property_id, level, position),
  FOREIGN KEY (property_id, level) REFERENCES building_levels (property_id, level)
) STRICT;

CREATE TABLE building_utilities (
  property_id TEXT NOT NULL REFERENCES buildings (property_id),
  position INTEGER NOT NULL CHECK (position >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('power', 'water', 'gas')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  edge INTEGER NOT NULL CHECK (edge >= 0),
  offset_mm INTEGER NOT NULL CHECK (offset_mm >= 0),
  width_mm INTEGER NOT NULL CHECK (width_mm >= 1),
  PRIMARY KEY (property_id, position)
) STRICT;

CREATE TABLE building_stairs (
  property_id TEXT NOT NULL REFERENCES buildings (property_id),
  position INTEGER NOT NULL CHECK (position >= 1),
  upper_level INTEGER NOT NULL CHECK (upper_level >= 1),
  flight_x_mm INTEGER NOT NULL,
  flight_y_mm INTEGER NOT NULL,
  flight_width_mm INTEGER NOT NULL CHECK (flight_width_mm >= 1),
  flight_depth_mm INTEGER NOT NULL CHECK (flight_depth_mm >= 1),
  foot_x_mm INTEGER NOT NULL,
  foot_y_mm INTEGER NOT NULL,
  foot_width_mm INTEGER NOT NULL CHECK (foot_width_mm >= 1),
  foot_depth_mm INTEGER NOT NULL CHECK (foot_depth_mm >= 1),
  head_x_mm INTEGER NOT NULL,
  head_y_mm INTEGER NOT NULL,
  head_width_mm INTEGER NOT NULL CHECK (head_width_mm >= 1),
  head_depth_mm INTEGER NOT NULL CHECK (head_depth_mm >= 1),
  PRIMARY KEY (property_id, position),
  FOREIGN KEY (property_id, upper_level) REFERENCES building_levels (property_id, level)
) STRICT;

CREATE TABLE equipment (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'equipment:' || ordinal),
  type_id TEXT NOT NULL REFERENCES equipment_types (id),
  supplier_party_id TEXT NOT NULL REFERENCES counterparties (id),
  purchase_invoice_id TEXT NOT NULL REFERENCES invoices (id),
  purchased_at_ms INTEGER NOT NULL CHECK (purchased_at_ms >= 0),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  installations INTEGER NOT NULL CHECK (installations >= 0),
  property_id TEXT REFERENCES buildings (property_id),
  level INTEGER,
  x_mm INTEGER CHECK (x_mm IS NULL OR x_mm >= 0),
  y_mm INTEGER CHECK (y_mm IS NULL OR y_mm >= 0),
  rotation INTEGER CHECK (rotation IS NULL OR rotation IN (0, 90, 180, 270)),
  CHECK ((property_id IS NULL) = (level IS NULL)
    AND (property_id IS NULL) = (x_mm IS NULL)
    AND (property_id IS NULL) = (y_mm IS NULL)
    AND (property_id IS NULL) = (rotation IS NULL)),
  FOREIGN KEY (property_id, level) REFERENCES building_levels (property_id, level)
) STRICT;

CREATE INDEX equipment_by_property ON equipment (property_id) WHERE property_id IS NOT NULL;

CREATE TABLE floor_covering_installations (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'floor-installation:' || ordinal),
  property_id TEXT NOT NULL REFERENCES buildings (property_id),
  firm_id TEXT NOT NULL REFERENCES company (firm_id),
  game_time_ms INTEGER NOT NULL CHECK (game_time_ms >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('installation', 'replacement', 'mixed')),
  cells INTEGER NOT NULL CHECK (cells >= 1),
  area_mm2 INTEGER NOT NULL CHECK (area_mm2 > 0),
  cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0),
  journal_entry_id TEXT NOT NULL UNIQUE REFERENCES ledger_entries (id)
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
