import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDatabase } from '../../../src/persistence/database';
import {
  readSchemaStamp,
  SAVE_MIGRATIONS,
  type Migration,
} from '../../../src/persistence/migrations';
import { SaveError } from '../../../src/persistence/save-error';
import { MS_PER_DAY } from '../../../src/domain/time';
import {
  makeStore,
  restoreImage,
  RUNTIME,
  tempDir,
  verifyImage,
  type TempDir,
} from '../../support/save-world';

/**
 * Frozen saves written by earlier builds (ADR-0027). `format-1-pending-probes.fisave`
 * was written once by the Step 04 `scripts/write-save-fixture.ts` with save
 * format 1, kernel format 1 and rules `freeindustry` v1, at 01:35 on day 0
 * with two probes pending. Step 05 introduced save format 2 (the company
 * tables) without changing the rules (ADR-0033), so this build upgrades it on
 * load, with a backup, and it must still continue to exactly the future it
 * had when it was written. Never regenerate it.
 */

const FIXTURE = join(__dirname, '../../fixtures/saves/format-1-pending-probes.fisave');
const LATEST = SAVE_MIGRATIONS.length;

/**
 * `format-2-company-books.fisave`, written once by the Step 05
 * `scripts/write-save-fixture.ts`: save format 2, rules v1, seed 19960105, at
 * 15:00 on day 45 (15 Feb 1996). A company founded with $50,000 has paid a
 * deposit, pays office rent by standing order, and has a $30,000 yard rent
 * bill overdue because the funds ran short; more bills are pending.
 */
const FIXTURE_2 = join(__dirname, '../../fixtures/saves/format-2-company-books.fisave');
const FIXTURE_2_AT_SAVE = {
  stateHash: 'cb9ef2faaef63bfee6a758eadba24a2fdb097d02a7bb5e15acbd88465c812995',
  journalHash: '0e19a0d8377a97a00afaf8f66fd89af3a3c0ee8c93a3617d1873c8f8151fe256',
};
const FIXTURE_2_DAY_120 = {
  stateHash: '89454469e86ab2c2a683801bb9217228a6b3e37fbe64a2ef8cefc4b08ab9e559',
  journalHash: 'c0ad8e47489ccf9e2a57b9b709576700de30fa655ae9a40dd5399d732b90c19e',
};

/** Fingerprints printed by the generator when the fixture was made. */
const AT_SAVE = {
  stateHash: '506fb7bafab31f790df7c41566a7455cdcf8edff964e808adca721db95cf6684',
  journalHash: '8adca1ef95bfe9d9f8ebbeaab8ae58dfef41f8780492bd6b3837f7a0bb86146f',
};
const END_OF_DAY = {
  stateHash: 'd77bb576f109e2bd083ac3a119345d72d9b654b405069b96664ca755dea6694e',
  journalHash: '8950b92367ed42ba896f8b93551af93a2923af57fde6bde7b23b06ab1352431c',
};

let dir: TempDir;

beforeEach(() => {
  dir = tempDir();
});

afterEach(() => {
  dir.remove();
});

function install(saveId = 'save-fixture') {
  const store = makeStore(join(dir.path, 'saves'));
  copyFileSync(FIXTURE, store.pathOf(saveId));
  return store;
}

describe('frozen save fixtures', () => {
  it('format 1: listed as older, upgraded on load with a backup, continuing exactly as when written', () => {
    const store = install();
    expect(store.inspect('save-fixture')).toEqual({
      saveId: 'save-fixture',
      status: 'needs-upgrade',
      problem: 'Saved in an older format (1); it will be upgraded, with a backup, when loaded.',
      header: null,
    });
    const loaded = store.read('save-fixture', verifyImage);
    expect(loaded.upgradedFrom).toBe(1);
    expect(loaded.label).toMatchObject({ name: 'Format 1 fixture', kind: 'manual' });
    expect(loaded.image.identity.worldId).toBe('1996a0a0-0000-4000-8000-000000000001');
    expect(loaded.image.workspace).toEqual({
      'window.personnel': { x: 24, y: 48, width: 320, height: 200, open: true },
    });
    expect(loaded.image.domain.company).toBeNull();
    const world = restoreImage(loaded.image);
    // The same fingerprints as the Step 04 build: the new company slice is absent, not empty.
    expect(world.fingerprint()).toEqual(AT_SAVE);
    expect(world.pendingEventCount).toBe(2);
    world.advanceTo(MS_PER_DAY);
    expect(world.fingerprint()).toEqual(END_OF_DAY);
    expect(world.state.diagnostics).toMatchObject({ firedProbes: 3, pendingProbes: 0 });
    // The slot is now current; the original is kept, untouched in format 1, as a backup.
    expect(store.inspect('save-fixture')).toMatchObject({
      status: 'ready',
      header: { seed: 19_960_101, nowMs: 5_700_000n, worldRevision: 4 },
    });
    expect(withDatabase(store.pathOf('save-fixture'), { mode: 'read' }, readSchemaStamp)).toEqual(
      expect.objectContaining({ userVersion: LATEST }),
    );
    const backups = readdirSync(join(store.directory, 'backups'));
    expect(backups).toEqual(['save-fixture.format-1.2026-11-07T12-00-00-000Z.fisave']);
    const backup = join(store.directory, 'backups', backups[0] ?? '');
    expect(withDatabase(backup, { mode: 'read' }, readSchemaStamp).userVersion).toBe(1);
    // The backup is itself a loadable format 1 save with the same world.
    store.importFrom(backup, 'save-from-backup', verifyImage);
    const again = restoreImage(store.read('save-from-backup', verifyImage).image);
    expect(again.fingerprint()).toEqual(AT_SAVE);
  });

  it('format 1: listing it never modifies the file', () => {
    const store = install();
    const before = readFileSync(store.pathOf('save-fixture'));
    store.list();
    store.inspect('save-fixture');
    expect(readFileSync(store.pathOf('save-fixture')).equals(before)).toBe(true);
    expect(existsSync(join(store.directory, 'backups'))).toBe(false);
  });

  it('format 1: upgrades through every later migration, including a test one, and plays the same', () => {
    const later: Migration = {
      version: LATEST + 1,
      description: 'Test: a later format',
      up: (db) => {
        db.exec('CREATE TABLE later_feature (id INTEGER PRIMARY KEY) STRICT');
      },
    };
    const store = install();
    const newer = makeStore(store.directory, { migrations: [...SAVE_MIGRATIONS, later] });
    const loaded = newer.read('save-fixture', verifyImage);
    expect(loaded.upgradedFrom).toBe(1);
    expect(
      withDatabase(newer.pathOf('save-fixture'), { mode: 'read' }, readSchemaStamp).userVersion,
    ).toBe(LATEST + 1);
    const world = restoreImage(loaded.image);
    world.advanceTo(MS_PER_DAY);
    expect(world.fingerprint()).toEqual(END_OF_DAY);
  });

  it('format 1 under different simulation rules: refused before any upgrade, file untouched', () => {
    const store = install();
    const before = readFileSync(store.pathOf('save-fixture'));
    const later = makeStore(store.directory, { runtime: { ...RUNTIME, rulesVersion: 2 } });
    const message =
      'This save was made with FreeIndustry simulation rules version 1. This build runs version 2 and has no conversion for it, so the world cannot continue exactly as it would have.';
    expect(later.inspect('save-fixture')).toMatchObject({
      status: 'incompatible',
      problem: message,
    });
    let error: unknown;
    try {
      later.read('save-fixture', verifyImage);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SaveError);
    expect((error as SaveError).code).toBe('INCOMPATIBLE_WORLD');
    expect((error as SaveError).message).toBe(message);
    expect(readFileSync(later.pathOf('save-fixture')).equals(before)).toBe(true);
    expect(existsSync(join(later.directory, 'backups'))).toBe(false);
  });

  it('format 2: upgraded on load with a backup, continuing the company books exactly as when written', () => {
    const store = makeStore(join(dir.path, 'saves'));
    copyFileSync(FIXTURE_2, store.pathOf('save-books'));
    // Step 07 added save format 3 (real estate) without changing the rules (ADR-0039).
    expect(store.inspect('save-books')).toMatchObject({ status: 'needs-upgrade' });
    const loaded = store.read('save-books', verifyImage);
    expect(loaded.upgradedFrom).toBe(2);
    expect(withDatabase(store.pathOf('save-books'), { mode: 'read' }, readSchemaStamp)).toEqual(
      expect.objectContaining({ userVersion: LATEST }),
    );
    const backups = readdirSync(join(store.directory, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = join(store.directory, 'backups', backups[0] ?? '');
    expect(withDatabase(backup, { mode: 'read' }, readSchemaStamp).userVersion).toBe(2);
    expect(store.inspect('save-books')).toMatchObject({
      status: 'ready',
      header: { seed: 19_960_105, nowMs: 3_942_000_000n, worldRevision: 5 },
    });
    // A world from before Step 07 has no real estate: the slice is absent, not empty.
    expect(loaded.image.domain.realEstate).toBeNull();
    const world = restoreImage(loaded.image);
    expect(world.fingerprint()).toEqual(FIXTURE_2_AT_SAVE);
    const company = world.state.company;
    expect(company).toMatchObject({
      legalName: 'Fixture Fabrication Co.',
      president: { name: 'Ada Fixture' },
      startingCapitalCents: 5_000_000n,
    });
    // $50,000 − $2,400 deposit − $30,000 yard rent − 2 × $1,200 office rent.
    expect(company?.ledger.accounts.map((account) => [account.code, account.balanceCents])).toEqual(
      [
        ['1010', 1_520_000n],
        ['1100', 0n],
        ['1400', 240_000n],
        ['2000', -3_000_000n],
        ['3000', -5_000_000n],
        ['4000', 0n],
        ['6100', 6_240_000n],
      ],
    );
    expect(
      company?.invoices
        .filter((invoice) => invoice.overdueSinceMs !== null && invoice.paidCents === 0n)
        .map((invoice) => invoice.totalCents),
    ).toEqual([3_000_000n]);
    world.advanceTo(120n * MS_PER_DAY);
    expect(world.fingerprint()).toEqual(FIXTURE_2_DAY_120);
    expect(world.checkInvariants()).toEqual([]);
  });
});

/**
 * `format-3-leased-workshop.fisave`, written once by the Step 07
 * `scripts/write-save-fixture.ts`: save format 3, rules v1, seed 19960107, at
 * 12:00 on day 100 (10 April 1996). A company founded with $2,600 leased the
 * workshop at 8 Canal Street, Harlow Falls, for six months; February and
 * March rent were paid by standing order and April's is overdue.
 */
const FIXTURE_3 = join(__dirname, '../../fixtures/saves/format-3-leased-workshop.fisave');
const FIXTURE_3_AT_SAVE = {
  stateHash: 'be58899b513eaf4117e9e951ce29f73081bd3afbd4a1ce4471fd2545a111c7f4',
  journalHash: '99eb8a9888c0b78b89715a235f69c660194d026f7d9fde06f2af04e9639981a5',
};
const FIXTURE_3_DAY_200 = {
  stateHash: '37753ee291aaa9ae5d7b7660472447126fffd567f894bab8a032a90c9e7810a9',
  journalHash: '580c774fac1f852b4a5e6b89e843daad65688c7c1f3857a783a869f5db43236d',
};

describe('frozen save fixtures: format 3', () => {
  it('loads unmodified, with its embedded real estate and lease, and continues past the lease end', () => {
    const store = makeStore(join(dir.path, 'saves'));
    copyFileSync(FIXTURE_3, store.pathOf('save-lease'));
    const before = readFileSync(store.pathOf('save-lease'));
    expect(store.inspect('save-lease')).toMatchObject({
      status: 'ready',
      header: { seed: 19_960_107, nowMs: 8_683_200_000n, worldRevision: 1 },
    });
    const loaded = store.read('save-lease', verifyImage);
    expect(loaded.upgradedFrom).toBeNull();
    expect(readFileSync(store.pathOf('save-lease')).equals(before)).toBe(true);
    const world = restoreImage(loaded.image);
    expect(world.fingerprint()).toEqual(FIXTURE_3_AT_SAVE);
    const estate = world.state.realEstate;
    expect(estate?.contentVersion).toBe('freeindustry-base/1');
    expect(estate?.properties).toHaveLength(41);
    expect(estate?.leases).toEqual([
      expect.objectContaining({ propertyId: 'hf-canal-8', termMonths: 6, status: 'active' }),
    ]);
    const overdue = world.state.company?.invoices.filter(
      (invoice) => invoice.overdueSinceMs !== null && invoice.paidCents === 0n,
    );
    expect(overdue?.map((invoice) => invoice.totalCents)).toEqual([52_000n]);
    world.advanceTo(200n * MS_PER_DAY);
    expect(world.fingerprint()).toEqual(FIXTURE_3_DAY_200);
    expect(world.state.realEstate?.leases[0]?.status).toBe('ended');
    expect(world.checkInvariants()).toEqual([]);
  });
});
