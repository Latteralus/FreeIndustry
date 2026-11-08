import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { withDatabase } from '../../../src/persistence/database';
import {
  SAVE_MIGRATIONS,
  readSchemaStamp,
  type Migration,
} from '../../../src/persistence/migrations';
import { SaveError } from '../../../src/persistence/save-error';
import type { SaveStore } from '../../../src/persistence/save-store';
import {
  busyWorld,
  imageOf,
  label,
  makeStore,
  newWorld,
  restoreImage,
  RUNTIME,
  tempDir,
  verifyImage,
  type TempDir,
} from '../../support/save-world';

/** The newest real save format, and the number a test-only later migration takes. */
const LATEST = SAVE_MIGRATIONS.length;
const NEXT = LATEST + 1;

let dir: TempDir;
let store: SaveStore;

beforeEach(() => {
  dir = tempDir();
  store = makeStore(join(dir.path, 'saves'));
});

afterEach(() => {
  dir.remove();
});

function errorOf(run: () => unknown): SaveError {
  try {
    run();
  } catch (error) {
    if (error instanceof SaveError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a SaveError');
}

const filesIn = (path: string) => readdirSync(path).sort();

/** Edit a save file directly, as damage or tampering would. */
function tamper(saveId: string, sql: string) {
  withDatabase(store.pathOf(saveId), { mode: 'write' }, (db) => {
    db.exec(sql);
  });
}

describe('SaveStore', () => {
  it('writes, lists and reads a save that restores to the identical world', () => {
    const world = busyWorld();
    const listing = store.write('save-a', imageOf(world), label('Mid-morning'), verifyImage);
    expect(listing).toMatchObject({
      saveId: 'save-a',
      status: 'ready',
      problem: null,
      header: { label: label('Mid-morning'), seed: 7, worldRevision: world.worldRevision },
    });
    expect(store.list().map((item) => item.saveId)).toEqual(['save-a']);
    const loaded = store.read('save-a', verifyImage);
    expect(loaded.upgradedFrom).toBeNull();
    expect(loaded.image).toEqual(imageOf(world));
    expect(restoreImage(loaded.image).fingerprint()).toEqual(world.fingerprint());
    expect(filesIn(store.directory)).toEqual(['save-a.fisave']);
  });

  it('keeps the previous save intact when a later write fails, and leaves no temporary file', () => {
    const first = busyWorld(1);
    store.write('save-a', imageOf(first), label('first'), verifyImage);
    const bytes = readFileSync(store.pathOf('save-a'));
    const error = errorOf(() =>
      store.write('save-a', imageOf(busyWorld(2)), label('second'), () => {
        throw new Error('verification failed');
      }),
    );
    expect(error.code).toBe('WRITE_FAILED');
    expect(error.message).toBe(
      'The save could not be written, so the previous save is unchanged: This save failed verification: verification failed',
    );
    expect(readFileSync(store.pathOf('save-a')).equals(bytes)).toBe(true);
    expect(store.read('save-a', verifyImage).label.name).toBe('first');
    expect(filesIn(store.directory)).toEqual(['save-a.fisave']);
  });

  it('creates nothing when the first write to a slot fails mid-transaction', () => {
    const image = imageOf(busyWorld());
    const broken = {
      ...image,
      kernel: { ...image.kernel, rngStreams: { diagnostics: [0, 0, 0, 0] } },
    };
    const error = errorOf(() => store.write('save-b', broken, label(), verifyImage));
    expect(error.code).toBe('WRITE_FAILED');
    expect(error.message).toMatch(/^The save could not be written, so nothing was saved: /);
    expect(filesIn(store.directory)).toEqual([]);
  });

  it('refuses to replace a slot with an image that would not restore exactly', () => {
    const world = busyWorld();
    const image = imageOf(world);
    const wrongHash = {
      ...image,
      fingerprint: { ...image.fingerprint, stateHash: '0'.repeat(64) },
    };
    expect(errorOf(() => store.write('save-c', wrongHash, label(), verifyImage)).code).toBe(
      'WRITE_FAILED',
    );
    expect(store.exists('save-c')).toBe(false);
  });

  it('removes temporary files left by an interrupted write when it starts', () => {
    writeFileSync(join(store.directory, '.~save-a.crashed.tmp'), 'partial');
    writeFileSync(join(store.directory, '.~save-a.crashed.tmp-journal'), 'partial');
    writeFileSync(join(store.directory, 'notes.txt'), 'kept');
    const reopened = makeStore(store.directory);
    expect(filesIn(reopened.directory)).toEqual(['notes.txt']);
  });

  describe('compatibility', () => {
    beforeEach(() => {
      store.write('save-a', imageOf(busyWorld()), label('Shop'), verifyImage);
    });

    it('refuses a save from a newer save format, with a clear message', () => {
      tamper('save-a', 'PRAGMA user_version = 9');
      expect(store.inspect('save-a')).toMatchObject({
        status: 'incompatible',
        problem: `This save was made by a newer version of FreeIndustry (save format 9; this build reads formats up to ${LATEST}). Update FreeIndustry to load it.`,
      });
      expect(errorOf(() => store.read('save-a', verifyImage)).code).toBe('NEWER_FORMAT');
    });

    it.each([
      [
        'newer simulation rules',
        'UPDATE worlds SET rules_version = 2',
        'This save was made with FreeIndustry simulation rules version 2, newer than this build\u2019s version 1. Update FreeIndustry to load it.'.replace(
          '\u2019',
          "'",
        ),
      ],
      [
        'another simulation',
        "UPDATE worlds SET rules_id = 'test-toy-workshop'",
        'This save belongs to another simulation ("test-toy-workshop"), not FreeIndustry.',
      ],
      [
        'another RNG algorithm',
        "UPDATE worlds SET rng_algorithm = 'mt19937'",
        `This save uses random-number algorithm mt19937; this build uses ${RUNTIME.rngAlgorithm}.`,
      ],
      [
        'content packs this build lacks',
        "UPDATE worlds SET content_version = '1.2.0'",
        'This save was built from content version 1.2.0; this build has content version none.',
      ],
    ])('refuses a save made for %s', (_name, sql, message) => {
      tamper('save-a', sql);
      expect(store.inspect('save-a')).toMatchObject({ status: 'incompatible', problem: message });
      const error = errorOf(() => store.read('save-a', verifyImage));
      expect(error.code).toBe('INCOMPATIBLE_WORLD');
      expect(error.message).toBe(message);
    });

    it('explains that an older rules version cannot continue exactly', () => {
      const older = makeStore(store.directory, { runtime: { ...RUNTIME, rulesVersion: 2 } });
      expect(older.inspect('save-a').problem).toBe(
        'This save was made with FreeIndustry simulation rules version 1. This build runs version 2 and has no conversion for it, so the world cannot continue exactly as it would have.',
      );
    });

    it('lists a file that is not a database as unreadable', () => {
      writeFileSync(
        store.pathOf('save-text'),
        'This is not a database, just some notes.\n'.repeat(50),
      );
      expect(store.inspect('save-text')).toMatchObject({
        status: 'unreadable',
        problem: 'This file is not a FreeIndustry save.',
      });
      expect(errorOf(() => store.read('save-text')).code).toBe('NOT_A_SAVE');
    });

    it('lists another program\u2019s SQLite database as unreadable', () => {
      const other = new Database(store.pathOf('save-other'));
      other.exec('CREATE TABLE contacts (name TEXT)');
      other.close();
      expect(store.inspect('save-other')).toMatchObject({
        status: 'unreadable',
        problem: 'This file is not a FreeIndustry save.',
      });
    });

    it('reports a missing save', () => {
      expect(errorOf(() => store.read('save-gone')).code).toBe('NOT_FOUND');
    });
  });

  describe('damage and tampering', () => {
    beforeEach(() => {
      store.write('save-a', imageOf(busyWorld()), label('Shop'), verifyImage);
    });

    it('refuses an edited world whose state no longer matches its fingerprint', () => {
      tamper('save-a', 'UPDATE diagnostics_state SET probe_count = 1000');
      const error = errorOf(() => store.read('save-a', verifyImage));
      expect(error.code).toBe('CORRUPT');
      expect(error.message).toBe(
        'This save failed verification: the restored world does not match the saved state hash',
      );
    });

    it('refuses a journal with a missing entry', () => {
      tamper(
        'save-a',
        'DELETE FROM journal_facts WHERE seq = 2; DELETE FROM journal_entries WHERE seq = 2',
      );
      const error = errorOf(() => store.read('save-a', verifyImage));
      expect(error.code).toBe('CORRUPT');
      expect(error.message).toMatch(/^This save is damaged: .*not contiguous/);
    });

    it('refuses a file with schema objects this build did not create', () => {
      tamper(
        'save-a',
        'CREATE TRIGGER sneaky AFTER INSERT ON audit_events BEGIN DELETE FROM journal_entries; END',
      );
      const error = errorOf(() => store.read('save-a', verifyImage));
      expect(error.code).toBe('CORRUPT');
      expect(error.message).toBe('This save is damaged: schema has an unexpected trigger sneaky');
    });

    it('refuses a file whose bytes are damaged', () => {
      const path = store.pathOf('save-a');
      const bytes = readFileSync(path);
      // Overwrite most pages after the header and schema with noise.
      for (let index = 8192; index < bytes.length; index += 1) {
        bytes[index] = (index * 31) & 0xff;
      }
      writeFileSync(path, bytes);
      const error = errorOf(() => store.read('save-a', verifyImage));
      expect(['CORRUPT', 'NOT_A_SAVE']).toContain(error.code);
      expect(error.message).toMatch(/damaged|not a FreeIndustry save/);
    });
  });

  describe('format upgrades', () => {
    const addNote: Migration = {
      version: NEXT,
      description: 'Test: probe notes',
      up: (db) => {
        db.exec("ALTER TABLE diagnostics_state ADD COLUMN note TEXT NOT NULL DEFAULT ''");
      },
    };

    it('upgrades an older save on load, keeping a backup of the original', () => {
      const world = busyWorld();
      store.write('save-old', imageOf(world), label('Old'), verifyImage);
      const newer = makeStore(store.directory, { migrations: [...SAVE_MIGRATIONS, addNote] });
      expect(newer.inspect('save-old')).toMatchObject({
        status: 'needs-upgrade',
        problem: `Saved in an older format (${LATEST}); it will be upgraded, with a backup, when loaded.`,
      });
      const loaded = newer.read('save-old', verifyImage);
      expect(loaded.upgradedFrom).toBe(LATEST);
      expect(loaded.image).toEqual(imageOf(world));
      expect(
        withDatabase(newer.pathOf('save-old'), { mode: 'read' }, readSchemaStamp).userVersion,
      ).toBe(NEXT);
      const backups = filesIn(join(newer.directory, 'backups'));
      expect(backups).toEqual([`save-old.format-${LATEST}.2026-11-07T12-00-00-000Z.fisave`]);
      const backup = join(newer.directory, 'backups', backups[0] ?? '');
      expect(withDatabase(backup, { mode: 'read' }, readSchemaStamp).userVersion).toBe(LATEST);
      expect(filesIn(newer.directory)).toEqual(['backups', 'save-old.fisave']);
      // The upgraded slot is now beyond the old build, which refuses it rather than misreading it…
      expect(errorOf(() => store.read('save-old', verifyImage)).code).toBe('NEWER_FORMAT');
      // …but the backup is a consistent copy of the original (made before the upgrade ran)
      // that the old build still loads.
      store.importFrom(backup, 'save-restored', verifyImage);
      expect(store.read('save-restored', verifyImage).image).toEqual(imageOf(world));
    });

    it('leaves the original byte-for-byte unchanged when an upgrade fails', () => {
      store.write('save-old', imageOf(busyWorld()), label('Old'), verifyImage);
      const original = readFileSync(store.pathOf('save-old'));
      const broken: Migration = {
        version: NEXT,
        description: 'Test: broken upgrade',
        up: () => {
          throw new Error('cannot convert probes');
        },
      };
      const newer = makeStore(store.directory, { migrations: [...SAVE_MIGRATIONS, broken] });
      const error = errorOf(() => newer.read('save-old', verifyImage));
      expect(error.code).toBe('MIGRATION_FAILED');
      expect(error.message).toMatch(
        new RegExp(`format ${NEXT} \\(Test: broken upgrade\\): cannot convert probes`),
      );
      expect(readFileSync(newer.pathOf('save-old')).equals(original)).toBe(true);
      expect(filesIn(newer.directory)).toEqual(['backups', 'save-old.fisave']);
    });
  });

  describe('export and import', () => {
    it('exports a consistent copy and imports it back as a new save', () => {
      const world = busyWorld();
      store.write('save-a', imageOf(world), label('Shop'), verifyImage);
      const exported = join(dir.path, 'Shop.fisave');
      store.exportTo('save-a', exported);
      expect(withDatabase(exported, { mode: 'read' }, readSchemaStamp).userVersion).toBe(LATEST);
      const listing = store.importFrom(exported, 'save-b', verifyImage);
      expect(listing).toMatchObject({
        saveId: 'save-b',
        status: 'ready',
        header: { label: { name: 'Shop' } },
      });
      expect(store.read('save-b', verifyImage).image).toEqual(imageOf(world));
      expect(filesIn(dir.path)).toEqual(['Shop.fisave', 'saves']);
    });

    it('overwrites an existing export target only once the copy is complete', () => {
      store.write('save-a', imageOf(busyWorld()), label('Shop'), verifyImage);
      const target = join(dir.path, 'Shop.fisave');
      writeFileSync(target, 'an older export');
      store.exportTo('save-a', target);
      expect(withDatabase(target, { mode: 'read' }, readSchemaStamp).userVersion).toBe(LATEST);
    });

    it('refuses to import a file that is not a FreeIndustry save, adding nothing', () => {
      const source = join(dir.path, 'notes.fisave');
      writeFileSync(source, 'hello');
      expect(errorOf(() => store.importFrom(source, 'save-x', verifyImage)).code).toBe(
        'NOT_A_SAVE',
      );
      expect(filesIn(store.directory)).toEqual([]);
    });

    it('checks an imported file before running any upgrade against it', () => {
      store.write('save-a', imageOf(newWorld()), label('Shop'), verifyImage);
      const clean = join(dir.path, 'clean.fisave');
      store.exportTo('save-a', clean);
      withDatabase(clean, { mode: 'write' }, (db) => {
        db.exec('CREATE TRIGGER sneaky AFTER INSERT ON schema_migrations BEGIN SELECT 1; END');
      });
      const newer = makeStore(store.directory, {
        migrations: [
          ...SAVE_MIGRATIONS,
          { version: NEXT, description: 'Test: no-op', up: () => undefined },
        ],
      });
      const error = errorOf(() => newer.importFrom(clean, 'save-x', verifyImage));
      expect(error.code).toBe('CORRUPT');
      expect(error.message).toBe('This save is damaged: schema has an unexpected trigger sneaky');
      expect(newer.exists('save-x')).toBe(false);
      expect(withDatabase(clean, { mode: 'read' }, readSchemaStamp).userVersion).toBe(LATEST);
    });

    it('imports an older-format save by upgrading a copy', () => {
      const world = busyWorld();
      store.write('save-a', imageOf(world), label('Shop'), verifyImage);
      const exported = join(dir.path, 'old.fisave');
      store.exportTo('save-a', exported);
      const newer = makeStore(join(dir.path, 'newer'), {
        migrations: [
          ...SAVE_MIGRATIONS,
          { version: NEXT, description: 'Test: no-op', up: () => undefined },
        ],
      });
      expect(newer.importFrom(exported, 'save-b', verifyImage).status).toBe('ready');
      expect(newer.read('save-b', verifyImage).image).toEqual(imageOf(world));
      expect(withDatabase(exported, { mode: 'read' }, readSchemaStamp).userVersion).toBe(LATEST);
    });
  });

  it('rotates three autosave slots, replacing the oldest', () => {
    const write = (id: string, savedAt: string) => {
      store.write(
        id,
        imageOf(newWorld()),
        { ...label('Autosave', 'autosave'), savedAt },
        verifyImage,
      );
    };
    expect(store.nextAutosaveSlot()).toBe('autosave-1');
    write('autosave-1', '2026-11-07T10:00:00.000Z');
    expect(store.nextAutosaveSlot()).toBe('autosave-2');
    write('autosave-2', '2026-11-07T10:05:00.000Z');
    write('autosave-3', '2026-11-07T10:10:00.000Z');
    expect(store.nextAutosaveSlot()).toBe('autosave-1');
    write('autosave-1', '2026-11-07T10:15:00.000Z');
    expect(store.nextAutosaveSlot()).toBe('autosave-2');
    expect(store.list().map((item) => item.saveId)).toEqual([
      'autosave-1',
      'autosave-3',
      'autosave-2',
    ]);
  });

  it('only accepts save IDs that are plain file stems', () => {
    expect(() => store.pathOf('../escape')).toThrow(SaveError);
    expect(() => store.pathOf('C:\\Windows\\win')).toThrow(SaveError);
    expect(existsSync(join(dir.path, 'escape.fisave'))).toBe(false);
  });
});
