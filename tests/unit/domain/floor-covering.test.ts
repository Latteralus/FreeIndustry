import { facilitiesProblems, type Facilities } from '../../../src/domain/facilities';
import {
  installationKindOf,
  runCells,
  runsOf,
  type CoveringInstallation,
} from '../../../src/domain/floor-covering';
import { accept, facilitiesOf, leasedWorld, type World } from '../../support/facility-world';

/**
 * The floor-covering records of Step 09A (ADR-0052): canonical cell runs,
 * the kind of an order, and the invariants that refuse an impossible order
 * however it got into a world.
 */

describe('cell runs', () => {
  it('groups distinct cells into sorted runs, merging neighbours and dropping repeats', () => {
    const cells = [
      { col: 3, row: 1 },
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 4, row: 1 },
      { col: 3, row: 1 },
      { col: 6, row: 1 },
    ];
    const runs = runsOf(cells);
    expect(runs).toEqual([
      [0, 0, 2],
      [1, 3, 5],
      [1, 6, 7],
    ]);
    expect([...runCells(runs)]).toHaveLength(5);
  });

  it('names an order by how many of its cells replace an installed material', () => {
    expect(installationKindOf(4, 0)).toBe('installation');
    expect(installationKindOf(4, 4)).toBe('replacement');
    expect(installationKindOf(4, 1)).toBe('mixed');
  });
});

describe('floor-order invariants', () => {
  /** A garage with one order under way: 2 × 2 cells of epoxy. */
  function ordered(): World {
    const world = leasedWorld();
    accept(world, 'facility.installFloorCovering', {
      propertyId: 'hf-canal-2',
      level: 0,
      materialId: 'epoxy-grey',
      rectangles: [{ col: 0, row: 0, cols: 2, rows: 2 }],
    });
    return world;
  }

  function problemsWith(world: World, change: (job: CoveringInstallation) => CoveringInstallation) {
    const facilities = facilitiesOf(world);
    const altered: Facilities = {
      ...facilities,
      installations: facilities.installations.map(change),
    };
    return facilitiesProblems(altered, world.state.realEstate, world.state.company);
  }

  it('hold for a real order', () => {
    const world = ordered();
    expect(problemsWith(world, (job) => job)).toEqual([]);
  });

  it('refuse sums that disagree, a wrong kind, and cells that are not the order’s', () => {
    const world = ordered();
    expect(problemsWith(world, (job) => ({ ...job, costCents: job.costCents + 1n }))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/costs something other than its installation and removal charges/),
      ]),
    );
    expect(problemsWith(world, (job) => ({ ...job, kind: 'replacement' }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/recorded as replacement/)]),
    );
    expect(
      problemsWith(world, (job) => ({
        ...job,
        runs: [
          [0, 0, 2],
          [1, 0, 3],
        ],
      })),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/cell count or area/)]));
    expect(
      problemsWith(world, (job) => ({
        ...job,
        runs: [
          [1, 0, 2],
          [0, 0, 2],
        ],
      })),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/out of order/)]));
  });

  it('refuse an order still under way after the lease ends, or one that completes before it began', () => {
    const world = ordered();
    const leaseEnd = world.state.realEstate?.leases[0]?.endsAtMs ?? 0n;
    expect(problemsWith(world, (job) => ({ ...job, completesAtMs: leaseEnd }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/will not hold when it finishes/)]),
    );
    expect(problemsWith(world, (job) => ({ ...job, completesAtMs: job.atMs }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/completes before it was ordered/)]),
    );
  });

  it('refuse two orders working on the same cell', () => {
    const world = ordered();
    const facilities = facilitiesOf(world);
    const [job] = facilities.installations;
    if (!job) {
      throw new Error('no order');
    }
    const twin = { ...job, id: 'floor-installation:2' as CoveringInstallation['id'] };
    const problems = facilitiesProblems(
      { ...facilities, installations: [job, twin] },
      world.state.realEstate,
      world.state.company,
    );
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/are both working on cell \(0, 0\)/)]),
    );
  });
});
