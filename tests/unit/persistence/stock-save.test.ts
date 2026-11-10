import Database from 'better-sqlite3';
import type { SqliteDatabase } from '../../../src/persistence/database';
import { checkIntegrity } from '../../../src/persistence/integrity';
import { applyMigrations, SAVE_MIGRATIONS } from '../../../src/persistence/migrations';
import { readWorld, writeWorld } from '../../../src/persistence/world-repository';
import { MS_PER_DAY } from '../../../src/domain/time';
import { accept } from '../../support/facility-world';
import { imageOf, label, restoreImage } from '../../support/save-world';
import {
  deliver,
  MOTORS_ON_A_PALLET,
  PAINT_IN_A_DRUM,
  stockOf,
  stockWorld,
} from '../../support/stock-world';

/**
 * Step 10 persistence (save format 6, ADR-0056): the product and container
 * catalogs, receipts, load units in all their locations, lots with their
 * parents and serials, movements and write-offs are stored relationally,
 * read back exactly, continue identically, and are refused when altered.
 */

const LATEST = SAVE_MIGRATIONS.length;

function saveDatabase(version = LATEST): SqliteDatabase {
  const db = new Database(':memory:');
  db.defaultSafeIntegers(true);
  db.pragma('foreign_keys = ON');
  applyMigrations(db, SAVE_MIGRATIONS.slice(0, version), {
    appVersion: '0.1.0',
    appliedAt: '2026-11-09T00:00:00Z',
  });
  return db;
}

const rows = (db: SqliteDatabase, sql: string) => db.prepare(sql).all();

/** Screws in cartons on a pallet, motors with serials, a drum of enamel, a partial scrap. */
function stockedWorld() {
  const world = stockWorld();
  deliver(world);
  deliver(world, MOTORS_ON_A_PALLET);
  deliver(world, PAINT_IN_A_DRUM);
  accept(world, 'stock.scrap', {
    lotId: 'lot:1',
    quantityMicro: '20000000',
    serials: null,
    reason: 'damaged',
  });
  accept(world, 'stock.scrap', {
    lotId: 'lot:5',
    quantityMicro: '1000000',
    serials: null,
    reason: 'defective',
  });
  return world;
}

describe('stock in a save', () => {
  it('round-trips every stock record exactly and continues identically', () => {
    const db = saveDatabase();
    const world = stockedWorld();
    expect(world.checkInvariants()).toEqual([]);
    const image = imageOf(world);
    writeWorld(db, image, label('Stock'));
    const read = readWorld(db);
    expect(read.image).toEqual(image);
    expect(checkIntegrity(db, SAVE_MIGRATIONS, LATEST)).toEqual([]);
    const restored = restoreImage(read.image);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    world.advanceTo(world.nowMs + 30n * MS_PER_DAY);
    restored.advanceTo(restored.nowMs + 30n * MS_PER_DAY);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    db.close();
  });

  it('keeps stock queryable in plain SQL: where every lot is, and what it came from', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(stockedWorld()), label());
    expect(
      rows(
        db,
        `SELECT l.id, l.product_id, l.quantity_micro, l.disposition, u.type_id, u.location_kind
         FROM stock_lots l JOIN load_units u ON u.id = l.load_unit_id ORDER BY l.ordinal`,
      ).slice(0, 2),
    ).toEqual([
      {
        id: 'lot:1',
        product_id: 'wood-screw-8-1-25',
        quantity_micro: 180_000_000n,
        disposition: 'available',
        type_id: 'carton-24x16x16',
        location_kind: 'load-unit',
      },
      {
        id: 'lot:2',
        product_id: 'wood-screw-8-1-25',
        quantity_micro: 200_000_000n,
        disposition: 'available',
        type_id: 'carton-24x16x16',
        location_kind: 'load-unit',
      },
    ]);
    expect(rows(db, "SELECT parent_lot_id FROM stock_lot_parents WHERE lot_id = 'lot:7'")).toEqual([
      { parent_lot_id: 'lot:1' },
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM stock_lot_serials WHERE lot_id = 'lot:5'")).toEqual([
      { n: 5n },
    ]);
    expect(
      rows(
        db,
        "SELECT kind, reason, cost_cents FROM stock_movements WHERE kind = 'scrap' ORDER BY ordinal",
      ),
    ).toEqual([
      { kind: 'scrap', reason: 'damaged', cost_cents: 104n },
      { kind: 'scrap', reason: 'defective', cost_cents: 9000n },
    ]);
    db.close();
  });

  it('refuses a receipt that differs from its invoice, or quantities the kernel cannot account for', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(stockedWorld()), label());
    db.prepare(
      "UPDATE stock_receipts SET cost_cents = cost_cents + 1 WHERE id = 'stock-receipt:1'",
    ).run();
    expect(checkIntegrity(db, SAVE_MIGRATIONS, LATEST)).toContain(
      '1 stock receipts differ from their invoices',
    );
    db.close();
    // A materialised screw passes every SQL check and is still refused on load.
    const other = saveDatabase();
    writeWorld(other, imageOf(stockedWorld()), label());
    other
      .prepare("UPDATE stock_lots SET quantity_micro = quantity_micro + 1000000 WHERE id = 'lot:2'")
      .run();
    expect(checkIntegrity(other, SAVE_MIGRATIONS, LATEST)).toEqual([]);
    expect(() => restoreImage(readWorld(other).image)).toThrow(/receipts less losses account for/);
    other.close();
  });

  it('cannot store an open lot in no load unit, or one serial twice', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(stockedWorld()), label());
    expect(() =>
      db.prepare("UPDATE stock_lots SET load_unit_id = NULL WHERE id = 'lot:2'").run(),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db
        .prepare(
          "UPDATE stock_lot_serials SET serial_id = (SELECT serial_id FROM stock_lot_serials WHERE lot_id = 'lot:5' AND position = 1) WHERE lot_id = 'lot:5' AND position = 2",
        )
        .run(),
    ).toThrow(/UNIQUE constraint/);
    db.close();
  });

  it('migration 6 adds empty stock tables to a format 5 save', () => {
    const db = saveDatabase(5);
    applyMigrations(db, SAVE_MIGRATIONS, {
      appVersion: '0.1.0',
      appliedAt: '2026-11-09T00:00:00Z',
    });
    expect(rows(db, 'SELECT count(*) AS n FROM stock')).toEqual([{ n: 0n }]);
    expect(rows(db, 'SELECT version FROM schema_migrations ORDER BY version').at(-1)).toEqual({
      version: 6n,
    });
    db.close();
  });

  it('a new world stores its catalogs and nothing else', () => {
    const db = saveDatabase();
    const world = stockWorld();
    writeWorld(db, imageOf(world), label());
    expect(rows(db, 'SELECT count(*) AS n FROM products')).toEqual([
      { n: BigInt(stockOf(world).products.length) },
    ]);
    expect(rows(db, 'SELECT count(*) AS n FROM load_units')).toEqual([{ n: 0n }]);
    expect(restoreImage(readWorld(db).image).fingerprint()).toEqual(world.fingerprint());
    db.close();
  });
});
