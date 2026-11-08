import Database from 'better-sqlite3';
import { withDatabase, type SqliteDatabase } from '../../../src/persistence/database';
import { checkIntegrity } from '../../../src/persistence/integrity';
import { applyMigrations, SAVE_MIGRATIONS } from '../../../src/persistence/migrations';
import type { SaveError } from '../../../src/persistence/save-error';
import { readWorld, writeWorld } from '../../../src/persistence/world-repository';
import {
  companyWorld,
  imageOf,
  label,
  makeStore,
  newWorld,
  restoreImage,
  tempDir,
  verifyImage,
  type TempDir,
} from '../../support/save-world';

/**
 * Step 05 persistence: the company and its books are stored relationally
 * (save format 2), read back exactly, and every layer of verification —
 * DDL, SQL structure checks, kernel invariants, fingerprints — refuses books
 * that have been altered, so opening funds and expenses survive save and load
 * with no unexplained adjustment.
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

describe('company books in a save', () => {
  it('round-trips a company mid-play exactly and continues identically', () => {
    const db = saveDatabase();
    const world = companyWorld();
    const image = imageOf(world);
    writeWorld(db, image, label('Books'));
    const read = readWorld(db);
    expect(read.image).toEqual(image);
    expect(checkIntegrity(db, SAVE_MIGRATIONS, LATEST)).toEqual([]);
    const restored = restoreImage(read.image);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    const end = 200n * 86_400_000n;
    restored.advanceTo(end);
    world.advanceTo(end);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    db.close();
  });

  it('keeps the books queryable: trial balance, open payables and payments in plain SQL', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(companyWorld()), label());
    expect(rows(db, 'SELECT code, balance_cents FROM ledger_accounts ORDER BY position')).toEqual([
      { code: '1010', balance_cents: 400_000n },
      { code: '1100', balance_cents: 0n },
      { code: '1400', balance_cents: 300_000n },
      { code: '2000', balance_cents: -1_200_000n },
      { code: '3000', balance_cents: -1_000_000n },
      { code: '4000', balance_cents: 0n },
      { code: '6100', balance_cents: 1_500_000n },
    ]);
    expect(
      rows(db, 'SELECT sum(debit_cents) AS debits, sum(credit_cents) AS credits FROM ledger_lines'),
    ).toEqual([{ debits: 3_400_000n, credits: 3_400_000n }]);
    expect(
      rows(
        db,
        `SELECT id, total_cents - paid_cents AS outstanding, overdue_since_ms IS NOT NULL AS overdue
         FROM invoices WHERE paid_cents < total_cents ORDER BY ordinal`,
      ),
    ).toEqual([
      { id: 'invoice:3', outstanding: 600_000n, overdue: 1n },
      { id: 'invoice:5', outstanding: 600_000n, overdue: 1n },
    ]);
    expect(rows(db, 'SELECT initiated_by, amount_cents FROM payments ORDER BY ordinal')).toEqual([
      { initiated_by: 'player', amount_cents: 300_000n },
      { initiated_by: 'standing-order', amount_cents: 150_000n },
      { initiated_by: 'standing-order', amount_cents: 150_000n },
    ]);
    expect(rows(db, "SELECT type FROM pending_events WHERE type LIKE 'finance.%'")).toEqual([
      { type: 'finance.obligationBill' },
    ]);
    db.close();
  });

  it('a world with no company stores no company rows', () => {
    const db = saveDatabase();
    writeWorld(db, imageOf(newWorld()), label());
    for (const table of ['company', 'counterparties', 'ledger_entries', 'invoices']) {
      expect(rows(db, `SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 0n }]);
    }
    expect(readWorld(db).image.domain.company).toBeNull();
    db.close();
  });

  describe('tampered books are refused on load', () => {
    let dir: TempDir;
    beforeEach(() => {
      dir = tempDir();
    });
    afterEach(() => {
      dir.remove();
    });

    function storeWithBooks() {
      const store = makeStore(dir.path);
      store.write('save-books', imageOf(companyWorld()), label('Books'), verifyImage);
      return store;
    }

    function refusal(store: ReturnType<typeof makeStore>, sql: string): SaveError {
      withDatabase(store.pathOf('save-books'), { mode: 'write' }, (db) => {
        db.exec(sql);
      });
      try {
        store.read('save-books', verifyImage);
      } catch (error) {
        return error as SaveError;
      }
      throw new Error('the tampered save was accepted');
    }

    it('an entry that no longer balances', () => {
      const error = refusal(
        storeWithBooks(),
        'UPDATE ledger_lines SET debit_cents = debit_cents + 1 WHERE entry_ordinal = 1 AND line_no = 1',
      );
      expect(error.code).toBe('CORRUPT');
      expect(error.message).toMatch(/1 ledger entries do not balance/);
    });

    it('a stored balance that differs from its postings', () => {
      const error = refusal(
        storeWithBooks(),
        "UPDATE ledger_accounts SET balance_cents = balance_cents + 500000 WHERE code = '1010'",
      );
      expect(error.message).toMatch(/1 account balances differ from their postings/);
    });

    it('a payment that was never recorded', () => {
      const error = refusal(
        storeWithBooks(),
        "UPDATE invoices SET paid_cents = total_cents WHERE id = 'invoice:3'",
      );
      expect(error.message).toMatch(/invoices record payments that do not exist/);
    });

    it('more opening capital, consistently posted, still fails: nothing explains it', () => {
      // Every SQL-level check passes, so the kernel's invariants and fingerprints must catch it.
      const error = refusal(
        storeWithBooks(),
        `UPDATE ledger_lines SET debit_cents = debit_cents + 100000 WHERE entry_ordinal = 1 AND line_no = 1;
         UPDATE ledger_lines SET credit_cents = credit_cents + 100000 WHERE entry_ordinal = 1 AND line_no = 2;
         UPDATE ledger_accounts SET balance_cents = balance_cents + 100000 WHERE code = '1010';
         UPDATE ledger_accounts SET balance_cents = balance_cents - 100000 WHERE code = '3000';`,
      );
      expect(error.code).toBe('CORRUPT');
      expect(error.message).toMatch(/failed verification/);
      expect(error.message).toMatch(/capital and payments explain/);
    });
  });
});
