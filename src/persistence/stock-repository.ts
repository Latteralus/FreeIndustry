import { isEntityIdOf, type EntityId } from '../domain/ids';
import {
  BASE_UNITS,
  CONTAINER_KINDS,
  DISPOSITIONS,
  LOSS_REASONS,
  LOT_CLOSURES,
  MIXING_RULES,
  MOVEMENT_KINDS,
  PRODUCT_CATEGORIES,
  PRODUCT_FORMS,
  SCRAP_REASONS,
  TRACKING_KINDS,
  type ContainerType,
  type LoadUnit,
  type LotOrigin,
  type Product,
  type Stock,
  type StockHandler,
  type StockLocation,
  type StockLot,
  type StockMovement,
  type StockReceipt,
} from '../domain/stock';
import { bigCell, int64, intCell, textCell, type SqliteDatabase } from './database';

/**
 * Maps the stock slice to the save-format-6 tables (ADR-0056) and back.
 * Writes happen inside `writeWorld`'s transaction. Reads validate every
 * enumerated value and ID kind; the kernel then checks the business
 * invariants and the fingerprints on load. Entity rows are written and read
 * in ordinal order, which is their order in the domain lists.
 */

/** Stock tables, children before parents, so they can be cleared in this order. */
export const STOCK_TABLES = [
  'stock_reservations',
  'stock_movement_units',
  'stock_movement_lines',
  'stock_movements',
  'stock_lot_serials',
  'stock_lot_parents',
  'stock_lots',
  'load_units',
  'stock_receipts',
  'container_type_carries',
  'container_type_holds',
  'container_types',
  'product_grades',
  'product_pack_units',
  'products',
  'stock',
] as const;

type Row = Record<string, unknown>;

function ordinalOf(id: string): number {
  return Number(id.slice(id.indexOf(':') + 1));
}

/** The location's columns, in the order `kind, property_id, level, x, y, rotation, load_unit, equipment, zone`. */
function locationValues(location: StockLocation | null): unknown[] {
  if (!location) {
    return [null, null, null, null, null, null, null, null, null];
  }
  switch (location.kind) {
    case 'floor':
      return [
        'floor',
        location.propertyId,
        location.level,
        location.xMm,
        location.yMm,
        location.rotation,
        null,
        null,
        null,
      ];
    case 'load-unit':
      return ['load-unit', null, null, null, null, null, location.loadUnitId, null, null];
    case 'equipment':
      return ['equipment', null, null, null, null, null, null, location.equipmentId, location.zone];
  }
}

function handlerValues(handler: StockHandler): [string, string | null] {
  switch (handler.kind) {
    case 'supplier':
      return ['supplier', handler.partyId];
    case 'company':
      return ['company', null];
    case 'employee':
      return ['employee', handler.personId];
  }
}

export function writeStock(db: SqliteDatabase, stock: Stock | null): void {
  if (!stock) {
    return;
  }
  db.prepare('INSERT INTO stock (singleton) VALUES (1)').run();

  const product = db.prepare(
    `INSERT INTO products (position, id, name, category, description, unit, form, tracking,
       quantum_micro, item_width_mm, item_depth_mm, item_height_mm, mass_per_quantum_mg,
       volume_per_quantum_mm3, colour) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const pack = db.prepare(
    'INSERT INTO product_pack_units (product_id, position, id, name, quanta) VALUES (?, ?, ?, ?, ?)',
  );
  const grade = db.prepare(
    'INSERT INTO product_grades (product_id, position, code, name) VALUES (?, ?, ?, ?)',
  );
  stock.products.forEach((item, index) => {
    product.run(
      index + 1,
      item.id,
      item.name,
      item.category,
      item.description,
      item.unit,
      item.form,
      item.tracking,
      int64(item.quantumMicro, 'quantum'),
      item.itemMm?.width ?? null,
      item.itemMm?.depth ?? null,
      item.itemMm?.height ?? null,
      int64(item.massPerQuantumMg, 'mass per quantum'),
      int64(item.volumePerQuantumMm3, 'volume per quantum'),
      item.colour,
    );
    item.packUnits.forEach((unit, position) => {
      pack.run(item.id, position + 1, unit.id, unit.name, unit.quanta);
    });
    item.grades.forEach((entry, position) => {
      grade.run(item.id, position + 1, entry.code, entry.name);
    });
  });

  const type = db.prepare(
    `INSERT INTO container_types (position, id, name, kind, description, outer_width_mm,
       outer_depth_mm, outer_height_mm, inner_width_mm, inner_depth_mm, inner_height_mm,
       tare_mass_g, payload_mass_g, mixing, colour)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const holds = db.prepare(
    'INSERT INTO container_type_holds (type_id, position, form) VALUES (?, ?, ?)',
  );
  const carries = db.prepare(
    'INSERT INTO container_type_carries (type_id, position, kind) VALUES (?, ?, ?)',
  );
  stock.containerTypes.forEach((item, index) => {
    type.run(
      index + 1,
      item.id,
      item.name,
      item.kind,
      item.description,
      item.outerMm.width,
      item.outerMm.depth,
      item.outerMm.height,
      item.innerMm.width,
      item.innerMm.depth,
      item.innerMm.height,
      item.tareMassG,
      item.payloadMassG,
      item.mixing,
      item.colour,
    );
    item.holds.forEach((form, position) => {
      holds.run(item.id, position + 1, form);
    });
    item.carries.forEach((kind, position) => {
      carries.run(item.id, position + 1, kind);
    });
  });

  const receipt = db.prepare(
    `INSERT INTO stock_receipts (ordinal, id, kind, game_time_ms, supplier_party_id, invoice_id,
       cost_cents, property_id, door_index, product_id, quantity_micro)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of stock.receipts) {
    receipt.run(
      ordinalOf(item.id),
      item.id,
      item.kind,
      int64(item.atMs, 'receipt time'),
      item.supplierPartyId,
      item.invoiceId,
      int64(item.costCents, 'receipt cost'),
      item.propertyId,
      item.doorIndex,
      item.productId,
      int64(item.quantityMicro, 'receipt quantity'),
    );
  }

  const unit = db.prepare(
    `INSERT INTO load_units (ordinal, id, type_id, owner_firm_id, created_at_ms, receipt_id,
       location_kind, property_id, level, x_mm, y_mm, rotation, parent_load_unit_id, equipment_id,
       zone_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of stock.loadUnits) {
    unit.run(
      ordinalOf(item.id),
      item.id,
      item.typeId,
      item.ownerFirmId,
      int64(item.createdAtMs, 'load unit time'),
      item.receiptId,
      ...locationValues(item.location),
    );
  }

  const lot = db.prepare(
    `INSERT INTO stock_lots (ordinal, id, product_id, owner_firm_id, grade, disposition,
       quantity_micro, cost_cents, load_unit_id, origin_kind, origin_receipt_id, created_at_ms,
       closed_at_ms, closed_reason, closed_into_lot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const parent = db.prepare(
    'INSERT INTO stock_lot_parents (lot_id, position, parent_lot_id) VALUES (?, ?, ?)',
  );
  const serial = db.prepare(
    'INSERT INTO stock_lot_serials (lot_id, position, serial_id) VALUES (?, ?, ?)',
  );
  for (const item of stock.lots) {
    lot.run(
      ordinalOf(item.id),
      item.id,
      item.productId,
      item.ownerFirmId,
      item.grade,
      item.disposition,
      int64(item.quantityMicro, 'lot quantity'),
      int64(item.costCents, 'lot cost'),
      item.loadUnitId,
      item.origin.kind,
      item.origin.kind === 'receipt' ? item.origin.receiptId : null,
      int64(item.createdAtMs, 'lot time'),
      item.closed ? int64(item.closed.atMs, 'lot closed') : null,
      item.closed?.reason ?? null,
      item.closed?.intoLotId ?? null,
    );
  }
  for (const item of stock.lots) {
    item.parentLotIds.forEach((id, position) => {
      parent.run(item.id, position + 1, id);
    });
    item.serials.forEach((id, position) => {
      serial.run(item.id, position + 1, id);
    });
  }

  const move = db.prepare(
    `INSERT INTO stock_movements (ordinal, id, game_time_ms, kind, handler_kind, handler_id, reason,
       receipt_id, entry_id, cost_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const line = db.prepare(
    `INSERT INTO stock_movement_lines (movement_id, position, lot_id, quantity_micro,
       from_load_unit_id, to_load_unit_id, result_lot_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const placed = db.prepare(
    `INSERT INTO stock_movement_units (movement_id, position, load_unit_id, from_kind,
       from_property_id, from_level, from_x_mm, from_y_mm, from_rotation, from_load_unit_id,
       from_equipment_id, from_zone, to_kind, to_property_id, to_level, to_x_mm, to_y_mm,
       to_rotation, to_load_unit_id, to_equipment_id, to_zone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of stock.movements) {
    move.run(
      ordinalOf(item.id),
      item.id,
      int64(item.atMs, 'movement time'),
      item.kind,
      ...handlerValues(item.handler),
      item.reason,
      item.receiptId,
      item.entryId,
      int64(item.costCents, 'movement cost'),
    );
    item.lines.forEach((entry, position) => {
      line.run(
        item.id,
        position + 1,
        entry.lotId,
        int64(entry.quantityMicro, 'movement quantity'),
        entry.fromLoadUnitId,
        entry.toLoadUnitId,
        entry.resultLotId,
      );
    });
    item.units.forEach((entry, position) => {
      placed.run(
        item.id,
        position + 1,
        entry.loadUnitId,
        ...locationValues(entry.from),
        ...locationValues(entry.to),
      );
    });
  }

  const reservation = db.prepare(
    `INSERT INTO stock_reservations (ordinal, id, lot_id, quantity_micro, purpose, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const item of stock.reservations) {
    reservation.run(
      ordinalOf(item.id),
      item.id,
      item.lotId,
      int64(item.quantityMicro, 'reservation quantity'),
      item.purpose,
      int64(item.createdAtMs, 'reservation time'),
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

function idCell<K extends string>(kind: K, value: unknown, what: string): EntityId<K> {
  const id = textCell(value, what);
  if (!isEntityIdOf(kind, id)) {
    throw new Error(`${what} ${JSON.stringify(id)} is not a ${kind} ID`);
  }
  return id;
}

function nullableId<K extends string>(kind: K, value: unknown, what: string): EntityId<K> | null {
  return value === null ? null : idCell(kind, value, what);
}

function grouped(db: SqliteDatabase, sql: string, key: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of all(db, sql)) {
    const parent = textCell(row[key], key);
    groups.set(parent, [...(groups.get(parent) ?? []), row]);
  }
  return groups;
}

function rotationCell(value: unknown, what: string): 0 | 90 | 180 | 270 {
  const rotation = intCell(value, what);
  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    throw new Error(`${what} ${rotation} is not a quarter turn`);
  }
  return rotation;
}

/** A location from its columns (prefix `''`, `from_` or `to_`), or null when they are empty. */
function locationCells(row: Row, prefix: string, parentColumn: string): StockLocation | null {
  const kind = row[`${prefix}kind`];
  if (kind === null) {
    return null;
  }
  switch (oneOf(['floor', 'load-unit', 'equipment'], kind, 'location kind')) {
    case 'floor':
      return {
        kind: 'floor',
        propertyId: textCell(row[`${prefix}property_id`], 'location property'),
        level: intCell(row[`${prefix}level`], 'location level'),
        xMm: intCell(row[`${prefix}x_mm`], 'location x'),
        yMm: intCell(row[`${prefix}y_mm`], 'location y'),
        rotation: rotationCell(row[`${prefix}rotation`], 'location rotation'),
      };
    case 'load-unit':
      return {
        kind: 'load-unit',
        loadUnitId: idCell('load-unit', row[parentColumn], 'carrier'),
      };
    case 'equipment':
      return {
        kind: 'equipment',
        equipmentId: idCell('equipment', row[`${prefix}equipment_id`], 'location equipment'),
        zone: intCell(row[prefix === '' ? 'zone_index' : `${prefix}zone`], 'location zone'),
      };
  }
}

function handlerCells(row: Row): StockHandler {
  switch (oneOf(['supplier', 'company', 'employee'], row['handler_kind'], 'handler')) {
    case 'supplier':
      return { kind: 'supplier', partyId: idCell('party', row['handler_id'], 'handler') };
    case 'company':
      return { kind: 'company' };
    case 'employee':
      return { kind: 'employee', personId: idCell('person', row['handler_id'], 'handler') };
  }
}

export function readStock(db: SqliteDatabase): Stock | null {
  const header = all(db, 'SELECT * FROM stock');
  if (header.length > 1) {
    throw new Error(`Expected at most one stock record, found ${header.length}`);
  }
  if (header.length === 0) {
    return null;
  }
  const packs = grouped(
    db,
    'SELECT * FROM product_pack_units ORDER BY product_id, position',
    'product_id',
  );
  const grades = grouped(
    db,
    'SELECT * FROM product_grades ORDER BY product_id, position',
    'product_id',
  );
  const products = all(db, 'SELECT * FROM products ORDER BY position').map((row): Product => {
    const id = textCell(row['id'], 'product id');
    const width = row['item_width_mm'];
    return {
      id,
      name: textCell(row['name'], 'product name'),
      category: oneOf(PRODUCT_CATEGORIES, row['category'], 'product category'),
      description: textCell(row['description'], 'product description'),
      unit: oneOf(BASE_UNITS, row['unit'], 'unit'),
      form: oneOf(PRODUCT_FORMS, row['form'], 'form'),
      tracking: oneOf(TRACKING_KINDS, row['tracking'], 'tracking'),
      quantumMicro: bigCell(row['quantum_micro'], 'quantum'),
      itemMm:
        width === null
          ? null
          : {
              width: intCell(width, 'item width'),
              depth: intCell(row['item_depth_mm'], 'item depth'),
              height: intCell(row['item_height_mm'], 'item height'),
            },
      massPerQuantumMg: bigCell(row['mass_per_quantum_mg'], 'mass per quantum'),
      volumePerQuantumMm3: bigCell(row['volume_per_quantum_mm3'], 'volume per quantum'),
      packUnits: (packs.get(id) ?? []).map((pack) => ({
        id: textCell(pack['id'], 'pack id'),
        name: textCell(pack['name'], 'pack name'),
        quanta: intCell(pack['quanta'], 'pack quanta'),
      })),
      grades: (grades.get(id) ?? []).map((grade) => ({
        code: textCell(grade['code'], 'grade code'),
        name: textCell(grade['name'], 'grade name'),
      })),
      colour: textCell(row['colour'], 'colour'),
    };
  });
  const holds = grouped(
    db,
    'SELECT * FROM container_type_holds ORDER BY type_id, position',
    'type_id',
  );
  const carries = grouped(
    db,
    'SELECT * FROM container_type_carries ORDER BY type_id, position',
    'type_id',
  );
  const containerTypes = all(db, 'SELECT * FROM container_types ORDER BY position').map(
    (row): ContainerType => {
      const id = textCell(row['id'], 'container type id');
      return {
        id,
        name: textCell(row['name'], 'container name'),
        kind: oneOf(CONTAINER_KINDS, row['kind'], 'container kind'),
        description: textCell(row['description'], 'container description'),
        outerMm: {
          width: intCell(row['outer_width_mm'], 'outer width'),
          depth: intCell(row['outer_depth_mm'], 'outer depth'),
          height: intCell(row['outer_height_mm'], 'outer height'),
        },
        innerMm: {
          width: intCell(row['inner_width_mm'], 'inner width'),
          depth: intCell(row['inner_depth_mm'], 'inner depth'),
          height: intCell(row['inner_height_mm'], 'inner height'),
        },
        tareMassG: intCell(row['tare_mass_g'], 'tare'),
        payloadMassG: intCell(row['payload_mass_g'], 'payload'),
        holds: (holds.get(id) ?? []).map((entry) => oneOf(PRODUCT_FORMS, entry['form'], 'form')),
        carries: (carries.get(id) ?? []).map((entry) =>
          oneOf(CONTAINER_KINDS, entry['kind'], 'carried kind'),
        ),
        mixing: oneOf(MIXING_RULES, row['mixing'], 'mixing'),
        colour: textCell(row['colour'], 'colour'),
      };
    },
  );

  const loadUnits = all(db, 'SELECT * FROM load_units ORDER BY ordinal').map((row): LoadUnit => {
    const location = locationCells(
      { ...row, kind: row['location_kind'] },
      '',
      'parent_load_unit_id',
    );
    if (!location) {
      throw new Error('A load unit has no location');
    }
    return {
      id: idCell('load-unit', row['id'], 'load unit id'),
      typeId: textCell(row['type_id'], 'load unit type'),
      ownerFirmId: idCell('firm', row['owner_firm_id'], 'load unit owner'),
      location,
      createdAtMs: bigCell(row['created_at_ms'], 'load unit time'),
      receiptId: nullableId('stock-receipt', row['receipt_id'], 'load unit receipt'),
    };
  });
  const parents = grouped(
    db,
    'SELECT * FROM stock_lot_parents ORDER BY lot_id, position',
    'lot_id',
  );
  const serials = grouped(
    db,
    'SELECT * FROM stock_lot_serials ORDER BY lot_id, position',
    'lot_id',
  );
  const lots = all(db, 'SELECT * FROM stock_lots ORDER BY ordinal').map((row): StockLot => {
    const id = idCell('lot', row['id'], 'lot id');
    const originKind = oneOf(['receipt', 'split', 'merge'], row['origin_kind'], 'lot origin');
    const origin: LotOrigin =
      originKind === 'receipt'
        ? {
            kind: 'receipt',
            receiptId: idCell('stock-receipt', row['origin_receipt_id'], 'lot receipt'),
          }
        : { kind: originKind };
    const closedAt = row['closed_at_ms'];
    return {
      id,
      productId: textCell(row['product_id'], 'lot product'),
      ownerFirmId: idCell('firm', row['owner_firm_id'], 'lot owner'),
      grade: textCell(row['grade'], 'lot grade'),
      disposition: oneOf(DISPOSITIONS, row['disposition'], 'disposition'),
      quantityMicro: bigCell(row['quantity_micro'], 'lot quantity'),
      costCents: bigCell(row['cost_cents'], 'lot cost'),
      loadUnitId: nullableId('load-unit', row['load_unit_id'], 'lot load unit'),
      serials: (serials.get(id) ?? []).map((entry) =>
        idCell('serial', entry['serial_id'], 'serial'),
      ),
      origin,
      parentLotIds: (parents.get(id) ?? []).map((entry) =>
        idCell('lot', entry['parent_lot_id'], 'parent lot'),
      ),
      createdAtMs: bigCell(row['created_at_ms'], 'lot time'),
      closed:
        closedAt === null
          ? null
          : {
              atMs: bigCell(closedAt, 'lot closed'),
              reason: oneOf(LOT_CLOSURES, row['closed_reason'], 'closure'),
              intoLotId: nullableId('lot', row['closed_into_lot_id'], 'merged into'),
            },
    };
  });
  const receipts = all(db, 'SELECT * FROM stock_receipts ORDER BY ordinal').map(
    (row): StockReceipt => {
      const id = idCell('stock-receipt', row['id'], 'receipt id');
      return {
        id,
        kind: oneOf(['diagnostic'], row['kind'], 'receipt kind'),
        atMs: bigCell(row['game_time_ms'], 'receipt time'),
        supplierPartyId: idCell('party', row['supplier_party_id'], 'receipt supplier'),
        invoiceId: idCell('invoice', row['invoice_id'], 'receipt invoice'),
        costCents: bigCell(row['cost_cents'], 'receipt cost'),
        propertyId: textCell(row['property_id'], 'receipt property'),
        doorIndex: intCell(row['door_index'], 'receipt door'),
        productId: textCell(row['product_id'], 'receipt product'),
        quantityMicro: bigCell(row['quantity_micro'], 'receipt quantity'),
        // A receipt's lots and load units are those that name it, in order (ADR-0056).
        lotIds: lots
          .filter((lot) => lot.origin.kind === 'receipt' && lot.origin.receiptId === id)
          .map((lot) => lot.id),
        loadUnitIds: loadUnits.filter((unit) => unit.receiptId === id).map((unit) => unit.id),
      };
    },
  );
  const lines = grouped(
    db,
    'SELECT * FROM stock_movement_lines ORDER BY movement_id, position',
    'movement_id',
  );
  const units = grouped(
    db,
    'SELECT * FROM stock_movement_units ORDER BY movement_id, position',
    'movement_id',
  );
  const reasons = [...SCRAP_REASONS, ...LOSS_REASONS] as const;
  const movements = all(db, 'SELECT * FROM stock_movements ORDER BY ordinal').map(
    (row): StockMovement => {
      const id = idCell('stock-move', row['id'], 'movement id');
      const reason = row['reason'];
      return {
        id,
        atMs: bigCell(row['game_time_ms'], 'movement time'),
        kind: oneOf(MOVEMENT_KINDS, row['kind'], 'movement kind'),
        handler: handlerCells(row),
        lines: (lines.get(id) ?? []).map((entry) => ({
          lotId: idCell('lot', entry['lot_id'], 'movement lot'),
          quantityMicro: bigCell(entry['quantity_micro'], 'movement quantity'),
          fromLoadUnitId: nullableId('load-unit', entry['from_load_unit_id'], 'from'),
          toLoadUnitId: nullableId('load-unit', entry['to_load_unit_id'], 'to'),
          resultLotId: nullableId('lot', entry['result_lot_id'], 'result lot'),
        })),
        units: (units.get(id) ?? []).map((entry) => {
          const to = locationCells(entry, 'to_', 'to_load_unit_id');
          if (!to) {
            throw new Error(`Movement ${id} moved a load unit to nowhere`);
          }
          return {
            loadUnitId: idCell('load-unit', entry['load_unit_id'], 'moved load unit'),
            from: locationCells(entry, 'from_', 'from_load_unit_id'),
            to,
          };
        }),
        reason: reason === null ? null : oneOf(reasons, reason, 'reason'),
        receiptId: nullableId('stock-receipt', row['receipt_id'], 'movement receipt'),
        entryId: nullableId('entry', row['entry_id'], 'movement entry'),
        costCents: bigCell(row['cost_cents'], 'movement cost'),
      };
    },
  );
  const reservations = all(db, 'SELECT * FROM stock_reservations ORDER BY ordinal').map((row) => ({
    id: idCell('stock-reservation', row['id'], 'reservation id'),
    lotId: idCell('lot', row['lot_id'], 'reservation lot'),
    quantityMicro: bigCell(row['quantity_micro'], 'reservation quantity'),
    purpose: textCell(row['purpose'], 'reservation purpose'),
    createdAtMs: bigCell(row['created_at_ms'], 'reservation time'),
  }));
  return { products, containerTypes, receipts, loadUnits, lots, movements, reservations };
}

/** Problems the DDL cannot express (ADR-0056); empty when consistent. */
export function stockStructureProblems(db: SqliteDatabase): string[] {
  const count = (sql: string): number => intCell((db.prepare(sql).get() as { n: unknown }).n, sql);
  const problems: string[] = [];
  if (count('SELECT count(*) AS n FROM stock') === 0) {
    for (const table of STOCK_TABLES) {
      if (count(`SELECT count(*) AS n FROM ${table}`) > 0) {
        problems.push(`${table} has rows but the world has no stock records`);
      }
    }
    return problems;
  }
  if (count('SELECT count(*) AS n FROM facilities') === 0) {
    problems.push('the world has stock records but no facilities');
  }
  const misplaced = count(
    `SELECT count(*) AS n FROM stock_lots l JOIN load_units u ON u.id = l.load_unit_id
     WHERE l.owner_firm_id <> u.owner_firm_id`,
  );
  if (misplaced > 0) {
    problems.push(`${misplaced} lots are in load units owned by another firm`);
  }
  const unpaid = count(
    `SELECT count(*) AS n FROM stock_receipts r WHERE r.cost_cents <>
       coalesce((SELECT total_cents FROM invoices i WHERE i.id = r.invoice_id), -1)`,
  );
  if (unpaid > 0) {
    problems.push(`${unpaid} stock receipts differ from their invoices`);
  }
  const unposted = count(
    `SELECT count(*) AS n FROM stock_movements m WHERE m.entry_id IS NOT NULL AND m.cost_cents <>
       coalesce((SELECT sum(debit_cents) FROM ledger_lines li JOIN ledger_entries le
                 ON le.ordinal = li.entry_ordinal WHERE le.id = m.entry_id), -1)`,
  );
  if (unposted > 0) {
    problems.push(`${unposted} stock write-offs differ from their journal entries`);
  }
  return problems;
}

/** Whether `db` has the stock tables (save format 6 and later). */
export function hasStockTables(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'stock'")
    .get() as { n: unknown };
  return intCell(row.n, 'stock table') === 1;
}
