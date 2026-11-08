import Database from 'better-sqlite3';
import { withDatabase, type SqliteDatabase } from '../../../src/persistence/database';
import { checkIntegrity } from '../../../src/persistence/integrity';
import { applyMigrations, SAVE_MIGRATIONS } from '../../../src/persistence/migrations';
import type { SaveError } from '../../../src/persistence/save-error';
import { readWorld, writeWorld } from '../../../src/persistence/world-repository';
import { MS_PER_DAY, MS_PER_HOUR } from '../../../src/domain/time';
import { estateWorld } from '../../support/real-estate-world';
import {
  command,
  imageOf,
  label,
  makeStore,
  newWorld,
  restoreImage,
  tempDir,
  verifyImage,
  type TempDir,
  type World,
} from '../../support/save-world';

/**
 * Step 07 persistence (save format 3, ADR-0039): a world's cities,
 * districts, properties and businesses, and the company's lease, are stored
 * relationally, read back exactly, and refused when altered.
 */

const LATEST = SAVE_MIGRATIONS.length;

function saveDatabase(): SqliteDatabase {
  const db = new Database(':memory:');
  db.defaultSafeIntegers(true);
  db.pragma('foreign_keys = ON');
  applyMigrations(db, SAVE_MIGRATIONS, { appVersion: '0.1.0', appliedAt: '2026-11-08T00:00:00Z' });
  return db;
}

const rows = (db: SqliteDatabase, sql: string) => db.prepare(sql).all();

/** A company leasing the workshop at 8 Canal Street, two months in. */
function leasedWorld(): World {
  const world = estateWorld(3);
  world.advanceTo(9n * MS_PER_HOUR);
  command(world, 'company.found', {
    legalName: 'Canal Works',
    presidentName: 'Jo Canal',
    startingCapitalCents: '5000000',
    premises: { propertyId: 'hf-canal-8', termMonths: 12, standingOrder: true },
  });
  world.advanceTo(62n * MS_PER_DAY);
  return world;
}

describe('real estate in a save', () => {
  it('round-trips a leased world exactly and continues identically to the end of the lease', () => {
    const db = saveDatabase();
    const world = leasedWorld();
    const image = imageOf(world);
    writeWorld(db, image, label('Lease'));
    const read = readWorld(db);
    expect(read.image).toEqual(image);
    expect(checkIntegrity(db, SAVE_MIGRATIONS, LATEST)).toEqual([]);
    const restored = restoreImage(read.image);
    const end = 400n * MS_PER_DAY;
    restored.advanceTo(end);
    world.advanceTo(end);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    expect(restored.state.realEstate?.leases[0]?.status).toBe('ended');
    db.close();
  });

  it('keeps cities, properties and the lease queryable in plain SQL', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(leasedWorld()), label());
    expect(rows(db, 'SELECT id FROM cities ORDER BY position')).toEqual([
      { id: 'harlow-falls' },
      { id: 'port-calder' },
      { id: 'cedar-bluff' },
    ]);
    expect(rows(db, 'SELECT count(*) AS n FROM properties')).toEqual([{ n: 41n }]);
    expect(
      rows(db, 'SELECT count(*) AS n FROM properties WHERE occupant_business_id IS NOT NULL'),
    ).toEqual([{ n: 14n }]);
    // The leased workshop's floor outline, and its rent joined to the company's obligation.
    expect(
      rows(
        db,
        "SELECT x_mm, y_mm FROM property_floor_points WHERE property_id = 'hf-canal-8' ORDER BY position",
      ),
    ).toEqual([
      { x_mm: 0n, y_mm: 0n },
      { x_mm: 8000n, y_mm: 0n },
      { x_mm: 8000n, y_mm: 12_000n },
      { x_mm: 0n, y_mm: 12_000n },
    ]);
    expect(
      rows(
        db,
        `SELECT l.id, p.address, l.status, o.amount_cents, o.issued
         FROM leases l JOIN properties p ON p.id = l.property_id
         JOIN obligations o ON o.id = l.rent_obligation_id`,
      ),
    ).toEqual([
      {
        id: 'lease:1',
        address: '8 Canal Street',
        status: 'active',
        amount_cents: 52_000n,
        issued: 3n,
      },
    ]);
    db.close();
  });

  it('a world without real estate stores none', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(newWorld()), label());
    for (const table of ['real_estate', 'cities', 'properties', 'leases']) {
      expect(rows(db, `SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 0n }]);
    }
    expect(readWorld(db).image.domain.realEstate).toBeNull();
    db.close();
  });

  describe('altered real estate is refused on load', () => {
    let dir: TempDir;
    beforeEach(() => {
      dir = tempDir();
    });
    afterEach(() => {
      dir.remove();
    });

    function refusal(sql: string): SaveError {
      const store = makeStore(dir.path);
      store.write('save-lease', imageOf(leasedWorld()), label('Lease'), verifyImage);
      withDatabase(store.pathOf('save-lease'), { mode: 'write' }, (db) => {
        db.exec(sql);
      });
      try {
        store.read('save-lease', verifyImage);
      } catch (error) {
        return error as SaveError;
      }
      throw new Error('the altered save was accepted');
    }

    it('a leased property also occupied by a business', () => {
      const error = refusal(
        "UPDATE properties SET occupant_business_id = 'ohio-valley-coop' WHERE id = 'hf-canal-8'",
      );
      expect(error.code).toBe('CORRUPT');
      expect(error.message).toMatch(/1 leased properties are also occupied by a business/);
    });

    it('a lease that no longer matches its rent obligation', () => {
      const error = refusal('UPDATE leases SET rent_cents_per_month = 100');
      expect(error.message).toMatch(/1 leases differ from their rent or deposit obligations/);
    });

    it('a bigger floor, consistently stored, fails the fingerprint check', () => {
      const error = refusal(
        "UPDATE property_floor_points SET x_mm = 9000 WHERE property_id = 'hf-canal-8' AND x_mm = 8000",
      );
      expect(error.code).toBe('CORRUPT');
      expect(error.message).toMatch(/failed verification/);
    });
  });
});
