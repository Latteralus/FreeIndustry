import { companyProblems } from '../../../src/domain/company-invariants';
import { availableFundsCents } from '../../../src/domain/invoicing';
import { ACCOUNT, balanceOf } from '../../../src/domain/ledger';
import {
  depositOf,
  endLease,
  floorAreaMm2,
  propertyProblems,
  realEstateProblems,
  signLease,
  upfrontCostOf,
  type RealEstate,
} from '../../../src/domain/real-estate';
import { Rejection } from '../../../src/domain/rejection';
import { addCalendarMonths } from '../../../src/domain/time';
import {
  company,
  ruleContext,
  settledValue,
  testRealEstate,
} from '../../support/real-estate-world';
import { must } from '../../support/must';

const EPOCH = { year: 1996, month: 1, day: 1 };

function propertyOf(estate: RealEstate, id: string) {
  const found = estate.properties.find((item) => item.id === id);
  if (!found) {
    throw new Error(id);
  }
  return found;
}

describe('real estate: listings', () => {
  it('derives area, deposit and the amount due on signing from the listing itself', () => {
    const estate = testRealEstate();
    const garage = propertyOf(estate, 'garage-1');
    const workshop = propertyOf(estate, 'workshop-2');
    expect(floorAreaMm2(garage)).toBe(18_000_000n);
    expect(floorAreaMm2(workshop)).toBe(96_000_000n);
    expect(depositOf(workshop)).toBe(100_000n);
    expect(upfrontCostOf(workshop)).toBe(150_000n);
    expect(upfrontCostOf(garage)).toBe(20_000n);
    expect(realEstateProblems(estate, null)).toEqual([]);
  });

  it('reports physically or commercially impossible listings', () => {
    const workshop = propertyOf(testRealEstate(), 'workshop-2');
    expect(
      propertyProblems({
        ...workshop,
        doors: [{ kind: 'personnel', edge: 2, offsetMm: 7500, widthMm: 900, heightMm: 2100 }],
      }),
    ).toEqual(['door 0 does not fit within its 8000 mm wall']);
    expect(
      propertyProblems({
        ...workshop,
        doors: [{ kind: 'personnel', edge: 9, offsetMm: 0, widthMm: 900, heightMm: 2100 }],
      }),
    ).toEqual(['door 0 is on edge 9, which the floor does not have']);
    expect(
      propertyProblems({
        ...workshop,
        doors: [{ kind: 'personnel', edge: 0, offsetMm: 0, widthMm: 900, heightMm: 5000 }],
      }),
    ).toEqual(["door 0 is taller than the building's clear height"]);
    expect(
      propertyProblems({
        ...workshop,
        doors: [{ kind: 'roller-shutter', edge: 0, offsetMm: 0, widthMm: 900, heightMm: 2000 }],
      }),
    ).toEqual(['there is no personnel door']);
    expect(propertyProblems({ ...workshop, minTermMonths: 40 })).toEqual([
      'lease terms must satisfy 1 ≤ minimum ≤ maximum ≤ 120',
    ]);
    expect(propertyProblems({ ...workshop, depositMonths: 0 })).toEqual([
      'the deposit must be 1–6 months of rent',
    ]);
    expect(propertyProblems({ ...workshop, rentCentsPerMonth: 0n })).toEqual([
      'rent must be a positive amount',
    ]);
    expect(propertyProblems({ ...workshop, floor: workshop.floor.slice(0, 3) })[0]).toMatch(
      /^floor: a floor outline needs/,
    );
  });

  it('reports broken references between cities, districts, businesses and properties', () => {
    const estate = testRealEstate();
    const [garage, workshop, unit] = estate.properties;
    if (!garage || !workshop || !unit) {
      throw new Error('fixture');
    }
    expect(
      realEstateProblems(
        { ...estate, properties: [garage, { ...workshop, id: 'garage-1' }, unit] },
        null,
      ),
    ).toContain('identifier garage-1 is used twice');
    expect(
      realEstateProblems(
        { ...estate, properties: [{ ...garage, districtId: 'nowhere' }, workshop, unit] },
        null,
      ),
    ).toContain('property garage-1 is in unknown district nowhere');
    expect(
      realEstateProblems(
        {
          ...estate,
          properties: [
            { ...garage, occupant: { kind: 'business', businessId: 'test-rival' } },
            workshop,
            unit,
          ],
        },
        null,
      ),
    ).toContain('test-rival occupies both garage-1 and unit-3');
    expect(
      realEstateProblems(
        { ...estate, businesses: [{ ...must(estate.businesses[0]), cityId: 'atlantis' }] },
        null,
      ),
    ).toEqual(expect.arrayContaining(['business test-rival is in unknown city atlantis']));
    expect(
      realEstateProblems(
        { ...estate, properties: [{ ...garage, id: 'Not A Slug' }, workshop, unit] },
        null,
      ),
    ).toContain('identifier "Not A Slug" is not a valid content identifier');
  });
});

describe('real estate: signing a lease', () => {
  it('pays the deposit and first month at once, commits the rent and occupies the property', () => {
    const context = ruleContext(9n * 3_600_000n);
    const books = company(1_000_000n, context);
    const signed = settledValue(
      signLease(
        testRealEstate(),
        books,
        { propertyId: 'workshop-2', termMonths: 12, standingOrder: true },
        context,
      ),
    );
    // $10,000 less the $1,000 deposit and $500 first month.
    expect(availableFundsCents(signed.company)).toBe(850_000n);
    expect(balanceOf(signed.company.ledger, ACCOUNT.depositsPaid)).toBe(100_000n);
    expect(balanceOf(signed.company.ledger, ACCOUNT.rent)).toBe(50_000n);
    expect(
      signed.company.invoices.map((invoice) => [invoice.totalCents, invoice.paidCents]),
    ).toEqual([
      [100_000n, 100_000n],
      [50_000n, 50_000n],
    ]);
    expect(
      signed.company.obligations.map((item) => [item.purpose, item.occurrences, item.issued]),
    ).toEqual([
      ['security-deposit', 1, 1],
      ['rent', 12, 1],
    ]);
    expect(signed.company.counterparties.map((party) => [party.name, party.kind])).toEqual([
      ['Robin Test', 'owner'],
      ['Test Estates', 'landlord'],
    ]);
    const lease = signed.realEstate.leases[0];
    expect(lease).toMatchObject({
      id: signed.leaseId,
      propertyId: 'workshop-2',
      termMonths: 12,
      rentCentsPerMonth: 50_000n,
      depositCents: 100_000n,
      status: 'active',
      endsAtMs: addCalendarMonths(EPOCH, context.nowMs, 12),
    });
    expect(propertyOf(signed.realEstate, 'workshop-2').occupant).toEqual({
      kind: 'lease',
      leaseId: signed.leaseId,
    });
    expect(companyProblems(signed.company)).toEqual([]);
    expect(realEstateProblems(signed.realEstate, signed.company)).toEqual([]);
  });

  it('accepts funds that exactly cover the amount due, and refuses a cent less with the figures', () => {
    const terms = { propertyId: 'workshop-2', termMonths: 6, standingOrder: false };
    const exactContext = ruleContext();
    const exact = company(150_000n, exactContext);
    expect(signLease(testRealEstate(), exact, terms, exactContext)).not.toBeInstanceOf(Rejection);
    const shortContext = ruleContext();
    const short = company(149_999n, shortContext);
    const refused = signLease(testRealEstate(), short, terms, shortContext);
    expect(refused).toBeInstanceOf(Rejection);
    expect((refused as Rejection).reason).toBe(
      "Insufficient funds: $1,499.99 available, $1,500.00 needed (deposit $1,000.00 and the first month's rent $500.00)",
    );
    expect((refused as Rejection).details).toEqual({
      availableCents: '149999',
      requiredCents: '150000',
    });
  });

  it('refuses occupied, already leased, unknown and wrongly termed property, changing nothing', () => {
    const estate = testRealEstate();
    const context = ruleContext();
    const books = company(10_000_000n, context);
    const attempt = (propertyId: string, termMonths: number, on = estate, by = books) =>
      signLease(on, by, { propertyId, termMonths, standingOrder: true }, context);
    expect((attempt('unit-3', 12) as Rejection).reason).toBe(
      'unit-3 Test Street is occupied by Rival Co.',
    );
    expect((attempt('nowhere', 12) as Rejection).reason).toBe('There is no property nowhere');
    expect((attempt('workshop-2', 3) as Rejection).reason).toBe(
      'workshop-2 Test Street is let for 6–36 months, not 3',
    );
    expect((attempt('workshop-2', 37) as Rejection).reason).toMatch(/not 37$/);
    // Refusals return before anything is staged: the inputs are untouched.
    expect(estate).toEqual(testRealEstate());
    expect(books.ledger.entries).toHaveLength(1);
    const signed = settledValue(attempt('garage-1', 6));
    expect((attempt('garage-1', 6, signed.realEstate, signed.company) as Rejection).reason).toBe(
      'garage-1 Test Street is already leased',
    );
    expect((attempt('workshop-2', 12, signed.realEstate, signed.company) as Rejection).reason).toBe(
      'Test Works already leases garage-1 Test Street. Running a second facility arrives with multi-site operations (plan Step 26).',
    );
  });
});

describe('real estate: the end of a lease', () => {
  it('moves the company out, frees the property and refunds the deposit through a receivable', () => {
    const start = ruleContext(0n);
    const signed = settledValue(
      signLease(
        testRealEstate(),
        company(1_000_000n, start),
        { propertyId: 'workshop-2', termMonths: 6, standingOrder: true },
        start,
      ),
    );
    const endsAt = signed.endsAtMs;
    expect(() =>
      endLease(signed.realEstate, signed.company, signed.leaseId, { ...start, nowMs: endsAt - 1n }),
    ).toThrow(/ends at/);
    const ended = endLease(signed.realEstate, signed.company, signed.leaseId, {
      ...start,
      nowMs: endsAt,
    });
    expect(propertyOf(ended.realEstate, 'workshop-2').occupant).toBeNull();
    expect(ended.realEstate.leases[0]).toMatchObject({
      status: 'ended',
      endedAtMs: endsAt,
      refundInvoiceId: ended.refundInvoiceId,
    });
    expect(balanceOf(ended.company.ledger, ACCOUNT.depositsPaid)).toBe(0n);
    expect(availableFundsCents(ended.company)).toBe(1_000_000n - 50_000n);
    expect(ended.company.payments.at(-1)).toMatchObject({
      direction: 'incoming',
      initiatedBy: 'counterparty',
      amountCents: 100_000n,
    });
    expect(companyProblems(ended.company)).toEqual([]);
    expect(realEstateProblems(ended.realEstate, ended.company)).toEqual([]);
    expect(() =>
      endLease(ended.realEstate, ended.company, signed.leaseId, { ...start, nowMs: endsAt }),
    ).toThrow(/not active/);
  });

  it('invariants catch a lease that disagrees with its property or its books', () => {
    const context = ruleContext();
    const signed = settledValue(
      signLease(
        testRealEstate(),
        company(1_000_000n, context),
        { propertyId: 'workshop-2', termMonths: 12, standingOrder: true },
        context,
      ),
    );
    const vacated: RealEstate = {
      ...signed.realEstate,
      properties: signed.realEstate.properties.map((item) =>
        item.id === 'workshop-2' ? { ...item, occupant: null } : item,
      ),
    };
    expect(realEstateProblems(vacated, signed.company)).toContain(
      `lease ${signed.leaseId} is active but the property says otherwise`,
    );
    const cheaper: RealEstate = {
      ...signed.realEstate,
      leases: signed.realEstate.leases.map((lease) => ({ ...lease, rentCentsPerMonth: 1n })),
    };
    expect(realEstateProblems(cheaper, signed.company)).toContain(
      `lease ${signed.leaseId} does not match its rent obligation`,
    );
    expect(realEstateProblems(signed.realEstate, null)).toContain(
      'leases exist but no company does',
    );
  });
});
