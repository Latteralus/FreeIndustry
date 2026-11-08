import fc from 'fast-check';
import Database from 'better-sqlite3';
import type { SqliteDatabase } from '../../../src/persistence/database';
import { applyMigrations, SAVE_MIGRATIONS } from '../../../src/persistence/migrations';
import { checkIntegrity } from '../../../src/persistence/integrity';
import { readHeader, readWorld, writeWorld } from '../../../src/persistence/world-repository';
import { MS_PER_MINUTE } from '../../../src/domain/time';
import {
  busyWorld,
  command,
  imageOf,
  label,
  newWorld,
  restoreImage,
  WORLD_ID,
} from '../../support/save-world';

function saveDatabase(): SqliteDatabase {
  const db = new Database(':memory:');
  db.defaultSafeIntegers(true);
  db.pragma('foreign_keys = ON');
  applyMigrations(db, SAVE_MIGRATIONS, { appVersion: '0.1.0', appliedAt: '2026-11-07T00:00:00Z' });
  return db;
}

const count = (db: SqliteDatabase, sql: string) =>
  Number((db.prepare(sql).get() as { n: bigint }).n);

describe('world repository', () => {
  it('writes a world mid-play and reads back exactly the same image', () => {
    const db = saveDatabase();
    const world = busyWorld();
    const image = imageOf(world);
    writeWorld(db, image, label('Mid-morning'));
    const read = readWorld(db);
    expect(read.label).toEqual(label('Mid-morning'));
    expect(read.image).toEqual(image);
    expect(checkIntegrity(db, SAVE_MIGRATIONS, SAVE_MIGRATIONS.length)).toEqual([]);
    // And the kernel accepts it as the very same world.
    expect(restoreImage(read.image).fingerprint()).toEqual(world.fingerprint());
  });

  it('stores core state relationally, not as one blob', () => {
    const db = saveDatabase();
    const world = busyWorld();
    writeWorld(db, imageOf(world), label());
    expect(count(db, "SELECT count(*) AS n FROM journal_entries WHERE kind = 'command'")).toBe(
      world.worldRevision,
    );
    expect(count(db, "SELECT count(*) AS n FROM journal_entries WHERE kind = 'event'")).toBe(
      world.processedEvents,
    );
    const pending = db
      .prepare('SELECT type, time_ms FROM pending_events ORDER BY time_ms')
      .all() as { type: string; time_ms: bigint }[];
    expect(pending.map((row) => row.type)).toEqual([
      'diagnostics.probeDue',
      'diagnostics.probeDue',
    ]);
    expect(pending.map((row) => row.time_ms)).toEqual([
      4n * 60n * MS_PER_MINUTE,
      7n * 60n * MS_PER_MINUTE,
    ]);
    expect(count(db, "SELECT count(*) AS n FROM rng_streams WHERE name = 'diagnostics'")).toBe(1);
    expect(
      db.prepare('SELECT probe_count, pending_probes, fired_probes FROM diagnostics_state').get(),
    ).toEqual({ probe_count: 1n, pending_probes: 2n, fired_probes: 2n });
    expect(
      count(db, "SELECT count(*) AS n FROM journal_facts WHERE type = 'diagnostics.probeFired'"),
    ).toBe(2);
    expect(readHeader(db)).toMatchObject({
      worldId: WORLD_ID,
      rulesId: 'freeindustry',
      seed: 7,
      nowMs: world.nowMs,
      worldRevision: world.worldRevision,
    });
  });

  it('property: any reachable world round-trips through SQLite and continues identically', () => {
    const step = fc.oneof(
      fc.record({
        kind: fc.constant('record' as const),
        label: fc.string({ minLength: 1, maxLength: 12 }),
      }),
      fc.record({
        kind: fc.constant('schedule' as const),
        label: fc.string({ minLength: 1, maxLength: 12 }),
        minutes: fc.integer({ min: 1, max: 600 }),
      }),
      fc.record({
        kind: fc.constant('advance' as const),
        minutes: fc.integer({ min: 0, max: 300 }),
      }),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.array(step, { maxLength: 25 }),
        (seed, steps) => {
          const world = newWorld(seed);
          for (const item of steps) {
            if (item.kind === 'record') {
              command(world, 'diagnostics.recordProbe', { label: item.label });
            } else if (item.kind === 'schedule' && world.state.diagnostics.pendingProbes < 100) {
              command(world, 'diagnostics.scheduleProbe', {
                label: item.label,
                delayMs: item.minutes * 60_000,
              });
            } else if (item.kind === 'advance') {
              world.advanceTo(world.nowMs + BigInt(item.minutes) * MS_PER_MINUTE);
            }
          }
          const db = saveDatabase();
          writeWorld(db, imageOf(world), label());
          const restored = restoreImage(readWorld(db).image);
          db.close();
          const end = world.nowMs + 2_000n * MS_PER_MINUTE;
          world.advanceTo(end);
          restored.advanceTo(end);
          expect(restored.fingerprint()).toEqual(world.fingerprint());
        },
      ),
      { numRuns: 60 },
    );
  });

  it('appends only the new journal tail on an incremental checkpoint', () => {
    const db = saveDatabase();
    const world = newWorld();
    command(world, 'diagnostics.scheduleProbe', { label: 'x', delayMs: 60_000 });
    writeWorld(db, imageOf(world), label());
    const stored = world.journal.length;
    world.advanceTo(10n * MS_PER_MINUTE);
    command(world, 'diagnostics.recordProbe', { label: 'later' });
    writeWorld(db, imageOf(world, stored + 1), label(), stored + 1);
    expect(readWorld(db).image).toEqual(imageOf(world));
  });

  it('refuses a journal tail that does not continue the stored journal, changing nothing', () => {
    const db = saveDatabase();
    const world = newWorld();
    command(world, 'diagnostics.recordProbe', { label: 'one' });
    writeWorld(db, imageOf(world), label('first'));
    const before = readWorld(db);
    command(world, 'diagnostics.recordProbe', { label: 'two' });
    command(world, 'diagnostics.recordProbe', { label: 'three' });
    // The stored journal has 1 entry; a tail from 3 would leave a gap.
    expect(() => {
      writeWorld(db, imageOf(world, 3), label('second'), 3);
    }).toThrow(/does not continue/);
    expect(readWorld(db)).toEqual(before);
  });

  it('rolls a failed write back completely: the previous world is still there, intact', () => {
    const db = saveDatabase();
    const first = busyWorld(1);
    writeWorld(db, imageOf(first), label('first'));
    const before = readWorld(db);
    const second = imageOf(busyWorld(2));
    // A corrupt random stream fails a CHECK constraint after the metadata,
    // world and snapshot rows have already been replaced inside the transaction.
    const broken = {
      ...second,
      kernel: { ...second.kernel, rngStreams: { diagnostics: [1, 2, 3, -1] } },
    };
    expect(() => {
      writeWorld(db, broken, label('second'));
    }).toThrow(/CHECK constraint/);
    expect(readWorld(db)).toEqual(before);
    expect(checkIntegrity(db, SAVE_MIGRATIONS, SAVE_MIGRATIONS.length)).toEqual([]);
  });

  it('refuses values that do not fit SQLite 64-bit integers', () => {
    const db = saveDatabase();
    const image = imageOf(newWorld());
    expect(() => {
      writeWorld(
        db,
        { ...image, kernel: { ...image.kernel, nowMs: (2n ** 63n).toString() } },
        label(),
      );
    }).toThrow(/does not fit a 64-bit integer/);
    expect(count(db, 'SELECT count(*) AS n FROM worlds')).toBe(0);
  });

  it('refuses a journal whose length disagrees with the world', () => {
    const db = saveDatabase();
    const world = busyWorld();
    const image = imageOf(world);
    expect(() => {
      writeWorld(db, { ...image, journal: image.journal.slice(1) }, label());
    }).toThrow(/Journal/);
  });
});
