import Database from 'better-sqlite3';
import type { SqliteDatabase } from '../../../src/persistence/database';
import { checkIntegrity } from '../../../src/persistence/integrity';
import { applyMigrations, SAVE_MIGRATIONS } from '../../../src/persistence/migrations';
import { readWorld, writeWorld } from '../../../src/persistence/world-repository';
import { MS_PER_DAY } from '../../../src/domain/time';
import {
  accept,
  buy,
  leasedWorld,
  placement,
  withCoverings,
  worksFinishAt,
  type World,
} from '../../support/facility-world';
import {
  imageOf,
  label,
  makeStore,
  restoreImage,
  tempDir,
  verifyImage,
} from '../../support/save-world';

/**
 * Step 08 persistence (save format 4, ADR-0049): building structure, the
 * catalogs, owned and installed equipment and the floor-covering layer are
 * stored relationally, read back exactly, continue identically, and are
 * refused when altered.
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

/** The industrial unit with a mezzanine: a 3,658 × 1,829 mm saw installed and turned, an item held by its dealer, and coverings. */
function laidOutWorld(): World {
  let world = leasedWorld('hf-canal-20');
  const [saw = '', bench = ''] = [
    ...buy(world, 'sliding-table-panel-saw'),
    ...buy(world, 'steel-workbench', 2),
  ];
  accept(world, 'equipment.install', placement(saw, 3000, 12000, 90, 'hf-canal-20'));
  accept(world, 'equipment.install', placement(bench, 1000, 1000, 0, 'hf-canal-20', 1));
  world.advanceTo(world.nowMs + 3n * MS_PER_DAY);
  world = withCoverings(
    world,
    [
      { level: 0, col: 6, row: 24, materialId: 'steel-plate' },
      { level: 0, col: 7, row: 24, materialId: 'steel-plate' },
      { level: 1, col: 0, row: 0, materialId: 'office-carpet-tile' },
    ],
    'hf-canal-20',
  );
  return world;
}

describe('facilities in a save', () => {
  it('round-trips equipment, structure and coverings exactly and continues identically', () => {
    const db = saveDatabase();
    const world = laidOutWorld();
    expect(world.checkInvariants()).toEqual([]);
    const image = imageOf(world);
    writeWorld(db, image, label('Layout'));
    const read = readWorld(db);
    expect(read.image).toEqual(image);
    expect(checkIntegrity(db, SAVE_MIGRATIONS, LATEST)).toEqual([]);
    const restored = restoreImage(read.image);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    // The odd-sized saw keeps its exact catalog footprint and placement.
    const saw = restored.state.facilities?.equipment.find(
      (item) => item.typeId === 'sliding-table-panel-saw',
    );
    expect(saw?.placement).toEqual({
      propertyId: 'hf-canal-20',
      level: 0,
      xMm: 3000,
      yMm: 12000,
      rotation: 90,
    });
    const type = restored.state.facilities?.equipmentTypes.find(
      (item) => item.id === 'sliding-table-panel-saw',
    );
    expect([type?.widthMm, type?.depthMm]).toEqual([3658, 1829]);
    expect(restored.state.facilities?.coverings).toEqual(world.state.facilities?.coverings);
    const end = 200n * MS_PER_DAY;
    restored.advanceTo(end);
    world.advanceTo(end);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    db.close();
  });

  it('keeps layouts queryable in plain SQL', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(laidOutWorld()), label());
    expect(rows(db, 'SELECT count(*) AS n FROM buildings')).toEqual([{ n: 41n }]);
    expect(
      rows(db, "SELECT surface_material_id FROM buildings WHERE property_id = 'hf-canal-2'"),
    ).toEqual([{ surface_material_id: 'concrete-worn' }]);
    expect(
      rows(
        db,
        'SELECT id, type_id, property_id, level, x_mm, y_mm, rotation FROM equipment ORDER BY ordinal',
      ),
    ).toEqual([
      {
        id: 'equipment:1',
        type_id: 'sliding-table-panel-saw',
        property_id: 'hf-canal-20',
        level: 0n,
        x_mm: 3000n,
        y_mm: 12000n,
        rotation: 90n,
      },
      {
        id: 'equipment:2',
        type_id: 'steel-workbench',
        property_id: 'hf-canal-20',
        level: 1n,
        x_mm: 1000n,
        y_mm: 1000n,
        rotation: 0n,
      },
      {
        id: 'equipment:3',
        type_id: 'steel-workbench',
        property_id: null,
        level: null,
        x_mm: null,
        y_mm: null,
        rotation: null,
      },
    ]);
    expect(
      rows(
        db,
        'SELECT level, col, row, material_id FROM floor_cell_coverings ORDER BY level, row, col',
      ),
    ).toEqual([
      { level: 0n, col: 6n, row: 24n, material_id: 'steel-plate' },
      { level: 0n, col: 7n, row: 24n, material_id: 'steel-plate' },
      { level: 1n, col: 0n, row: 0n, material_id: 'office-carpet-tile' },
    ]);
    db.close();
  });

  it('a plain floor stores no covering rows at all', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(leasedWorld()), label());
    expect(rows(db, 'SELECT count(*) AS n FROM floor_cell_coverings')).toEqual([{ n: 0n }]);
    db.close();
  });

  it('refuses a save whose equipment stands in premises nobody leases, or whose layout was tampered with', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(laidOutWorld()), label());
    db.prepare(
      "UPDATE equipment SET property_id = 'hf-canal-2', level = 0, x_mm = 0, y_mm = 0, rotation = 0 WHERE id = 'equipment:3'",
    ).run();
    expect(checkIntegrity(db, SAVE_MIGRATIONS, LATEST)).toContain(
      '1 items of equipment stand in premises nobody leases',
    );
    db.close();
    // An overlap the SQL checks cannot see is refused by the kernel's invariants on load.
    const other = saveDatabase();
    writeWorld(other, imageOf(laidOutWorld()), label());
    other
      .prepare("UPDATE equipment SET x_mm = 3000, y_mm = 12000, level = 0 WHERE id = 'equipment:2'")
      .run();
    expect(checkIntegrity(other, SAVE_MIGRATIONS, LATEST)).toEqual([]);
    expect(() => restoreImage(readWorld(other).image)).toThrow(/overlaps/);
    other.close();
  });

  it('stores floor orders with their cells and charges, laid or under way, and continues them identically (format 5)', () => {
    const db = saveDatabase();
    const world = leasedWorld('hf-canal-2');
    accept(world, 'facility.installFloorCovering', {
      propertyId: 'hf-canal-2',
      level: 0,
      materialId: 'epoxy-grey',
      rectangles: [{ col: 0, row: 10, cols: 6, rows: 2 }],
    });
    world.advanceTo(worksFinishAt(world));
    // A replacement still under way when the game is saved.
    accept(world, 'facility.installFloorCovering', {
      propertyId: 'hf-canal-2',
      level: 0,
      materialId: 'steel-plate',
      rectangles: [{ col: 4, row: 9, cols: 2, rows: 3 }],
    });
    const image = imageOf(world);
    writeWorld(db, image, label('Floor works'));
    expect(checkIntegrity(db, SAVE_MIGRATIONS, LATEST)).toEqual([]);
    expect(readWorld(db).image).toEqual(image);
    expect(
      rows(
        db,
        `SELECT id, material_id, status, kind, cells, area_mm2, replaced_cells, install_cents,
           removal_cents, cost_cents FROM floor_covering_installations ORDER BY ordinal`,
      ),
    ).toEqual([
      {
        id: 'floor-installation:1',
        material_id: 'epoxy-grey',
        status: 'complete',
        kind: 'installation',
        cells: 12n,
        area_mm2: 2_400_000n, // six full cells and six partial cells of 150,000 mm²
        replaced_cells: 0n,
        install_cents: 13_200n,
        removal_cents: 0n,
        cost_cents: 13_200n,
      },
      {
        id: 'floor-installation:2',
        material_id: 'steel-plate',
        status: 'scheduled',
        kind: 'mixed',
        cells: 6n,
        area_mm2: 1_300_000n,
        replaced_cells: 4n,
        install_cents: 23_400n,
        removal_cents: 1_280n,
        cost_cents: 24_680n,
      },
    ]);
    expect(
      rows(
        db,
        "SELECT row, first_col, end_col FROM floor_covering_installation_runs WHERE installation_id = 'floor-installation:2' ORDER BY position",
      ),
    ).toEqual([
      { row: 9n, first_col: 4n, end_col: 6n },
      { row: 10n, first_col: 4n, end_col: 6n },
      { row: 11n, first_col: 4n, end_col: 6n },
    ]);
    const restored = restoreImage(readWorld(db).image);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    // The pending completion was saved in the event queue: both finish the job identically.
    const later = world.nowMs + 5n * MS_PER_DAY;
    world.advanceTo(later);
    restored.advanceTo(later);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    expect(restored.state.facilities?.installations.map((job) => job.status)).toEqual([
      'complete',
      'complete',
    ]);
    db.close();
  });

  it('refuses a save whose floor order disagrees with its entry, or names cells it does not change', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(laidOutWorld()), label());
    db.prepare(
      "UPDATE floor_covering_installations SET install_cents = install_cents + 1, cost_cents = cost_cents + 1 WHERE id = 'floor-installation:1'",
    ).run();
    expect(checkIntegrity(db, SAVE_MIGRATIONS, LATEST)).toContain(
      '1 floor installations differ from their journal entries',
    );
    db.close();
    const other = saveDatabase();
    writeWorld(other, imageOf(laidOutWorld()), label());
    other
      .prepare(
        "UPDATE floor_covering_installation_runs SET end_col = end_col + 1 WHERE installation_id = 'floor-installation:1'",
      )
      .run();
    expect(() => restoreImage(readWorld(other).image)).toThrow(/cell count or area|did not lay it/);
    other.close();
  });

  it('migration 5 refuses a format 4 save that somehow holds floor coverings', () => {
    const db = new Database(':memory:');
    db.defaultSafeIntegers(true);
    const context = { appVersion: '0.1.0', appliedAt: '2026-11-08T00:00:00Z' };
    applyMigrations(db, SAVE_MIGRATIONS.slice(0, 4), context);
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO floor_covering_installations (ordinal, id, property_id, firm_id, game_time_ms, kind,
         cells, area_mm2, cost_cents, journal_entry_id)
       VALUES (1, 'floor-installation:1', 'hf-canal-2', 'firm:1', 0, 'installation', 1, 1, 1, 'entry:1')`,
    ).run();
    expect(() => applyMigrations(db, SAVE_MIGRATIONS, context)).toThrow(
      /no build before Step 09A could create/,
    );
    db.close();
  });

  it('survives a save store write and read with identical fingerprints', () => {
    const dir = tempDir();
    try {
      const store = makeStore(dir.path);
      const world = laidOutWorld();
      store.write('save-layout', imageOf(world), label('Layout'), verifyImage);
      const loaded = store.read('save-layout', verifyImage);
      expect(restoreImage(loaded.image).fingerprint()).toEqual(world.fingerprint());
    } finally {
      dir.remove();
    }
  });
});
