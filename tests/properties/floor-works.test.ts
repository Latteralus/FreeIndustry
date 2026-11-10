import fc from 'fast-check';
import { levelGeometry } from '../../src/domain/facility';
import { ledgerProblems, trialBalance } from '../../src/domain/ledger';
import { cellKey } from '../../src/domain/region';
import { MS_PER_HOUR } from '../../src/domain/time';
import { FREEINDUSTRY_RULES } from '../../src/simulation/freeindustry-rules';
import { SimulationKernel } from '../../src/simulation/kernel';
import {
  buy,
  accept,
  facilitiesOf,
  leasedWorld,
  placement,
  submit,
  type World,
} from '../support/facility-world';

/**
 * Property (plan Step 09A acceptance): random floor orders — any material,
 * any rectangles (some reaching outside the floor or off the grid), placed
 * at random times while earlier jobs are under way or finished — keep the
 * books balanced and every covered cell eligible. A refused order changes
 * nothing; an accepted one moves cash by exactly its cost; an installed
 * machine and the slab never change.
 *
 * The industrial unit at 20 Canal Street (hf-canal-20) has columns (partial
 * cells) and a mezzanine; orders go to both levels.
 */

const SITE = 'hf-canal-20';
const MATERIALS = [
  'concrete-standard',
  'concrete-worn',
  'concrete-polished',
  'epoxy-grey',
  'steel-plate',
  'safety-hatching',
  'office-carpet-tile',
  'no-such-floor',
] as const;

// The ground floor is 30 × 48 cells and the mezzanine 30 × 12: most rectangles land on the floor, some do not.
const rect = fc.record({
  col: fc.integer({ min: 0, max: 31 }),
  row: fc.integer({ min: 0, max: 14 }),
  cols: fc.integer({ min: 1, max: 6 }),
  rows: fc.integer({ min: 1, max: 4 }),
});

const step = fc.record({
  hours: fc.integer({ min: 0, max: 72 }),
  level: fc.constantFrom(0, 0, 0, 1),
  material: fc.constantFrom(...MATERIALS),
  rectangles: fc.array(rect, { minLength: 1, maxLength: 3 }),
});

function cashOf(world: World): bigint {
  return (
    world.state.company?.ledger.accounts.find((account) => account.code === '1010')?.balanceCents ??
    0n
  );
}

describe('property: floor orders keep the books balanced and every covered cell eligible', () => {
  it('holds over random order scripts', () => {
    const start = leasedWorld(SITE, { capitalCents: '30000000' });
    const [bench = ''] = buy(start, 'steel-workbench');
    accept(start, 'equipment.install', placement(bench, 3000, 3000, 0, SITE));
    const checkpoint = start.checkpoint();
    const machine = facilitiesOf(start).equipment.find((item) => item.id === bench);
    const building = facilitiesOf(start).buildings.find((item) => item.propertyId === SITE);
    const property = start.state.realEstate?.properties.find((item) => item.id === SITE);
    if (!building || !property) {
      throw new Error('no unit');
    }
    const coverage = new Map(
      building.levels.map((level) => [
        level.index,
        levelGeometry(building, property, level).coverage,
      ]),
    );
    let accepted = 0;
    let completed = 0;
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 12 }), (script) => {
        const world: World = SimulationKernel.restore(FREEINDUSTRY_RULES, checkpoint);
        for (const action of script) {
          world.advanceTo(world.nowMs + BigInt(action.hours) * MS_PER_HOUR);
          const before = world.fingerprint();
          const cash = cashOf(world);
          const orders = facilitiesOf(world).installations.length;
          const result = submit(world, 'facility.installFloorCovering', {
            propertyId: SITE,
            level: action.level,
            materialId: action.material,
            rectangles: action.rectangles,
          });
          if (result.ok) {
            accepted += 1;
            const job = facilitiesOf(world).installations[orders];
            expect(job).toBeDefined();
            expect(cashOf(world)).toBe(cash - (job?.costCents ?? 0n));
            expect(job?.costCents).toBe((job?.installCents ?? 0n) + (job?.removalCents ?? 0n));
          } else {
            expect(world.fingerprint()).toEqual(before);
          }
          const company = world.state.company;
          expect(company && ledgerProblems(company.ledger)).toEqual([]);
          const totals = company ? trialBalance(company.ledger) : null;
          expect(totals?.debitsCents).toBe(totals?.creditsCents);
          for (const cell of facilitiesOf(world).coverings) {
            expect(coverage.get(cell.level)?.get(cellKey(cell.col, cell.row)) ?? 0).toBeGreaterThan(
              0,
            );
          }
          expect(world.checkInvariants()).toEqual([]);
        }
        completed += facilitiesOf(world).installations.filter(
          (job) => job.status === 'complete',
        ).length;
        expect(facilitiesOf(world).equipment.find((item) => item.id === bench)).toEqual(machine);
        expect(
          world.state.realEstate?.properties.find((item) => item.id === SITE)?.floorLoadKgPerM2,
        ).toBe(property.floorLoadKgPerM2);
      }),
      { numRuns: 60 },
    );
    // The scripts really buy and lay floors, not only get refused.
    expect(accepted).toBeGreaterThan(25);
    expect(completed).toBeGreaterThan(5);
  });
});
