import fc from 'fast-check';
import { baseContent } from '../../src/catalog/base-content';
import type { Company } from '../../src/domain/company';
import { formatEntityId, type AllocateId } from '../../src/domain/ids';
import { ledgerProblems, trialBalance } from '../../src/domain/ledger';
import { Rejection } from '../../src/domain/rejection';
import {
  contentsMassMg,
  grossMassMg,
  indexStock,
  massOfMg,
  MICRO_PER_UNIT,
  packQuantityMicro,
  quantaOf,
  rootUnitOf,
  volumeOfMm3,
  type Stock,
  type StockHandler,
} from '../../src/domain/stock';
import { stockProblems } from '../../src/domain/stock-invariants';
import {
  loseStock,
  mergeLots,
  relocateLoadUnit,
  releaseReservation,
  reserveStock,
  scrapStock,
  splitLot,
  transferStock,
} from '../../src/domain/stock-operations';
import { stockTake } from '../../src/domain/stock-records';
import { formatQuantity, parseQuantity } from '../../src/renderer/app/units';
import { facilitiesOf } from '../support/facility-world';
import {
  deliver,
  FACTORY,
  MOTORS_ON_A_PALLET,
  PAINT_IN_A_DRUM,
  stockOf,
  stockWorld,
} from '../support/stock-world';

/**
 * Properties (plan Step 10 acceptance): stock cannot materialise between
 * locations or be in two containers, and the quantity, mass and unit
 * conversion invariants hold.
 *
 * Random scripts of transfers, splits, merges, relocations, reservations,
 * releases, scrapping and losses, with random (often impossible) lots,
 * quantities and destinations, run against a factory holding screws in
 * cartons on a pallet, serialized motors, a drum of enamel and a bag of
 * pellets. After every step every invariant holds; what is held equals what
 * was received less what was lost; every open lot is in exactly one load
 * unit and every load unit in exactly one place; the stock-take agrees with
 * the record; Inventory equals the lots' cost; the books balance. A refused
 * step changes nothing.
 */

const WORKER: StockHandler = { kind: 'employee', personId: formatEntityId('person', 9) };

function baseWorld() {
  const world = stockWorld(FACTORY, 11);
  deliver(world);
  deliver(world, MOTORS_ON_A_PALLET);
  deliver(world, PAINT_IN_A_DRUM);
  deliver(world, {
    productId: 'hdpe-pellets',
    containerTypeId: 'bulk-bag-1t',
    containers: 1,
    quantityPerContainerMicro: '500000000',
    palletTypeId: null,
    containersPerPallet: null,
    totalCostCents: '42500',
  });
  return world;
}

const BASE = baseWorld();

const op = fc.oneof(
  fc.record({
    kind: fc.constant('transfer' as const),
    lot: fc.nat(30),
    to: fc.nat(30),
    part: fc.nat(8),
    near: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('split' as const), lot: fc.nat(30), part: fc.nat(8) }),
  fc.record({
    kind: fc.constant('merge' as const),
    a: fc.nat(30),
    b: fc.nat(30),
    together: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('relocate' as const),
    unit: fc.nat(30),
    onto: fc.option(fc.nat(30)),
    x: fc.integer({ min: 0, max: 60 }),
    y: fc.integer({ min: 0, max: 60 }),
    turn: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('reserve' as const), lot: fc.nat(30), part: fc.nat(8) }),
  fc.record({ kind: fc.constant('release' as const), which: fc.nat(10) }),
  fc.record({ kind: fc.constant('scrap' as const), lot: fc.nat(30), part: fc.nat(8) }),
  fc.record({ kind: fc.constant('lose' as const), lot: fc.nat(30), part: fc.nat(8) }),
);

/** A share of a lot: 0 is one quantum, 8 is all of it, between are eighths (rounded to quanta). */
function share(stock: Stock, lotId: string, part: number): bigint {
  const index = indexStock(stock);
  const lot = index.lots.get(lotId);
  const product = lot && index.products.get(lot.productId);
  if (!lot || !product) {
    return MICRO_PER_UNIT;
  }
  if (part === 0) {
    return product.quantumMicro;
  }
  const quanta = (quantaOf(product, lot.quantityMicro) * BigInt(part)) / 8n;
  return (quanta === 0n ? 1n : quanta) * product.quantumMicro;
}

function received(stock: Stock, lost: Map<string, bigint>): Map<string, bigint> {
  const expected = new Map<string, bigint>();
  for (const receipt of stock.receipts) {
    expected.set(
      receipt.productId,
      (expected.get(receipt.productId) ?? 0n) + receipt.quantityMicro,
    );
  }
  for (const [productId, quantity] of lost) {
    expected.set(productId, (expected.get(productId) ?? 0n) - quantity);
  }
  return expected;
}

describe('stock conservation under random handling (Step 10 gate)', () => {
  it('nothing materialises, vanishes or is in two places; mass, cost and books agree', () => {
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 18 }), (script) => {
        const { company: startCompany, realEstate } = BASE.state;
        if (!startCompany || !realEstate) {
          throw new Error('no company');
        }
        const facilities = facilitiesOf(BASE);
        let stock = stockOf(BASE);
        let company: Company = startCompany;
        const lost = new Map<string, bigint>();
        const counters = new Map<string, number>();
        const allocateId: AllocateId = (kind) => {
          const next = (counters.get(kind) ?? 5000) + 1;
          counters.set(kind, next);
          return formatEntityId(kind, next);
        };
        const context = { nowMs: BASE.nowMs, allocateId };
        for (const step of script) {
          const lots = stock.lots.filter((lot) => !lot.closed);
          const lotAt = (n: number) => lots[n % Math.max(1, lots.length)]?.id ?? 'lot:999';
          const unitAt = (n: number) =>
            stock.loadUnits[n % stock.loadUnits.length]?.id ?? formatEntityId('load-unit', 999);
          const before = { stock, company };
          let next: { stock: Stock; company?: Company } | Rejection;
          switch (step.kind) {
            case 'transfer': {
              const id = lotAt(step.lot);
              // Half the time, a unit in the same stack (within reach); otherwise any unit at all.
              const index = indexStock(stock);
              const from = index.lots.get(id)?.loadUnitId ?? '';
              const root = rootUnitOf(index, from)?.id;
              const near = stock.loadUnits.filter(
                (unit) => unit.id !== from && rootUnitOf(index, unit.id)?.id === root,
              );
              const target =
                step.near && near.length > 0
                  ? (near[step.to % near.length]?.id ?? '')
                  : unitAt(step.to);
              next = transferStock(
                stock,
                facilities,
                realEstate,
                {
                  lotId: id,
                  quantityMicro: share(stock, id, step.part),
                  toLoadUnitId: target,
                  handler: WORKER,
                },
                context,
              );
              break;
            }
            case 'split': {
              const id = lotAt(step.lot);
              next = splitLot(
                stock,
                { lotId: id, quantityMicro: share(stock, id, step.part), handler: WORKER },
                context,
              );
              break;
            }
            case 'merge': {
              // Half the time, two lots that share a load unit; otherwise any two.
              const paired = lots.filter((lot) =>
                lots.some((other) => other.id !== lot.id && other.loadUnitId === lot.loadUnitId),
              );
              const first =
                step.together && paired.length > 0
                  ? (paired[step.a % paired.length]?.id ?? '')
                  : lotAt(step.a);
              const unit = indexStock(stock).lots.get(first)?.loadUnitId;
              const partners = lots.filter((lot) => lot.loadUnitId === unit && lot.id !== first);
              const second =
                step.together && partners.length > 0
                  ? (partners[step.b % partners.length]?.id ?? '')
                  : lotAt(step.b);
              next = mergeLots(stock, { lotIds: [first, second], handler: WORKER }, context);
              break;
            }
            case 'relocate':
              next = relocateLoadUnit(
                stock,
                facilities,
                realEstate,
                company,
                {
                  loadUnitId: unitAt(step.unit),
                  to:
                    step.onto === null
                      ? {
                          kind: 'floor',
                          propertyId: FACTORY,
                          level: 0,
                          xMm: step.x * 500,
                          yMm: step.y * 500,
                          rotation: step.turn ? 90 : 0,
                        }
                      : { kind: 'load-unit', loadUnitId: unitAt(step.onto) },
                  handler: WORKER,
                },
                context,
              );
              break;
            case 'reserve': {
              const id = lotAt(step.lot);
              const held = reserveStock(
                stock,
                { lotId: id, quantityMicro: share(stock, id, step.part), purpose: 'task:1' },
                context,
              );
              next = held instanceof Rejection ? held : { stock: held.stock };
              break;
            }
            case 'release': {
              const reservation =
                stock.reservations[step.which % Math.max(1, stock.reservations.length)];
              const released = releaseReservation(
                stock,
                reservation?.id ?? 'stock-reservation:999',
              );
              next = released instanceof Rejection ? released : { stock: released };
              break;
            }
            case 'scrap': {
              const id = lotAt(step.lot);
              next = scrapStock(
                stock,
                company,
                { lotId: id, quantityMicro: share(stock, id, step.part), reason: 'damaged' },
                context,
              );
              break;
            }
            case 'lose': {
              const id = lotAt(step.lot);
              const quantity = share(stock, id, step.part);
              const productId = indexStock(stock).lots.get(id)?.productId ?? '';
              next = loseStock(
                stock,
                company,
                { lotId: id, quantityMicro: quantity, reason: 'destroyed', handler: WORKER },
                context,
              );
              if (!(next instanceof Rejection)) {
                lost.set(productId, (lost.get(productId) ?? 0n) + quantity);
              }
              break;
            }
          }
          if (next instanceof Rejection) {
            // A refusal changes nothing.
            expect(stock).toBe(before.stock);
            expect(company).toBe(before.company);
            continue;
          }
          stock = next.stock;
          company = next.company ?? company;

          expect(stockProblems(stock, facilities, realEstate, company)).toEqual([]);
          expect(ledgerProblems(company.ledger)).toEqual([]);
          const totals = trialBalance(company.ledger);
          expect(totals.debitsCents).toBe(totals.creditsCents);
          // Conservation: held = received − lost, product by product.
          const held = new Map<string, bigint>();
          for (const lot of stock.lots) {
            if (!lot.closed) {
              held.set(lot.productId, (held.get(lot.productId) ?? 0n) + lot.quantityMicro);
            }
          }
          for (const [productId, quantity] of received(stock, lost)) {
            expect(held.get(productId) ?? 0n).toBe(quantity);
          }
          // One place: every open lot in exactly one existing unit; every unit listed once.
          const index = indexStock(stock);
          const placements = [...index.lotsIn.values()].flat().map((lot) => lot.id);
          expect(new Set(placements).size).toBe(placements.length);
          expect(placements.length).toBe(stock.lots.filter((lot) => !lot.closed).length);
          expect(new Set(stock.loadUnits.map((unit) => unit.id)).size).toBe(stock.loadUnits.length);
          // The physical count agrees with the record.
          expect(stockTake(stock).every((line) => line.countedMicro === line.recordedMicro)).toBe(
            true,
          );
          // Mass: a unit is its tare plus its contents, and contents are their lots plus carried units.
          for (const unit of stock.loadUnits) {
            const type = index.types.get(unit.typeId);
            expect(grossMassMg(index, unit.id)).toBe(
              BigInt(type?.tareMassG ?? 0) * 1000n + contentsMassMg(index, unit.id),
            );
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

const catalog = baseContent().stock;

describe('quantity, mass and unit conversions are exact', () => {
  const product = fc.constantFrom(...catalog.products);

  it('quanta, quantities and mass and volume convert exactly and add up', () => {
    fc.assert(
      fc.property(
        product,
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        (item, a, b) => {
          const qa = a * item.quantumMicro;
          const qb = b * item.quantumMicro;
          expect(quantaOf(item, qa)).toBe(a);
          expect(massOfMg(item, qa + qb)).toBe(massOfMg(item, qa) + massOfMg(item, qb));
          expect(volumeOfMm3(item, qa + qb)).toBe(volumeOfMm3(item, qa) + volumeOfMm3(item, qb));
          expect(massOfMg(item, qa)).toBe(a * item.massPerQuantumMg);
        },
      ),
    );
  });

  it('pack units are whole numbers of quanta and convert back exactly', () => {
    const packed = catalog.products.flatMap((item) =>
      item.packUnits.map((pack) => ({ item, pack })),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...packed),
        fc.bigInt({ min: 0n, max: 10n ** 6n }),
        ({ item, pack }, count) => {
          const quantity = packQuantityMicro(item, pack.id, count);
          expect(quantaOf(item, quantity)).toBe(count * BigInt(pack.quanta));
          expect(quantity / (BigInt(pack.quanta) * item.quantumMicro)).toBe(count);
        },
      ),
    );
  });

  it('metric display is the exact quantity, and US display is within half its last place', () => {
    fc.assert(
      fc.property(product, fc.bigInt({ min: 1n, max: 10n ** 9n }), (item, quanta) => {
        const micro = (quanta * item.quantumMicro).toString();
        const metric = formatQuantity(item, micro, 'metric');
        expect(parseQuantity(metric.replace(/ (each|kg|L)$/, ''))).toBe(micro);
        const us = formatQuantity(item, micro, 'us');
        if (item.unit === 'kg') {
          const pounds = Number(us.replace(/[^0-9.]/g, ''));
          expect(Math.abs(pounds - Number(micro) / 453_592.37)).toBeLessThanOrEqual(
            0.005 + 1e-9 * pounds,
          );
        } else if (item.unit === 'L') {
          const gallons = Number(us.replace(/[^0-9.]/g, ''));
          expect(Math.abs(gallons - Number(micro) / 3_785_411.784)).toBeLessThanOrEqual(
            0.005 + 1e-9 * gallons,
          );
        } else {
          expect(us).toBe(metric);
        }
      }),
    );
  });
});
