import {
  indexStock,
  lotMassMg,
  rootUnitOf,
  type Stock,
  type StockIndex,
  type StockLot,
  type StockMovement,
} from './stock';

/**
 * Reading the stock records (spec §3.4, §5.5; plan Step 10): a stock-take,
 * a lot's lineage back to the deliveries it came from, and the history of a
 * load unit or lot. Pure and read-only.
 */

/** One line of a stock-take: a product at a site, counted two independent ways. */
export interface CountLine {
  readonly productId: string;
  /** The premises the goods are in, or null for goods that are in no floor stack. */
  readonly propertyId: string | null;
  /** Found by walking every load unit standing on a floor or at a machine, and what it holds. */
  readonly countedMicro: bigint;
  /** The quantities the open lots record. */
  readonly recordedMicro: bigint;
  readonly scrapMicro: bigint;
  readonly lots: number;
  readonly massMg: bigint;
  readonly costCents: bigint;
}

/**
 * A stock-take of everything the company holds, by product and premises.
 * The count walks the physical stacks from the floor up; the record sums
 * the lots. They agree unless a lot is in no stack anyone can reach, which
 * the invariants rule out, so a difference here is a defect, not shrinkage
 * (nothing is lost without a recorded loss).
 */
export function stockTake(stock: Stock): CountLine[] {
  const index = indexStock(stock);
  const lines = new Map<
    string,
    {
      productId: string;
      propertyId: string | null;
      counted: bigint;
      recorded: bigint;
      scrap: bigint;
      lots: number;
      mass: bigint;
      cost: bigint;
    }
  >();
  const line = (productId: string, propertyId: string | null) => {
    const key = `${productId}|${propertyId ?? ''}`;
    let found = lines.get(key);
    if (!found) {
      found = {
        productId,
        propertyId,
        counted: 0n,
        recorded: 0n,
        scrap: 0n,
        lots: 0,
        mass: 0n,
        cost: 0n,
      };
      lines.set(key, found);
    }
    return found;
  };
  const siteOf = (lot: StockLot): string | null => {
    const root = lot.loadUnitId === null ? undefined : rootUnitOf(index, lot.loadUnitId);
    return root?.location.kind === 'floor' ? root.location.propertyId : null;
  };
  // The record: every open lot.
  for (const lot of stock.lots) {
    if (lot.closed) {
      continue;
    }
    const entry = line(lot.productId, siteOf(lot));
    entry.recorded += lot.quantityMicro;
    entry.lots += 1;
    entry.mass += lotMassMg(index, lot);
    entry.cost += lot.costCents;
    if (lot.disposition === 'scrap') {
      entry.scrap += lot.quantityMicro;
    }
  }
  // The count: walk down from every unit that stands on its own.
  const visited = new Set<string>();
  const walk = (unitId: string, propertyId: string | null) => {
    if (visited.has(unitId)) {
      return;
    }
    visited.add(unitId);
    for (const lot of index.lotsIn.get(unitId) ?? []) {
      line(lot.productId, propertyId).counted += lot.quantityMicro;
    }
    for (const child of index.childrenOf.get(unitId) ?? []) {
      walk(child.id, propertyId);
    }
  };
  for (const unit of stock.loadUnits) {
    if (unit.location.kind === 'floor') {
      walk(unit.id, unit.location.propertyId);
    } else if (unit.location.kind === 'equipment') {
      walk(unit.id, null);
    }
  }
  return [...lines.values()]
    .map((entry) => ({
      productId: entry.productId,
      propertyId: entry.propertyId,
      countedMicro: entry.counted,
      recordedMicro: entry.recorded,
      scrapMicro: entry.scrap,
      lots: entry.lots,
      massMg: entry.mass,
      costCents: entry.cost,
    }))
    .sort(
      (a, b) =>
        (a.propertyId ?? '').localeCompare(b.propertyId ?? '') ||
        a.productId.localeCompare(b.productId),
    );
}

/** A lot and everything it came from, nearest first, without repeats (bounded). */
export function lineageOf(index: StockIndex, lotId: string, limit = 50): StockLot[] {
  const found: StockLot[] = [];
  const seen = new Set<string>();
  const queue = [lotId];
  while (queue.length > 0 && found.length < limit) {
    const id = queue.shift() ?? '';
    const lot = index.lots.get(id);
    if (!lot || seen.has(id)) {
      continue;
    }
    seen.add(id);
    found.push(lot);
    queue.push(...lot.parentLotIds);
  }
  return found;
}

/**
 * The movements that concern a load unit or a lot: every movement of the
 * unit itself, every movement into or out of it, and every movement of the
 * lots it holds and of the lots they came from. Oldest first; at most
 * `limit`, keeping the latest.
 */
export function historyOf(
  stock: Stock,
  subject: { readonly loadUnitId: string | null; readonly lotIds: readonly string[] },
  limit = 200,
): StockMovement[] {
  const index = indexStock(stock);
  const lots = new Set<string>();
  for (const id of subject.lotIds) {
    for (const lot of lineageOf(index, id)) {
      lots.add(lot.id);
    }
  }
  const unit = subject.loadUnitId;
  const concerns = (entry: StockMovement) =>
    entry.units.some((placed) => placed.loadUnitId === unit) ||
    entry.lines.some(
      (line) =>
        lots.has(line.lotId) ||
        (line.resultLotId !== null && lots.has(line.resultLotId)) ||
        (unit !== null && (line.fromLoadUnitId === unit || line.toLoadUnitId === unit)),
    );
  return stock.movements.filter(concerns).slice(-limit);
}
