import { isEntityIdOf, parseEntityId, type EntityId } from '../domain/ids';
import {
  BUSINESS_ROLES,
  DOOR_KINDS,
  LABOR_CLASSES,
  PERMITTED_USES,
  PROPERTY_KINDS,
  type Business,
  type City,
  type District,
  type Lease,
  type Property,
  type RealEstate,
} from '../domain/real-estate';
import {
  bigCell,
  int64,
  intCell,
  nullableTextCell,
  textCell,
  type SqliteDatabase,
} from './database';

/**
 * Maps the real-estate slice to the save-format-3 tables (ADR-0039) and back.
 * Writes happen inside `writeWorld`'s transaction. Reads validate every
 * enumerated value and ID kind; the kernel then checks the business
 * invariants and the fingerprints on load.
 */

/** Real-estate tables, children before parents, so they can be cleared in this order. */
export const REAL_ESTATE_TABLES = [
  'leases',
  'property_uses',
  'property_doors',
  'property_floor_points',
  'properties',
  'businesses',
  'district_streets',
  'districts',
  'city_wage_rates',
  'cities',
  'real_estate',
] as const;

type Row = Record<string, unknown>;

const flag = (value: boolean) => (value ? 1 : 0);

export function writeRealEstate(db: SqliteDatabase, realEstate: RealEstate | null): void {
  if (!realEstate) {
    return;
  }
  db.prepare(
    'INSERT INTO real_estate (singleton, scenario_id, scenario_name, content_version) VALUES (1, ?, ?, ?)',
  ).run(realEstate.scenario.id, realEstate.scenario.name, realEstate.contentVersion);

  const city = db.prepare(
    `INSERT INTO cities (position, id, name, region, population, description, workforce,
       unemployment_permille, map_x, map_y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const wage = db.prepare(
    'INSERT INTO city_wage_rates (city_id, position, labor_class, cents_per_hour) VALUES (?, ?, ?, ?)',
  );
  realEstate.cities.forEach((item, index) => {
    city.run(
      index + 1,
      item.id,
      item.name,
      item.region,
      item.population,
      item.description,
      item.workforce,
      item.unemploymentPermille,
      item.map.x,
      item.map.y,
    );
    item.wageRates.forEach((rate, position) => {
      wage.run(item.id, position + 1, rate.laborClass, int64(rate.centsPerHour, 'Wage rate'));
    });
  });

  const district = db.prepare(
    `INSERT INTO districts (position, id, city_id, name, description, site_width_m, site_depth_m,
       highway_access_m, rail_siding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const street = db.prepare(
    `INSERT INTO district_streets (district_id, position, name, from_x, from_y, to_x, to_y, width_m)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  realEstate.districts.forEach((item, index) => {
    district.run(
      index + 1,
      item.id,
      item.cityId,
      item.name,
      item.description,
      item.siteWidthM,
      item.siteDepthM,
      item.highwayAccessM,
      flag(item.railSiding),
    );
    item.streets.forEach((road, position) => {
      street.run(
        item.id,
        position + 1,
        road.name,
        road.from.x,
        road.from.y,
        road.to.x,
        road.to.y,
        road.widthM,
      );
    });
  });

  const business = db.prepare(
    'INSERT INTO businesses (position, id, city_id, name, role, trade) VALUES (?, ?, ?, ?, ?, ?)',
  );
  realEstate.businesses.forEach((item, index) => {
    business.run(index + 1, item.id, item.cityId, item.name, item.role, item.trade);
  });

  const property = db.prepare(
    `INSERT INTO properties (position, id, district_id, address, kind, description, site_x_m,
       site_y_m, clear_height_mm, floor_load_kg_m2, power_kva, three_phase, water, gas, landlord,
       rent_cents_per_month, deposit_months, min_term_months, max_term_months, occupant_business_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const point = db.prepare(
    'INSERT INTO property_floor_points (property_id, position, x_mm, y_mm) VALUES (?, ?, ?, ?)',
  );
  const door = db.prepare(
    `INSERT INTO property_doors (property_id, position, kind, edge, offset_mm, width_mm, height_mm)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const use = db.prepare('INSERT INTO property_uses (property_id, position, use) VALUES (?, ?, ?)');
  realEstate.properties.forEach((item, index) => {
    property.run(
      index + 1,
      item.id,
      item.districtId,
      item.address,
      item.kind,
      item.description,
      item.site.x,
      item.site.y,
      item.clearHeightMm,
      item.floorLoadKgPerM2,
      item.powerKva,
      flag(item.threePhase),
      flag(item.water),
      flag(item.gas),
      item.landlord,
      int64(item.rentCentsPerMonth, 'Rent'),
      item.depositMonths,
      item.minTermMonths,
      item.maxTermMonths,
      item.occupant?.kind === 'business' ? item.occupant.businessId : null,
    );
    item.floor.forEach((corner, position) => {
      point.run(item.id, position + 1, corner.x, corner.y);
    });
    item.doors.forEach((opening, position) => {
      door.run(
        item.id,
        position + 1,
        opening.kind,
        opening.edge,
        opening.offsetMm,
        opening.widthMm,
        opening.heightMm,
      );
    });
    item.permittedUses.forEach((permitted, position) => {
      use.run(item.id, position + 1, permitted);
    });
  });

  const lease = db.prepare(
    `INSERT INTO leases (ordinal, id, property_id, tenant_firm_id, landlord_party_id, started_at_ms,
       ends_at_ms, term_months, rent_cents_per_month, deposit_cents, rent_obligation_id,
       deposit_obligation_id, standing_order, status, ended_at_ms, refund_invoice_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of realEstate.leases) {
    const ordinal = parseEntityId(item.id)?.ordinal;
    if (ordinal === undefined) {
      throw new Error(`${item.id} is not an entity ID`);
    }
    lease.run(
      ordinal,
      item.id,
      item.propertyId,
      item.tenantFirmId,
      item.landlordPartyId,
      int64(item.startedAtMs, 'Lease start'),
      int64(item.endsAtMs, 'Lease end'),
      item.termMonths,
      int64(item.rentCentsPerMonth, 'Lease rent'),
      int64(item.depositCents, 'Lease deposit'),
      item.rentObligationId,
      item.depositObligationId,
      flag(item.standingOrder),
      item.status,
      item.endedAtMs === null ? null : int64(item.endedAtMs, 'Lease ended'),
      item.refundInvoiceId,
    );
  }
}

// ------------------------------------------------------------------ reads

function all(db: SqliteDatabase, sql: string): Row[] {
  return db.prepare(sql).all() as Row[];
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, what: string): T {
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

/** Child rows grouped by their parent's text ID, in position order. */
function grouped(db: SqliteDatabase, sql: string, key: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of all(db, sql)) {
    const parent = textCell(row[key], key);
    groups.set(parent, [...(groups.get(parent) ?? []), row]);
  }
  return groups;
}

export function readRealEstate(db: SqliteDatabase): RealEstate | null {
  const rows = all(db, 'SELECT * FROM real_estate');
  const [header] = rows;
  if (rows.length > 1) {
    throw new Error(`Expected at most one real-estate record, found ${rows.length}`);
  }
  if (!header) {
    return null;
  }
  const wages = grouped(db, 'SELECT * FROM city_wage_rates ORDER BY city_id, position', 'city_id');
  const cities = all(db, 'SELECT * FROM cities ORDER BY position').map((row): City => {
    const id = textCell(row['id'], 'city id');
    return {
      id,
      name: textCell(row['name'], 'city name'),
      region: textCell(row['region'], 'city region'),
      population: intCell(row['population'], 'population'),
      description: textCell(row['description'], 'city description'),
      workforce: intCell(row['workforce'], 'workforce'),
      unemploymentPermille: intCell(row['unemployment_permille'], 'unemployment'),
      wageRates: (wages.get(id) ?? []).map((rate) => ({
        laborClass: oneOf(LABOR_CLASSES, rate['labor_class'], 'labor class'),
        centsPerHour: bigCell(rate['cents_per_hour'], 'wage rate'),
      })),
      map: { x: intCell(row['map_x'], 'map x'), y: intCell(row['map_y'], 'map y') },
    };
  });
  const streets = grouped(
    db,
    'SELECT * FROM district_streets ORDER BY district_id, position',
    'district_id',
  );
  const districts = all(db, 'SELECT * FROM districts ORDER BY position').map((row): District => {
    const id = textCell(row['id'], 'district id');
    return {
      id,
      cityId: textCell(row['city_id'], 'district city'),
      name: textCell(row['name'], 'district name'),
      description: textCell(row['description'], 'district description'),
      siteWidthM: intCell(row['site_width_m'], 'site width'),
      siteDepthM: intCell(row['site_depth_m'], 'site depth'),
      highwayAccessM: intCell(row['highway_access_m'], 'highway access'),
      railSiding: boolCell(row['rail_siding'], 'rail siding'),
      streets: (streets.get(id) ?? []).map((road) => ({
        name: textCell(road['name'], 'street name'),
        from: { x: intCell(road['from_x'], 'street x'), y: intCell(road['from_y'], 'street y') },
        to: { x: intCell(road['to_x'], 'street x'), y: intCell(road['to_y'], 'street y') },
        widthM: intCell(road['width_m'], 'street width'),
      })),
    };
  });
  const businesses = all(db, 'SELECT * FROM businesses ORDER BY position').map((row): Business => ({
    id: textCell(row['id'], 'business id'),
    cityId: textCell(row['city_id'], 'business city'),
    name: textCell(row['name'], 'business name'),
    role: oneOf(BUSINESS_ROLES, row['role'], 'business role'),
    trade: textCell(row['trade'], 'business trade'),
  }));
  const leases = all(db, 'SELECT * FROM leases ORDER BY ordinal').map((row): Lease => {
    const ended = row['ended_at_ms'];
    const refund = row['refund_invoice_id'];
    return {
      id: idCell('lease', row['id'], 'lease id'),
      propertyId: textCell(row['property_id'], 'lease property'),
      tenantFirmId: idCell('firm', row['tenant_firm_id'], 'lease tenant'),
      landlordPartyId: idCell('party', row['landlord_party_id'], 'lease landlord'),
      startedAtMs: bigCell(row['started_at_ms'], 'lease start'),
      endsAtMs: bigCell(row['ends_at_ms'], 'lease end'),
      termMonths: intCell(row['term_months'], 'lease term'),
      rentCentsPerMonth: bigCell(row['rent_cents_per_month'], 'lease rent'),
      depositCents: bigCell(row['deposit_cents'], 'lease deposit'),
      rentObligationId: idCell('obligation', row['rent_obligation_id'], 'rent obligation'),
      depositObligationId: idCell('obligation', row['deposit_obligation_id'], 'deposit obligation'),
      standingOrder: boolCell(row['standing_order'], 'standing order'),
      status: oneOf(['active', 'ended'], row['status'], 'lease status'),
      endedAtMs: ended === null ? null : bigCell(ended, 'lease ended'),
      refundInvoiceId: refund === null ? null : idCell('invoice', refund, 'refund invoice'),
    };
  });
  const activeLease = new Map(
    leases.filter((lease) => lease.status === 'active').map((lease) => [lease.propertyId, lease]),
  );
  const points = grouped(
    db,
    'SELECT * FROM property_floor_points ORDER BY property_id, position',
    'property_id',
  );
  const doors = grouped(
    db,
    'SELECT * FROM property_doors ORDER BY property_id, position',
    'property_id',
  );
  const uses = grouped(
    db,
    'SELECT * FROM property_uses ORDER BY property_id, position',
    'property_id',
  );
  const properties = all(db, 'SELECT * FROM properties ORDER BY position').map((row): Property => {
    const id = textCell(row['id'], 'property id');
    const business = nullableTextCell(row['occupant_business_id'], 'occupant');
    const lease = activeLease.get(id);
    return {
      id,
      districtId: textCell(row['district_id'], 'property district'),
      address: textCell(row['address'], 'address'),
      kind: oneOf(PROPERTY_KINDS, row['kind'], 'property kind'),
      description: textCell(row['description'], 'property description'),
      site: { x: intCell(row['site_x_m'], 'site x'), y: intCell(row['site_y_m'], 'site y') },
      floor: (points.get(id) ?? []).map((corner) => ({
        x: intCell(corner['x_mm'], 'floor x'),
        y: intCell(corner['y_mm'], 'floor y'),
      })),
      clearHeightMm: intCell(row['clear_height_mm'], 'clear height'),
      floorLoadKgPerM2: intCell(row['floor_load_kg_m2'], 'floor load'),
      powerKva: intCell(row['power_kva'], 'power'),
      threePhase: boolCell(row['three_phase'], 'three phase'),
      water: boolCell(row['water'], 'water'),
      gas: boolCell(row['gas'], 'gas'),
      doors: (doors.get(id) ?? []).map((opening) => ({
        kind: oneOf(DOOR_KINDS, opening['kind'], 'door kind'),
        edge: intCell(opening['edge'], 'door edge'),
        offsetMm: intCell(opening['offset_mm'], 'door offset'),
        widthMm: intCell(opening['width_mm'], 'door width'),
        heightMm: intCell(opening['height_mm'], 'door height'),
      })),
      permittedUses: (uses.get(id) ?? []).map((permitted) =>
        oneOf(PERMITTED_USES, permitted['use'], 'permitted use'),
      ),
      landlord: textCell(row['landlord'], 'landlord'),
      rentCentsPerMonth: bigCell(row['rent_cents_per_month'], 'rent'),
      depositMonths: intCell(row['deposit_months'], 'deposit months'),
      minTermMonths: intCell(row['min_term_months'], 'minimum term'),
      maxTermMonths: intCell(row['max_term_months'], 'maximum term'),
      occupant:
        business !== null
          ? { kind: 'business', businessId: business }
          : lease
            ? { kind: 'lease', leaseId: lease.id }
            : null,
    };
  });
  return {
    scenario: {
      id: textCell(header['scenario_id'], 'scenario id'),
      name: textCell(header['scenario_name'], 'scenario name'),
    },
    contentVersion: textCell(header['content_version'], 'content version'),
    cities,
    districts,
    businesses,
    properties,
    leases,
  };
}

/** Problems the DDL cannot express (ADR-0039); empty when consistent. */
export function realEstateStructureProblems(db: SqliteDatabase): string[] {
  const count = (sql: string): number => intCell((db.prepare(sql).get() as { n: unknown }).n, sql);
  const problems: string[] = [];
  if (count('SELECT count(*) AS n FROM real_estate') === 0) {
    for (const table of REAL_ESTATE_TABLES) {
      if (count(`SELECT count(*) AS n FROM ${table}`) > 0) {
        problems.push(`${table} has rows but the world has no real estate`);
      }
    }
    return problems;
  }
  const doubleOccupied = count(
    `SELECT count(*) AS n FROM leases l JOIN properties p ON p.id = l.property_id
     WHERE l.status = 'active' AND p.occupant_business_id IS NOT NULL`,
  );
  if (doubleOccupied > 0) {
    problems.push(`${doubleOccupied} leased properties are also occupied by a business`);
  }
  const shapeless = count(
    `SELECT count(*) AS n FROM properties p
     WHERE (SELECT count(*) FROM property_floor_points f WHERE f.property_id = p.id) < 4`,
  );
  if (shapeless > 0) {
    problems.push(`${shapeless} properties have no floor outline`);
  }
  const unrecognised = count(
    `SELECT count(*) AS n FROM leases l WHERE NOT EXISTS
       (SELECT 1 FROM obligations o WHERE o.id = l.rent_obligation_id AND o.purpose = 'rent'
          AND o.amount_cents = l.rent_cents_per_month AND o.occurrences = l.term_months)
     OR NOT EXISTS
       (SELECT 1 FROM obligations o WHERE o.id = l.deposit_obligation_id
          AND o.purpose = 'security-deposit' AND o.amount_cents = l.deposit_cents)`,
  );
  if (unrecognised > 0) {
    problems.push(`${unrecognised} leases differ from their rent or deposit obligations`);
  }
  return problems;
}

/** Whether `db` has the real-estate tables (save format 3 and later). */
export function hasRealEstateTables(db: SqliteDatabase): boolean {
  const row = db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'real_estate'",
    )
    .get() as { n: unknown };
  return intCell(row.n, 'real-estate table') === 1;
}
