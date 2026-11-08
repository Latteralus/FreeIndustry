import fc from 'fast-check';
import Database from 'better-sqlite3';
import { companyProblems } from '../../src/domain/company-invariants';
import { outstandingOf } from '../../src/domain/invoicing';
import { ACCOUNT, balanceOf, trialBalance } from '../../src/domain/ledger';
import { MS_PER_DAY, MS_PER_HOUR } from '../../src/domain/time';
import { applyMigrations, SAVE_MIGRATIONS } from '../../src/persistence/migrations';
import { readWorld, writeWorld } from '../../src/persistence/world-repository';
import { testUuid } from '../support/toy-workshop';
import {
  companyOf,
  imageOf,
  label,
  newWorld,
  restoreImage,
  type World,
} from '../support/save-world';

/**
 * Step 05 gate, property-based: for random founding capital, obligations,
 * payments and advances of time, every posting balances, cash never goes
 * negative and is fully explained by the capital and recorded payments, the
 * books always reconcile with the open documents, refused commands change
 * nothing, and a save at any moment through real SQLite continues exactly
 * like the uninterrupted world.
 */

type Action =
  | {
      readonly kind: 'obligation';
      readonly purpose: 'rent' | 'security-deposit';
      readonly amountCents: number;
      readonly occurrences: number;
      readonly firstBillInDays: number;
      readonly paymentTermsDays: number;
      readonly standingOrder: boolean;
    }
  | { readonly kind: 'pay'; readonly pick: number; readonly fraction: number }
  | { readonly kind: 'advance'; readonly hours: number };

const action: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    kind: fc.constant('obligation' as const),
    purpose: fc.constantFrom('rent' as const, 'security-deposit' as const),
    amountCents: fc.integer({ min: 1, max: 2_000_000 }),
    occurrences: fc.integer({ min: 1, max: 6 }),
    firstBillInDays: fc.integer({ min: 0, max: 40 }),
    paymentTermsDays: fc.integer({ min: 0, max: 20 }),
    standingOrder: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('pay' as const),
    pick: fc.nat(),
    fraction: fc.integer({ min: 1, max: 120 }),
  }),
  fc.record({ kind: fc.constant('advance' as const), hours: fc.integer({ min: 0, max: 900 }) }),
);

let runs = 0;

/**
 * Apply one action. A refused command must leave the world unchanged. The
 * command ID is derived from the step, so a resumed copy replaying the same
 * steps journals the same commands.
 */
function apply(world: World, step: Action, commandId: string): void {
  if (step.kind === 'advance') {
    world.advanceTo(world.nowMs + BigInt(step.hours) * MS_PER_HOUR);
    return;
  }
  let type: string;
  let payload: unknown;
  if (step.kind === 'obligation') {
    type = 'diagnostics.addTestObligation';
    payload = {
      purpose: step.purpose,
      amountCents: String(step.amountCents),
      cadence: step.purpose === 'rent' ? 'monthly' : 'once',
      occurrences: step.purpose === 'rent' ? step.occurrences : 1,
      firstBillInDays: step.firstBillInDays,
      paymentTermsDays: step.paymentTermsDays,
      standingOrder: step.standingOrder,
    };
  } else {
    const open = companyOf(world).invoices.filter((invoice) => outstandingOf(invoice) > 0n);
    const invoice = open[step.pick % Math.max(open.length, 1)];
    if (!invoice) {
      return;
    }
    // Sometimes more than is outstanding, sometimes more than the cash: both must be refused.
    const amount = (outstandingOf(invoice) * BigInt(step.fraction)) / 100n;
    type = 'finance.payInvoice';
    payload = { invoiceId: invoice.id, amountCents: String(amount > 0n ? amount : 1n) };
  }
  const before = world.fingerprint();
  const result = world.submit({
    commandId,
    expectedWorldRevision: world.worldRevision,
    type,
    payload,
  });
  if (!result.ok) {
    expect(result.error.code).toBe('COMMAND_REJECTED');
    expect(world.fingerprint()).toEqual(before);
  }
}

function assertBooks(world: World): void {
  const company = companyOf(world);
  expect(world.checkInvariants()).toEqual([]);
  expect(companyProblems(company)).toEqual([]);
  const cash = balanceOf(company.ledger, ACCOUNT.cash);
  expect(cash >= 0n).toBe(true);
  const paidOut = company.payments.reduce((sum, payment) => sum + payment.amountCents, 0n);
  expect(cash).toBe(company.startingCapitalCents - paidOut);
  const totals = trialBalance(company.ledger);
  expect(totals.debitsCents).toBe(totals.creditsCents);
  for (const entry of company.ledger.entries) {
    const debits = entry.lines.reduce((sum, line) => sum + line.debitCents, 0n);
    const credits = entry.lines.reduce((sum, line) => sum + line.creditCents, 0n);
    expect(debits).toBe(credits);
  }
}

function saveAndReload(world: World): World {
  const db = new Database(':memory:');
  try {
    db.defaultSafeIntegers(true);
    db.pragma('foreign_keys = ON');
    applyMigrations(db, SAVE_MIGRATIONS, { appVersion: '0.1.0', appliedAt: 'now' });
    writeWorld(db, imageOf(world), label());
    return restoreImage(readWorld(db).image);
  } finally {
    db.close();
  }
}

describe('accounting properties', () => {
  it('books stay balanced, explained and reconciled; saves continue identically', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100_000, max: 5_000_000 }),
        fc.array(action, { minLength: 1, maxLength: 25 }),
        fc.nat(),
        (capital, script, savePoint) => {
          runs += 1;
          const idOf = (index: number) => testUuid(runs * 1_000 + index + 1);
          const world = newWorld(3);
          world.advanceTo(9n * MS_PER_HOUR);
          const founded = world.submit({
            commandId: idOf(999),
            expectedWorldRevision: 0,
            type: 'company.found',
            payload: {
              legalName: 'Property Co',
              presidentName: 'Pat Test',
              startingCapitalCents: String(capital),
            },
          });
          expect(founded.ok).toBe(true);
          const cut = savePoint % script.length;
          let copy: World | null = null;
          script.forEach((step, index) => {
            if (index === cut) {
              copy = saveAndReload(world);
            }
            apply(world, step, idOf(index));
            assertBooks(world);
          });
          const end = world.nowMs + 60n * MS_PER_DAY;
          world.advanceTo(end);
          assertBooks(world);
          // The copy replays the rest of the script from its save point and must agree.
          const resumed = copy as World | null;
          if (resumed) {
            script.slice(cut).forEach((step, offset) => {
              apply(resumed, step, idOf(cut + offset));
            });
            resumed.advanceTo(end);
            expect(resumed.fingerprint()).toEqual(world.fingerprint());
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
