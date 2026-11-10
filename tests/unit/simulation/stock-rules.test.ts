import { ACCOUNT } from '../../../src/domain/ledger';
import { floorFootprint, indexStock } from '../../../src/domain/stock';
import { receivingAreas, type FloorSite } from '../../../src/domain/stock-floor';
import { siteOf } from '../../../src/domain/stock-operations';
import { FREEINDUSTRY_RULES } from '../../../src/simulation/freeindustry-rules';
import { SimulationKernel } from '../../../src/simulation/kernel';
import { answerQuery } from '../../../src/worker/facility-view';
import { MS_PER_DAY } from '../../../src/domain/time';
import {
  accept,
  buy,
  facilitiesOf,
  leasedWorld,
  placement,
  refusal,
  submit,
} from '../../support/facility-world';
import { estateWorld } from '../../support/real-estate-world';
import { testUuid } from '../../support/toy-workshop';
import {
  balance,
  deliver,
  deliveryRefusal,
  FACTORY,
  lotOf,
  MOTORS_ON_A_PALLET,
  PAINT_IN_A_DRUM,
  SCREWS_ON_A_PALLET,
  stockOf,
  stockWorld,
  WORKSHOP,
} from '../../support/stock-world';

/**
 * Step 10 stock through the kernel (ADR-0054, ADR-0055): the development
 * test delivery and the player's scrap classification, with every refusal
 * leaving the world exactly as it was.
 */

function factorySite(world: ReturnType<typeof stockWorld>): FloorSite {
  const realEstate = world.state.realEstate;
  const site = realEstate && siteOf(facilitiesOf(world), realEstate, FACTORY);
  if (!site) {
    throw new Error('no factory site');
  }
  return site;
}

describe('a test delivery', () => {
  it('arrives through a goods door: four cartons on a pallet, one lot each, paid to Inventory', () => {
    const world = stockWorld();
    const cashBefore = balance(world, ACCOUNT.cash);
    deliver(world);
    const stock = stockOf(world);
    expect(stock.receipts).toHaveLength(1);
    const [receipt] = stock.receipts;
    expect(receipt).toMatchObject({
      kind: 'diagnostic',
      productId: 'wood-screw-8-1-25',
      quantityMicro: 800_000_000n,
      costCents: 4160n,
    });
    // One pallet on the floor carrying four cartons, each holding exactly one lot of 200.
    const index = indexStock(stock);
    const pallet = stock.loadUnits.find((unit) => unit.typeId === 'gma-pallet');
    expect(pallet?.location.kind).toBe('floor');
    const cartons = stock.loadUnits.filter((unit) => unit.typeId === 'carton-24x16x16');
    expect(cartons).toHaveLength(4);
    expect(
      cartons.every(
        (unit) => unit.location.kind === 'load-unit' && unit.location.loadUnitId === pallet?.id,
      ),
    ).toBe(true);
    expect(stock.lots.map((lot) => [lot.quantityMicro, lot.costCents])).toEqual([
      [200_000_000n, 1040n],
      [200_000_000n, 1040n],
      [200_000_000n, 1040n],
      [200_000_000n, 1040n],
    ]);
    for (const carton of cartons) {
      expect(index.lotsIn.get(carton.id)).toHaveLength(1);
    }
    // The books: cash down by exactly the cost, Inventory up by it, the supplier paid.
    expect(balance(world, ACCOUNT.cash)).toBe(cashBefore - 4160n);
    expect(balance(world, ACCOUNT.inventory)).toBe(4160n);
    const invoice = world.state.company?.invoices.find((item) => item.id === receipt?.invoiceId);
    expect(invoice).toMatchObject({ direction: 'payable', totalCents: 4160n, paidCents: 4160n });
    expect(world.checkInvariants()).toEqual([]);
  });

  it('stands entirely on the landing inside a goods door, never at the personnel door', () => {
    const world = stockWorld();
    deliver(world);
    deliver(world, MOTORS_ON_A_PALLET);
    const property = world.state.realEstate?.properties.find((item) => item.id === FACTORY);
    const site = factorySite(world);
    const landings = receivingAreas(site);
    expect(landings.map((area) => property?.doors[area.doorIndex]?.kind)).toEqual([
      'loading-dock',
      'loading-dock',
      'roller-shutter',
    ]);
    const types = new Map(stockOf(world).containerTypes.map((type) => [type.id, type]));
    for (const unit of stockOf(world).loadUnits) {
      if (unit.location.kind !== 'floor') {
        continue;
      }
      const type = types.get(unit.typeId);
      const rect = type ? floorFootprint(type, unit.location) : null;
      expect(
        rect &&
          landings.some(
            (area) =>
              rect.x >= area.rect.x &&
              rect.y >= area.rect.y &&
              rect.x + rect.width <= area.rect.x + area.rect.width &&
              rect.y + rect.depth <= area.rect.y + area.rect.depth,
          ),
      ).toBe(true);
    }
  });

  it('gives serialized goods a serial for every item, and liquids a drum of their own', () => {
    const world = stockWorld();
    deliver(world, MOTORS_ON_A_PALLET);
    deliver(world, PAINT_IN_A_DRUM);
    const [motors, paint] = stockOf(world).lots;
    expect(motors?.serials).toHaveLength(6);
    expect(new Set(motors?.serials).size).toBe(6);
    expect(paint?.quantityMicro).toBe(200_000_000n);
    expect(paint?.serials).toEqual([]);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('shares the cost across the lots to the cent, the first lots taking the odd cents', () => {
    const world = stockWorld();
    deliver(world, { totalCostCents: '1001' });
    expect(stockOf(world).lots.map((lot) => lot.costCents)).toEqual([251n, 250n, 250n, 250n]);
    expect(balance(world, ACCOUNT.inventory)).toBe(1001n);
  });

  it('is charged once when the same command is sent twice', () => {
    const world = stockWorld();
    const command = {
      commandId: testUuid(777_001),
      expectedWorldRevision: world.worldRevision,
      type: 'diagnostics.deliverTestStock',
      payload: SCREWS_ON_A_PALLET,
    };
    expect(world.submit(command).ok).toBe(true);
    const again = world.submit(command);
    expect(again.ok && again.receipt.duplicate).toBe(true);
    expect(stockOf(world).receipts).toHaveLength(1);
    expect(balance(world, ACCOUNT.inventory)).toBe(4160n);
  });

  describe('is refused with nothing changed', () => {
    const cases: [
      string,
      () => ReturnType<typeof stockWorld>,
      Parameters<typeof deliveryRefusal>[1],
      string,
    ][] = [
      [
        'a part of an item',
        stockWorld,
        { quantityPerContainerMicro: '2500000' },
        'is not a quantity of Wood screws',
      ],
      [
        'half a gram of pellets',
        stockWorld,
        {
          productId: 'hdpe-pellets',
          containerTypeId: 'bulk-bag-1t',
          palletTypeId: null,
          containersPerPallet: null,
          containers: 1,
          quantityPerContainerMicro: '25000500',
        },
        'is not a quantity of HDPE pellets',
      ],
      [
        'a carton overloaded',
        stockWorld,
        { quantityPerContainerMicro: '12000000000' },
        'would carry 31.2 kg; it is rated for 30 kg',
      ],
      [
        'a liquid in a carton',
        stockWorld,
        { productId: 'enamel-machine-grey', quantityPerContainerMicro: '1000000' },
        'cannot hold liquids',
      ],
      [
        'plywood on a 48 × 40 pallet',
        stockWorld,
        {
          productId: 'birch-plywood-18mm',
          containerTypeId: 'gma-pallet',
          palletTypeId: null,
          containersPerPallet: null,
          containers: 1,
          quantityPerContainerMicro: '10000000',
        },
        'does not fit',
      ],
      [
        'a pallet on a pallet',
        stockWorld,
        { containerTypeId: 'gma-pallet', quantityPerContainerMicro: '1000000' },
        'Pallets are not delivered on pallets',
      ],
      [
        'an unknown product',
        stockWorld,
        { productId: 'gold-bars' },
        'There is no product gold-bars',
      ],
      ['an unknown grade', stockWorld, { grade: 'luxury' }, 'has no grade luxury'],
      [
        'more than the company can pay',
        () => leasedWorld(WORKSHOP, { capitalCents: '300000' }),
        { totalCostCents: '9000000' },
        'Insufficient funds',
      ],
    ];
    it.each(cases)('%s', (_name, make, delivery, message) => {
      const world = make();
      const before = world.fingerprint();
      expect(deliveryRefusal(world, delivery)).toContain(message);
      expect(world.fingerprint()).toEqual(before);
    });

    it('when the receiving area is full: the garage takes one pallet, then no more', () => {
      const world = leasedWorld('hf-canal-2');
      deliver(world, MOTORS_ON_A_PALLET);
      const before = world.fingerprint();
      expect(deliveryRefusal(world, MOTORS_ON_A_PALLET)).toContain(
        'There is no room for a Wooden pallet, 48 × 40 in',
      );
      expect(world.fingerprint()).toEqual(before);
      // Two pallets at once: room for the first only, so neither is delivered.
      const fresh = leasedWorld('hf-canal-2');
      const empty = fresh.fingerprint();
      expect(deliveryRefusal(fresh, { containers: 8 })).toContain(
        'have room for 1 of the 2 load units',
      );
      expect(fresh.fingerprint()).toEqual(empty);
    });

    it('when the company has no premises, or the world has no stock records', () => {
      const world = estateWorld();
      accept(world, 'company.found', {
        legalName: 'No Premises',
        presidentName: 'Pat Nowhere',
        startingCapitalCents: '5000000',
      });
      const before = world.fingerprint();
      expect(deliveryRefusal(world, {})).toContain('has no premises to deliver to');
      expect(world.fingerprint()).toEqual(before);
    });
  });
});

describe('classifying stock as scrap', () => {
  it('splits off the scrapped part in place and writes its cost down to nothing', () => {
    const world = stockWorld();
    deliver(world);
    const carton = lotOf(world, 'lot:1').loadUnitId;
    accept(world, 'stock.scrap', {
      lotId: 'lot:1',
      quantityMicro: '50000000',
      serials: null,
      reason: 'damaged',
    });
    const parent = lotOf(world, 'lot:1');
    const scrap = lotOf(world, 'lot:5');
    expect(parent).toMatchObject({
      quantityMicro: 150_000_000n,
      costCents: 780n,
      disposition: 'available',
    });
    expect(scrap).toMatchObject({
      quantityMicro: 50_000_000n,
      costCents: 0n,
      disposition: 'scrap',
      loadUnitId: carton,
      parentLotIds: ['lot:1'],
      origin: { kind: 'split' },
    });
    // Nothing moved; the cost written down is posted on its own account.
    expect(balance(world, ACCOUNT.inventory)).toBe(4160n - 260n);
    expect(balance(world, ACCOUNT.inventoryScrapped)).toBe(260n);
    const movement = stockOf(world).movements.at(-1);
    expect(movement).toMatchObject({
      kind: 'scrap',
      reason: 'damaged',
      costCents: 260n,
      handler: { kind: 'company' },
    });
    expect(world.checkInvariants()).toEqual([]);
  });

  it('scraps a whole lot as itself, and a liquid only whole', () => {
    const world = stockWorld();
    deliver(world, PAINT_IN_A_DRUM);
    const before = world.fingerprint();
    expect(
      refusal(world, 'stock.scrap', {
        lotId: 'lot:1',
        quantityMicro: '1000000',
        serials: null,
        reason: 'contaminated',
      }),
    ).toContain('scrap the whole lot');
    expect(world.fingerprint()).toEqual(before);
    accept(world, 'stock.scrap', {
      lotId: 'lot:1',
      quantityMicro: '200000000',
      serials: null,
      reason: 'contaminated',
    });
    expect(lotOf(world, 'lot:1')).toMatchObject({
      disposition: 'scrap',
      costCents: 0n,
      quantityMicro: 200_000_000n,
    });
    expect(stockOf(world).lots).toHaveLength(1);
    expect(balance(world, ACCOUNT.inventory)).toBe(0n);
    expect(balance(world, ACCOUNT.inventoryScrapped)).toBe(110_000n);
    expect(
      refusal(world, 'stock.scrap', {
        lotId: 'lot:1',
        quantityMicro: '200000000',
        serials: null,
        reason: 'damaged',
      }),
    ).toContain('already scrap');
  });

  it('names the serials of the motors scrapped, by default the lowest', () => {
    const world = stockWorld();
    deliver(world, MOTORS_ON_A_PALLET);
    const serials = lotOf(world, 'lot:1').serials;
    accept(world, 'stock.scrap', {
      lotId: 'lot:1',
      quantityMicro: '2000000',
      serials: [serials[4], serials[5]],
      reason: 'defective',
    });
    expect(lotOf(world, 'lot:2').serials).toEqual([serials[4], serials[5]]);
    expect(lotOf(world, 'lot:1').serials).toEqual(serials.slice(0, 4));
    accept(world, 'stock.scrap', {
      lotId: 'lot:1',
      quantityMicro: '1000000',
      serials: null,
      reason: 'defective',
    });
    expect(lotOf(world, 'lot:3').serials).toEqual([serials[0]]);
    expect(
      refusal(world, 'stock.scrap', {
        lotId: 'lot:1',
        quantityMicro: '1000000',
        serials: [serials[5] ?? ''],
        reason: 'damaged',
      }),
    ).toContain('distinct serials held in lot lot:1');
  });

  it('refuses more than the lot holds, part of an item, and a lot that does not exist', () => {
    const world = stockWorld();
    deliver(world);
    const before = world.fingerprint();
    expect(
      refusal(world, 'stock.scrap', {
        lotId: 'lot:1',
        quantityMicro: '300000000',
        serials: null,
        reason: 'damaged',
      }),
    ).toContain('holds 200 each');
    expect(
      refusal(world, 'stock.scrap', {
        lotId: 'lot:1',
        quantityMicro: '500000',
        serials: null,
        reason: 'damaged',
      }),
    ).toContain('not a whole number of items');
    expect(
      refusal(world, 'stock.scrap', {
        lotId: 'lot:99',
        quantityMicro: '1000000',
        serials: null,
        reason: 'damaged',
      }),
    ).toContain('There is no lot lot:99');
    expect(world.fingerprint()).toEqual(before);
  });
});

describe('stock on the floor is in the way of equipment', () => {
  it('refuses a machine on a pallet and shows the overlap in the placement preview', () => {
    const world = stockWorld();
    deliver(world, MOTORS_ON_A_PALLET);
    const pallet = stockOf(world).loadUnits[0];
    if (pallet?.location.kind !== 'floor') {
      throw new Error('the pallet is not on the floor');
    }
    const [bench = ''] = buy(world, 'steel-workbench');
    // A pallet stands on a dock apron; the apron is kept clear of equipment anyway, so place
    // the bench just inside the apron's edge, overlapping the pallet from inside the hall.
    const site = factorySite(world);
    const apron = receivingAreas(site)[0]?.rect;
    expect(apron).toBeDefined();
    const before = world.fingerprint();
    const at = placement(bench, pallet.location.xMm, pallet.location.yMm, 0, FACTORY);
    const message = refusal(world, 'equipment.install', at);
    expect(message).toMatch(/clear landing|stand on the Wooden pallet/);
    expect(world.fingerprint()).toEqual(before);
    const verdict = answerQuery(
      { kind: 'placement', equipmentTypeId: 'steel-workbench', ...at },
      world.state.facilities,
      world.state.realEstate,
      world.state.company,
      { nowMs: world.nowMs, epoch: world.config.epoch, stock: world.state.stock },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.problems.some((problem) => problem.code === 'stock')).toBe(true);
  });
});

describe('worlds without stock records', () => {
  it('refuse stock commands with the reason, and keep their fingerprints', () => {
    const world = leasedWorld(WORKSHOP);
    const legacy = injectNoStock(world);
    const before = legacy.fingerprint();
    const result = submit(legacy, 'diagnostics.deliverTestStock', SCREWS_ON_A_PALLET);
    expect(result.ok ? '' : result.error.message).toContain(
      'created before physical stock existed',
    );
    expect(legacy.fingerprint()).toEqual(before);
  });
});

describe('the lease ends', () => {
  it('leaves the stock where it stands, still owned, on premises the company no longer holds', () => {
    const world = leasedWorld(WORKSHOP, { termMonths: 12 });
    deliver(world, MOTORS_ON_A_PALLET);
    world.advanceTo(400n * MS_PER_DAY);
    expect(world.state.realEstate?.leases[0]?.status).toBe('ended');
    expect(stockOf(world).loadUnits[0]?.location).toMatchObject({
      kind: 'floor',
      propertyId: WORKSHOP,
    });
    expect(balance(world, ACCOUNT.inventory)).toBe(54_000n);
    expect(world.checkInvariants()).toEqual([]);
  });
});

/** The same world as if it had been made before Step 10: no stock slice at all. */
function injectNoStock(world: ReturnType<typeof leasedWorld>) {
  const checkpoint = world.checkpoint();
  return SimulationKernel.restore(FREEINDUSTRY_RULES, {
    state: {
      ...checkpoint.state,
      domain: FREEINDUSTRY_RULES.encodeState({ ...world.state, stock: null }),
    },
    journal: checkpoint.journal,
  });
}
