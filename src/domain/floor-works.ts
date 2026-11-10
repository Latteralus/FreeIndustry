import { formatUsd, MAX_AMOUNT_CENTS, type Cents } from '../shared/money';
import { ensureCounterparty, type Company, type RuleContext } from './company';
import { fundsMessage } from './equipment';
import { levelGeometry, levelOf, type Building } from './facility';
import type { Facilities } from './facilities';
import {
  compareCoverings,
  installationKindOf,
  runCells,
  runsOf,
  type CellRun,
  type CoveringInstallation,
  type FloorCovering,
  type FloorMaterial,
  type FloorMaterialCategory,
} from './floor-covering';
import type { EntityId } from './ids';
import { availableFundsCents, invoiceOf, issueInvoice, recordPayment } from './invoicing';
import { ensureAccount, FLOOR_ACCOUNTS } from './ledger';
import type { Lease, Property, RealEstate } from './real-estate';
import { cellKey, gridSpan } from './region';
import { reject, Rejection } from './rejection';
import { isoDateAt, MS_PER_DAY, type CivilDate, type SimTimeMs } from './time';

/**
 * Buying floor coverings (spec §5.6, plan Step 09A; DECISIONS ADR-0046,
 * ADR-0052). The company orders a material for a set of cells from a floor
 * contractor:
 *
 * - **Quote.** Exactly which cells change (cells already in the material
 *   are skipped), their exact covered area (a partial cell is charged for
 *   its share only), the installation charge, the removal charge for cells
 *   whose installed material is taken up first, and how long the work takes.
 *   All sums are `bigint` and rounded half-up to whole cents once per order.
 * - **Order.** The contractor invoices the quoted amount and is paid at
 *   once: one balanced entry with installation and removal on separate
 *   expense accounts (owner decision: everything is expensed). The cells are
 *   then *under works* until the job completes: no other floor order and no
 *   equipment may go onto them, while equipment already standing there
 *   stays exactly as it is (owner decision).
 * - **Completion.** A scheduled event lays the material: each cell's
 *   covering names the order. Structure and equipment are never touched.
 *
 * The contractor is an outside firm; no company staff take part.
 */

/** The floor contractor every city's firms use (a FreeIndustry invention, ledger OR-86). */
export const FLOOR_CONTRACTOR = 'Keystone Floor Contractors';

/** Most rectangles in one order; a fill of any real floor needs far fewer. */
export const MAX_ORDER_RECTANGLES = 2000;
/** Most floor orders a company may place (bounded state; revisit with Step 33). */
export const MAX_FLOOR_ORDERS = 10_000;
/** Most cells the rectangles of one order may span in total, overlaps counted twice. */
const MAX_ORDER_SPAN_CELLS = 200_000;

/**
 * A crew's daily output in m² for laying each category of material, and for
 * taking each category up (FreeIndustry values, ledger OR-86). One crew
 * works the job; a day of its work is one simulated day.
 */
const LAY_M2_PER_DAY: Readonly<Record<FloorMaterialCategory, bigint>> = {
  concrete: 80n,
  'polished-concrete': 60n,
  'painted-concrete': 200n,
  epoxy: 100n,
  'steel-plate': 50n,
  'diamond-plate': 50n,
  'anti-slip': 150n,
  'safety-marking': 250n,
  office: 120n,
};
const LIFT_M2_PER_DAY: Readonly<Record<FloorMaterialCategory, bigint>> = {
  concrete: 60n,
  'polished-concrete': 60n,
  'painted-concrete': 300n,
  epoxy: 150n,
  'steel-plate': 80n,
  'diamond-plate': 80n,
  'anti-slip': 200n,
  'safety-marking': 300n,
  office: 200n,
};

const MM2_PER_M2 = 1_000_000n;

/** A rectangle of cells: columns `col … col + cols − 1`, rows `row … row + rows − 1`. */
interface CellRect {
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}

export interface FloorOrderRequest {
  readonly propertyId: string;
  readonly level: number;
  readonly materialId: string;
  readonly rectangles: readonly CellRect[];
}

/** What a removal component of an order takes up. */
interface Removal {
  readonly materialId: string;
  readonly cells: number;
  readonly areaMm2: bigint;
}

export interface FloorQuote {
  readonly propertyId: string;
  readonly level: number;
  readonly materialId: string;
  /** Cells that change, and their exact covered area. */
  readonly cells: number;
  readonly areaMm2: bigint;
  /** Selected cells already in the material: skipped and not charged. */
  readonly skippedCells: number;
  readonly replacedCells: number;
  readonly replacedAreaMm2: bigint;
  readonly removals: readonly Removal[];
  readonly installCents: Cents;
  readonly removalCents: Cents;
  readonly totalCents: Cents;
  readonly workDays: number;
  readonly completesAtMs: SimTimeMs;
  readonly runs: readonly CellRun[];
}

export interface FloorContext {
  readonly nowMs: SimTimeMs;
  readonly epoch: CivilDate;
}

/** `numerator / 10⁶` rounded half-up, for non-negative numerators (cents × mm² → cents). */
function centsOfMm2Price(numerator: bigint): Cents {
  return (numerator + MM2_PER_M2 / 2n) / MM2_PER_M2;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * Whole crew days for laying `layMm2` of a category and taking up each
 * removal: the exact sum of area ÷ daily output, rounded up, at least one.
 */
function workDaysOf(
  layMm2: bigint,
  category: FloorMaterialCategory,
  lifts: readonly { readonly areaMm2: bigint; readonly category: FloorMaterialCategory }[],
): number {
  // Σ area_i / (10⁶ · rate_i) over a common denominator: the product of the distinct rates.
  const terms = [
    { areaMm2: layMm2, rate: LAY_M2_PER_DAY[category] },
    ...lifts.map((lift) => ({ areaMm2: lift.areaMm2, rate: LIFT_M2_PER_DAY[lift.category] })),
  ];
  const rates = [...new Set(terms.map((term) => term.rate))];
  const common = rates.reduce((product, rate) => product * rate, 1n);
  const numerator = terms.reduce((sum, term) => sum + term.areaMm2 * (common / term.rate), 0n);
  const days = ceilDiv(numerator, common * MM2_PER_M2);
  return Number(days < 1n ? 1n : days);
}

function propertyOf(realEstate: RealEstate, id: string): Property | undefined {
  return realEstate.properties.find((property) => property.id === id);
}

function buildingOf(facilities: Facilities, id: string): Building | undefined {
  return facilities.buildings.find((building) => building.propertyId === id);
}

/** The company's active lease of a property, if it holds one. */
export function activeLeaseOf(
  realEstate: RealEstate,
  company: Company,
  propertyId: string,
): Lease | undefined {
  return realEstate.leases.find(
    (lease) =>
      lease.status === 'active' &&
      lease.propertyId === propertyId &&
      lease.tenantFirmId === company.firmId,
  );
}

/** Orders still under way on a level. */
export function scheduledWorks(
  facilities: Facilities,
  propertyId: string,
  level: number,
): CoveringInstallation[] {
  return facilities.installations.filter(
    (item) => item.status === 'scheduled' && item.propertyId === propertyId && item.level === level,
  );
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function m2(areaMm2: bigint): string {
  const hundredths = (areaMm2 * 100n + MM2_PER_M2 / 2n) / MM2_PER_M2;
  return `${(Number(hundredths) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} m²`;
}

/**
 * The exact quote for an order, or why it cannot be placed at all. Refused
 * with the reason when there is no company, the company does not lease the
 * premises, the level or material is unknown or not sold, a rectangle is
 * malformed or reaches a cell outside the usable floor, a cell is already
 * under works, every cell already has the material, the order is too small
 * to price, or the contractor would finish after the lease ends. Funds are
 * checked by the order, so a quote can show what an unaffordable order costs.
 */
export function quoteFloorCovering(
  facilities: Facilities,
  realEstate: RealEstate,
  company: Company | null,
  request: FloorOrderRequest,
  context: FloorContext,
): FloorQuote | Rejection {
  if (!company) {
    return reject('No company has been founded yet');
  }
  const property = propertyOf(realEstate, request.propertyId);
  const building = buildingOf(facilities, request.propertyId);
  if (!property || !building) {
    return reject(`There is no property ${request.propertyId}`);
  }
  const lease = activeLeaseOf(realEstate, company, property.id);
  if (!lease) {
    return reject(`${company.legalName} does not occupy ${property.address}`);
  }
  const level = levelOf(building, request.level);
  if (!level) {
    return reject(`${property.address} has no level ${request.level}`);
  }
  const material = facilities.floorMaterials.find((item) => item.id === request.materialId);
  if (!material) {
    return reject(`There is no floor material ${request.materialId}`);
  }
  if (material.installCentsPerM2 === null) {
    return reject(`${material.name} is an existing surface only; it is not sold`);
  }
  const count = request.rectangles.length;
  if (count < 1 || count > MAX_ORDER_RECTANGLES) {
    return reject(`An order covers 1–${MAX_ORDER_RECTANGLES} rectangles of cells, not ${count}`);
  }
  const geometry = levelGeometry(building, property, level);
  const span = gridSpan(geometry.bounds);
  let spanCells = 0;
  for (const rect of request.rectangles) {
    const whole = [rect.col, rect.row, rect.cols, rect.rows].every(Number.isSafeInteger);
    if (
      !whole ||
      rect.col < 0 ||
      rect.row < 0 ||
      rect.cols < 1 ||
      rect.rows < 1 ||
      rect.col + rect.cols > span.cols ||
      rect.row + rect.rows > span.rows
    ) {
      return reject(
        `The rectangle of ${rect.cols} × ${rect.rows} cells at (${rect.col}, ${rect.row}) is not on the ${span.cols} × ${span.rows} grid of ${level.name}`,
      );
    }
    spanCells += rect.cols * rect.rows;
  }
  if (spanCells > MAX_ORDER_SPAN_CELLS) {
    return reject(
      `An order may span at most ${MAX_ORDER_SPAN_CELLS.toLocaleString('en-US')} cells`,
    );
  }

  // The distinct selected cells, and the first that is not part of the usable floor.
  const selected = new Map<number, { col: number; row: number; area: number }>();
  let outside = 0;
  let firstOutside: { col: number; row: number } | null = null;
  for (const rect of request.rectangles) {
    for (let row = rect.row; row < rect.row + rect.rows; row += 1) {
      for (let col = rect.col; col < rect.col + rect.cols; col += 1) {
        const key = cellKey(col, row);
        if (selected.has(key)) {
          continue;
        }
        const area = geometry.coverage.get(key) ?? 0;
        if (area <= 0) {
          outside += 1;
          firstOutside ??= { col, row };
        }
        selected.set(key, { col, row, area });
      }
    }
  }
  if (firstOutside) {
    return reject(
      `${plural(outside, 'selected cell')} ${outside === 1 ? 'is' : 'are'} outside the usable floor of ${level.name}, the first at (${firstOutside.col}, ${firstOutside.row}); only full and partial cells can be covered`,
      { outsideCells: outside },
    );
  }

  const works = scheduledWorks(facilities, property.id, level.index);
  for (const job of works) {
    let clash = 0;
    for (const { col, row } of runCells(job.runs)) {
      if (selected.has(cellKey(col, row))) {
        clash += 1;
      }
    }
    if (clash > 0) {
      return reject(
        `${plural(clash, 'selected cell')} ${clash === 1 ? 'is' : 'are'} already under floor works (${job.id}) until ${isoDateAt(context.epoch, job.completesAtMs)}`,
        { installationId: job.id },
      );
    }
  }

  const current = new Map<number, FloorCovering>();
  for (const covering of facilities.coverings) {
    if (covering.propertyId === property.id && covering.level === level.index) {
      current.set(cellKey(covering.col, covering.row), covering);
    }
  }
  const changing: { col: number; row: number }[] = [];
  let area = 0n;
  let skipped = 0;
  let replacedCells = 0;
  let replacedArea = 0n;
  const removals = new Map<string, { cells: number; areaMm2: bigint }>();
  for (const [key, cell] of selected) {
    const installed = current.get(key);
    const existing = installed?.materialId ?? building.surfaceMaterialId;
    if (existing === material.id) {
      skipped += 1;
      continue;
    }
    changing.push(cell);
    area += BigInt(cell.area);
    if (installed) {
      replacedCells += 1;
      replacedArea += BigInt(cell.area);
      const removal = removals.get(installed.materialId) ?? { cells: 0, areaMm2: 0n };
      removals.set(installed.materialId, {
        cells: removal.cells + 1,
        areaMm2: removal.areaMm2 + BigInt(cell.area),
      });
    }
  }
  if (changing.length === 0) {
    return reject(`Every selected cell is already ${material.name}`);
  }

  const materialOf = (id: string): FloorMaterial => {
    const found = facilities.floorMaterials.find((item) => item.id === id);
    if (!found) {
      throw new Error(`Floor covering of unknown material ${id}`);
    }
    return found;
  };
  const removalList = [...removals]
    .map(([materialId, removal]) => ({ materialId, ...removal }))
    .sort((a, b) => (a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0));
  const installExact = area * material.installCentsPerM2;
  const removalExact = removalList.reduce(
    (sum, removal) => sum + removal.areaMm2 * materialOf(removal.materialId).removalCentsPerM2,
    0n,
  );
  // One rounding per order: the total; the installation line is rounded and removal takes the rest.
  const totalCents = centsOfMm2Price(installExact + removalExact);
  const installCents = centsOfMm2Price(installExact);
  const removalCents = totalCents - installCents;
  if (installCents <= 0n) {
    return reject(`${m2(area)} of ${material.name} is too small an order to price`);
  }
  if (totalCents > MAX_AMOUNT_CENTS) {
    return reject(`An order can total at most ${formatUsd(MAX_AMOUNT_CENTS)}`);
  }

  const workDays = workDaysOf(
    area,
    material.category,
    removalList.map((removal) => ({
      areaMm2: removal.areaMm2,
      category: materialOf(removal.materialId).category,
    })),
  );
  const completesAtMs = context.nowMs + BigInt(workDays) * MS_PER_DAY;
  if (completesAtMs >= lease.endsAtMs) {
    return reject(
      `${FLOOR_CONTRACTOR} would finish on ${isoDateAt(context.epoch, completesAtMs)} (${plural(workDays, 'working day')}), after the lease of ${property.address} ends on ${isoDateAt(context.epoch, lease.endsAtMs)}`,
    );
  }
  return {
    propertyId: property.id,
    level: level.index,
    materialId: material.id,
    cells: changing.length,
    areaMm2: area,
    skippedCells: skipped,
    replacedCells,
    replacedAreaMm2: replacedArea,
    removals: removalList,
    installCents,
    removalCents,
    totalCents,
    workDays,
    completesAtMs,
    runs: runsOf(changing),
  };
}

export interface FloorOrderOutcome {
  readonly facilities: Facilities;
  readonly company: Company;
  readonly installationId: EntityId<'floor-installation'>;
  readonly invoiceId: EntityId<'invoice'>;
  readonly quote: FloorQuote;
}

/**
 * Order the quoted work: the contractor invoices it and is paid now, and the
 * cells are under works until `quote.completesAtMs`, when the caller's
 * scheduled event completes it (`completeFloorWorks`). Refused with nothing
 * changed for any reason the quote refuses, or for funds that do not cover
 * the total (with the figures).
 */
export function orderFloorCovering(
  facilities: Facilities,
  realEstate: RealEstate,
  company: Company,
  request: FloorOrderRequest,
  context: RuleContext & FloorContext,
): FloorOrderOutcome | Rejection {
  const quote = quoteFloorCovering(facilities, realEstate, company, request, context);
  if (quote instanceof Rejection) {
    return quote;
  }
  if (facilities.installations.length >= MAX_FLOOR_ORDERS) {
    return reject(`A company can place at most ${MAX_FLOOR_ORDERS} floor orders`);
  }
  const material = facilities.floorMaterials.find((item) => item.id === quote.materialId);
  if (!material) {
    throw new Error(`Quoted unknown material ${quote.materialId}`);
  }
  const available = availableFundsCents(company);
  if (quote.totalCents > available) {
    return reject(
      fundsMessage(
        available,
        quote.totalCents,
        `${m2(quote.areaMm2)} of ${material.name} by ${FLOOR_CONTRACTOR}`,
      ),
      { availableCents: available.toString(), requiredCents: quote.totalCents.toString() },
    );
  }
  const contractor = ensureCounterparty(company, FLOOR_CONTRACTOR, 'supplier', context.allocateId);
  let ledger = ensureAccount(contractor.company.ledger, FLOOR_ACCOUNTS.installation);
  if (quote.removalCents > 0n) {
    ledger = ensureAccount(ledger, FLOOR_ACCOUNTS.removal);
  }
  const removed = quote.removals.map((removal) => {
    const name = facilities.floorMaterials.find((item) => item.id === removal.materialId)?.name;
    return `${m2(removal.areaMm2)} of ${name ?? removal.materialId}`;
  });
  const issued = issueInvoice(
    { ...contractor.company, ledger },
    {
      direction: 'payable',
      counterpartyId: contractor.counterpartyId,
      description: `Floor works: ${material.name}, ${plural(quote.cells, 'cell')}`.slice(0, 120),
      lines: [
        {
          account: FLOOR_ACCOUNTS.installation.code,
          description: `Laying ${m2(quote.areaMm2)} of ${material.name}`.slice(0, 120),
          amountCents: quote.installCents,
        },
        ...(quote.removalCents > 0n
          ? [
              {
                account: FLOOR_ACCOUNTS.removal.code,
                description: `Taking up ${removed.join(', ')}`.slice(0, 120),
                amountCents: quote.removalCents,
              },
            ]
          : []),
      ],
      dueAtMs: context.nowMs,
      obligation: null,
    },
    context,
  );
  if (issued instanceof Rejection) {
    return issued;
  }
  const paid = recordPayment(
    issued.company,
    { invoiceId: issued.invoiceId, amountCents: quote.totalCents, initiatedBy: 'player' },
    context,
  );
  if (paid instanceof Rejection) {
    return paid;
  }
  const invoice = invoiceOf(issued.company, issued.invoiceId);
  if (!invoice) {
    throw new Error(`Invoice ${issued.invoiceId} was not created`);
  }
  const installationId = context.allocateId('floor-installation');
  const installation: CoveringInstallation = {
    id: installationId,
    propertyId: quote.propertyId,
    level: quote.level,
    materialId: quote.materialId,
    firmId: company.firmId,
    atMs: context.nowMs,
    completesAtMs: quote.completesAtMs,
    status: 'scheduled',
    kind: installationKindOf(quote.cells, quote.replacedCells),
    cells: quote.cells,
    areaMm2: quote.areaMm2,
    replacedCells: quote.replacedCells,
    replacedAreaMm2: quote.replacedAreaMm2,
    installCents: quote.installCents,
    removalCents: quote.removalCents,
    costCents: quote.totalCents,
    journalEntryId: invoice.entryId,
    runs: quote.runs,
  };
  return {
    facilities: { ...facilities, installations: [...facilities.installations, installation] },
    company: paid.company,
    installationId,
    invoiceId: issued.invoiceId,
    quote,
  };
}

/**
 * The contractor finishes: every cell of the order takes its material and
 * names the order. Coverings of other cells, the structure and every item of
 * equipment are left exactly as they were.
 */
export function completeFloorWorks(facilities: Facilities, installationId: string): Facilities {
  const job = facilities.installations.find((item) => item.id === installationId);
  if (job?.status !== 'scheduled') {
    throw new Error(`Floor installation ${installationId} is not under way`);
  }
  const laid = new Set<number>();
  const coverings: FloorCovering[] = [];
  for (const { col, row } of runCells(job.runs)) {
    laid.add(cellKey(col, row));
    coverings.push({
      propertyId: job.propertyId,
      level: job.level,
      col,
      row,
      materialId: job.materialId,
      installationId: job.id,
    });
  }
  const kept = facilities.coverings.filter(
    (covering) =>
      covering.propertyId !== job.propertyId ||
      covering.level !== job.level ||
      !laid.has(cellKey(covering.col, covering.row)),
  );
  return {
    ...facilities,
    coverings: [...kept, ...coverings].sort(compareCoverings),
    installations: facilities.installations.map((item) =>
      item.id === job.id ? { ...item, status: 'complete' as const } : item,
    ),
  };
}
