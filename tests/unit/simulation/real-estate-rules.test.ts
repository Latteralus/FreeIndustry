import type { JsonValue } from '../../../src/shared/canonical-json';
import { availableFundsCents } from '../../../src/domain/invoicing';
import { ACCOUNT, balanceOf } from '../../../src/domain/ledger';
import { MS_PER_DAY, MS_PER_HOUR } from '../../../src/domain/time';
import type { FreeIndustryState } from '../../../src/domain/world-state';
import { DEFAULT_EPOCH, FREEINDUSTRY_RULES } from '../../../src/simulation/freeindustry-rules';
import { SimulationKernel } from '../../../src/simulation/kernel';
import { estateWorld, setupFor } from '../../support/real-estate-world';
import { testUuid } from '../../support/toy-workshop';

type World = SimulationKernel<FreeIndustryState>;

let counter = 0;
function submit(world: World, type: string, payload: unknown) {
  counter += 1;
  return world.submit({
    commandId: testUuid(10_000 + counter),
    expectedWorldRevision: world.worldRevision,
    type,
    payload,
  });
}

function accept(world: World, type: string, payload: unknown): void {
  const result = submit(world, type, payload);
  if (!result.ok) {
    throw new Error(`${type}: ${result.error.message}`);
  }
}

const FOUNDING = {
  legalName: 'Canal Works',
  presidentName: 'Jo Canal',
  startingCapitalCents: '5000000', // $50,000
};

/** 8 Canal Street, Harlow Falls: $520 a month, two months' deposit. */
const WORKSHOP = { propertyId: 'hf-canal-8', termMonths: 6, standingOrder: true };

function property(world: World, id: string) {
  const found = world.state.realEstate?.properties.find((item) => item.id === id);
  if (!found) {
    throw new Error(id);
  }
  return found;
}

describe('real-estate rules in the kernel', () => {
  it('a new world carries the content it was created from; the same seed and setup give the same world', () => {
    const world = estateWorld(11);
    expect(world.state.realEstate?.properties).toHaveLength(41);
    expect(world.state.realEstate?.scenario).toEqual({ id: 'standard', name: 'Standard start' });
    expect(estateWorld(11).fingerprint()).toEqual(world.fingerprint());
    expect(estateWorld(11, 'backed').fingerprint().stateHash).not.toBe(
      world.fingerprint().stateHash,
    );
    // A world created without content has no real estate, so pre-Step-07 worlds keep their hashes.
    const bare = SimulationKernel.create(FREEINDUSTRY_RULES, { seed: 11, epoch: DEFAULT_EPOCH });
    expect(bare.state.realEstate).toBeNull();
    expect(Object.keys(bare.encodedState().domain as object)).toEqual(['diagnostics']);
  });

  it('refuses a world setup that already holds leases, or that is invalid', () => {
    const full = setupFor().setup as { realEstate: Record<string, unknown>; facilities: unknown };
    const setup = full.realEstate;
    const withLease = {
      ...full,
      realEstate: {
        ...setup,
        properties: (setup['properties'] as Record<string, unknown>[]).map((item, index) =>
          index === 0 ? { ...item, occupant: { kind: 'lease', leaseId: 'lease:1' } } : item,
        ),
      },
    };
    expect(() =>
      SimulationKernel.create(
        FREEINDUSTRY_RULES,
        { seed: 1, epoch: DEFAULT_EPOCH },
        withLease as JsonValue,
      ),
    ).toThrow('A new world cannot start with leases');
    const broken = { ...full, realEstate: { ...setup, districts: [] } };
    expect(() =>
      SimulationKernel.create(
        FREEINDUSTRY_RULES,
        { seed: 1, epoch: DEFAULT_EPOCH },
        broken as JsonValue,
      ),
    ).toThrow(/Invalid world setup: property .* is in unknown district/);
  });

  it('founds the company and signs the lease in one command, recording both', () => {
    const world = estateWorld();
    world.advanceTo(9n * MS_PER_HOUR);
    accept(world, 'company.found', { ...FOUNDING, premises: WORKSHOP });
    const company = world.state.company;
    expect(company?.legalName).toBe('Canal Works');
    // $50,000 less the $1,040 deposit and the first month's $520.
    expect(company && availableFundsCents(company)).toBe(4_844_000n);
    expect(property(world, 'hf-canal-8').occupant).toEqual({ kind: 'lease', leaseId: 'lease:1' });
    const facts = world.journal.entries.at(-1)?.facts.map((fact) => fact.type);
    expect(facts).toEqual(['company.founded', 'realEstate.leaseSigned']);
    expect(world.checkInvariants()).toEqual([]);
    // The next rent bill and the end of the lease are on the queue.
    expect(
      world
        .pendingEvents()
        .map((event) => event.type)
        .sort(),
    ).toEqual(['finance.obligationBill', 'realEstate.leaseEnds']);
  });

  it('is all or nothing: a lease the capital cannot cover founds no company either', () => {
    const world = estateWorld();
    const before = world.fingerprint();
    const refused = submit(world, 'company.found', {
      ...FOUNDING,
      startingCapitalCents: '150000', // $1,500 < $1,560 due on signing
      premises: WORKSHOP,
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatchObject({
      code: 'COMMAND_REJECTED',
      message:
        "Insufficient funds: $1,500.00 available, $1,560.00 needed (deposit $1,040.00 and the first month's rent $520.00)",
    });
    expect(world.fingerprint()).toEqual(before);
    expect(world.state.company).toBeNull();
    expect(world.worldRevision).toBe(0);
  });

  it('refusals of realEstate.lease change nothing', () => {
    const world = estateWorld();
    expect(submit(world, 'realEstate.lease', WORKSHOP)).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_REJECTED', message: 'No company has been founded yet' },
    });
    accept(world, 'company.found', FOUNDING);
    const before = world.fingerprint();
    for (const [payload, message] of [
      [
        { ...WORKSHOP, propertyId: 'hf-canal-12' },
        '12 Canal Street is occupied by Brennan Sheet Metal',
      ],
      [{ ...WORKSHOP, termMonths: 48 }, '8 Canal Street is let for 6–36 months, not 48'],
      [{ ...WORKSHOP, propertyId: 'no-such-place' }, 'There is no property no-such-place'],
    ] as const) {
      expect(submit(world, 'realEstate.lease', payload)).toMatchObject({
        ok: false,
        error: { code: 'COMMAND_REJECTED', message },
      });
    }
    expect(world.fingerprint()).toEqual(before);
    accept(world, 'realEstate.lease', WORKSHOP);
    expect(
      submit(world, 'realEstate.lease', { ...WORKSHOP, propertyId: 'hf-canal-2' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_REJECTED' },
    });
  });

  it('bills rent monthly, paid by standing order, and ends the lease with the deposit refunded', () => {
    const world = estateWorld();
    world.advanceTo(9n * MS_PER_HOUR);
    accept(world, 'company.found', { ...FOUNDING, premises: WORKSHOP });
    world.advanceTo(95n * MS_PER_DAY); // early April: February, March and April rent paid
    let company = world.state.company;
    expect(company?.payments.map((payment) => payment.initiatedBy)).toEqual([
      'player',
      'player',
      'standing-order',
      'standing-order',
      'standing-order',
    ]);
    expect(company && balanceOf(company.ledger, ACCOUNT.rent)).toBe(4n * 52_000n);
    // The term is six months: 1 July 1996 at 09:00.
    world.advanceTo(200n * MS_PER_DAY);
    company = world.state.company;
    expect(company && balanceOf(company.ledger, ACCOUNT.rent)).toBe(6n * 52_000n);
    expect(company && balanceOf(company.ledger, ACCOUNT.depositsPaid)).toBe(0n);
    expect(company && availableFundsCents(company)).toBe(5_000_000n - 6n * 52_000n);
    expect(world.state.realEstate?.leases[0]).toMatchObject({ status: 'ended' });
    expect(property(world, 'hf-canal-8').occupant).toBeNull();
    expect(world.checkInvariants()).toEqual([]);
    // Vacant again, so it can be leased again.
    accept(world, 'realEstate.lease', WORKSHOP);
  });

  it('without a standing order, unpaid rent becomes overdue and the shortfall is visible', () => {
    const world = estateWorld();
    accept(world, 'company.found', {
      ...FOUNDING,
      startingCapitalCents: '160000', // $1,600: just enough to sign
      premises: { ...WORKSHOP, standingOrder: false },
    });
    world.advanceTo(40n * MS_PER_DAY);
    const company = world.state.company;
    const overdue = company?.invoices.filter((invoice) => invoice.overdueSinceMs !== null);
    expect(overdue?.map((invoice) => invoice.totalCents)).toEqual([52_000n]);
    expect(company && availableFundsCents(company)).toBe(4_000n);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('checkpoint restore and journal replay reproduce a leased world exactly', () => {
    const world = estateWorld(5);
    world.advanceTo(3n * MS_PER_HOUR);
    accept(world, 'company.found', { ...FOUNDING, premises: WORKSHOP });
    world.advanceTo(50n * MS_PER_DAY);
    const restored = SimulationKernel.restore(FREEINDUSTRY_RULES, world.checkpoint());
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    restored.advanceTo(250n * MS_PER_DAY);
    world.advanceTo(250n * MS_PER_DAY);
    expect(restored.fingerprint()).toEqual(world.fingerprint());

    const replay = estateWorld(5);
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
    replay.advanceTo(250n * MS_PER_DAY);
    expect(replay.fingerprint()).toEqual(world.fingerprint());
  });
});
