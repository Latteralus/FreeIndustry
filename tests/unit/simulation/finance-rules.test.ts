import { ACCOUNT, balanceOf } from '../../../src/domain/ledger';
import { MS_PER_DAY, MS_PER_HOUR } from '../../../src/domain/time';
import { FREEINDUSTRY_RULES } from '../../../src/simulation/freeindustry-rules';
import { SimulationKernel } from '../../../src/simulation/kernel';
import { testUuid } from '../../support/toy-workshop';
import { at, command, companyOf, newWorld, type World } from '../../support/save-world';

/**
 * Step 05 rules through the real kernel: founding, bills from obligations,
 * standing orders, overdue bills, player payments, idempotency and
 * all-or-nothing refusals.
 */

const FOUND = {
  legalName: 'Harbour Tool Works',
  presidentName: 'Mae Okafor',
  startingCapitalCents: '1000000', // $10,000.00
};

function founded(): World {
  const world = newWorld(11);
  world.advanceTo(8n * MS_PER_HOUR);
  command(world, 'company.found', FOUND);
  return world;
}

function obligation(world: World, overrides: Record<string, unknown> = {}): void {
  command(world, 'diagnostics.addTestObligation', {
    purpose: 'rent',
    amountCents: '300000',
    cadence: 'monthly',
    occurrences: 3,
    firstBillInDays: 1,
    paymentTermsDays: 0,
    standingOrder: true,
    ...overrides,
  });
}

let next = 10_000;
function submit(world: World, type: string, payload: unknown, revision = world.worldRevision) {
  next += 1;
  return world.submit({
    commandId: testUuid(next),
    expectedWorldRevision: revision,
    type,
    payload,
  });
}

function factsOf(world: World, type: string) {
  return world.journal.entries.flatMap((entry) =>
    entry.facts.filter((fact) => fact.type === type).map((fact) => fact.data),
  );
}

const cash = (world: World) => balanceOf(companyOf(world).ledger, ACCOUNT.cash);

describe('company and finance rules', () => {
  it('a new world has no company, and its encoding has no company slice', () => {
    const world = newWorld();
    expect(world.state.company).toBeNull();
    expect(world.checkpoint().state.domain).toEqual({
      diagnostics: expect.any(Object) as unknown,
    });
  });

  it('founding posts the capital, records a fact and passes every invariant', () => {
    const world = founded();
    const company = companyOf(world);
    expect(company.legalName).toBe('Harbour Tool Works');
    expect(company.foundedAtMs).toBe(8n * MS_PER_HOUR);
    expect(cash(world)).toBe(1_000_000n);
    expect(factsOf(world, 'company.founded')).toEqual([
      { firmId: 'firm:1', legalName: 'Harbour Tool Works', startingCapitalCents: '1000000' },
    ]);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('refuses money commands before a company exists, and a second founding after', () => {
    const world = newWorld();
    const pay = submit(world, 'finance.payInvoice', { invoiceId: 'invoice:1', amountCents: '1' });
    expect(pay).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_REJECTED', message: 'No company has been founded yet' },
    });
    command(world, 'company.found', FOUND);
    expect(submit(world, 'company.found', FOUND)).toMatchObject({
      ok: false,
      error: { message: 'Harbour Tool Works has already been founded in this world' },
    });
  });

  it('a standing order pays each monthly bill on its due date', () => {
    const world = founded();
    obligation(world);
    world.advanceTo(100n * MS_PER_DAY);
    const company = companyOf(world);
    expect(company.invoices.map((invoice) => invoice.paidCents)).toEqual([
      300_000n,
      300_000n,
      300_000n,
    ]);
    expect(company.payments.map((payment) => payment.initiatedBy)).toEqual([
      'standing-order',
      'standing-order',
      'standing-order',
    ]);
    // Bills on 2 Jan, 2 Feb and 2 Mar 1996 (a leap year: day 61) at 08:00.
    expect(company.invoices.map((invoice) => invoice.issuedAtMs)).toEqual([
      MS_PER_DAY + 8n * MS_PER_HOUR,
      32n * MS_PER_DAY + 8n * MS_PER_HOUR,
      61n * MS_PER_DAY + 8n * MS_PER_HOUR,
    ]);
    expect(cash(world)).toBe(100_000n);
    expect(balanceOf(company.ledger, ACCOUNT.rent)).toBe(900_000n);
    expect(world.pendingEvents()).toEqual([]);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('a bill the funds cannot cover becomes overdue, explicitly, and stops "next event"', () => {
    const world = founded();
    obligation(world, { amountCents: '700000' });
    const first = world.advanceTo(100n * MS_PER_DAY, { stopAfterNotable: true });
    expect(first).toMatchObject({ stop: 'notable', nowMs: MS_PER_DAY + 8n * MS_PER_HOUR });
    expect(cash(world)).toBe(300_000n);
    const second = world.advanceTo(100n * MS_PER_DAY, { stopAfterNotable: true });
    expect(second.nowMs).toBe(32n * MS_PER_DAY + 8n * MS_PER_HOUR);
    expect(factsOf(world, 'finance.invoiceOverdue')).toEqual([
      {
        invoiceId: 'invoice:2',
        direction: 'payable',
        outstandingCents: '700000',
        availableCents: '300000',
        standingOrderRefused: true,
      },
    ]);
    const company = companyOf(world);
    expect(cash(world)).toBe(300_000n); // never overdrawn
    expect(company.invoices[1]?.overdueSinceMs).toBe(32n * MS_PER_DAY + 8n * MS_PER_HOUR);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('the player pays an overdue bill; a payment beyond the funds changes nothing', () => {
    const world = founded();
    obligation(world, { amountCents: '1200000', cadence: 'once', occurrences: 1 });
    world.advanceTo(2n * MS_PER_DAY);
    expect(world.state.company?.invoices[0]?.overdueSinceMs).not.toBeNull();
    const before = world.fingerprint();
    const refused = submit(world, 'finance.payInvoice', {
      invoiceId: 'invoice:1',
      amountCents: '1200000',
    });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'COMMAND_REJECTED',
        message: 'Insufficient funds: $10,000.00 available, $12,000.00 needed',
        details: { availableCents: '1000000', requiredCents: '1200000' },
      },
    });
    expect(world.fingerprint()).toEqual(before);
    command(world, 'finance.payInvoice', { invoiceId: 'invoice:1', amountCents: '1000000' });
    expect(cash(world)).toBe(0n);
    expect(world.state.company?.invoices[0]?.paidCents).toBe(1_000_000n);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('a resubmitted payment is answered from the journal and never pays twice', () => {
    const world = founded();
    obligation(world, { standingOrder: false, cadence: 'once', occurrences: 1 });
    world.advanceTo(2n * MS_PER_DAY);
    const envelope = {
      commandId: testUuid(99_001),
      expectedWorldRevision: world.worldRevision,
      type: 'finance.payInvoice',
      payload: { invoiceId: 'invoice:1', amountCents: '100000' },
    };
    const first = world.submit(envelope);
    const again = world.submit(envelope);
    expect(first).toMatchObject({ ok: true, receipt: { duplicate: false } });
    expect(again).toMatchObject({ ok: true, receipt: { duplicate: true } });
    expect(world.state.company?.payments).toHaveLength(1);
    // A second click prepared against the old revision is stale, not a second payment.
    const stale = submit(
      world,
      'finance.payInvoice',
      { invoiceId: 'invoice:1', amountCents: '100000' },
      envelope.expectedWorldRevision,
    );
    expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(cash(world)).toBe(900_000n);
  });

  it('a bill paid before its due date is left alone when the date comes', () => {
    const world = founded();
    obligation(world, {
      standingOrder: true,
      cadence: 'once',
      occurrences: 1,
      paymentTermsDays: 10,
    });
    world.advanceTo(2n * MS_PER_DAY);
    command(world, 'finance.payInvoice', { invoiceId: 'invoice:1', amountCents: '300000' });
    world.advanceTo(20n * MS_PER_DAY);
    expect(factsOf(world, 'finance.invoiceSettledBeforeDue')).toEqual([{ invoiceId: 'invoice:1' }]);
    expect(world.state.company?.payments.map((payment) => payment.initiatedBy)).toEqual(['player']);
  });

  it('replaying the journal and restoring a checkpoint reproduce the same world', () => {
    const world = founded();
    obligation(world, { amountCents: '400000' });
    obligation(world, { purpose: 'security-deposit', cadence: 'once', occurrences: 1 });
    world.advanceTo(45n * MS_PER_DAY);
    const checkpoint = JSON.parse(JSON.stringify(world.checkpoint())) as unknown;
    const restored = SimulationKernel.restore(FREEINDUSTRY_RULES, checkpoint);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    restored.advanceTo(120n * MS_PER_DAY);
    world.advanceTo(120n * MS_PER_DAY);
    expect(restored.fingerprint()).toEqual(world.fingerprint());

    const replay = newWorld(11);
    for (const entry of world.journal.entries) {
      if (entry.kind === 'command') {
        replay.advanceTo(entry.atMs);
        const result = replay.submit({
          commandId: entry.commandId,
          expectedWorldRevision: entry.revision - 1,
          type: entry.type,
          payload: entry.payload,
        });
        expect(result.ok).toBe(true);
      }
    }
    replay.advanceTo(120n * MS_PER_DAY);
    expect(replay.fingerprint()).toEqual(world.fingerprint());
  });

  it('a tampered checkpoint whose books do not balance is refused on restore', () => {
    const world = founded();
    const checkpoint = JSON.parse(JSON.stringify(world.checkpoint())) as {
      state: { domain: { company: { ledger: { accounts: { balanceCents: string }[] } } } };
    };
    at(checkpoint.state.domain.company.ledger.accounts, 0).balanceCents = '1000001';
    expect(() => SimulationKernel.restore(FREEINDUSTRY_RULES, checkpoint)).toThrow(
      /company: ledger: account 1010 holds 1000001/,
    );
  });
});
