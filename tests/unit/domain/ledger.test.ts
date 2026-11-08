import fc from 'fast-check';
import { formatEntityId, type EntityId } from '../../../src/domain/ids';
import {
  ACCOUNT,
  balanceOf,
  credit,
  debit,
  ledgerProblems,
  openLedger,
  postEntry,
  STANDARD_CHART,
  trialBalance,
  type Ledger,
  type LedgerEntry,
} from '../../../src/domain/ledger';
import { Rejection } from '../../../src/domain/rejection';
import {
  formatUsd,
  MAX_AMOUNT_CENTS,
  MAX_BALANCE_CENTS,
  positiveCentsString,
} from '../../../src/shared/money';

const PARTY = 'party:1' as EntityId<'party'>;

let ordinal = 0;
function entry(lines: LedgerEntry['lines'], overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  ordinal += 1;
  return {
    id: formatEntityId('entry', ordinal),
    atMs: 0n,
    description: 'Test posting',
    sourceKey: `test:${ordinal}`,
    counterpartyId: PARTY,
    lines,
    ...overrides,
  };
}

function posted(ledger: Ledger, next: LedgerEntry): Ledger {
  const result = postEntry(ledger, next);
  if (result instanceof Rejection) {
    throw new Error(result.reason);
  }
  return result;
}

const funded = () =>
  posted(
    openLedger(STANDARD_CHART),
    entry([debit(ACCOUNT.cash, 100_000n), credit(ACCOUNT.ownerCapital, 100_000n)]),
  );

describe('money formatting', () => {
  it.each([
    [0n, '$0.00'],
    [5n, '$0.05'],
    [123_456_789n, '$1,234,567.89'],
    [-250n, '-$2.50'],
    [MAX_BALANCE_CENTS, '$10,000,000,000,000.00'],
  ])('%s cents is %s', (cents, text) => {
    expect(formatUsd(cents)).toBe(text);
  });

  it('validates cents strings without throwing on non-numbers (regression)', () => {
    for (const text of ['12.50', '1e6', '-5', '0', '0100', ' 5', '']) {
      expect(positiveCentsString.safeParse(text).success).toBe(false);
    }
    expect(positiveCentsString.safeParse(MAX_AMOUNT_CENTS.toString()).success).toBe(true);
    expect(positiveCentsString.safeParse((MAX_AMOUNT_CENTS + 1n).toString()).success).toBe(false);
    expect(positiveCentsString.parse('1')).toBe('1');
  });
});

describe('double-entry ledger', () => {
  it('opens every chart account at zero, in chart order', () => {
    const ledger = openLedger(STANDARD_CHART);
    expect(ledger.accounts.map((account) => account.code)).toEqual(
      STANDARD_CHART.map((account) => account.code),
    );
    expect(ledger.accounts.every((account) => account.balanceCents === 0n)).toBe(true);
    expect(() => openLedger([...STANDARD_CHART, ...STANDARD_CHART.slice(0, 1)])).toThrow(
      /repeated/,
    );
  });

  it('posts a balanced entry and moves debit-positive balances', () => {
    const ledger = funded();
    expect(balanceOf(ledger, ACCOUNT.cash)).toBe(100_000n);
    expect(balanceOf(ledger, ACCOUNT.ownerCapital)).toBe(-100_000n);
    expect(trialBalance(ledger)).toEqual({ debitsCents: 100_000n, creditsCents: 100_000n });
    expect(ledgerProblems(ledger)).toEqual([]);
  });

  it.each([
    ['an unbalanced entry', [debit(ACCOUNT.cash, 10n), credit(ACCOUNT.ownerCapital, 9n)], /debits/],
    ['a single line', [debit(ACCOUNT.cash, 10n)], /at least two lines/],
    [
      'a line that is both debit and credit',
      [
        { account: ACCOUNT.cash, debitCents: 5n, creditCents: 5n },
        credit(ACCOUNT.ownerCapital, 0n),
      ],
      /one positive debit/,
    ],
    [
      'an unknown account',
      [debit('9999', 10n), credit(ACCOUNT.ownerCapital, 10n)],
      /unknown account 9999/,
    ],
    [
      'a line over the amount limit',
      [debit(ACCOUNT.rent, MAX_AMOUNT_CENTS + 1n), credit(ACCOUNT.payables, MAX_AMOUNT_CENTS + 1n)],
      /largest amount/,
    ],
  ])('throws for %s and posts nothing', (_name, lines, message) => {
    const ledger = funded();
    expect(() => postEntry(ledger, entry(lines))).toThrow(message);
    expect(ledger.entries).toHaveLength(1);
  });

  it('never posts the same business event twice', () => {
    const ledger = funded();
    const first = entry([debit(ACCOUNT.rent, 10n), credit(ACCOUNT.payables, 10n)], {
      sourceKey: 'invoice:7',
    });
    const once = posted(ledger, first);
    expect(() =>
      postEntry(
        once,
        entry([debit(ACCOUNT.rent, 10n), credit(ACCOUNT.payables, 10n)], {
          sourceKey: 'invoice:7',
        }),
      ),
    ).toThrow(/invoice:7 has already been posted/);
  });

  it('requires a counterparty whenever cash moves', () => {
    expect(() =>
      postEntry(
        openLedger(STANDARD_CHART),
        entry([debit(ACCOUNT.cash, 10n), credit(ACCOUNT.ownerCapital, 10n)], {
          counterpartyId: null,
        }),
      ),
    ).toThrow(/must name its counterparty/);
  });

  it('refuses entries dated before the previous one', () => {
    const later = posted(
      openLedger(STANDARD_CHART),
      entry([debit(ACCOUNT.cash, 10n), credit(ACCOUNT.ownerCapital, 10n)], { atMs: 500n }),
    );
    expect(() =>
      postEntry(
        later,
        entry([debit(ACCOUNT.rent, 1n), credit(ACCOUNT.payables, 1n)], { atMs: 499n }),
      ),
    ).toThrow(/dated before/);
  });

  it('refuses to overdraw cash, with the amounts in the reason', () => {
    const ledger = funded();
    const result = postEntry(
      ledger,
      entry([debit(ACCOUNT.payables, 100_001n), credit(ACCOUNT.cash, 100_001n)]),
    );
    expect(result).toBeInstanceOf(Rejection);
    expect((result as Rejection).reason).toBe(
      'Insufficient funds: $1,000.00 available, $1,000.01 needed',
    );
    expect((result as Rejection).details).toEqual({
      availableCents: '100000',
      requiredCents: '100001',
    });
  });

  it('refuses a balance beyond the books’ limit instead of overflowing', () => {
    let ledger = openLedger(STANDARD_CHART);
    for (let index = 0; index < 100; index += 1) {
      ledger = posted(
        ledger,
        entry([
          debit(ACCOUNT.cash, MAX_AMOUNT_CENTS),
          credit(ACCOUNT.ownerCapital, MAX_AMOUNT_CENTS),
        ]),
      );
    }
    expect(balanceOf(ledger, ACCOUNT.cash)).toBe(MAX_BALANCE_CENTS);
    const result = postEntry(
      ledger,
      entry([debit(ACCOUNT.cash, 1n), credit(ACCOUNT.ownerCapital, 1n)]),
    );
    expect(result).toBeInstanceOf(Rejection);
    expect((result as Rejection).reason).toMatch(/beyond the largest balance/);
  });

  it('detects stored balances that do not match the postings', () => {
    const ledger = funded();
    const tampered: Ledger = {
      ...ledger,
      accounts: ledger.accounts.map((account) =>
        account.code === ACCOUNT.cash ? { ...account, balanceCents: 100_100n } : account,
      ),
    };
    expect(ledgerProblems(tampered)).toEqual(
      expect.arrayContaining([
        'account 1010 holds 100100 but its lines sum to 100000',
        'account balances sum to 100, not zero (trial balance does not balance)',
      ]),
    );
  });

  it('property: any sequence of accepted postings keeps every invariant', () => {
    const codes = STANDARD_CHART.map((account) => account.code);
    const posting = fc.record({
      debitAccount: fc.constantFrom(...codes),
      creditAccount: fc.constantFrom(...codes),
      cents: fc.bigInt({ min: 1n, max: 10_000_000n }),
      split: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(posting, { maxLength: 60 }), (postings) => {
        let ledger = funded();
        let accepted = 1;
        for (const { debitAccount, creditAccount, cents, split } of postings) {
          const half = cents / 2n;
          const lines =
            split && half > 0n && cents - half > 0n
              ? [
                  debit(debitAccount, half),
                  debit(debitAccount, cents - half),
                  credit(creditAccount, cents),
                ]
              : [debit(debitAccount, cents), credit(creditAccount, cents)];
          const result = postEntry(ledger, entry(lines));
          if (result instanceof Rejection) {
            // Only overdrafts are refused here; the books are unchanged.
            expect(result.reason).toMatch(/^Insufficient funds/);
            continue;
          }
          ledger = result;
          accepted += 1;
          expect(balanceOf(ledger, ACCOUNT.cash) >= 0n).toBe(true);
        }
        expect(ledger.entries).toHaveLength(accepted);
        expect(ledgerProblems(ledger)).toEqual([]);
        const totals = trialBalance(ledger);
        expect(totals.debitsCents).toBe(totals.creditsCents);
      }),
      { numRuns: 200 },
    );
  });
});
