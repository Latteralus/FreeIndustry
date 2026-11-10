import { availableFundsCents } from '../../../src/domain/invoicing';
import { MS_PER_DAY } from '../../../src/domain/time';
import { answerQuery } from '../../../src/worker/facility-view';
import type { JsonValue } from '../../../src/shared/canonical-json';
import { DEFAULT_EPOCH, FREEINDUSTRY_RULES } from '../../../src/simulation/freeindustry-rules';
import { SimulationKernel } from '../../../src/simulation/kernel';
import { estateWorld, setupFor } from '../../support/real-estate-world';
import {
  accept,
  buy,
  facilitiesOf,
  leasedWorld,
  placement,
  refusal,
  submit,
  injectCoverings,
  withCoverings,
  type World,
} from '../../support/facility-world';

/**
 * Step 08 equipment rules in the kernel (ADR-0045, ADR-0048): buying through
 * the books, installing only where every exact placement rule holds,
 * relocation charges, removal, the end of a lease, and the independence of
 * equipment and floor coverings. The garage at 2 Canal Street (rear) is
 * 3,000 × 5,800 mm, single-phase 3 kVA, 2,300 mm clear, 500 kg/m², with a
 * roller shutter in the south wall and a personnel door and distribution
 * board in the west wall.
 */

const cashOf = (world: World) => {
  const company = world.state.company;
  if (!company) {
    throw new Error('no company');
  }
  return availableFundsCents(company);
};

function problemsAt(
  world: World,
  typeId: string,
  x: number,
  y: number,
  rotation = 0,
  propertyId = 'hf-canal-2',
  level = 0,
) {
  const result = answerQuery(
    {
      kind: 'placement',
      equipmentTypeId: typeId,
      equipmentId: null,
      propertyId,
      level,
      xMm: x,
      yMm: y,
      rotation,
    },
    world.state.facilities,
    world.state.realEstate,
    world.state.company,
  );
  return result.problems;
}

const codes = (problems: readonly { code: string }[]) =>
  [...new Set(problems.map((p) => p.code))].sort();

describe('buying equipment', () => {
  it('is paid to the dealer through the books, and the items wait uninstalled', () => {
    const world = leasedWorld();
    const before = cashOf(world);
    const ids = buy(world, 'steel-workbench', 2);
    expect(ids).toEqual(['equipment:1', 'equipment:2']);
    expect(cashOf(world)).toBe(before - 2n * 28_500n);
    const company = world.state.company;
    const machinery = company?.ledger.accounts.find((account) => account.code === '1500');
    expect(machinery).toMatchObject({ name: 'Machinery and equipment', balanceCents: 57_000n });
    const dealer = company?.counterparties.find((party) => party.name === 'Midwest Shop Equipment');
    expect(dealer?.kind).toBe('supplier');
    expect(facilitiesOf(world).equipment.every((item) => item.placement === null)).toBe(true);
    const facts = world.journal.entries.at(-1)?.facts ?? [];
    expect(facts.map((fact) => fact.type)).toEqual(['equipment.purchased']);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('refuses an order the funds cannot cover, changing nothing', () => {
    const world = leasedWorld('hf-canal-2', { capitalCents: '200000' });
    const before = world.fingerprint();
    expect(
      refusal(world, 'equipment.purchase', { equipmentTypeId: 'engine-lathe', quantity: 1 }),
    ).toMatch(/^Insufficient funds: \$1,810\.00 available, \$14,200\.00 needed \(1 × Engine lathe/);
    expect(world.fingerprint()).toEqual(before);
    expect(
      refusal(world, 'equipment.purchase', { equipmentTypeId: 'no-such-thing', quantity: 1 }),
    ).toBe('There is no equipment type no-such-thing');
  });

  it('is refused in a world made before Step 08, which has no equipment', () => {
    expect(estateWorld().state.facilities).not.toBeNull();
    // A bare real-estate setup builds a world exactly as Step 07 did, without facilities.
    const { realEstate } = setupFor().setup as { realEstate: JsonValue };
    const world = SimulationKernel.create(
      FREEINDUSTRY_RULES,
      { seed: 3, epoch: DEFAULT_EPOCH },
      realEstate,
    );
    expect(world.state.facilities).toBeNull();
    expect(Object.keys(world.encodedState().domain as object)).not.toContain('facilities');
    accept(world, 'company.found', {
      legalName: 'Old Co.',
      presidentName: 'Pat Old',
      startingCapitalCents: '1000000',
    });
    expect(
      refusal(world, 'equipment.purchase', { equipmentTypeId: 'steel-workbench', quantity: 1 }),
    ).toMatch(
      /^This world has no equipment or building layouts: it was created before they existed \(plan Step 08\)/,
    );
  });
});

describe('installing: exact placement rules', () => {
  it('installs a bench on the lattice; it then stands exactly on its catalog footprint', () => {
    const world = leasedWorld();
    const [bench = ''] = buy(world, 'steel-workbench');
    const cash = cashOf(world);
    accept(world, 'equipment.install', placement(bench, 0, 0));
    expect(cashOf(world)).toBe(cash); // the first installation is in the price
    const item = facilitiesOf(world).equipment[0];
    expect(item?.placement).toEqual({
      propertyId: 'hf-canal-2',
      level: 0,
      xMm: 0,
      yMm: 0,
      rotation: 0,
    });
    expect(item?.installations).toBe(1);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('refuses positions off the 250 mm lattice and turns other than quarter turns', () => {
    const world = leasedWorld();
    const [bench = ''] = buy(world, 'steel-workbench');
    const before = world.fingerprint();
    expect(refusal(world, 'equipment.install', placement(bench, 125, 0))).toMatch(
      /^Equipment stands on the 250 mm placement lattice; \(125 mm, 0 mm\) is not on it/,
    );
    expect(refusal(world, 'equipment.install', placement(bench, 0, 0, 45))).toMatch(
      /^Equipment turns in quarter turns only \(0°, 90°, 180° or 270°\), not 45°/,
    );
    expect(world.fingerprint()).toEqual(before);
  });

  it('S03-style: an oversized machine is refused with the dimensions that do not fit', () => {
    const world = leasedWorld();
    const problems = problemsAt(world, 'edge-bander', 0, 0);
    expect(problems.find((p) => p.code === 'fit')?.message).toBe(
      'The Automatic edge-banding machine does not fit: its footprint is 6,400 mm × 1,300 mm and the floor of 2 Canal Street (rear) is only 3,000 mm × 5,800 mm',
    );
    // A 12 ft × 6 ft saw is too long across the garage but would fit turned.
    expect(
      problemsAt(world, 'sliding-table-panel-saw', 0, 0).find((p) => p.code === 'fit')?.message,
    ).toMatch(
      /Turned this way the Sliding-table panel saw is 3,658 mm × 1,829 mm, more than the 3,000 mm × 5,800 mm floor; turn it a quarter/,
    );
  });

  it('checks height, slab load, power, phase and permitted use', () => {
    const world = leasedWorld();
    expect(
      problemsAt(world, 'pallet-racking-bay', 0, 0).find((p) => p.code === 'height')?.message,
    ).toBe('The Pallet racking bay is 4,500 mm tall; the clear height here is 2,300 mm');
    expect(codes(problemsAt(world, 'engine-lathe', 0, 0))).toEqual(
      expect.arrayContaining(['floor-load', 'services']),
    );
    expect(
      problemsAt(world, 'engine-lathe', 0, 0).find((p) => p.code === 'floor-load')?.message,
    ).toBe(
      'The Engine lathe, 1.5 m between centres weighs 1,900 kg on its footprint, 617 kg/m²; the floor here is rated for 500 kg/m²',
    );
    expect(
      problemsAt(world, 'mig-welding-station', 500, 500).find((p) => p.code === 'power')?.message,
    ).toBe(
      'With the MIG welding station the installed equipment would draw 7.5 kVA; the electrical supply of 2 Canal Street (rear) is 3 kVA',
    );
    expect(problemsAt(world, 'office-desk', 0, 0).map((p) => p.code)).toEqual(['use']);
  });

  it('keeps door landings and the distribution board clear', () => {
    const world = leasedWorld();
    expect(problemsAt(world, 'steel-shelving', 0, 4500, 90).map((p) => p.message)).toContain(
      'The Steel shelving unit blocks the clear landing at the personnel door in the west wall (door 2)',
    );
    expect(problemsAt(world, 'steel-shelving', 0, 3000, 90).map((p) => p.message)).toContain(
      'The Steel shelving unit blocks the clear landing at Electrical intake and distribution board',
    );
  });

  it('keeps equipment apart and keeps each item’s zones open', () => {
    const world = leasedWorld();
    const [first = '', second = ''] = buy(world, 'steel-workbench', 2);
    accept(world, 'equipment.install', placement(first, 0, 0));
    expect(refusal(world, 'equipment.install', placement(second, 500, 0))).toMatch(
      /^The Steel workbench overlaps the Steel workbench \(equipment:1\)/,
    );
    // Turned to face the north wall, its operator station would be in the wall.
    expect(
      problemsAt(world, 'steel-workbench', 1000, 0, 180).find((p) => p.code === 'zone')?.message,
    ).toBe(
      'The operator station at the front of the Steel workbench (800 mm deep) runs into a wall, column or obstacle',
    );
    // Standing in front of the first bench, in its operator station.
    expect(
      problemsAt(world, 'pedestal-grinder', 500, 750).find((p) => p.code === 'zone')?.message,
    ).toBe(
      'The Pedestal grinder stands in the operator station at the front of the Steel workbench (equipment:1)',
    );
  });

  it('refuses a layout that cuts off an operator station from the door (route)', () => {
    const world = leasedWorld();
    const [shelf = '', bench = '', grinder = ''] = [
      ...buy(world, 'steel-shelving'),
      ...buy(world, 'steel-workbench'),
      ...buy(world, 'pedestal-grinder'),
    ];
    accept(world, 'equipment.install', placement(shelf, 1000, 0));
    accept(world, 'equipment.install', placement(bench, 0, 2500));
    const before = world.fingerprint();
    // The grinder would leave only 200 mm and 500 mm gaps beside the bench: the shelf is cut off.
    expect(refusal(world, 'equipment.install', placement(grinder, 2000, 2500))).toMatch(
      /^The operator station at the front of the Steel shelving unit \(equipment:1\) could not be reached on foot: a clear way at least 800 mm wide is needed/,
    );
    // Between the bench and the grinder there would be only 500 mm: refused too.
    expect(codes(problemsAt(world, 'pedestal-grinder', 2250, 1500))).toEqual(['route']);
    // In the north-east corner, clear of every way, it is allowed.
    expect(codes(problemsAt(world, 'pedestal-grinder', 2500, 500))).toEqual([]);
    expect(world.fingerprint()).toEqual(before);
  });

  it('stores an odd-sized footprint exactly: a 3,658 × 1,829 mm saw in the industrial unit', () => {
    const world = leasedWorld('hf-canal-20');
    const [saw = ''] = buy(world, 'sliding-table-panel-saw');
    accept(world, 'equipment.install', placement(saw, 3000, 12000, 0, 'hf-canal-20'));
    const view = answerQuery(
      {
        kind: 'placement',
        equipmentTypeId: 'sliding-table-panel-saw',
        equipmentId: saw,
        propertyId: 'hf-canal-20',
        level: 0,
        xMm: 3000,
        yMm: 12000,
        rotation: 90,
      },
      world.state.facilities,
      world.state.realEstate,
      world.state.company,
    );
    expect(view.footprint).toEqual({ x: 3000, y: 12000, width: 1829, depth: 3658 });
    expect(world.checkInvariants()).toEqual([]);
  });

  it('measures headroom under the mezzanine, and places on the mezzanine against its own slab', () => {
    const world = leasedWorld('hf-canal-20');
    expect(
      problemsAt(world, 'pallet-racking-bay', 0, 2000, 0, 'hf-canal-20').find(
        (p) => p.code === 'height',
      )?.message,
    ).toBe(
      'The Pallet racking bay is 4,500 mm tall; the clear height under the Mezzanine is 2,500 mm',
    );
    expect(codes(problemsAt(world, 'pallet-racking-bay', 0, 12000, 0, 'hf-canal-20'))).toEqual([]);
    // On the mezzanine (350 kg/m²) a lathe is too heavy; shelving is fine.
    expect(codes(problemsAt(world, 'engine-lathe', 1000, 1000, 0, 'hf-canal-20', 1))).toContain(
      'floor-load',
    );
    expect(codes(problemsAt(world, 'steel-shelving', 1000, 1000, 0, 'hf-canal-20', 1))).toEqual([]);
  });
});

describe('moving, removing and the end of the lease', () => {
  it('a move is a paid rigging job; removal is free and a later reinstallation is charged', () => {
    const world = leasedWorld();
    const [bench = ''] = buy(world, 'steel-workbench');
    accept(world, 'equipment.install', placement(bench, 0, 0));
    let cash = cashOf(world);
    accept(world, 'equipment.move', placement(bench, 500, 1000, 0));
    expect(cashOf(world)).toBe(cash - 4000n);
    expect(world.journal.entries.at(-1)?.facts[0]).toMatchObject({
      type: 'equipment.moved',
      data: { equipmentId: bench, xMm: 500, yMm: 1000, chargedCents: '4000' },
    });
    const rigging = world.state.company?.ledger.accounts.find((account) => account.code === '6200');
    expect(rigging).toMatchObject({ type: 'expense', balanceCents: 4000n });
    cash = cashOf(world);
    accept(world, 'equipment.uninstall', { equipmentId: bench });
    expect(cashOf(world)).toBe(cash);
    expect(facilitiesOf(world).equipment[0]?.placement).toBeNull();
    accept(world, 'equipment.install', placement(bench, 0, 0));
    expect(cashOf(world)).toBe(cash - 4000n);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('when the lease ends the dealers take the equipment away', () => {
    const world = leasedWorld('hf-canal-2', { termMonths: 1 });
    const [bench = ''] = buy(world, 'steel-workbench');
    accept(world, 'equipment.install', placement(bench, 0, 0));
    world.advanceTo(40n * MS_PER_DAY);
    expect(world.state.realEstate?.leases[0]?.status).toBe('ended');
    expect(facilitiesOf(world).equipment[0]?.placement).toBeNull();
    const facts = world.journal.entries.flatMap((entry) => entry.facts.map((fact) => fact.type));
    expect(facts).toContain('equipment.removedAtLeaseEnd');
    expect(refusal(world, 'equipment.install', placement(bench, 0, 0))).toBe(
      'Layout Works does not occupy 2 Canal Street (rear)',
    );
    expect(world.checkInvariants()).toEqual([]);
  });

  it('refuses premises the company does not hold', () => {
    const world = leasedWorld();
    const [bench = ''] = buy(world, 'steel-workbench');
    expect(refusal(world, 'equipment.install', placement(bench, 0, 0, 0, 'hf-canal-8'))).toBe(
      'Layout Works does not occupy 8 Canal Street',
    );
  });
});

describe('floor coverings and equipment are independent layers', () => {
  it('installing, moving and removing equipment leaves every covering unchanged', () => {
    const world = withCoverings(leasedWorld(), [
      { level: 0, col: 0, row: 0, materialId: 'epoxy-grey' },
      { level: 0, col: 1, row: 0, materialId: 'epoxy-grey' },
      { level: 0, col: 5, row: 11, materialId: 'steel-plate' },
    ]);
    expect(world.checkInvariants()).toEqual([]);
    const coverings = facilitiesOf(world).coverings;
    const slab = world.state.realEstate?.properties.find(
      (p) => p.id === 'hf-canal-2',
    )?.floorLoadKgPerM2;
    const [bench = ''] = buy(world, 'steel-workbench');
    accept(world, 'equipment.install', placement(bench, 0, 0));
    expect(facilitiesOf(world).coverings).toEqual(coverings);
    accept(world, 'equipment.move', placement(bench, 1000, 1000));
    expect(facilitiesOf(world).coverings).toEqual(coverings);
    accept(world, 'equipment.uninstall', { equipmentId: bench });
    expect(facilitiesOf(world).coverings).toEqual(coverings);
    // No covering changes the slab's rating.
    expect(
      world.state.realEstate?.properties.find((p) => p.id === 'hf-canal-2')?.floorLoadKgPerM2,
    ).toBe(slab);
  });

  it('a covering on a cell outside the usable floor, or of an unknown material, breaks the invariants', () => {
    expect(() =>
      injectCoverings(leasedWorld(), [{ level: 0, col: 6, row: 0, materialId: 'epoxy-grey' }]),
    ).toThrow(/not an eligible cell/);
    expect(() =>
      injectCoverings(leasedWorld(), [{ level: 0, col: 0, row: 0, materialId: 'gold-leaf' }]),
    ).toThrow(/unknown material gold-leaf/);
  });
});

describe('commands are atomic', () => {
  it('a refused install stages nothing (IDs, books, facts)', () => {
    const world = leasedWorld();
    const [bench = ''] = buy(world, 'steel-workbench');
    accept(world, 'equipment.install', placement(bench, 0, 0));
    const before = world.fingerprint();
    const result = submit(world, 'equipment.move', placement(bench, 0, 4500));
    expect(result.ok).toBe(false);
    expect(world.fingerprint()).toEqual(before);
  });
});
