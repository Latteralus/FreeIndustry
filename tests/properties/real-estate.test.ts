import fc from 'fast-check';
import { baseContent } from '../../src/catalog/base-content';
import { availableFundsCents, outstandingOf } from '../../src/domain/invoicing';
import { ACCOUNT, balanceOf } from '../../src/domain/ledger';
import { MS_PER_DAY, MS_PER_HOUR } from '../../src/domain/time';
import { FREEINDUSTRY_RULES } from '../../src/simulation/freeindustry-rules';
import { SimulationKernel } from '../../src/simulation/kernel';
import { estateWorld } from '../support/real-estate-world';
import { testUuid } from '../support/toy-workshop';

/**
 * Step 07 gate, property-based: whatever the player tries — founding with or
 * without premises, leasing occupied or vacant property on any term, paying
 * bills, letting years pass — the books balance, cash is exactly the capital
 * plus and minus recorded payments, no property is held twice, a lease is
 * paid for every month it runs and no longer, and a refused command changes
 * nothing.
 */

const PROPERTY_IDS = baseContent().realEstate.properties.map((property) => property.id);

const step = fc.oneof(
  fc.record({
    kind: fc.constant('found' as const),
    capitalDollars: fc.integer({ min: 1_000, max: 120_000 }),
    lease: fc.option(
      fc.record({
        propertyId: fc.constantFrom(...PROPERTY_IDS),
        termMonths: fc.integer({ min: 1, max: 120 }),
        standingOrder: fc.boolean(),
      }),
    ),
  }),
  fc.record({
    kind: fc.constant('lease' as const),
    propertyId: fc.constantFrom(...PROPERTY_IDS),
    termMonths: fc.integer({ min: 1, max: 120 }),
    standingOrder: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('pay' as const),
    pick: fc.nat(),
    cents: fc.integer({ min: 1, max: 2_000_000 }),
  }),
  fc.record({
    kind: fc.constant('advance' as const),
    hours: fc.integer({ min: 1, max: 24 * 400 }),
  }),
);

describe('property: leasing keeps the world consistent', () => {
  it('holds every invariant after every step, and refusals change nothing', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff }),
        fc.array(step, { maxLength: 14 }),
        (seed, steps) => {
          const world = estateWorld(seed);
          let commands = 0;
          const submit = (type: string, payload: unknown) => {
            commands += 1;
            const before = world.fingerprint();
            const result = world.submit({
              commandId: testUuid(commands),
              expectedWorldRevision: world.worldRevision,
              type,
              // As over IPC: plain JSON (fast-check builds null-prototype records).
              payload: JSON.parse(JSON.stringify(payload)) as unknown,
            });
            if (!result.ok) {
              expect(result.error.code).toBe('COMMAND_REJECTED');
              expect(world.fingerprint()).toEqual(before);
            }
          };
          for (const action of steps) {
            switch (action.kind) {
              case 'found':
                submit('company.found', {
                  legalName: 'Property Test Co.',
                  presidentName: 'Pat Property',
                  startingCapitalCents: String(action.capitalDollars * 100),
                  ...(action.lease ? { premises: action.lease } : {}),
                });
                break;
              case 'lease':
                submit('realEstate.lease', {
                  propertyId: action.propertyId,
                  termMonths: action.termMonths,
                  standingOrder: action.standingOrder,
                });
                break;
              case 'pay': {
                const open = (world.state.company?.invoices ?? []).filter(
                  (invoice) => invoice.direction === 'payable' && outstandingOf(invoice) > 0n,
                );
                const invoice = open[action.pick % Math.max(open.length, 1)];
                if (invoice) {
                  submit('finance.payInvoice', {
                    invoiceId: invoice.id,
                    amountCents: String(action.cents),
                  });
                }
                break;
              }
              case 'advance':
                world.advanceTo(world.nowMs + BigInt(action.hours) * MS_PER_HOUR);
                break;
            }
            expect(world.checkInvariants()).toEqual([]);
            const company = world.state.company;
            const estate = world.state.realEstate;
            if (!estate) {
              throw new Error('no real estate');
            }
            const active = estate.leases.filter((lease) => lease.status === 'active');
            expect(active.length).toBeLessThanOrEqual(1);
            for (const property of estate.properties) {
              const holders = active.filter((lease) => lease.propertyId === property.id);
              expect(holders.length).toBe(property.occupant?.kind === 'lease' ? 1 : 0);
            }
            if (company) {
              let expected = company.startingCapitalCents;
              for (const payment of company.payments) {
                expected +=
                  payment.direction === 'incoming' ? payment.amountCents : -payment.amountCents;
              }
              expect(availableFundsCents(company)).toBe(expected);
              expect(expected).toBeGreaterThanOrEqual(0n);
              // Rent is booked once per month invoiced, never beyond a lease's term.
              let rentBooked = 0n;
              for (const lease of estate.leases) {
                const rent = company.obligations.find((item) => item.id === lease.rentObligationId);
                expect(rent?.issued).toBeLessThanOrEqual(lease.termMonths);
                rentBooked += BigInt(rent?.issued ?? 0) * lease.rentCentsPerMonth;
                if (lease.status === 'ended') {
                  expect(rent?.issued).toBe(lease.termMonths);
                }
              }
              expect(balanceOf(company.ledger, ACCOUNT.rent)).toBe(rentBooked);
              // Deposits are held exactly for the active lease.
              expect(balanceOf(company.ledger, ACCOUNT.depositsPaid)).toBe(
                active.reduce((sum, lease) => sum + lease.depositCents, 0n),
              );
            } else {
              expect(estate.leases).toEqual([]);
            }
          }
          // And the whole history restores to the same world.
          const restored = SimulationKernel.restore(FREEINDUSTRY_RULES, world.checkpoint());
          expect(restored.fingerprint()).toEqual(world.fingerprint());
          restored.advanceTo(world.nowMs + 30n * MS_PER_DAY);
          world.advanceTo(world.nowMs + 30n * MS_PER_DAY);
          expect(restored.fingerprint()).toEqual(world.fingerprint());
        },
      ),
      { numRuns: 150 },
    );
  });
});
