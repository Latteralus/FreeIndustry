import { baseContent } from '../../../src/catalog/base-content';
import { formatEntityId } from '../../../src/domain/ids';
import {
  boxFits,
  capacityProblems,
  containerTypeProblems,
  contentsVolumeMm3,
  costShare,
  floorFootprint,
  grossMassMg,
  indexStock,
  isWholeQuantity,
  massOfMg,
  maxHeightMm,
  packQuantityMicro,
  productProblems,
  quantaOf,
  volumeOfMm3,
  type ContainerType,
  type LoadUnit,
  type Product,
  type Stock,
  type StockLot,
} from '../../../src/domain/stock';
import { SCRAP_REASONS as DOMAIN_SCRAP_REASONS } from '../../../src/domain/stock';
import { SCRAP_REASONS as IPC_SCRAP_REASONS } from '../../../src/shared/ipc/commands';

/**
 * Step 10 stock definitions (ADR-0053): exact quantities in whole quanta,
 * exact mass and volume, pack units, and the capacity rules of a load unit.
 */

const catalog = baseContent().stock;
const product = (id: string): Product => {
  const found = catalog.products.find((item) => item.id === id);
  if (!found) {
    throw new Error(`no product ${id}`);
  }
  return found;
};
const container = (id: string): ContainerType => {
  const found = catalog.containerTypes.find((item) => item.id === id);
  if (!found) {
    throw new Error(`no container ${id}`);
  }
  return found;
};

const FIRM = formatEntityId('firm', 1);
const floor = {
  kind: 'floor' as const,
  propertyId: 'hf-ng-8',
  level: 0,
  xMm: 0,
  yMm: 0,
  rotation: 0 as const,
};

function unit(n: number, typeId: string, location: LoadUnit['location'] = floor): LoadUnit {
  return {
    id: formatEntityId('load-unit', n),
    typeId,
    ownerFirmId: FIRM,
    location,
    createdAtMs: 0n,
    receiptId: null,
  };
}

function lot(n: number, productId: string, quantityMicro: bigint, unitN: number): StockLot {
  return {
    id: formatEntityId('lot', n),
    productId,
    ownerFirmId: FIRM,
    grade: product(productId).grades[0]?.code ?? '',
    disposition: 'available',
    quantityMicro,
    costCents: 100n,
    loadUnitId: formatEntityId('load-unit', unitN),
    serials: [],
    origin: { kind: 'split' },
    parentLotIds: [],
    createdAtMs: 0n,
    closed: null,
  };
}

function stockWith(loadUnits: LoadUnit[], lots: StockLot[]): Stock {
  return { ...catalog, loadUnits, lots };
}

describe('quantities are exact whole quanta', () => {
  it('counts items one at a time and weighs bulk and liquids to the gram and millilitre', () => {
    const screws = product('wood-screw-8-1-25');
    expect(quantaOf(screws, 2_000_000_000n)).toBe(2000n);
    expect(isWholeQuantity(screws, 2_500_000n)).toBe(false); // 2.5 screws
    expect(() => quantaOf(screws, 2_500_000n)).toThrow('not a whole number of quanta');
    const pellets = product('hdpe-pellets');
    expect(isWholeQuantity(pellets, 25_500_000n)).toBe(true); // 25.5 kg
    expect(isWholeQuantity(pellets, 25_000_500n)).toBe(false); // 25.0005 kg: half a gram
    const paint = product('enamel-machine-grey');
    expect(isWholeQuantity(paint, 3_785_000n)).toBe(true); // a 3.785 L gallon can
  });

  it('gives exact mass and volume: 2,000 screws weigh 5.2 kg, 208 L of enamel 260 kg', () => {
    expect(massOfMg(product('wood-screw-8-1-25'), 2_000_000_000n)).toBe(5_200_000n);
    expect(massOfMg(product('enamel-machine-grey'), 208_000_000n)).toBe(260_000_000n);
    expect(volumeOfMm3(product('enamel-machine-grey'), 208_000_000n)).toBe(208_000_000n);
    // A stud's box: 2,438 × 89 × 38 mm.
    expect(volumeOfMm3(product('pine-stud-2x4-8ft'), 1_000_000n)).toBe(2438n * 89n * 38n);
  });

  it('converts pack units exactly: a box of 200 screws, a 25 kg bag, a 3.785 L gallon', () => {
    expect(packQuantityMicro(product('wood-screw-8-1-25'), 'box-200', 3n)).toBe(600_000_000n);
    expect(packQuantityMicro(product('hdpe-pellets'), 'bag-25kg', 2n)).toBe(50_000_000n);
    expect(packQuantityMicro(product('enamel-machine-grey'), 'gallon', 1n)).toBe(3_785_000n);
    expect(() => packQuantityMicro(product('motor-half-hp'), 'box-200', 1n)).toThrow();
  });

  it('shares a cost to the cent so the parts always add back to the whole', () => {
    expect(costShare(1001n, 1n, 3n)).toBe(334n);
    expect(1001n - costShare(1001n, 1n, 3n)).toBe(667n);
    expect(costShare(1001n, 3n, 3n)).toBe(1001n);
    expect(costShare(1n, 1n, 2n)).toBe(1n); // half a cent rounds up, once
  });

  it('keeps the domain and IPC lists of scrap reasons the same', () => {
    expect([...IPC_SCRAP_REASONS]).toEqual([...DOMAIN_SCRAP_REASONS]);
  });
});

describe('containers', () => {
  it('stand on their outer footprint, turned a quarter swaps width and depth', () => {
    const pallet = container('gma-pallet');
    expect(floorFootprint(pallet, floor)).toEqual({ x: 0, y: 0, width: 1219, depth: 1016 });
    expect(floorFootprint(pallet, { ...floor, xMm: 3000, rotation: 90 })).toEqual({
      x: 3000,
      y: 0,
      width: 1016,
      depth: 1219,
    });
    // A pallet carries its load above the deck: 140 mm deck + 1,350 mm envelope.
    expect(maxHeightMm(pallet)).toBe(1490);
    expect(maxHeightMm(container('steel-drum-55gal'))).toBe(876);
  });

  it('fit an item in any axis-aligned orientation, but not one that is too long every way', () => {
    expect(
      boxFits({ width: 254, depth: 165, height: 165 }, { width: 165, depth: 600, height: 300 }),
    ).toBe(true);
    // A full plywood sheet (2,440 × 1,220) overhangs a 1,219 mm pallet by a millimetre.
    expect(boxFits({ width: 2440, depth: 1220, height: 18 }, container('gma-pallet').innerMm)).toBe(
      false,
    );
    expect(
      boxFits({ width: 2440, depth: 1220, height: 18 }, container('lumber-bunk-8ft').innerMm),
    ).toBe(true);
  });

  it('weigh their tare plus everything in and on them', () => {
    const stock = stockWith(
      [
        unit(1, 'gma-pallet'),
        unit(2, 'carton-24x16x16', {
          kind: 'load-unit',
          loadUnitId: formatEntityId('load-unit', 1),
        }),
      ],
      [lot(1, 'wood-screw-8-1-25', 2_000_000_000n, 2)],
    );
    const index = indexStock(stock);
    // Carton: 900 g + 5.2 kg of screws; pallet: 21 kg + the carton.
    expect(grossMassMg(index, formatEntityId('load-unit', 2))).toBe(6_100_000n);
    expect(grossMassMg(index, formatEntityId('load-unit', 1))).toBe(27_100_000n);
    // The pallet's contents take the carton's outside volume.
    expect(contentsVolumeMm3(index, formatEntityId('load-unit', 1))).toBe(610n * 406n * 406n);
    expect(capacityProblems(index, formatEntityId('load-unit', 1))).toEqual([]);
    expect(capacityProblems(index, formatEntityId('load-unit', 2))).toEqual([]);
  });

  it('refuse more mass than the payload: 30 kg in a carton, not 31.2', () => {
    const index = indexStock(
      stockWith([unit(1, 'carton-24x16x16')], [lot(1, 'wood-screw-8-1-25', 12_000_000_000n, 1)]),
    );
    expect(capacityProblems(index, formatEntityId('load-unit', 1))).toEqual([
      'the Corrugated carton, 24 × 16 × 16 in load-unit:1 would carry 31.2 kg; it is rated for 30 kg',
    ]);
  });

  it('refuse more volume than the inside holds', () => {
    // 1,100 L of enamel would be 1,375 kg: too heavy as well as too big for a 208 L drum.
    const index = indexStock(
      stockWith([unit(1, 'steel-drum-55gal')], [lot(1, 'enamel-machine-grey', 230_000_000n, 1)]),
    );
    const problems = capacityProblems(index, formatEntityId('load-unit', 1));
    expect(problems.some((problem) => problem.includes('take 230 L; it holds 208.23 L'))).toBe(
      true,
    );
  });

  it('refuse goods of a form they cannot hold, items that do not fit, and units they cannot carry', () => {
    const liquidInCarton = indexStock(
      stockWith([unit(1, 'carton-24x16x16')], [lot(1, 'enamel-machine-grey', 1_000_000n, 1)]),
    );
    expect(capacityProblems(liquidInCarton, formatEntityId('load-unit', 1))[0]).toContain(
      'cannot hold liquids',
    );
    const studInCarton = indexStock(
      stockWith([unit(1, 'carton-24x16x16')], [lot(1, 'pine-stud-2x4-8ft', 1_000_000n, 1)]),
    );
    expect(capacityProblems(studInCarton, formatEntityId('load-unit', 1))[0]).toContain(
      'does not fit',
    );
    const palletOnCarton = indexStock(
      stockWith(
        [
          unit(1, 'carton-24x16x16'),
          unit(2, 'gma-pallet', { kind: 'load-unit', loadUnitId: formatEntityId('load-unit', 1) }),
        ],
        [],
      ),
    );
    expect(capacityProblems(palletOnCarton, formatEntityId('load-unit', 1))).toContain(
      'the Corrugated carton, 24 × 16 × 16 in load-unit:1 cannot carry a Wooden pallet, 48 × 40 in',
    );
  });

  it('keep their mixing rule, and hold a bulk solid or liquid as exactly one lot', () => {
    const twoProducts = indexStock(
      stockWith(
        [unit(1, 'carton-24x16x16')],
        [lot(1, 'wood-screw-8-1-25', 1_000_000n, 1), lot(2, 'motor-half-hp', 1_000_000n, 1)],
      ),
    );
    expect(capacityProblems(twoProducts, formatEntityId('load-unit', 1))).toContain(
      'the Corrugated carton, 24 × 16 × 16 in load-unit:1 holds one product at a time',
    );
    const twoPaints = indexStock(
      stockWith(
        [unit(1, 'steel-drum-55gal')],
        [
          lot(1, 'enamel-machine-grey', 1_000_000n, 1),
          lot(2, 'enamel-machine-grey', 1_000_000n, 1),
        ],
      ),
    );
    expect(capacityProblems(twoPaints, formatEntityId('load-unit', 1)).join()).toContain(
      'can hold only one lot',
    );
    // A mixed pallet may hold several products side by side.
    const mixed = indexStock(
      stockWith(
        [unit(1, 'gma-pallet')],
        [lot(1, 'wood-screw-8-1-25', 1_000_000n, 1), lot(2, 'motor-half-hp', 1_000_000n, 1)],
      ),
    );
    expect(capacityProblems(mixed, formatEntityId('load-unit', 1))).toEqual([]);
  });
});

describe('catalog validation', () => {
  it('accepts every bundled product and container', () => {
    for (const item of catalog.products) {
      expect(productProblems(item)).toEqual([]);
    }
    for (const type of catalog.containerTypes) {
      expect(containerTypeProblems(type)).toEqual([]);
    }
  });

  it('refuses impossible products', () => {
    const screws = product('wood-screw-8-1-25');
    expect(productProblems({ ...screws, quantumMicro: 500_000n })).toContain(
      'items are handled one at a time (quantum 1 each)',
    );
    expect(productProblems({ ...screws, volumePerQuantumMm3: 1n })).toContain(
      "an item's volume must be its dimensions' product",
    );
    expect(productProblems({ ...product('hdpe-pellets'), quantumMicro: 3n })).toContain(
      'the quantum must divide one base unit exactly',
    );
    expect(
      productProblems({ ...product('enamel-machine-grey'), tracking: 'serialized' }),
    ).toContain('only items can be serialized');
    expect(productProblems({ ...screws, grades: [] })).toContain(
      'a product has 1–6 quality grades',
    );
  });

  it('refuses impossible containers', () => {
    const carton = container('carton-24x16x16');
    expect(
      containerTypeProblems({ ...carton, innerMm: { width: 700, depth: 396, height: 396 } }),
    ).toContain('the inside must lie within the footprint');
    expect(containerTypeProblems({ ...carton, holds: [], carries: [] })).toContain(
      'it must hold goods or carry load units',
    );
    expect(containerTypeProblems({ ...container('gma-pallet'), holds: ['liquid'] })).toContain(
      'an open platform cannot hold a liquid',
    );
  });
});
