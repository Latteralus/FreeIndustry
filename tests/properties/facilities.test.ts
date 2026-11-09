import fc from 'fast-check';
import { isQuarterTurn, PLACEMENT_LATTICE_MM } from '../../src/domain/equipment';
import { MS_PER_HOUR } from '../../src/domain/time';
import { FREEINDUSTRY_RULES } from '../../src/simulation/freeindustry-rules';
import { SimulationKernel } from '../../src/simulation/kernel';
import {
  facilitiesOf,
  leasedWorld,
  submit,
  withCoverings,
  type World,
} from '../support/facility-world';

/**
 * Property: random scripts of equipment purchases, installations, moves
 * and removals in a garage with floor coverings (plan Step 08). After every
 * step the world's invariants hold (exact layout rules, books, coverings);
 * every installed item stands on the 250 mm lattice in a quarter turn with
 * its catalog footprint; refused commands change nothing; and no equipment
 * command ever changes a floor covering or the slab.
 */

const TYPES = [
  'steel-workbench',
  'steel-shelving',
  'pedestal-grinder',
  'floor-drill-press',
] as const;

const step = fc.oneof(
  fc.record({ kind: fc.constant('buy' as const), type: fc.constantFrom(...TYPES) }),
  fc.record({
    kind: fc.constantFrom('install' as const, 'move' as const),
    item: fc.integer({ min: 1, max: 6 }),
    x: fc.integer({ min: 0, max: 12 }).map((n) => n * 250 + (n % 7 === 6 ? 125 : 0)),
    y: fc.integer({ min: 0, max: 23 }).map((n) => n * 250),
    rotation: fc.constantFrom(0, 90, 180, 270, 45),
  }),
  fc.record({ kind: fc.constant('uninstall' as const), item: fc.integer({ min: 1, max: 6 }) }),
);

function base(): World {
  return withCoverings(leasedWorld('hf-canal-2'), [
    { level: 0, col: 0, row: 0, materialId: 'epoxy-grey' },
    { level: 0, col: 3, row: 4, materialId: 'diamond-plate' },
    { level: 0, col: 5, row: 11, materialId: 'safety-hatching' },
  ]);
}

describe('property: equipment layouts stay valid and never touch the floor layer', () => {
  it('holds over random command scripts', () => {
    const start = base();
    const checkpoint = start.checkpoint();
    const coverings = facilitiesOf(start).coverings;
    const slab = start.state.realEstate?.properties.find(
      (p) => p.id === 'hf-canal-2',
    )?.floorLoadKgPerM2;
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 25 }), (script) => {
        const world: World = SimulationKernel.restore(FREEINDUSTRY_RULES, checkpoint);
        for (const action of script) {
          world.advanceTo(world.nowMs + MS_PER_HOUR);
          const before = world.fingerprint();
          const result =
            action.kind === 'buy'
              ? submit(world, 'equipment.purchase', { equipmentTypeId: action.type, quantity: 1 })
              : action.kind === 'uninstall'
                ? submit(world, 'equipment.uninstall', { equipmentId: `equipment:${action.item}` })
                : submit(
                    world,
                    action.kind === 'install' ? 'equipment.install' : 'equipment.move',
                    {
                      equipmentId: `equipment:${action.item}`,
                      propertyId: 'hf-canal-2',
                      level: 0,
                      xMm: action.x,
                      yMm: action.y,
                      rotation: action.rotation,
                    },
                  );
          if (!result.ok) {
            expect(world.fingerprint()).toEqual(before);
          }
          expect(world.checkInvariants()).toEqual([]);
          const facilities = facilitiesOf(world);
          expect(facilities.coverings).toEqual(coverings);
          for (const item of facilities.equipment) {
            if (item.placement) {
              expect(item.placement.xMm % PLACEMENT_LATTICE_MM).toBe(0);
              expect(item.placement.yMm % PLACEMENT_LATTICE_MM).toBe(0);
              expect(isQuarterTurn(item.placement.rotation)).toBe(true);
            }
          }
        }
        expect(
          world.state.realEstate?.properties.find((p) => p.id === 'hf-canal-2')?.floorLoadKgPerM2,
        ).toBe(slab);
      }),
      { numRuns: 60 },
    );
  });
});
