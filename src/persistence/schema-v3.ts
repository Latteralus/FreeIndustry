/**
 * Save schema version 3 (ADR-0039): the world's real estate — its cities,
 * districts, established businesses and properties, copied from content when
 * the world was created — and the company's leases. Added to the version 2
 * tables by migration 3; worlds saved before Step 07 have no real estate, so
 * the tables start empty.
 *
 * Content rows keep their content order in `position`. A property's floor
 * outline, doors and permitted uses are child rows in order. Who occupies a
 * property is stored once: an established business in `occupant_business_id`,
 * or the company through its active lease (at most one active lease per
 * property, by a partial unique index). Leases reference the company's own
 * obligations and the deposit-refund invoice, so the books and the lease can
 * be joined in plain SQL.
 */
export const SCHEMA_V3 = `
CREATE TABLE real_estate (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  scenario_id TEXT NOT NULL CHECK (length(scenario_id) BETWEEN 1 AND 48),
  scenario_name TEXT NOT NULL CHECK (length(scenario_name) BETWEEN 1 AND 60),
  content_version TEXT NOT NULL CHECK (length(content_version) BETWEEN 1 AND 80)
) STRICT;

CREATE TABLE cities (
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 48),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 60),
  population INTEGER NOT NULL CHECK (population >= 0),
  description TEXT NOT NULL CHECK (length(description) <= 240),
  workforce INTEGER NOT NULL CHECK (workforce BETWEEN 0 AND population),
  unemployment_permille INTEGER NOT NULL CHECK (unemployment_permille BETWEEN 0 AND 1000),
  map_x INTEGER NOT NULL CHECK (map_x BETWEEN 0 AND 1000),
  map_y INTEGER NOT NULL CHECK (map_y BETWEEN 0 AND 1000)
) STRICT;

CREATE TABLE city_wage_rates (
  city_id TEXT NOT NULL REFERENCES cities (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  labor_class TEXT NOT NULL CHECK (labor_class IN ('production', 'warehouse', 'office', 'technical')),
  cents_per_hour INTEGER NOT NULL CHECK (cents_per_hour > 0),
  PRIMARY KEY (city_id, position),
  UNIQUE (city_id, labor_class)
) STRICT;

CREATE TABLE districts (
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 48),
  city_id TEXT NOT NULL REFERENCES cities (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description TEXT NOT NULL CHECK (length(description) <= 240),
  site_width_m INTEGER NOT NULL CHECK (site_width_m >= 1),
  site_depth_m INTEGER NOT NULL CHECK (site_depth_m >= 1),
  highway_access_m INTEGER NOT NULL CHECK (highway_access_m >= 0),
  rail_siding INTEGER NOT NULL CHECK (rail_siding IN (0, 1))
) STRICT;

CREATE TABLE district_streets (
  district_id TEXT NOT NULL REFERENCES districts (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  from_x INTEGER NOT NULL,
  from_y INTEGER NOT NULL,
  to_x INTEGER NOT NULL,
  to_y INTEGER NOT NULL,
  width_m INTEGER NOT NULL CHECK (width_m >= 1),
  PRIMARY KEY (district_id, position)
) STRICT;

CREATE TABLE businesses (
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 48),
  city_id TEXT NOT NULL REFERENCES cities (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  role TEXT NOT NULL CHECK (role IN ('manufacturer', 'supplier', 'buyer')),
  trade TEXT NOT NULL CHECK (length(trade) BETWEEN 1 AND 80)
) STRICT;

CREATE TABLE properties (
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 48),
  district_id TEXT NOT NULL REFERENCES districts (id),
  address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('garage', 'workshop', 'commercial-unit', 'industrial-unit',
    'warehouse', 'factory')),
  description TEXT NOT NULL CHECK (length(description) <= 240),
  site_x_m INTEGER NOT NULL CHECK (site_x_m >= 0),
  site_y_m INTEGER NOT NULL CHECK (site_y_m >= 0),
  clear_height_mm INTEGER NOT NULL CHECK (clear_height_mm > 0),
  floor_load_kg_m2 INTEGER NOT NULL CHECK (floor_load_kg_m2 > 0),
  power_kva INTEGER NOT NULL CHECK (power_kva > 0),
  three_phase INTEGER NOT NULL CHECK (three_phase IN (0, 1)),
  water INTEGER NOT NULL CHECK (water IN (0, 1)),
  gas INTEGER NOT NULL CHECK (gas IN (0, 1)),
  landlord TEXT NOT NULL CHECK (length(landlord) BETWEEN 1 AND 60),
  rent_cents_per_month INTEGER NOT NULL CHECK (rent_cents_per_month > 0),
  deposit_months INTEGER NOT NULL CHECK (deposit_months BETWEEN 1 AND 6),
  min_term_months INTEGER NOT NULL CHECK (min_term_months >= 1),
  max_term_months INTEGER NOT NULL CHECK (max_term_months BETWEEN min_term_months AND 120),
  occupant_business_id TEXT UNIQUE REFERENCES businesses (id)
) STRICT;

CREATE TABLE property_floor_points (
  property_id TEXT NOT NULL REFERENCES properties (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  x_mm INTEGER NOT NULL CHECK (x_mm BETWEEN 0 AND 1000000),
  y_mm INTEGER NOT NULL CHECK (y_mm BETWEEN 0 AND 1000000),
  PRIMARY KEY (property_id, position)
) STRICT;

CREATE TABLE property_doors (
  property_id TEXT NOT NULL REFERENCES properties (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('personnel', 'roller-shutter', 'loading-dock')),
  edge INTEGER NOT NULL CHECK (edge >= 0),
  offset_mm INTEGER NOT NULL CHECK (offset_mm >= 0),
  width_mm INTEGER NOT NULL CHECK (width_mm > 0),
  height_mm INTEGER NOT NULL CHECK (height_mm > 0),
  PRIMARY KEY (property_id, position)
) STRICT;

CREATE TABLE property_uses (
  property_id TEXT NOT NULL REFERENCES properties (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  use TEXT NOT NULL CHECK (use IN ('light-manufacturing', 'general-manufacturing', 'assembly',
    'storage', 'distribution', 'offices')),
  PRIMARY KEY (property_id, position),
  UNIQUE (property_id, use)
) STRICT;

CREATE TABLE leases (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'lease:' || ordinal),
  property_id TEXT NOT NULL REFERENCES properties (id),
  tenant_firm_id TEXT NOT NULL REFERENCES company (firm_id),
  landlord_party_id TEXT NOT NULL REFERENCES counterparties (id),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  ends_at_ms INTEGER NOT NULL CHECK (ends_at_ms > started_at_ms),
  term_months INTEGER NOT NULL CHECK (term_months BETWEEN 1 AND 120),
  rent_cents_per_month INTEGER NOT NULL CHECK (rent_cents_per_month > 0),
  deposit_cents INTEGER NOT NULL CHECK (deposit_cents > 0),
  rent_obligation_id TEXT NOT NULL UNIQUE REFERENCES obligations (id),
  deposit_obligation_id TEXT NOT NULL UNIQUE REFERENCES obligations (id),
  standing_order INTEGER NOT NULL CHECK (standing_order IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
  refund_invoice_id TEXT UNIQUE REFERENCES invoices (id),
  CHECK ((status = 'active') = (ended_at_ms IS NULL)),
  CHECK ((ended_at_ms IS NULL) = (refund_invoice_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX leases_one_active_per_property ON leases (property_id) WHERE status = 'active';
`;
