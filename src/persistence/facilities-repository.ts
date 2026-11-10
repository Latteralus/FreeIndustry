import {
  EQUIPMENT_CATEGORIES,
  SIDES,
  ZONE_KINDS,
  type Equipment,
  type EquipmentType,
} from '../domain/equipment';
import type { Facilities } from '../domain/facilities';
import { FEATURE_KINDS, UTILITY_KINDS, type Building, type Level } from '../domain/facility';
import {
  FLOOR_MATERIAL_CATEGORIES,
  INSTALLATION_KINDS,
  INSTALLATION_STATUSES,
  type CellRun,
  type CoveringInstallation,
  type FloorCovering,
  type FloorMaterial,
} from '../domain/floor-covering';
import { isEntityIdOf, parseEntityId, type EntityId } from '../domain/ids';
import { PERMITTED_USES } from '../domain/real-estate';
import type { RectMm } from '../domain/region';
import { bigCell, int64, intCell, textCell, type SqliteDatabase } from './database';

/**
 * Maps the facilities slice to the save-format-4 tables (ADR-0049) and back.
 * Writes happen inside `writeWorld`'s transaction. Reads validate every
 * enumerated value and ID kind; the kernel then checks the business
 * invariants and the fingerprints on load.
 */

/** Facilities tables, children before parents, so they can be cleared in this order. */
export const FACILITIES_TABLES = [
  'floor_cell_coverings',
  'floor_covering_installation_runs',
  'floor_covering_installations',
  'equipment',
  'building_stairs',
  'building_utilities',
  'building_features',
  'building_level_points',
  'building_levels',
  'buildings',
  'equipment_type_zones',
  'equipment_type_uses',
  'equipment_types',
  'floor_materials',
  'facilities',
] as const;

type Row = Record<string, unknown>;

const flag = (value: boolean) => (value ? 1 : 0);

function ordinalOf(id: string): number {
  const ordinal = parseEntityId(id)?.ordinal;
  if (ordinal === undefined) {
    throw new Error(`${id} is not an entity ID`);
  }
  return ordinal;
}

export function writeFacilities(db: SqliteDatabase, facilities: Facilities | null): void {
  if (!facilities) {
    return;
  }
  db.prepare('INSERT INTO facilities (singleton) VALUES (1)').run();

  const material = db.prepare(
    `INSERT INTO floor_materials (position, id, name, category, description, install_cents_per_m2,
       removal_cents_per_m2, colour, texture_set, texture_variants, pattern_x_mm, pattern_y_mm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  facilities.floorMaterials.forEach((item, index) => {
    material.run(
      index + 1,
      item.id,
      item.name,
      item.category,
      item.description,
      item.installCentsPerM2 === null ? null : int64(item.installCentsPerM2, 'Install price'),
      int64(item.removalCentsPerM2, 'Removal price'),
      item.colour,
      item.textureSet,
      item.textureVariants,
      item.patternMm.x,
      item.patternMm.y,
    );
  });

  const type = db.prepare(
    `INSERT INTO equipment_types (position, id, name, category, description, supplier, price_cents,
       relocation_cents, width_mm, depth_mm, height_mm, weight_kg, power_va, three_phase, water, gas)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const use = db.prepare(
    'INSERT INTO equipment_type_uses (type_id, position, use) VALUES (?, ?, ?)',
  );
  const zone = db.prepare(
    `INSERT INTO equipment_type_zones (type_id, position, kind, side, offset_mm, width_mm, depth_mm)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  facilities.equipmentTypes.forEach((item, index) => {
    type.run(
      index + 1,
      item.id,
      item.name,
      item.category,
      item.description,
      item.supplier,
      int64(item.priceCents, 'Equipment price'),
      int64(item.relocationCents, 'Relocation charge'),
      item.widthMm,
      item.depthMm,
      item.heightMm,
      item.weightKg,
      item.powerVa,
      flag(item.threePhase),
      flag(item.water),
      flag(item.gas),
    );
    item.uses.forEach((permitted, position) => {
      use.run(item.id, position + 1, permitted);
    });
    item.zones.forEach((z, position) => {
      zone.run(item.id, position + 1, z.kind, z.side, z.offsetMm, z.widthMm, z.depthMm);
    });
  });

  const building = db.prepare(
    `INSERT INTO buildings (position, property_id, surface_material_id, parcel_x_mm, parcel_y_mm,
       parcel_width_mm, parcel_depth_mm) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const level = db.prepare(
    `INSERT INTO building_levels (property_id, level, name, elevation_mm, deck_depth_mm,
       clear_height_mm, floor_load_kg_m2) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const point = db.prepare(
    'INSERT INTO building_level_points (property_id, level, position, x_mm, y_mm) VALUES (?, ?, ?, ?, ?)',
  );
  const feature = db.prepare(
    `INSERT INTO building_features (property_id, level, position, kind, label, x_mm, y_mm, width_mm,
       depth_mm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const utility = db.prepare(
    `INSERT INTO building_utilities (property_id, position, kind, label, edge, offset_mm, width_mm)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const stair = db.prepare(
    `INSERT INTO building_stairs (property_id, position, upper_level, flight_x_mm, flight_y_mm,
       flight_width_mm, flight_depth_mm, foot_x_mm, foot_y_mm, foot_width_mm, foot_depth_mm,
       head_x_mm, head_y_mm, head_width_mm, head_depth_mm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const r4 = (r: RectMm) => [r.x, r.y, r.width, r.depth] as const;
  facilities.buildings.forEach((item, index) => {
    building.run(index + 1, item.propertyId, item.surfaceMaterialId, ...r4(item.parcel));
    for (const floor of item.levels) {
      level.run(
        item.propertyId,
        floor.index,
        floor.name,
        floor.elevationMm,
        floor.deckDepthMm,
        floor.clearHeightMm,
        floor.floorLoadKgPerM2,
      );
      floor.floor.forEach((corner, position) => {
        point.run(item.propertyId, floor.index, position + 1, corner.x, corner.y);
      });
      floor.features.forEach((f, position) => {
        feature.run(item.propertyId, floor.index, position + 1, f.kind, f.label, ...r4(f.rect));
      });
    }
    item.utilities.forEach((u, position) => {
      utility.run(item.propertyId, position + 1, u.kind, u.label, u.edge, u.offsetMm, u.widthMm);
    });
    item.stairs.forEach((s, position) => {
      stair.run(
        item.propertyId,
        position + 1,
        s.upperLevel,
        ...r4(s.flight),
        ...r4(s.foot),
        ...r4(s.head),
      );
    });
  });

  const equipment = db.prepare(
    `INSERT INTO equipment (ordinal, id, type_id, supplier_party_id, purchase_invoice_id,
       purchased_at_ms, price_cents, installations, property_id, level, x_mm, y_mm, rotation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of facilities.equipment) {
    const placed = item.placement;
    equipment.run(
      ordinalOf(item.id),
      item.id,
      item.typeId,
      item.supplierPartyId,
      item.purchaseInvoiceId,
      int64(item.purchasedAtMs, 'Purchase time'),
      int64(item.priceCents, 'Equipment price'),
      item.installations,
      placed?.propertyId ?? null,
      placed?.level ?? null,
      placed?.xMm ?? null,
      placed?.yMm ?? null,
      placed?.rotation ?? null,
    );
  }

  const installation = db.prepare(
    `INSERT INTO floor_covering_installations (ordinal, id, property_id, level, material_id,
       firm_id, game_time_ms, completes_at_ms, status, kind, cells, area_mm2, replaced_cells,
       replaced_area_mm2, install_cents, removal_cents, cost_cents, journal_entry_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const run = db.prepare(
    `INSERT INTO floor_covering_installation_runs (installation_id, position, row, first_col, end_col)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const item of facilities.installations) {
    installation.run(
      ordinalOf(item.id),
      item.id,
      item.propertyId,
      item.level,
      item.materialId,
      item.firmId,
      int64(item.atMs, 'Installation time'),
      int64(item.completesAtMs, 'Installation completion'),
      item.status,
      item.kind,
      item.cells,
      int64(item.areaMm2, 'Installation area'),
      item.replacedCells,
      int64(item.replacedAreaMm2, 'Installation replaced area'),
      int64(item.installCents, 'Installation charge'),
      int64(item.removalCents, 'Removal charge'),
      int64(item.costCents, 'Installation cost'),
      item.journalEntryId,
    );
    item.runs.forEach(([row, from, to], index) => {
      run.run(item.id, index + 1, row, from, to);
    });
  }
  const covering = db.prepare(
    `INSERT INTO floor_cell_coverings (property_id, level, col, row, material_id, installation_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const item of facilities.coverings) {
    covering.run(
      item.propertyId,
      item.level,
      item.col,
      item.row,
      item.materialId,
      item.installationId,
    );
  }
}

// ------------------------------------------------------------------ reads

function all(db: SqliteDatabase, sql: string): Row[] {
  return db.prepare(sql).all() as Row[];
}

function oneOf<T extends string | number>(allowed: readonly T[], value: unknown, what: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`Unknown ${what} ${JSON.stringify(value)}`);
  }
  return found;
}

function boolCell(value: unknown, what: string): boolean {
  const number = intCell(value, what);
  if (number !== 0 && number !== 1) {
    throw new Error(`${what} must be 0 or 1, not ${number}`);
  }
  return number === 1;
}

function idCell<K extends string>(kind: K, value: unknown, what: string): EntityId<K> {
  const id = textCell(value, what);
  if (!isEntityIdOf(kind, id)) {
    throw new Error(`${what} ${JSON.stringify(id)} is not a ${kind} ID`);
  }
  return id;
}

function grouped(db: SqliteDatabase, sql: string, key: (row: Row) => string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of all(db, sql)) {
    const parent = key(row);
    groups.set(parent, [...(groups.get(parent) ?? []), row]);
  }
  return groups;
}

function rectCells(row: Row, prefix: string): RectMm {
  return {
    x: intCell(row[`${prefix}x_mm`], `${prefix}x`),
    y: intCell(row[`${prefix}y_mm`], `${prefix}y`),
    width: intCell(row[`${prefix}width_mm`], `${prefix}width`),
    depth: intCell(row[`${prefix}depth_mm`], `${prefix}depth`),
  };
}

export function readFacilities(db: SqliteDatabase): Facilities | null {
  const header = all(db, 'SELECT * FROM facilities');
  if (header.length > 1) {
    throw new Error(`Expected at most one facilities record, found ${header.length}`);
  }
  if (header.length === 0) {
    return null;
  }
  const floorMaterials = all(db, 'SELECT * FROM floor_materials ORDER BY position').map(
    (row): FloorMaterial => {
      const install = row['install_cents_per_m2'];
      return {
        id: textCell(row['id'], 'material id'),
        name: textCell(row['name'], 'material name'),
        category: oneOf(FLOOR_MATERIAL_CATEGORIES, row['category'], 'material category'),
        description: textCell(row['description'], 'material description'),
        installCentsPerM2: install === null ? null : bigCell(install, 'install price'),
        removalCentsPerM2: bigCell(row['removal_cents_per_m2'], 'removal price'),
        colour: textCell(row['colour'], 'colour'),
        textureSet: textCell(row['texture_set'], 'texture set'),
        textureVariants: intCell(row['texture_variants'], 'texture variants'),
        patternMm: {
          x: intCell(row['pattern_x_mm'], 'pattern x'),
          y: intCell(row['pattern_y_mm'], 'pattern y'),
        },
      };
    },
  );
  const uses = grouped(db, 'SELECT * FROM equipment_type_uses ORDER BY type_id, position', (row) =>
    textCell(row['type_id'], 'type id'),
  );
  const zones = grouped(
    db,
    'SELECT * FROM equipment_type_zones ORDER BY type_id, position',
    (row) => textCell(row['type_id'], 'type id'),
  );
  const equipmentTypes = all(db, 'SELECT * FROM equipment_types ORDER BY position').map(
    (row): EquipmentType => {
      const id = textCell(row['id'], 'type id');
      return {
        id,
        name: textCell(row['name'], 'type name'),
        category: oneOf(EQUIPMENT_CATEGORIES, row['category'], 'equipment category'),
        description: textCell(row['description'], 'type description'),
        supplier: textCell(row['supplier'], 'supplier'),
        priceCents: bigCell(row['price_cents'], 'price'),
        relocationCents: bigCell(row['relocation_cents'], 'relocation'),
        widthMm: intCell(row['width_mm'], 'width'),
        depthMm: intCell(row['depth_mm'], 'depth'),
        heightMm: intCell(row['height_mm'], 'height'),
        weightKg: intCell(row['weight_kg'], 'weight'),
        powerVa: intCell(row['power_va'], 'power'),
        threePhase: boolCell(row['three_phase'], 'three phase'),
        water: boolCell(row['water'], 'water'),
        gas: boolCell(row['gas'], 'gas'),
        uses: (uses.get(id) ?? []).map((u) => oneOf(PERMITTED_USES, u['use'], 'use')),
        zones: (zones.get(id) ?? []).map((z) => ({
          kind: oneOf(ZONE_KINDS, z['kind'], 'zone kind'),
          side: oneOf(SIDES, z['side'], 'zone side'),
          offsetMm: intCell(z['offset_mm'], 'zone offset'),
          widthMm: intCell(z['width_mm'], 'zone width'),
          depthMm: intCell(z['depth_mm'], 'zone depth'),
        })),
      };
    },
  );
  const byLevel = (row: Row) =>
    `${textCell(row['property_id'], 'property')}#${intCell(row['level'], 'level')}`;
  const points = grouped(
    db,
    'SELECT * FROM building_level_points ORDER BY property_id, level, position',
    byLevel,
  );
  const features = grouped(
    db,
    'SELECT * FROM building_features ORDER BY property_id, level, position',
    byLevel,
  );
  const byProperty = (row: Row) => textCell(row['property_id'], 'property');
  const levels = grouped(
    db,
    'SELECT * FROM building_levels ORDER BY property_id, level',
    byProperty,
  );
  const utilities = grouped(
    db,
    'SELECT * FROM building_utilities ORDER BY property_id, position',
    byProperty,
  );
  const stairs = grouped(
    db,
    'SELECT * FROM building_stairs ORDER BY property_id, position',
    byProperty,
  );
  const buildings = all(db, 'SELECT * FROM buildings ORDER BY position').map((row): Building => {
    const propertyId = textCell(row['property_id'], 'building property');
    return {
      propertyId,
      surfaceMaterialId: textCell(row['surface_material_id'], 'surface'),
      parcel: rectCells(row, 'parcel_'),
      levels: (levels.get(propertyId) ?? []).map((l): Level => {
        const key = `${propertyId}#${intCell(l['level'], 'level')}`;
        return {
          index: intCell(l['level'], 'level'),
          name: textCell(l['name'], 'level name'),
          elevationMm: intCell(l['elevation_mm'], 'elevation'),
          deckDepthMm: intCell(l['deck_depth_mm'], 'deck depth'),
          floor: (points.get(key) ?? []).map((p) => ({
            x: intCell(p['x_mm'], 'level x'),
            y: intCell(p['y_mm'], 'level y'),
          })),
          clearHeightMm: intCell(l['clear_height_mm'], 'clear height'),
          floorLoadKgPerM2: intCell(l['floor_load_kg_m2'], 'floor load'),
          features: (features.get(key) ?? []).map((f) => ({
            kind: oneOf(FEATURE_KINDS, f['kind'], 'feature kind'),
            label: textCell(f['label'], 'feature label'),
            rect: rectCells(f, ''),
          })),
        };
      }),
      utilities: (utilities.get(propertyId) ?? []).map((u) => ({
        kind: oneOf(UTILITY_KINDS, u['kind'], 'utility kind'),
        label: textCell(u['label'], 'utility label'),
        edge: intCell(u['edge'], 'utility edge'),
        offsetMm: intCell(u['offset_mm'], 'utility offset'),
        widthMm: intCell(u['width_mm'], 'utility width'),
      })),
      stairs: (stairs.get(propertyId) ?? []).map((s) => ({
        upperLevel: intCell(s['upper_level'], 'stair level'),
        flight: rectCells(s, 'flight_'),
        foot: rectCells(s, 'foot_'),
        head: rectCells(s, 'head_'),
      })),
    };
  });
  const equipment = all(db, 'SELECT * FROM equipment ORDER BY ordinal').map((row): Equipment => {
    const property = row['property_id'];
    return {
      id: idCell('equipment', row['id'], 'equipment id'),
      typeId: textCell(row['type_id'], 'equipment type'),
      supplierPartyId: idCell('party', row['supplier_party_id'], 'dealer'),
      purchaseInvoiceId: idCell('invoice', row['purchase_invoice_id'], 'purchase invoice'),
      purchasedAtMs: bigCell(row['purchased_at_ms'], 'purchase time'),
      priceCents: bigCell(row['price_cents'], 'equipment price'),
      installations: intCell(row['installations'], 'installations'),
      placement:
        property === null
          ? null
          : {
              propertyId: textCell(property, 'equipment property'),
              level: intCell(row['level'], 'equipment level'),
              xMm: intCell(row['x_mm'], 'equipment x'),
              yMm: intCell(row['y_mm'], 'equipment y'),
              rotation: intCell(row['rotation'], 'equipment rotation'),
            },
    };
  });
  const runs = grouped(
    db,
    'SELECT * FROM floor_covering_installation_runs ORDER BY installation_id, position',
    (row) => textCell(row['installation_id'], 'run installation'),
  );
  const installations = all(db, 'SELECT * FROM floor_covering_installations ORDER BY ordinal').map(
    (row): CoveringInstallation => {
      const id = idCell('floor-installation', row['id'], 'installation id');
      return {
        id,
        propertyId: textCell(row['property_id'], 'installation property'),
        level: intCell(row['level'], 'installation level'),
        materialId: textCell(row['material_id'], 'installation material'),
        firmId: idCell('firm', row['firm_id'], 'installation firm'),
        atMs: bigCell(row['game_time_ms'], 'installation time'),
        completesAtMs: bigCell(row['completes_at_ms'], 'installation completion'),
        status: oneOf(INSTALLATION_STATUSES, row['status'], 'installation status'),
        kind: oneOf(INSTALLATION_KINDS, row['kind'], 'installation kind'),
        cells: intCell(row['cells'], 'installation cells'),
        areaMm2: bigCell(row['area_mm2'], 'installation area'),
        replacedCells: intCell(row['replaced_cells'], 'installation replaced cells'),
        replacedAreaMm2: bigCell(row['replaced_area_mm2'], 'installation replaced area'),
        installCents: bigCell(row['install_cents'], 'installation charge'),
        removalCents: bigCell(row['removal_cents'], 'removal charge'),
        costCents: bigCell(row['cost_cents'], 'installation cost'),
        journalEntryId: idCell('entry', row['journal_entry_id'], 'installation entry'),
        runs: (runs.get(id) ?? []).map((cells): CellRun => [
          intCell(cells['row'], 'run row'),
          intCell(cells['first_col'], 'run first column'),
          intCell(cells['end_col'], 'run end column'),
        ]),
      };
    },
  );
  const coverings = all(
    db,
    'SELECT * FROM floor_cell_coverings ORDER BY property_id, level, row, col',
  ).map((row): FloorCovering => ({
    propertyId: textCell(row['property_id'], 'covering property'),
    level: intCell(row['level'], 'covering level'),
    col: intCell(row['col'], 'covering col'),
    row: intCell(row['row'], 'covering row'),
    materialId: textCell(row['material_id'], 'covering material'),
    installationId: idCell('floor-installation', row['installation_id'], 'covering installation'),
  }));
  return { floorMaterials, equipmentTypes, buildings, equipment, coverings, installations };
}

/** Problems the DDL cannot express (ADR-0049); empty when consistent. */
export function facilitiesStructureProblems(db: SqliteDatabase): string[] {
  const count = (sql: string): number => intCell((db.prepare(sql).get() as { n: unknown }).n, sql);
  const problems: string[] = [];
  if (count('SELECT count(*) AS n FROM facilities') === 0) {
    for (const table of FACILITIES_TABLES) {
      if (count(`SELECT count(*) AS n FROM ${table}`) > 0) {
        problems.push(`${table} has rows but the world has no facilities`);
      }
    }
    return problems;
  }
  if (count('SELECT count(*) AS n FROM real_estate') === 0) {
    problems.push('the world has facilities but no real estate');
  }
  const missing = count(
    'SELECT count(*) AS n FROM properties p WHERE NOT EXISTS (SELECT 1 FROM buildings b WHERE b.property_id = p.id)',
  );
  if (missing > 0) {
    problems.push(`${missing} properties have no building record`);
  }
  const groundless = count(
    `SELECT count(*) AS n FROM buildings b WHERE NOT EXISTS
       (SELECT 1 FROM building_levels l WHERE l.property_id = b.property_id AND l.level = 0)`,
  );
  if (groundless > 0) {
    problems.push(`${groundless} buildings have no ground floor`);
  }
  const shapeless = count(
    `SELECT count(*) AS n FROM building_levels l
     WHERE (SELECT count(*) FROM building_level_points p
            WHERE p.property_id = l.property_id AND p.level = l.level) < 4`,
  );
  if (shapeless > 0) {
    problems.push(`${shapeless} building levels have no floor outline`);
  }
  const unleased = count(
    `SELECT count(*) AS n FROM equipment e WHERE e.property_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM leases l WHERE l.property_id = e.property_id AND l.status = 'active')`,
  );
  if (unleased > 0) {
    problems.push(`${unleased} items of equipment stand in premises nobody leases`);
  }
  const unbalanced = count(
    `SELECT count(*) AS n FROM floor_covering_installations i WHERE i.cost_cents <>
       coalesce((SELECT sum(debit_cents) FROM ledger_lines li JOIN ledger_entries le
                 ON le.ordinal = li.entry_ordinal WHERE le.id = i.journal_entry_id), -1)`,
  );
  if (unbalanced > 0) {
    problems.push(`${unbalanced} floor installations differ from their journal entries`);
  }
  return problems;
}

/** Whether `db` has the facilities tables (save format 4 and later). */
export function hasFacilitiesTables(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'facilities'")
    .get() as { n: unknown };
  return intCell(row.n, 'facilities table') === 1;
}
