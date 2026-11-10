import type { Company } from '../../../src/domain/company';
import type { Facilities } from '../../../src/domain/facilities';
import { formatEntityId, type AllocateId } from '../../../src/domain/ids';
import { ACCOUNT, balanceOf } from '../../../src/domain/ledger';
import type { RealEstate } from '../../../src/domain/real-estate';
import { Rejection } from '../../../src/domain/rejection';
import {
  floorFootprint,
  indexStock,
  type LoadUnit,
  type Stock,
  type StockHandler,
} from '../../../src/domain/stock';
import { levelGeometry } from '../../../src/domain/facility';
import {
  findReceivingSpot,
  floorPlacementProblems,
  receivingAreas,
} from '../../../src/domain/stock-floor';
import { stockProblems } from '../../../src/domain/stock-invariants';
import {
  floorObstacles,
  loseStock,
  mergeLots,
  relocateLoadUnit,
  releaseReservation,
  reserveStock,
  siteOf,
  splitLot,
  transferStock,
  TRANSFER_REACH_MM,
} from '../../../src/domain/stock-operations';
import { historyOf, lineageOf, stockTake } from '../../../src/domain/stock-records';
import { facilitiesOf } from '../../support/facility-world';
import {
  deliver,
  FACTORY,
  injectStock,
  MOTORS_ON_A_PALLET,
  PAINT_IN_A_DRUM,
  stockOf,
  stockWorld,
  WORKSHOP,
} from '../../support/stock-world';

/**
 * Step 10 stock operations (ADR-0054): every one atomic, conserving and
 * recorded, refused with the reason and nothing changed when a rule fails;
 * and the invariants that refuse impossible stock.
 */

const NO_UNIT = formatEntityId('load-unit', 999);
const WORKER: StockHandler = { kind: 'employee', personId: formatEntityId('person', 9) };

/** The world's slices and a rule context whose IDs cannot collide with the kernel's. */
function parts(world: ReturnType<typeof stockWorld>) {
  const counters = new Map<string, number>();
  const allocateId: AllocateId = (kind) => {
    const next = (counters.get(kind) ?? 1000) + 1;
    counters.set(kind, next);
    return formatEntityId(kind, next);
  };
  const { company, realEstate } = world.state;
  if (!company || !realEstate) {
    throw new Error('no company or real estate');
  }
  return {
    stock: stockOf(world),
    facilities: facilitiesOf(world),
    realEstate,
    company,
    context: { nowMs: world.nowMs, allocateId },
  };
}

function settled<T>(result: T | Rejection): T {
  if (result instanceof Rejection) {
    throw new Error(result.reason);
  }
  return result;
}

function refused(result: unknown): string {
  if (!(result instanceof Rejection)) {
    throw new Error('expected a refusal');
  }
  return result.reason;
}

function consistent(
  stock: Stock,
  facilities: Facilities,
  realEstate: RealEstate,
  company: Company,
) {
  expect(stockProblems(stock, facilities, realEstate, company)).toEqual([]);
}

const unitOf = (stock: Stock, id: string): LoadUnit => {
  const unit = indexStock(stock).units.get(id);
  if (!unit) {
    throw new Error(`no ${id}`);
  }
  return unit;
};

describe('transfers', () => {
  it('move a whole lot as itself between cartons on one pallet', () => {
    const world = stockWorld();
    deliver(world);
    const { stock, facilities, realEstate, company, context } = parts(world);
    const [first, second] = stock.lots;
    const moved = settled(
      transferStock(
        stock,
        facilities,
        realEstate,
        {
          lotId: first?.id ?? '',
          quantityMicro: 200_000_000n,
          toLoadUnitId: second?.loadUnitId ?? '',
          handler: WORKER,
        },
        context,
      ),
    );
    const index = indexStock(moved.stock);
    expect(index.lots.get(first?.id ?? '')?.loadUnitId).toBe(second?.loadUnitId);
    expect(index.lotsIn.get(first?.loadUnitId ?? '')).toBeUndefined();
    expect(moved.stock.movements.at(-1)).toMatchObject({
      kind: 'transfer',
      handler: WORKER,
      lines: [
        {
          lotId: first?.id,
          fromLoadUnitId: first?.loadUnitId,
          toLoadUnitId: second?.loadUnitId,
          resultLotId: null,
        },
      ],
    });
    consistent(moved.stock, facilities, realEstate, company);
  });

  it('split a part off into a child lot that takes its share of the cost and its serials', () => {
    const world = stockWorld();
    deliver(world, MOTORS_ON_A_PALLET);
    deliver(world, MOTORS_ON_A_PALLET);
    const { stock, facilities, realEstate, company, context } = parts(world);
    const [a, b] = stock.lots;
    // The two pallets stand side by side on the first dock's apron, within reach.
    const moved = settled(
      transferStock(
        stock,
        facilities,
        realEstate,
        {
          lotId: a?.id ?? '',
          quantityMicro: 2_000_000n,
          toLoadUnitId: b?.loadUnitId ?? '',
          handler: WORKER,
        },
        context,
      ),
    );
    const index = indexStock(moved.stock);
    const child = moved.stock.lots.at(-1);
    expect(child).toMatchObject({
      quantityMicro: 2_000_000n,
      costCents: 18_000n,
      loadUnitId: b?.loadUnitId,
      parentLotIds: [a?.id],
      serials: a?.serials.slice(0, 2),
    });
    expect(index.lots.get(a?.id ?? '')).toMatchObject({
      quantityMicro: 4_000_000n,
      costCents: 36_000n,
    });
    expect(lineageOf(index, child?.id ?? '').map((lot) => lot.id)).toEqual([child?.id, a?.id]);
    consistent(moved.stock, facilities, realEstate, company);
  });

  it('refuse load units further apart than one person can reach', () => {
    const world = stockWorld();
    deliver(world, MOTORS_ON_A_PALLET);
    deliver(world, MOTORS_ON_A_PALLET);
    const { stock: delivered, facilities, realEstate, company, context } = parts(world);
    const [a, c] = delivered.lots;
    // Carry the second pallet out into the hall, metres from the first.
    const { stock } = settled(
      relocateLoadUnit(
        delivered,
        facilities,
        realEstate,
        company,
        {
          loadUnitId: c?.loadUnitId ?? '',
          to: {
            kind: 'floor',
            propertyId: FACTORY,
            level: 0,
            xMm: 12_300,
            yMm: 12_300,
            rotation: 0,
          },
          handler: WORKER,
        },
        context,
      ),
    );
    expect(
      refused(
        transferStock(
          stock,
          facilities,
          realEstate,
          {
            lotId: a?.id ?? '',
            quantityMicro: 1_000_000n,
            toLoadUnitId: c?.loadUnitId ?? '',
            handler: WORKER,
          },
          context,
        ),
      ),
    ).toContain(`not within ${TRANSFER_REACH_MM} mm of each other; the stock must be carried`);
  });

  it('refuse reserved stock, an overload, and pouring one lot of a liquid into another', () => {
    const world = stockWorld();
    deliver(world);
    deliver(world, PAINT_IN_A_DRUM);
    deliver(world, PAINT_IN_A_DRUM);
    const { stock, facilities, realEstate, context } = parts(world);
    const [screws, other] = stock.lots;
    const reserved = settled(
      reserveStock(
        stock,
        { lotId: screws?.id ?? '', quantityMicro: 150_000_000n, purpose: 'task:1' },
        context,
      ),
    );
    expect(
      refused(
        transferStock(
          reserved.stock,
          facilities,
          realEstate,
          {
            lotId: screws?.id ?? '',
            quantityMicro: 100_000_000n,
            toLoadUnitId: other?.loadUnitId ?? '',
            handler: WORKER,
          },
          context,
        ),
      ),
    ).toContain('Only 50 each of lot');
    // The reservation itself can move, and it follows its goods into the child lot.
    const moved = settled(
      transferStock(
        reserved.stock,
        facilities,
        realEstate,
        {
          lotId: screws?.id ?? '',
          quantityMicro: 150_000_000n,
          reservationId: reserved.reservationId,
          toLoadUnitId: other?.loadUnitId ?? '',
          handler: WORKER,
        },
        context,
      ),
    );
    const child = moved.stock.lots.at(-1);
    expect(moved.stock.reservations).toEqual([
      expect.objectContaining({
        id: reserved.reservationId,
        lotId: child?.id,
        quantityMicro: 150_000_000n,
      }),
    ]);
    const paints = stock.lots.filter((lot) => lot.productId === 'enamel-machine-grey');
    const blend = transferStock(
      stock,
      facilities,
      realEstate,
      {
        lotId: paints[0]?.id ?? '',
        quantityMicro: 1_000_000n,
        toLoadUnitId: paints[1]?.loadUnitId ?? '',
        handler: WORKER,
      },
      context,
    );
    expect(refused(blend)).toMatch(/only one lot|not within/);
  });
});

describe('capacity on transfer', () => {
  it('refuses filling a 30 kg carton with 31.2 kg of screws', () => {
    const world = stockWorld();
    deliver(world, {
      containers: 2,
      containersPerPallet: 2,
      quantityPerContainerMicro: '6000000000',
    });
    const { stock, facilities, realEstate, context } = parts(world);
    const [a, b] = stock.lots;
    expect(
      refused(
        transferStock(
          stock,
          facilities,
          realEstate,
          {
            lotId: a?.id ?? '',
            quantityMicro: 6_000_000_000n,
            toLoadUnitId: b?.loadUnitId ?? '',
            handler: WORKER,
          },
          context,
        ),
      ),
    ).toContain('would carry 31.2 kg; it is rated for 30 kg');
  });
});

describe('splitting and merging in place', () => {
  it('splits items into counted lots and merges them back into one with both as parents', () => {
    const world = stockWorld();
    deliver(world, MOTORS_ON_A_PALLET);
    const { stock, facilities, realEstate, company, context } = parts(world);
    const original = stock.lots[0];
    const split = settled(
      splitLot(
        stock,
        { lotId: original?.id ?? '', quantityMicro: 2_000_000n, handler: WORKER },
        context,
      ),
    );
    consistent(split.stock, facilities, realEstate, company);
    const merged = settled(
      mergeLots(
        split.stock,
        { lotIds: [split.lotId, original?.id ?? ''], handler: WORKER },
        context,
      ),
    );
    const index = indexStock(merged.stock);
    const lot = index.lots.get(merged.lotId);
    expect(lot).toMatchObject({
      quantityMicro: 6_000_000n,
      costCents: 54_000n,
      origin: { kind: 'merge' },
      parentLotIds: [original?.id, split.lotId],
      serials: original?.serials,
    });
    expect(index.lots.get(original?.id ?? '')?.closed).toMatchObject({
      reason: 'merged',
      intoLotId: merged.lotId,
    });
    expect(lineageOf(index, merged.lotId).map((item) => item.id)).toEqual([
      merged.lotId,
      original?.id,
      split.lotId,
    ]);
    consistent(merged.stock, facilities, realEstate, company);
  });

  it('refuses splitting a liquid in its drum, splitting off everything, and merging unlike lots', () => {
    const world = stockWorld();
    deliver(world, PAINT_IN_A_DRUM);
    deliver(world);
    const { stock, context } = parts(world);
    const [paint, screws] = stock.lots;
    expect(
      refused(
        splitLot(
          stock,
          { lotId: paint?.id ?? '', quantityMicro: 1_000_000n, handler: WORKER },
          context,
        ),
      ),
    ).toContain('cannot be split off in the same container');
    expect(
      refused(
        splitLot(
          stock,
          { lotId: screws?.id ?? '', quantityMicro: 200_000_000n, handler: WORKER },
          context,
        ),
      ),
    ).toContain('this is all of it');
    expect(
      refused(
        mergeLots(stock, { lotIds: [paint?.id ?? '', screws?.id ?? ''], handler: WORKER }, context),
      ),
    ).toContain('same product, grade and disposition in the same load unit');
    expect(
      refused(mergeLots(stock, { lotIds: [screws?.id ?? ''], handler: WORKER }, context)),
    ).toContain('two or more');
  });
});

describe('relocating a load unit', () => {
  it('takes a carton off its pallet and stands it on open floor, with its lot', () => {
    const world = stockWorld();
    deliver(world);
    const { stock, facilities, realEstate, company, context } = parts(world);
    const carton = stock.loadUnits.find((unit) => unit.typeId === 'carton-24x16x16');
    const moved = settled(
      relocateLoadUnit(
        stock,
        facilities,
        realEstate,
        company,
        {
          loadUnitId: carton?.id ?? '',
          to: {
            kind: 'floor',
            propertyId: FACTORY,
            level: 0,
            xMm: 12_300,
            yMm: 12_300,
            rotation: 0,
          },
          handler: WORKER,
        },
        context,
      ),
    );
    expect(unitOf(moved.stock, carton?.id ?? '').location).toMatchObject({
      kind: 'floor',
      xMm: 12_300,
    });
    expect(stockTake(moved.stock).every((line) => line.countedMicro === line.recordedMicro)).toBe(
      true,
    );
    expect(
      historyOf(moved.stock, { loadUnitId: carton?.id ?? '', lotIds: [] }).map(
        (entry) => entry.kind,
      ),
    ).toEqual(['receipt', 'relocation']);
    consistent(moved.stock, facilities, realEstate, company);
  });

  it('refuses a unit inside itself, a carrier that cannot carry it, and a floor spot that breaks a rule', () => {
    const world = stockWorld();
    deliver(world);
    deliver(world, PAINT_IN_A_DRUM);
    const { stock, facilities, realEstate, company, context } = parts(world);
    const drum = stock.loadUnits.find((unit) => unit.typeId === 'steel-drum-55gal');
    const pallet = stock.loadUnits.find((unit) => unit.typeId === 'gma-pallet');
    const carton = stock.loadUnits.find((unit) => unit.typeId === 'carton-24x16x16');
    const move = (to: Parameters<typeof relocateLoadUnit>[4]['to'], id = pallet?.id ?? '') =>
      relocateLoadUnit(
        stock,
        facilities,
        realEstate,
        company,
        { loadUnitId: id, to, handler: WORKER },
        context,
      );
    expect(refused(move({ kind: 'load-unit', loadUnitId: carton?.id ?? NO_UNIT }))).toContain(
      'cannot be put inside itself',
    );
    expect(
      refused(move({ kind: 'load-unit', loadUnitId: drum?.id ?? NO_UNIT }, carton?.id ?? '')),
    ).toContain('cannot carry a Corrugated carton');
    expect(
      refused(
        move({ kind: 'floor', propertyId: FACTORY, level: 0, xMm: 999_000, yMm: 0, rotation: 0 }),
      ),
    ).toContain('outside the walls');
    // The personnel door's landing is kept clear for people.
    const site = siteOf(facilities, realEstate, FACTORY);
    const ground = site?.building.levels[0];
    const entrance =
      site &&
      ground &&
      levelGeometry(site.building, site.property, ground).keepClear.find((zone) => zone.entrance);
    expect(entrance).toBeDefined();
    expect(
      refused(
        move({
          kind: 'floor',
          propertyId: FACTORY,
          level: 0,
          xMm: entrance?.rect.x ?? 0,
          yMm: entrance?.rect.y ?? 0,
          rotation: 0,
        }),
      ),
    ).toContain('would block the clear landing at the personnel door');
    expect(
      refused(move({ kind: 'floor', propertyId: WORKSHOP, level: 0, xMm: 0, yMm: 0, rotation: 0 })),
    ).toContain('does not occupy');
  });
});

describe('losses', () => {
  it('reduce or close a lot for a recorded cause and write its cost off on its own account', () => {
    const world = stockWorld();
    deliver(world, MOTORS_ON_A_PALLET);
    const { stock, facilities, realEstate, company, context } = parts(world);
    const lot = stock.lots[0];
    const part = settled(
      loseStock(
        stock,
        company,
        { lotId: lot?.id ?? '', quantityMicro: 1_000_000n, reason: 'destroyed', handler: WORKER },
        context,
      ),
    );
    expect(part.costCents).toBe(9_000n);
    expect(balanceOf(part.company.ledger, ACCOUNT.inventoryLosses)).toBe(9_000n);
    expect(balanceOf(part.company.ledger, ACCOUNT.inventory)).toBe(45_000n);
    consistent(part.stock, facilities, realEstate, part.company);
    const all = settled(
      loseStock(
        part.stock,
        part.company,
        { lotId: lot?.id ?? '', quantityMicro: 5_000_000n, reason: 'missing', handler: WORKER },
        context,
      ),
    );
    expect(indexStock(all.stock).lots.get(lot?.id ?? '')).toMatchObject({
      quantityMicro: 0n,
      loadUnitId: null,
      serials: [],
      closed: { reason: 'lost' },
    });
    expect(balanceOf(all.company.ledger, ACCOUNT.inventory)).toBe(0n);
    consistent(all.stock, facilities, realEstate, all.company);
  });
});

describe('reservations', () => {
  it('hold back a quantity until released', () => {
    const world = stockWorld();
    deliver(world);
    const { stock, context } = parts(world);
    const held = settled(
      reserveStock(
        stock,
        { lotId: 'lot:1', quantityMicro: 200_000_000n, purpose: 'order:1' },
        context,
      ),
    );
    expect(
      refused(
        reserveStock(
          held.stock,
          { lotId: 'lot:1', quantityMicro: 1_000_000n, purpose: 'order:2' },
          context,
        ),
      ),
    ).toContain('Only 0 each of lot lot:1 is free');
    const released = settled(releaseReservation(held.stock, held.reservationId));
    expect(released.reservations).toEqual([]);
  });
});

describe('receiving areas', () => {
  it('are the landings of the goods doors only, and a building without one cannot receive', () => {
    const world = stockWorld(WORKSHOP);
    const { stock, facilities, realEstate } = parts(world);
    const site = siteOf(facilities, realEstate, WORKSHOP);
    if (!site) {
      throw new Error('no site');
    }
    expect(receivingAreas(site).map((area) => site.property.doors[area.doorIndex]?.kind)).toEqual([
      'roller-shutter',
    ]);
    // The same workshop with its roller shutter bricked up (a copy, so its geometry is derived afresh).
    const doorless = {
      building: { ...site.building },
      property: {
        ...site.property,
        doors: site.property.doors.filter((door) => door.kind === 'personnel'),
      },
    };
    expect(receivingAreas(doorless)).toEqual([]);
    const type = stock.containerTypes.find((item) => item.id === 'gma-pallet');
    if (!type) {
      throw new Error('no pallet');
    }
    expect(
      findReceivingSpot(
        doorless,
        { label: 'a pallet', type, grossMassMg: 21_000_000n },
        { equipment: [], stock: [], works: [] },
      ),
    ).toBeNull();
    // On the real workshop, a spot is found inside the shutter's landing, clear of everything.
    const spot = findReceivingSpot(
      site,
      { label: 'a pallet', type, grossMassMg: 21_000_000n },
      { equipment: [], stock: floorObstacles(stock, WORKSHOP), works: [] },
    );
    expect(spot).not.toBeNull();
    if (spot) {
      expect(
        floorPlacementProblems(
          site,
          { label: 'a pallet', type, grossMassMg: 21_000_000n },
          spot.location,
          { equipment: [], stock: [], works: [] },
        ),
      ).toEqual([]);
      expect(floorFootprint(type, spot.location).width).toBe(1016); // turned to stand two abreast
    }
  });

  it('refuses a load beyond the slab rating, exactly', () => {
    const world = stockWorld();
    const { stock, facilities, realEstate } = parts(world);
    const site = siteOf(facilities, realEstate, FACTORY);
    const type = stock.containerTypes.find((item) => item.id === 'gma-pallet');
    if (!site || !type) {
      throw new Error('no site');
    }
    const rating = BigInt(site.building.levels[0]?.floorLoadKgPerM2 ?? 0);
    const area = 1219n * 1016n;
    const at = {
      kind: 'floor' as const,
      propertyId: FACTORY,
      level: 0,
      xMm: 12_300,
      yMm: 12_300,
      rotation: 0 as const,
    };
    const none = { equipment: [], stock: [], works: [] };
    expect(
      floorPlacementProblems(
        site,
        { label: 'a pallet', type, grossMassMg: rating * area },
        at,
        none,
        { route: false },
      ),
    ).toEqual([]);
    expect(
      floorPlacementProblems(
        site,
        { label: 'a pallet', type, grossMassMg: rating * area + 1n },
        at,
        none,
        { route: false },
      )[0]?.code,
    ).toBe('floor-load');
  });
});

describe('the invariants refuse impossible stock', () => {
  const tamper = (change: (stock: Stock) => Stock) => () => {
    const world = stockWorld();
    deliver(world);
    deliver(world, MOTORS_ON_A_PALLET);
    injectStock(world, change);
  };

  it('stock that materialised: a lot with more than was received', () => {
    expect(
      tamper((stock) => ({
        ...stock,
        lots: stock.lots.map((lot, index) =>
          index === 0 ? { ...lot, quantityMicro: lot.quantityMicro + 1_000_000n } : lot,
        ),
      })),
    ).toThrow(/receipts less losses account for/);
  });

  it('a serial held by two lots', () => {
    expect(
      tamper((stock) => ({
        ...stock,
        lots: stock.lots.map((lot) =>
          lot.productId === 'motor-half-hp'
            ? {
                ...lot,
                // The first serial listed twice, in place of the last.
                serials: lot.serials.map((serial, at) =>
                  at === lot.serials.length - 1 ? (lot.serials[0] ?? serial) : serial,
                ),
              }
            : lot,
        ),
      })),
    ).toThrow(/held twice/);
  });

  it('a lot in a load unit that does not exist', () => {
    expect(
      tamper((stock) => ({
        ...stock,
        lots: stock.lots.map((lot, index) =>
          index === 0 ? { ...lot, loadUnitId: formatEntityId('load-unit', 99) } : lot,
        ),
      })),
    ).toThrow(/is in no load unit/);
  });

  it('a load unit inside itself', () => {
    expect(
      tamper((stock) => ({
        ...stock,
        loadUnits: stock.loadUnits.map((unit, index) =>
          index === 0
            ? {
                ...unit,
                location: {
                  kind: 'load-unit' as const,
                  loadUnitId: stock.loadUnits[1]?.id ?? unit.id,
                },
              }
            : unit,
        ),
      })),
    ).toThrow(/loop of load units/);
  });

  it('two pallets standing on the same spot', () => {
    expect(
      tamper((stock) => {
        const first = stock.loadUnits.find((unit) => unit.location.kind === 'floor');
        return {
          ...stock,
          loadUnits: stock.loadUnits.map((unit) =>
            unit.location.kind === 'floor' && unit.id !== first?.id && first
              ? { ...unit, location: first.location }
              : unit,
          ),
        };
      }),
    ).toThrow(/would overlap the Wooden pallet/);
  });

  it('a cost the books do not show', () => {
    expect(
      tamper((stock) => ({
        ...stock,
        lots: stock.lots.map((lot, index) =>
          index === 0 ? { ...lot, costCents: lot.costCents + 1n } : lot,
        ),
      })),
    ).toThrow(/Inventory is .* but the lots held cost/);
  });
});

describe('the stock-take', () => {
  it('counts the stacks from the floor up and finds a lot no stack holds', () => {
    const world = stockWorld();
    deliver(world);
    const stock = stockOf(world);
    expect(stockTake(stock)).toEqual([
      expect.objectContaining({
        productId: 'wood-screw-8-1-25',
        propertyId: FACTORY,
        countedMicro: 800_000_000n,
        recordedMicro: 800_000_000n,
        lots: 4,
        massMg: 2_080_000n,
        costCents: 4160n,
      }),
    ]);
    // A carton that hangs from a loop of carriers is in no stack anyone could reach.
    const [pallet, carton] = stock.loadUnits;
    const lost: Stock = {
      ...stock,
      loadUnits: stock.loadUnits.map((unit) =>
        unit.id === pallet?.id
          ? { ...unit, location: { kind: 'load-unit' as const, loadUnitId: carton?.id ?? unit.id } }
          : unit,
      ),
    };
    const lines = stockTake(lost);
    expect(lines.some((line) => line.countedMicro !== line.recordedMicro)).toBe(true);
  });
});
