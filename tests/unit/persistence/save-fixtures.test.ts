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
  it('is upgraded on load with a backup, keeps its embedded real estate and lease, and continues past the lease end', () => {
    const store = makeStore(join(dir.path, 'saves'));
    copyFileSync(FIXTURE_3, store.pathOf('save-lease'));
    // Step 08 added save format 4 (facilities) without changing the rules (ADR-0049).
    expect(store.inspect('save-lease')).toMatchObject({ status: 'needs-upgrade' });
    const loaded = store.read('save-lease', verifyImage);
    expect(loaded.upgradedFrom).toBe(3);
    const backups = readdirSync(join(store.directory, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = join(store.directory, 'backups', backups[0] ?? '');
    expect(withDatabase(backup, { mode: 'read' }, readSchemaStamp).userVersion).toBe(3);
    expect(store.inspect('save-lease')).toMatchObject({
      status: 'ready',
      header: { seed: 19_960_107, nowMs: 8_683_200_000n, worldRevision: 1 },
    });
    // A world from before Step 08 has no facilities: the slice is absent, not empty.
    expect(loaded.image.domain.facilities).toBeNull();
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

/**
 * `format-4-installed-equipment.fisave`, written once by the Step 08
 * `scripts/write-save-fixture.ts`: save format 4, rules v1, seed 19960108,
 * at 12:00 on day 40. A company with $60,000 leases the industrial unit at
 * 20 Canal Street for a year; a 3,658 × 1,829 mm panel saw stands turned a
 * quarter on the ground floor, a workbench was installed on the mezzanine
 * and then moved (a paid relocation), and a second bench is held by its
 * dealer.
 */
const FIXTURE_4 = join(__dirname, '../../fixtures/saves/format-4-installed-equipment.fisave');
const FIXTURE_4_AT_SAVE = {
  stateHash: 'b949ce27816e56cb71f91deb0b1769f92f3cf14e042ad48b7baf7daa7a3019c9',
  journalHash: 'f67b8e4fb8cf9cfa1d573d1f92311162e06e6d0b3d50a32906d22a175ab40eff',
};
const FIXTURE_4_DAY_400 = {
  stateHash: '9a164f5702cb862e8181a56fe46e9151b8f5993914d6191e23f11a67788f0c7d',
  journalHash: 'fa0235a92cd97652b8091a7c5d68306874487c3fcd403c4dae2eedf7d80a7fb4',
};

describe('frozen save fixtures: format 4', () => {
  it('is upgraded on load with a backup, keeps its exact layout, and continues past the lease end', () => {
    const store = makeStore(join(dir.path, 'saves'));
    copyFileSync(FIXTURE_4, store.pathOf('save-layout'));
    // Step 09A added save format 5 (floor works) without changing the rules (ADR-0052).
    expect(store.inspect('save-layout')).toMatchObject({ status: 'needs-upgrade' });
    const loaded = store.read('save-layout', verifyImage);
    expect(loaded.upgradedFrom).toBe(4);
    const backups = readdirSync(join(store.directory, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = join(store.directory, 'backups', backups[0] ?? '');
    expect(withDatabase(backup, { mode: 'read' }, readSchemaStamp).userVersion).toBe(4);
    expect(store.inspect('save-layout')).toMatchObject({
      status: 'ready',
      header: { seed: 19_960_108, nowMs: 3_499_200_000n, worldRevision: 6 },
    });
    const world = restoreImage(loaded.image);
    expect(world.fingerprint()).toEqual(FIXTURE_4_AT_SAVE);
    expect(world.state.facilities?.equipment.map((item) => [item.typeId, item.placement])).toEqual([
      [
        'sliding-table-panel-saw',
        { propertyId: 'hf-canal-20', level: 0, xMm: 3000, yMm: 12000, rotation: 90 },
      ],
      [
        'steel-workbench',
        { propertyId: 'hf-canal-20', level: 1, xMm: 3000, yMm: 1500, rotation: 0 },
      ],
      ['steel-workbench', null],
    ]);
    world.advanceTo(400n * MS_PER_DAY);
    expect(world.fingerprint()).toEqual(FIXTURE_4_DAY_400);
    expect(world.state.facilities?.equipment.every((item) => item.placement === null)).toBe(true);
    expect(world.checkInvariants()).toEqual([]);
  });
});

/**
 * `format-5-floor-works.fisave`, written once by the Step 09A
 * `scripts/write-save-fixture.ts`: save format 5, rules v1, seed 19960109,
 * at 12:00 on day 40. A company with $60,000 leases 20 Canal Street for a
 * year; the panel saw stands turned a quarter; grey epoxy was laid across 140
 * cells and carpet tiles across 48 mezzanine cells; a steel-plate order over
 * part of the epoxy and some bare floor was placed at the save and is still
 * under way.
 */
const FIXTURE_5 = join(__dirname, '../../fixtures/saves/format-5-floor-works.fisave');
const FIXTURE_5_AT_SAVE = {
  stateHash: '09b89d9094f5237e7d69dc63ce8fe0dbe7f15085381ab2f516eebda0dd8dedb6',
  journalHash: 'aa3821d941547dd33cc3e61c3e7592a2e682e9e637d5e7edd22a6dc1b134dee5',
};
const FIXTURE_5_DAY_400 = {
  stateHash: '3b1c91cde65caf138b7df474889e1509e698e4ebe2c611fba42a4764e0adccd7',
  journalHash: 'aedf274230315aa007851203b826bdbf1ad8268260cda7f524c47a1c320147d9',
};

describe('frozen save fixtures: format 5', () => {
  it('is upgraded on load with a backup, finishes the order under way, and keeps the floor past the lease end', () => {
    const store = makeStore(join(dir.path, 'saves'));
    copyFileSync(FIXTURE_5, store.pathOf('save-floor'));
    // Step 10 added save format 6 (stock) without changing the rules (ADR-0056).
    expect(store.inspect('save-floor')).toMatchObject({ status: 'needs-upgrade' });
    const loaded = store.read('save-floor', verifyImage);
    expect(loaded.upgradedFrom).toBe(5);
    const backups = readdirSync(join(store.directory, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = join(store.directory, 'backups', backups[0] ?? '');
    expect(withDatabase(backup, { mode: 'read' }, readSchemaStamp).userVersion).toBe(5);
    expect(store.inspect('save-floor')).toMatchObject({
      status: 'ready',
      header: { seed: 19_960_109, nowMs: 3_499_200_000n, worldRevision: 6 },
    });
    const world = restoreImage(loaded.image);
    // A world made before Step 10 has no stock records, and its fingerprints are unchanged.
    expect(world.state.stock).toBeNull();
    expect(world.fingerprint()).toEqual(FIXTURE_5_AT_SAVE);
    const jobs = () =>
      world.state.facilities?.installations.map((job) => [job.materialId, job.kind, job.status]);
    expect(jobs()).toEqual([
      ['epoxy-grey', 'installation', 'complete'],
      ['office-carpet-tile', 'installation', 'complete'],
      ['steel-plate', 'mixed', 'scheduled'],
    ]);
    expect(world.state.facilities?.coverings).toHaveLength(188);
    world.advanceTo(400n * MS_PER_DAY);
    expect(world.fingerprint()).toEqual(FIXTURE_5_DAY_400);
    expect(jobs()?.every(([, , status]) => status === 'complete')).toBe(true);
    // The lease ended and the dealer took the saw; the floor stays with the building.
    expect(world.state.realEstate?.leases[0]?.status).toBe('ended');
    expect(world.state.facilities?.equipment[0]?.placement).toBeNull();
    expect(
      world.state.facilities?.coverings.filter((cell) => cell.materialId === 'steel-plate'),
    ).toHaveLength(72);
    expect(world.checkInvariants()).toEqual([]);
  });
});

/**
 * `format-6-stock.fisave`, written once by the Step 10
 * `scripts/write-save-fixture.ts`: save format 6, rules v1, seed 19960110,
 * at 12:00 on day 20. A company leases the factory at 8 Northgate Drive for
 * two years with a workbench installed; four test deliveries stand on the
 * dock aprons (screws in four cartons on a pallet, six serialized motors on
 * a pallet, a drum of enamel, a bulk bag of pellets); 20 screws and one motor
 * have been classified as scrap.
 */
const FIXTURE_6 = join(__dirname, '../../fixtures/saves/format-6-stock.fisave');
const FIXTURE_6_AT_SAVE = {
  stateHash: '09cb135e93357bf035ee36afcc758a538e2be027249cddfa4897f12ee67b979a',
  journalHash: '320666f8c059051c45254076a683da9318bb17384acdcbef9f232f1dd9104f7d',
};
const FIXTURE_6_DAY_800 = {
  stateHash: '4a1696e7aebfae310ab81fe7d87233151b83500fb0e13ce28807aff37f973af9',
  journalHash: '38716ac8f6cc30e9143769696de3dec38294c9e2367e9070ce33668480459fd1',
};

describe('frozen save fixtures: format 6', () => {
  it('loads unmodified with its stock, and keeps every lot where it stands past the lease end', () => {
    const store = makeStore(join(dir.path, 'saves'));
    copyFileSync(FIXTURE_6, store.pathOf('save-stock'));
    const before = readFileSync(store.pathOf('save-stock'));
    expect(store.inspect('save-stock')).toMatchObject({
      status: 'ready',
      header: { seed: 19_960_110, nowMs: 1_771_200_000n, worldRevision: 9 },
    });
    const loaded = store.read('save-stock', verifyImage);
    expect(loaded.upgradedFrom).toBeNull();
    expect(readFileSync(store.pathOf('save-stock')).equals(before)).toBe(true);
    const world = restoreImage(loaded.image);
    expect(world.fingerprint()).toEqual(FIXTURE_6_AT_SAVE);
    const stock = world.state.stock;
    expect(stock?.receipts.map((receipt) => receipt.productId)).toEqual([
      'wood-screw-8-1-25',
      'motor-half-hp',
      'enamel-machine-grey',
      'hdpe-pellets',
    ]);
    expect(stock?.loadUnits.filter((unit) => unit.location.kind === 'floor')).toHaveLength(4);
    expect(
      stock?.lots.filter((lot) => lot.disposition === 'scrap').map((lot) => lot.quantityMicro),
    ).toEqual([20_000_000n, 1_000_000n]);
    const before800 = stock?.loadUnits.map((unit) => unit.location);
    world.advanceTo(800n * MS_PER_DAY);
    expect(world.fingerprint()).toEqual(FIXTURE_6_DAY_800);
    expect(world.state.realEstate?.leases[0]?.status).toBe('ended');
    expect(world.state.stock?.loadUnits.map((unit) => unit.location)).toEqual(before800);
    expect(world.checkInvariants()).toEqual([]);
  });
});
