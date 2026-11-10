/**
 * Save schema version 6 (ADR-0056): physical stock (plan Step 10). The
 * product and container catalogs the world was built with; every receipt,
 * load unit and lot, with each lot's parents and serials; every movement,
 * with its lot quantities and the load units it placed or moved; and the
 * reservations held on lots (spec §10.2 `locations`, `stock_lots`,
 * `serialized_items`, `load_units`, `lot_contents`, `stock_movements`,
 * `stock_reservations`).
 *
 * A load unit's location is one of three shapes, enforced by a CHECK: on a
 * floor (property, level, x, y, rotation), in or on another load unit, or at
 * an equipment port. A lot is in exactly one load unit while open and in
 * none once closed. A receipt's lots and load units are those that name it,
 * in order. Quantities are millionths of the product's base unit; masses are
 * milligrams (products) or grams (containers); volumes mm³.
 *
 * Added to the version 5 tables by migration 6. No build before Step 10 had
 * stock, so the tables start empty.
 */

/** Columns of one stock location, prefixed `from_` or `to_`, all nullable. */
function locationColumns(prefix: 'from' | 'to'): string {
  return `
  ${prefix}_kind TEXT CHECK (${prefix}_kind IS NULL OR ${prefix}_kind IN ('floor', 'load-unit', 'equipment')),
  ${prefix}_property_id TEXT,
  ${prefix}_level INTEGER,
  ${prefix}_x_mm INTEGER,
  ${prefix}_y_mm INTEGER,
  ${prefix}_rotation INTEGER CHECK (${prefix}_rotation IS NULL OR ${prefix}_rotation IN (0, 90, 180, 270)),
  ${prefix}_load_unit_id TEXT,
  ${prefix}_equipment_id TEXT,
  ${prefix}_zone INTEGER`;
}

/** The location columns hold exactly one shape (or none, for an empty `from_`). */
function locationShape(prefix: string): string {
  const floor = ['property_id', 'level', 'x_mm', 'y_mm', 'rotation'];
  const parent = ['load_unit_id'];
  const port = ['equipment_id', 'zone'];
  const set = (columns: readonly string[]) =>
    columns.map((column) => `${prefix}_${column} IS NOT NULL`).join(' AND ');
  const unset = (columns: readonly string[]) =>
    columns.map((column) => `${prefix}_${column} IS NULL`).join(' AND ');
  return [
    `(${prefix}_kind IS NULL AND ${unset([...floor, ...parent, ...port])})`,
    `(${prefix}_kind = 'floor' AND ${set(floor)} AND ${unset([...parent, ...port])})`,
    `(${prefix}_kind = 'load-unit' AND ${set(parent)} AND ${unset([...floor, ...port])})`,
    `(${prefix}_kind = 'equipment' AND ${set(port)} AND ${unset([...floor, ...parent])})`,
  ].join(' OR ');
}

export const SCHEMA_V6 = `
CREATE TABLE stock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
) STRICT;

CREATE TABLE products (
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 48),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  category TEXT NOT NULL CHECK (category IN ('lumber', 'sheet-goods', 'hardware', 'metal',
    'plastics', 'coatings', 'components')),
  description TEXT NOT NULL CHECK (length(description) <= 240),
  unit TEXT NOT NULL CHECK (unit IN ('each', 'kg', 'L')),
  form TEXT NOT NULL CHECK (form IN ('item', 'bulk', 'liquid')),
  tracking TEXT NOT NULL CHECK (tracking IN ('lot', 'serialized')),
  quantum_micro INTEGER NOT NULL CHECK (quantum_micro BETWEEN 1 AND 1000000),
  item_width_mm INTEGER CHECK (item_width_mm IS NULL OR item_width_mm >= 1),
  item_depth_mm INTEGER CHECK (item_depth_mm IS NULL OR item_depth_mm >= 1),
  item_height_mm INTEGER CHECK (item_height_mm IS NULL OR item_height_mm >= 1),
  mass_per_quantum_mg INTEGER NOT NULL CHECK (mass_per_quantum_mg >= 1),
  volume_per_quantum_mm3 INTEGER NOT NULL CHECK (volume_per_quantum_mm3 >= 1),
  colour TEXT NOT NULL CHECK (length(colour) = 7),
  CHECK ((item_width_mm IS NULL) = (item_depth_mm IS NULL)
    AND (item_width_mm IS NULL) = (item_height_mm IS NULL)
    AND (item_width_mm IS NOT NULL) = (form = 'item'))
) STRICT;

CREATE TABLE product_pack_units (
  product_id TEXT NOT NULL REFERENCES products (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 48),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  quanta INTEGER NOT NULL CHECK (quanta >= 1),
  PRIMARY KEY (product_id, position),
  UNIQUE (product_id, id)
) STRICT;

CREATE TABLE product_grades (
  product_id TEXT NOT NULL REFERENCES products (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 48),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  PRIMARY KEY (product_id, position),
  UNIQUE (product_id, code)
) STRICT;

CREATE TABLE container_types (
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 48),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('pallet', 'crate', 'carton', 'tote', 'drum', 'bulk-bag',
    'cart', 'machine-buffer')),
  description TEXT NOT NULL CHECK (length(description) <= 240),
  outer_width_mm INTEGER NOT NULL CHECK (outer_width_mm >= 1),
  outer_depth_mm INTEGER NOT NULL CHECK (outer_depth_mm >= 1),
  outer_height_mm INTEGER NOT NULL CHECK (outer_height_mm >= 1),
  inner_width_mm INTEGER NOT NULL CHECK (inner_width_mm >= 1),
  inner_depth_mm INTEGER NOT NULL CHECK (inner_depth_mm >= 1),
  inner_height_mm INTEGER NOT NULL CHECK (inner_height_mm >= 1),
  tare_mass_g INTEGER NOT NULL CHECK (tare_mass_g >= 1),
  payload_mass_g INTEGER NOT NULL CHECK (payload_mass_g >= 1),
  mixing TEXT NOT NULL CHECK (mixing IN ('mixed', 'single-product', 'single-lot')),
  colour TEXT NOT NULL CHECK (length(colour) = 7)
) STRICT;

CREATE TABLE container_type_holds (
  type_id TEXT NOT NULL REFERENCES container_types (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  form TEXT NOT NULL CHECK (form IN ('item', 'bulk', 'liquid')),
  PRIMARY KEY (type_id, position),
  UNIQUE (type_id, form)
) STRICT;

CREATE TABLE container_type_carries (
  type_id TEXT NOT NULL REFERENCES container_types (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('pallet', 'crate', 'carton', 'tote', 'drum', 'bulk-bag',
    'cart', 'machine-buffer')),
  PRIMARY KEY (type_id, position),
  UNIQUE (type_id, kind)
) STRICT;

CREATE TABLE stock_receipts (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'stock-receipt:' || ordinal),
  kind TEXT NOT NULL CHECK (kind = 'diagnostic'),
  game_time_ms INTEGER NOT NULL CHECK (game_time_ms >= 0),
  supplier_party_id TEXT NOT NULL REFERENCES counterparties (id),
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices (id),
  cost_cents INTEGER NOT NULL CHECK (cost_cents > 0),
  property_id TEXT NOT NULL REFERENCES properties (id),
  door_index INTEGER NOT NULL CHECK (door_index >= 0),
  product_id TEXT NOT NULL REFERENCES products (id),
  quantity_micro INTEGER NOT NULL CHECK (quantity_micro > 0)
) STRICT;

CREATE TABLE load_units (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'load-unit:' || ordinal),
  type_id TEXT NOT NULL REFERENCES container_types (id),
  owner_firm_id TEXT NOT NULL REFERENCES company (firm_id),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  receipt_id TEXT REFERENCES stock_receipts (id),
  location_kind TEXT NOT NULL CHECK (location_kind IN ('floor', 'load-unit', 'equipment')),
  property_id TEXT,
  level INTEGER,
  x_mm INTEGER CHECK (x_mm IS NULL OR x_mm >= 0),
  y_mm INTEGER CHECK (y_mm IS NULL OR y_mm >= 0),
  rotation INTEGER CHECK (rotation IS NULL OR rotation IN (0, 90, 180, 270)),
  parent_load_unit_id TEXT REFERENCES load_units (id) DEFERRABLE INITIALLY DEFERRED
    CHECK (parent_load_unit_id IS NOT id),
  equipment_id TEXT REFERENCES equipment (id),
  zone_index INTEGER CHECK (zone_index IS NULL OR zone_index >= 0),
  CHECK ((location_kind = 'floor') = (property_id IS NOT NULL AND level IS NOT NULL
      AND x_mm IS NOT NULL AND y_mm IS NOT NULL AND rotation IS NOT NULL)
    AND (location_kind = 'floor' OR (property_id IS NULL AND level IS NULL AND x_mm IS NULL
      AND y_mm IS NULL AND rotation IS NULL))
    AND (location_kind = 'load-unit') = (parent_load_unit_id IS NOT NULL)
    AND (location_kind = 'equipment') = (equipment_id IS NOT NULL)
    AND (equipment_id IS NULL) = (zone_index IS NULL)),
  FOREIGN KEY (property_id, level) REFERENCES building_levels (property_id, level)
) STRICT;

CREATE TABLE stock_lots (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'lot:' || ordinal),
  product_id TEXT NOT NULL REFERENCES products (id),
  owner_firm_id TEXT NOT NULL REFERENCES company (firm_id),
  grade TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('available', 'scrap')),
  quantity_micro INTEGER NOT NULL CHECK (quantity_micro >= 0),
  cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0),
  load_unit_id TEXT REFERENCES load_units (id),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('receipt', 'split', 'merge')),
  origin_receipt_id TEXT REFERENCES stock_receipts (id),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  closed_at_ms INTEGER CHECK (closed_at_ms IS NULL OR closed_at_ms >= created_at_ms),
  closed_reason TEXT CHECK (closed_reason IS NULL OR closed_reason IN ('merged', 'lost')),
  closed_into_lot_id TEXT REFERENCES stock_lots (id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((origin_kind = 'receipt') = (origin_receipt_id IS NOT NULL)),
  CHECK ((closed_at_ms IS NULL) = (closed_reason IS NULL)),
  CHECK ((closed_at_ms IS NULL) = (load_unit_id IS NOT NULL)),
  CHECK (closed_at_ms IS NULL OR quantity_micro = 0),
  CHECK ((closed_reason IS 'merged') = (closed_into_lot_id IS NOT NULL)),
  CHECK (disposition = 'available' OR cost_cents = 0),
  FOREIGN KEY (product_id, grade) REFERENCES product_grades (product_id, code)
) STRICT;

CREATE TABLE stock_lot_parents (
  lot_id TEXT NOT NULL REFERENCES stock_lots (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  parent_lot_id TEXT NOT NULL REFERENCES stock_lots (id) CHECK (parent_lot_id IS NOT lot_id),
  PRIMARY KEY (lot_id, position),
  UNIQUE (lot_id, parent_lot_id)
) STRICT;

CREATE TABLE stock_lot_serials (
  lot_id TEXT NOT NULL REFERENCES stock_lots (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  serial_id TEXT NOT NULL UNIQUE CHECK (serial_id GLOB 'serial:[1-9]*'),
  PRIMARY KEY (lot_id, position)
) STRICT;

CREATE TABLE stock_movements (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'stock-move:' || ordinal),
  game_time_ms INTEGER NOT NULL CHECK (game_time_ms >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'transfer', 'split', 'merge', 'relocation',
    'scrap', 'loss')),
  handler_kind TEXT NOT NULL CHECK (handler_kind IN ('supplier', 'company', 'employee')),
  handler_id TEXT CHECK ((handler_kind = 'company') = (handler_id IS NULL)),
  reason TEXT CHECK (reason IS NULL OR reason IN ('damaged', 'defective', 'contaminated',
    'obsolete', 'destroyed', 'spilled', 'missing')),
  receipt_id TEXT UNIQUE REFERENCES stock_receipts (id),
  entry_id TEXT UNIQUE REFERENCES ledger_entries (id),
  cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0),
  CHECK ((kind = 'receipt') = (receipt_id IS NOT NULL)),
  CHECK ((entry_id IS NULL) = (cost_cents = 0)),
  CHECK ((kind IN ('scrap', 'loss')) = (reason IS NOT NULL))
) STRICT;

CREATE TABLE stock_movement_lines (
  movement_id TEXT NOT NULL REFERENCES stock_movements (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  lot_id TEXT NOT NULL REFERENCES stock_lots (id),
  quantity_micro INTEGER NOT NULL CHECK (quantity_micro > 0),
  from_load_unit_id TEXT REFERENCES load_units (id),
  to_load_unit_id TEXT REFERENCES load_units (id),
  result_lot_id TEXT REFERENCES stock_lots (id),
  PRIMARY KEY (movement_id, position)
) STRICT;

CREATE TABLE stock_movement_units (
  movement_id TEXT NOT NULL REFERENCES stock_movements (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  load_unit_id TEXT NOT NULL REFERENCES load_units (id),${locationColumns('from')},${locationColumns('to')},
  CHECK (${locationShape('from')}),
  CHECK (${locationShape('to')}),
  CHECK (to_kind IS NOT NULL),
  PRIMARY KEY (movement_id, position)
) STRICT;

CREATE TABLE stock_reservations (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'stock-reservation:' || ordinal),
  lot_id TEXT NOT NULL REFERENCES stock_lots (id),
  quantity_micro INTEGER NOT NULL CHECK (quantity_micro > 0),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 60),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;
`;
