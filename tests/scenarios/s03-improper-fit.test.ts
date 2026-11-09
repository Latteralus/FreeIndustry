import { availableFundsCents } from '../../src/domain/invoicing';
import { facilitiesView, answerQuery } from '../../src/worker/facility-view';
import {
  accept,
  buy,
  leasedWorld,
  placement,
  refusal,
  type World,
} from '../support/facility-world';

/**
 * Spec scenario S03 — Improper fit (plan Step 08): in a leased garage,
 * attempt to place a machine exceeding the garage's floor and one that would
 * block the route through it. Each rejection explains the violated
 * real-world dimension, the worker's placement check gives the renderer the
 * colliding rectangles to preview, and nothing changes in the world.
 */

const cash = (world: World) => {
  const company = world.state.company;
  return company ? availableFundsCents(company) : 0n;
};

const query = (world: World, typeId: string, x: number, y: number, rotation = 0) =>
  answerQuery(
    {
      kind: 'placement',
      equipmentTypeId: typeId,
      equipmentId: null,
      propertyId: 'hf-canal-2',
      level: 0,
      xMm: x,
      yMm: y,
      rotation,
    },
    world.state.facilities,
    world.state.realEstate,
    world.state.company,
  );

describe('S03: improper fit', () => {
  it('refuses an oversized machine and a blocked route, explaining the dimensions, changing nothing', () => {
    const world = leasedWorld('hf-canal-2');
    const view = facilitiesView(
      world.state.facilities ??
        (() => {
          throw new Error('no facilities');
        })(),
      world.state.realEstate,
      world.state.company,
      world.config.epoch,
    );
    // The garage's floor, from its geometry: 3.0 × 5.8 m, 72 cells, 6 partial, 17.4 m².
    const floor = view.premises?.levels[0];
    expect(floor?.usableAreaMm2).toBe('17400000');
    expect(floor?.cells).toEqual({ cols: 6, rows: 12, full: 66, partial: 6, outside: 0 });

    // An edge bander, 6.4 m long, does not fit either way round.
    const [bander = ''] = buy(world, 'edge-bander');
    const afterPurchase = cash(world);
    const preview = query(world, 'edge-bander', 0, 0);
    expect(preview.allowed).toBe(false);
    expect(preview.footprint).toEqual({ x: 0, y: 0, width: 6400, depth: 1300 });
    const fit = preview.problems.find((problem) => problem.code === 'fit');
    expect(fit?.rect).toEqual(preview.footprint);
    const before = world.fingerprint();
    expect(refusal(world, 'equipment.install', placement(bander, 0, 0))).toMatch(
      /does not fit: its footprint is 6,400 mm × 1,300 mm and the floor of 2 Canal Street \(rear\) is only 3,000 mm × 5,800 mm/,
    );
    expect(refusal(world, 'equipment.install', placement(bander, 0, 0, 90))).toMatch(
      /^The Automatic edge-banding machine does not fit: its footprint is 6,400 mm × 1,300 mm/,
    );
    expect(world.fingerprint()).toEqual(before);
    expect(cash(world)).toBe(afterPurchase);

    // A bench fits; a shelving unit that would close the way to it does not.
    const [bench = '', shelf = '', grinder = ''] = [
      ...buy(world, 'steel-workbench'),
      ...buy(world, 'steel-shelving'),
      ...buy(world, 'pedestal-grinder'),
    ];
    accept(world, 'equipment.install', placement(shelf, 1000, 0));
    accept(world, 'equipment.install', placement(bench, 0, 2500));
    const blocking = query(world, 'pedestal-grinder', 2000, 2500);
    expect(blocking.problems.map((problem) => problem.code)).toEqual(['route']);
    // The preview can show where: the operator station that would be cut off.
    expect(blocking.problems[0]?.rect).toEqual({ x: 1000, y: 450, width: 1200, depth: 800 });
    const held = world.fingerprint();
    expect(refusal(world, 'equipment.install', placement(grinder, 2000, 2500))).toMatch(
      /could not be reached on foot: a clear way at least 800 mm wide is needed/,
    );
    expect(world.fingerprint()).toEqual(held);
    expect(world.checkInvariants()).toEqual([]);
  });
});
