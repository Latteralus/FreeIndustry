import {
  ensureCounterparty,
  foundCompany,
  MAX_STARTING_CAPITAL_CENTS,
  MIN_STARTING_CAPITAL_CENTS,
  type Company,
} from '../../../src/domain/company';
import { companyProblems } from '../../../src/domain/company-invariants';
import { formatEntityId, type AllocateId, type EntityId } from '../../../src/domain/ids';
import {
  issueInvoice,
  liquidityOf,
  markOverdue,
  outstandingOf,
  recordPayment,
} from '../../../src/domain/invoicing';
import { ACCOUNT, balanceOf } from '../../../src/domain/ledger';
import {
  addObligation,
  invoiceOccurrence,
  issueTimeOf,
  nextIssueTimeOf,
} from '../../../src/domain/obligations';
import { Rejection } from '../../../src/domain/rejection';
import {
  addCalendarMonths,
  calendarAt,
  isoDateAt,
  MS_PER_DAY,
  MS_PER_HOUR,
  type CivilDate,
} from '../../../src/domain/time';
import { at } from '../../support/save-world';

const EPOCH: CivilDate = { year: 1996, month: 1, day: 1 };

/** A deterministic ID source, as the kernel provides. */
function ids(): AllocateId {
  const counters = new Map<string, number>();
  return <K extends string>(kind: K): EntityId<K> => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return formatEntityId(kind, next);
  };
}

function ok<T>(result: T | Rejection): T {
  if (result instanceof Rejection) {
    throw new Error(`unexpected rejection: ${result.reason}`);
  }
  return result;
}

function founded(capital = 1_000_000n, allocateId = ids()) {
  const company = ok(
    foundCompany(
      null,
      { legalName: '  Acme Works  ', presidentName: 'Ada Lovell', startingCapitalCents: capital },
      { nowMs: 9n * MS_PER_HOUR, allocateId },
    ),
  );
  return { company, allocateId };
}

function landlord(company: Company, allocateId: AllocateId) {
  return ensureCounterparty(company, 'Harbour Estates', 'landlord', allocateId);
}

describe('calendar months', () => {
  it('keeps the day of month and time, clamping to short months (1996 is a leap year)', () => {
    const jan31 = 30n * MS_PER_DAY + 9n * MS_PER_HOUR;
    const dates = [0, 1, 2, 3, 13].map((months) => {
      const time = addCalendarMonths(EPOCH, jan31, months);
      const at = calendarAt(EPOCH, time);
      return `${isoDateAt(EPOCH, time)} ${at.hour}h`;
    });
    expect(dates).toEqual([
      '1996-01-31 9h',
      '1996-02-29 9h',
      '1996-03-31 9h',
      '1996-04-30 9h',
      '1997-02-28 9h',
    ]);
  });
});

describe('founding a company', () => {
  it('registers the company and its president and posts the opening capital', () => {
    const { company } = founded(2_500_000n);
    expect(company).toMatchObject({
      firmId: 'firm:1',
      legalName: 'Acme Works',
      president: { personId: 'person:1', name: 'Ada Lovell' },
      ownerPartyId: 'party:1',
      foundedAtMs: 9n * MS_PER_HOUR,
      financing: 'owner-funds',
      startingCapitalCents: 2_500_000n,
      invoices: [],
      payments: [],
      obligations: [],
    });
    expect(company.counterparties).toEqual([
      { id: 'party:1', name: 'Ada Lovell', kind: 'owner', personId: 'person:1' },
    ]);
    expect(company.ledger.entries).toEqual([
      {
        id: 'entry:1',
        atMs: 9n * MS_PER_HOUR,
        description: 'Opening capital from Ada Lovell',
        sourceKey: 'firm:1/opening-capital',
        counterpartyId: 'party:1',
        lines: [
          { account: ACCOUNT.cash, debitCents: 2_500_000n, creditCents: 0n },
          { account: ACCOUNT.ownerCapital, debitCents: 0n, creditCents: 2_500_000n },
        ],
      },
    ]);
    expect(balanceOf(company.ledger, ACCOUNT.cash)).toBe(2_500_000n);
    expect(companyProblems(company)).toEqual([]);
  });

  it.each([
    [{ legalName: '   ' }, 'Company name cannot be blank'],
    [{ presidentName: 'Ada\u0007' }, "President's name cannot contain control characters"],
    [{ legalName: 'x'.repeat(61) }, 'Company name can be at most 60 characters'],
    [
      { startingCapitalCents: MIN_STARTING_CAPITAL_CENTS - 1n },
      'Starting capital must be between $1,000.00 and $100,000,000.00',
    ],
    [
      { startingCapitalCents: MAX_STARTING_CAPITAL_CENTS + 1n },
      'Starting capital must be between $1,000.00 and $100,000,000.00',
    ],
  ])('refuses %j', (override, reason) => {
    const result = foundCompany(
      null,
      { legalName: 'Acme', presidentName: 'Ada', startingCapitalCents: 500_000n, ...override },
      { nowMs: 0n, allocateId: ids() },
    );
    expect(result).toBeInstanceOf(Rejection);
    expect((result as Rejection).reason).toBe(reason);
  });

  it('refuses to found a second company', () => {
    const { company } = founded();
    const again = foundCompany(
      company,
      { legalName: 'Other', presidentName: 'Bo', startingCapitalCents: 500_000n },
      { nowMs: 0n, allocateId: ids() },
    );
    expect((again as Rejection).reason).toBe('Acme Works has already been founded in this world');
  });

  it('registers a counterparty once and reuses it', () => {
    const { company, allocateId } = founded();
    const first = landlord(company, allocateId);
    const second = landlord(first.company, allocateId);
    expect(second.counterpartyId).toBe(first.counterpartyId);
    expect(second.company.counterparties).toHaveLength(2);
  });
});

describe('invoices and payments', () => {
  function withBill(total = 300_000n) {
    const setup = founded();
    const party = landlord(setup.company, setup.allocateId);
    const issued = ok(
      issueInvoice(
        party.company,
        {
          direction: 'payable',
          counterpartyId: party.counterpartyId,
          description: 'Workshop rent, February',
          lines: [{ account: ACCOUNT.rent, description: 'Rent', amountCents: total }],
          dueAtMs: 10n * MS_PER_DAY,
          obligation: null,
        },
        { nowMs: MS_PER_DAY, allocateId: setup.allocateId },
      ),
    );
    return { ...setup, ...issued, partyId: party.counterpartyId };
  }

  it('a payable recognises the expense and the liability, not cash', () => {
    const { company, invoiceId } = withBill();
    expect(balanceOf(company.ledger, ACCOUNT.rent)).toBe(300_000n);
    expect(balanceOf(company.ledger, ACCOUNT.payables)).toBe(-300_000n);
    expect(balanceOf(company.ledger, ACCOUNT.cash)).toBe(1_000_000n);
    expect(company.ledger.entries.at(-1)?.sourceKey).toBe(invoiceId);
    expect(liquidityOf(company)).toMatchObject({ payablesOpenCents: 300_000n });
    expect(companyProblems(company)).toEqual([]);
  });

  it('paying in two parts settles it exactly; overpaying and repaying are refused', () => {
    const { company, invoiceId, allocateId } = withBill();
    const context = { nowMs: 2n * MS_PER_DAY, allocateId };
    const part = ok(
      recordPayment(company, { invoiceId, amountCents: 100_000n, initiatedBy: 'player' }, context),
    );
    const over = recordPayment(
      part.company,
      { invoiceId, amountCents: 200_001n, initiatedBy: 'player' },
      context,
    );
    expect((over as Rejection).reason).toBe(
      'Invoice invoice:1 has $2,000.00 outstanding; $2,000.01 is more than that',
    );
    const rest = ok(
      recordPayment(
        part.company,
        { invoiceId, amountCents: 200_000n, initiatedBy: 'player' },
        context,
      ),
    );
    const paid = rest.company;
    expect(outstandingOf(at(paid.invoices, 0))).toBe(0n);
    expect(balanceOf(paid.ledger, ACCOUNT.cash)).toBe(700_000n);
    expect(balanceOf(paid.ledger, ACCOUNT.payables)).toBe(0n);
    expect(paid.payments.map((payment) => payment.amountCents)).toEqual([100_000n, 200_000n]);
    expect(companyProblems(paid)).toEqual([]);
    const again = recordPayment(
      paid,
      { invoiceId, amountCents: 1n, initiatedBy: 'player' },
      context,
    );
    expect((again as Rejection).reason).toBe('Invoice invoice:1 is already settled');
  });

  it('refuses a payment the company cannot fund, changing nothing', () => {
    const { company, invoiceId, allocateId } = withBill(5_000_000n);
    const result = recordPayment(
      company,
      { invoiceId, amountCents: 5_000_000n, initiatedBy: 'player' },
      { nowMs: 2n * MS_PER_DAY, allocateId },
    );
    expect(result).toBeInstanceOf(Rejection);
    expect((result as Rejection).reason).toBe(
      'Insufficient funds: $10,000.00 available, $50,000.00 needed',
    );
  });

  it('a receivable recognises revenue; collecting it brings cash in', () => {
    const setup = founded();
    const customer = ensureCounterparty(setup.company, 'Brick Co', 'customer', setup.allocateId);
    const issued = ok(
      issueInvoice(
        customer.company,
        {
          direction: 'receivable',
          counterpartyId: customer.counterpartyId,
          description: 'Sale of 10 crates',
          lines: [{ account: ACCOUNT.sales, description: 'Crates', amountCents: 45_000n }],
          dueAtMs: 30n * MS_PER_DAY,
          obligation: null,
        },
        { nowMs: MS_PER_DAY, allocateId: setup.allocateId },
      ),
    );
    expect(balanceOf(issued.company.ledger, ACCOUNT.receivables)).toBe(45_000n);
    expect(balanceOf(issued.company.ledger, ACCOUNT.sales)).toBe(-45_000n);
    expect(balanceOf(issued.company.ledger, ACCOUNT.cash)).toBe(1_000_000n);
    const late = markOverdue(issued.company, issued.invoiceId, 30n * MS_PER_DAY);
    expect(liquidityOf(late)).toMatchObject({
      receivablesOpenCents: 45_000n,
      receivablesOverdueCents: 45_000n,
      overdueShortfallCents: 0n,
    });
    expect(() =>
      recordPayment(
        late,
        { invoiceId: issued.invoiceId, amountCents: 45_000n, initiatedBy: 'player' },
        { nowMs: 31n * MS_PER_DAY, allocateId: setup.allocateId },
      ),
    ).toThrow(/cannot settle a receivable/);
    const collected = ok(
      recordPayment(
        late,
        { invoiceId: issued.invoiceId, amountCents: 45_000n, initiatedBy: 'counterparty' },
        { nowMs: 31n * MS_PER_DAY, allocateId: setup.allocateId },
      ),
    );
    expect(balanceOf(collected.company.ledger, ACCOUNT.cash)).toBe(1_045_000n);
    expect(balanceOf(collected.company.ledger, ACCOUNT.receivables)).toBe(0n);
    expect(collected.company.payments[0]?.direction).toBe('incoming');
    expect(companyProblems(collected.company)).toEqual([]);
  });

  it('refuses invoice lines on control accounts', () => {
    const { company, allocateId } = founded();
    expect(() =>
      issueInvoice(
        company,
        {
          direction: 'payable',
          counterpartyId: company.ownerPartyId,
          description: 'Sneaky cash',
          lines: [{ account: ACCOUNT.cash, description: 'Cash', amountCents: 1n }],
          dueAtMs: 0n,
          obligation: null,
        },
        { nowMs: 0n, allocateId },
      ),
    ).toThrow(/control account 1010/);
  });

  it('an unpaid bill past due reports the shortfall the cash cannot cover', () => {
    const { company, invoiceId } = withBill(1_500_000n);
    expect(() => markOverdue(company, invoiceId, 9n * MS_PER_DAY)).toThrow(/not due/);
    const late = markOverdue(company, invoiceId, 10n * MS_PER_DAY);
    expect(liquidityOf(late)).toEqual({
      cashCents: 1_000_000n,
      creditAvailableCents: 0n,
      availableCents: 1_000_000n,
      payablesOpenCents: 1_500_000n,
      payablesOverdueCents: 1_500_000n,
      receivablesOpenCents: 0n,
      receivablesOverdueCents: 0n,
      overdueShortfallCents: 500_000n,
    });
  });
});

describe('obligations', () => {
  function rent(overrides: Partial<Parameters<typeof addObligation>[1]> = {}) {
    const setup = founded();
    const party = landlord(setup.company, setup.allocateId);
    const added = ok(
      addObligation(
        party.company,
        {
          counterpartyId: party.counterpartyId,
          purpose: 'rent',
          description: 'Workshop rent',
          amountCents: 120_000n,
          cadence: 'monthly',
          firstIssueAtMs: 30n * MS_PER_DAY,
          occurrences: 3,
          paymentTermsDays: 7,
          standingOrder: false,
          ...overrides,
        },
        { nowMs: 9n * MS_PER_HOUR, allocateId: setup.allocateId },
      ),
    );
    return { ...setup, ...added };
  }

  it('schedules monthly occurrences on the calendar', () => {
    const { company } = rent();
    const obligation = at(company.obligations, 0);
    expect(
      [1, 2, 3].map((occurrence) => isoDateAt(EPOCH, issueTimeOf(obligation, occurrence, EPOCH))),
    ).toEqual(['1996-01-31', '1996-02-29', '1996-03-31']);
    expect(nextIssueTimeOf(obligation, EPOCH)).toBe(30n * MS_PER_DAY);
    expect(() => issueTimeOf(obligation, 4, EPOCH)).toThrow(/no occurrence 4/);
  });

  it('invoices each occurrence once, in order, at its issue time', () => {
    const { company, obligationId, allocateId } = rent();
    const context = { nowMs: 30n * MS_PER_DAY, allocateId, epoch: EPOCH };
    expect(() => invoiceOccurrence(company, obligationId, 2, context)).toThrow(/out of turn/);
    expect(() =>
      invoiceOccurrence(company, obligationId, 1, { ...context, nowMs: 29n * MS_PER_DAY }),
    ).toThrow(/not now/);
    const first = ok(invoiceOccurrence(company, obligationId, 1, context));
    const invoice = at(first.company.invoices, 0);
    expect(invoice).toMatchObject({
      direction: 'payable',
      description: 'Workshop rent (1 of 3, from 1996-01-31)',
      totalCents: 120_000n,
      dueAtMs: 37n * MS_PER_DAY,
      obligation: { id: obligationId, occurrence: 1 },
    });
    expect(first.company.obligations[0]?.issued).toBe(1);
    expect(() => invoiceOccurrence(first.company, obligationId, 1, context)).toThrow(/out of turn/);
    expect(balanceOf(first.company.ledger, ACCOUNT.rent)).toBe(120_000n);
    expect(companyProblems(first.company)).toEqual([]);
  });

  it('books a security deposit as an asset, not an expense', () => {
    const { company, obligationId, allocateId } = rent({
      purpose: 'security-deposit',
      cadence: 'once',
      occurrences: 1,
      firstIssueAtMs: 9n * MS_PER_HOUR,
    });
    const billed = ok(
      invoiceOccurrence(company, obligationId, 1, {
        nowMs: 9n * MS_PER_HOUR,
        allocateId,
        epoch: EPOCH,
      }),
    );
    expect(balanceOf(billed.company.ledger, ACCOUNT.depositsPaid)).toBe(120_000n);
    expect(balanceOf(billed.company.ledger, ACCOUNT.rent)).toBe(0n);
  });

  it.each([
    [{ amountCents: 0n }, 'An obligation must be for a positive amount'],
    [{ occurrences: 0 }, 'An obligation needs at least one occurrence'],
    [{ occurrences: 121 }, 'An obligation can have at most 120 occurrences'],
    [
      { cadence: 'once' as const, occurrences: 2 },
      'A one-off obligation has exactly one occurrence',
    ],
    [{ paymentTermsDays: 91 }, 'Payment terms must be 0–90 days'],
    [{ firstIssueAtMs: 0n }, 'An obligation cannot start in the past'],
  ])('refuses %j', (override, reason) => {
    const setup = founded();
    const result = addObligation(
      setup.company,
      {
        counterpartyId: setup.company.ownerPartyId,
        purpose: 'rent',
        description: 'Rent',
        amountCents: 100n,
        cadence: 'monthly',
        firstIssueAtMs: MS_PER_DAY,
        occurrences: 2,
        paymentTermsDays: 0,
        standingOrder: false,
        ...override,
      },
      { nowMs: 9n * MS_PER_HOUR, allocateId: setup.allocateId },
    );
    expect((result as Rejection).reason).toBe(reason);
  });
});

describe('company invariants', () => {
  it('catches cash that no payment explains', () => {
    const { company } = founded();
    const ledger = company.ledger;
    const tampered: Company = {
      ...company,
      startingCapitalCents: company.startingCapitalCents - 1n,
      ledger,
    };
    expect(companyProblems(tampered)).toEqual([
      'cash is 1000000, but capital and payments explain 999999',
    ]);
  });

  it('catches a payable balance that differs from the open invoices', () => {
    const setup = founded();
    const issued = ok(
      issueInvoice(
        setup.company,
        {
          direction: 'payable',
          counterpartyId: setup.company.ownerPartyId,
          description: 'Bill',
          lines: [{ account: ACCOUNT.rent, description: 'Rent', amountCents: 500n }],
          dueAtMs: 9n * MS_PER_HOUR,
          obligation: null,
        },
        { nowMs: 9n * MS_PER_HOUR, allocateId: setup.allocateId },
      ),
    );
    const tampered: Company = {
      ...issued.company,
      invoices: issued.company.invoices.map((invoice) => ({ ...invoice, paidCents: 200n })),
    };
    expect(companyProblems(tampered)).toEqual(
      expect.arrayContaining([
        'invoice invoice:1 records 200 paid; its payments differ',
        'accounts payable does not equal the 300 outstanding on payable invoices',
      ]),
    );
  });
});
