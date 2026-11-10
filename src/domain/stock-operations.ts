import { formatUsd, MAX_AMOUNT_CENTS, type Cents } from '../shared/money';
import { ensureCounterparty, type Company, type RuleContext } from './company';
import { fundsMessage, isQuarterTurn, placedShape, type StockObstacle } from './equipment';
import {
  buildingOf,
  companyOccupies,
  equipmentTypeOf,
  installedIn,
  worksAreas,
  type Facilities,
} from './facilities';
import type { EntityId } from './ids';
import { availableFundsCents, issueInvoice, recordPayment } from './invoicing';
import { credit, debit, ensureAccount, INVENTORY_ACCOUNTS, postEntry } from './ledger';
import type { RealEstate } from './real-estate';
import { reject, Rejection } from './rejection';
import type { RectMm } from './region';
import {
  capacityProblems,
  costShare,
  descendantsOf,
  floorFootprint,
  grossMassMg,
  indexStock,
  isWholeQuantity,
  itemCount,
  MAX_LOAD_UNITS,
  MAX_LOT_QUANTITY_MICRO,
  MAX_LOTS,
  MAX_MOVEMENTS,
  MAX_NESTING,
  MAX_RESERVATIONS,
  MAX_SERIALS_PER_LOT,
  carriersOf,
  rootUnitOf,
  unreservedMicro,
  type ContainerType,
  type FloorLocation,
  type LoadUnit,
  type LossReason,
  type MovementLine,
  type MovementUnit,
  type Product,
  type ScrapReason,
  type Stock,
  type StockHandler,
  type StockIndex,
  type StockLocation,
  type StockLot,
  type StockMovement,
} from './stock';
import {
  findReceivingSpot,
  floorPlacementProblems,
  type FloorNeighbours,
  type FloorSite,
} from './stock-floor';

/**
 * Operations on physical stock (spec §5.3, §5.5, §9.3; plan Step 10;
 * ADR-0054). Each one is atomic: it returns the new stock (and books) with
 * every rule satisfied, or a refusal with nothing changed. Each records a
 * movement naming who handled it, and none creates or destroys a quantity
 * except a receipt (goods arriving from outside) and a loss (goods leaving
 * the world for a recorded reason).
 *
 * - **Receive** (the development-only test delivery until purchasing,
 *   Step 14): a supplier's driver unloads paid-for goods onto a goods door's
 *   landing.
 * - **Transfer** a quantity of a lot from its load unit into another within
 *   arm's reach (the whole lot moves; a part becomes a child lot).
 * - **Split** a lot in place into two counted lots; **merge** lots of the
 *   same product, grade and disposition in one load unit into one.
 * - **Relocate** a whole load unit, with everything in it, to a floor
 *   position or onto or into another load unit.
 * - **Reserve** a quantity for a purpose, and **release** it.
 * - **Scrap**: classify a quantity as scrap where it stands and write its cost
 *   down; **lose**: a quantity leaves the world for a recorded cause and its
 *   cost is written off.
 *
 * Transfers need the two load units within reach because no one walks
 * between them; moving stock any further is relocating a load unit, whose
 * route and travel time are the moving task's (Step 12). Until staff exist
 * (Steps 11–12) only receipts and scrapping have a producer in the game;
 * the other operations are exercised by the tests and are what those steps
 * build on.
 */

/** How far apart two load units may be for one person to pass goods between them without walking. */
export const TRANSFER_REACH_MM = 600;

/** Counterparty of the development-only test deliveries (ADR-0055). */
const DIAGNOSTIC_SUPPLIER = 'Diagnostic supplier';

/** Most containers one test delivery may bring. */
const MAX_DELIVERY_CONTAINERS = 100;

/** Kinds a delivery may arrive in: carts and machine buffers belong to the company's own floor. */
const DELIVERABLE: readonly string[] = ['pallet', 'crate', 'carton', 'tote', 'drum', 'bulk-bag'];

export interface StockOutcome {
  readonly stock: Stock;
  readonly movementId: EntityId<'stock-move'>;
}

const qty = (product: Product, micro: bigint): string => {
  const whole = micro / 1_000_000n;
  const fraction = micro % 1_000_000n;
  const text =
    fraction === 0n
      ? whole.toLocaleString('en-US')
      : `${whole.toLocaleString('en-US')}.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`;
  return `${text} ${product.unit}`;
};

// ------------------------------------------------------------- helpers

function productOf(index: StockIndex, id: string): Product | undefined {
  return index.products.get(id);
}

function typeOfUnit(index: StockIndex, unit: LoadUnit): ContainerType {
  const type = index.types.get(unit.typeId);
  if (!type) {
    throw new Error(`${unit.id} has unknown container type ${unit.typeId}`);
  }
  return type;
}

export function unitLabel(index: StockIndex, unit: LoadUnit): string {
  const type = index.types.get(unit.typeId);
  return `the ${type?.name ?? 'load unit'} (${unit.id})`;
}

/** Load units standing on the floors of a building, as obstacles, leaving out `except`. */
export function floorObstacles(
  stock: Stock,
  propertyId: string,
  except: ReadonlySet<string> = new Set(),
): StockObstacle[] {
  const index = indexStock(stock);
  return stock.loadUnits.flatMap((unit): StockObstacle[] => {
    const { location } = unit;
    const type = index.types.get(unit.typeId);
    if (
      location.kind !== 'floor' ||
      location.propertyId !== propertyId ||
      except.has(unit.id) ||
      !type
    ) {
      return [];
    }
    return [
      {
        id: unit.id,
        level: location.level,
        label: unitLabel(index, unit),
        rect: floorFootprint(type, location),
      },
    ];
  });
}

export function siteOf(
  facilities: Facilities,
  realEstate: RealEstate,
  propertyId: string,
): FloorSite | null {
  const building = buildingOf(facilities, propertyId);
  const property = realEstate.properties.find((candidate) => candidate.id === propertyId);
  return building && property ? { building, property } : null;
}

/** Where a load unit physically is: the property, level and plan rectangle of what carries it. */
function placeOfUnit(
  index: StockIndex,
  facilities: Facilities | null,
  unitId: string,
): { readonly propertyId: string; readonly level: number; readonly rect: RectMm } | null {
  const root = rootUnitOf(index, unitId);
  if (!root) {
    return null;
  }
  const { location } = root;
  if (location.kind === 'floor') {
    return {
      propertyId: location.propertyId,
      level: location.level,
      rect: floorFootprint(typeOfUnit(index, root), location),
    };
  }
  if (location.kind === 'equipment' && facilities) {
    const item = facilities.equipment.find((candidate) => candidate.id === location.equipmentId);
    const type = item && equipmentTypeOf(facilities, item.typeId);
    const placement = item?.placement;
    if (!type || !placement || !isQuarterTurn(placement.rotation)) {
      return null;
    }
    const shape = placedShape(type, placement, placement.rotation);
    const zone = shape.zones[location.zone];
    return zone
      ? { propertyId: placement.propertyId, level: placement.level, rect: zone.rect }
      : null;
  }
  return null;
}

/** Whether two plan rectangles are at most `reach` apart (exact Euclidean gap). */
function withinReach(a: RectMm, b: RectMm, reach: number): boolean {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.depth), b.y - (a.y + a.depth));
  return BigInt(dx) * BigInt(dx) + BigInt(dy) * BigInt(dy) <= BigInt(reach) * BigInt(reach);
}

const NO_NEIGHBOURS: FloorNeighbours = { equipment: [], stock: [], works: [] };

/**
 * Every rule about what is in a stack still holds after a change: capacity of
 * each unit from `unitId` down to the bottom of its stack, and the floor load
 * of the bottom unit if it stands on a floor.
 */
function stackProblems(
  stock: Stock,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  unitId: string,
): string[] {
  const index = indexStock(stock);
  const problems: string[] = [];
  for (const unit of [index.units.get(unitId), ...carriersOf(index, unitId)]) {
    if (unit) {
      problems.push(...capacityProblems(index, unit.id));
    }
  }
  const root = rootUnitOf(index, unitId);
  if (root?.location.kind === 'floor' && facilities && realEstate) {
    const site = siteOf(facilities, realEstate, root.location.propertyId);
    if (site) {
      problems.push(
        ...floorPlacementProblems(
          site,
          {
            label: unitLabel(index, root),
            type: typeOfUnit(index, root),
            grossMassMg: grossMassMg(index, root.id),
          },
          root.location,
          NO_NEIGHBOURS,
          { route: false },
        )
          .filter((problem) => problem.code === 'floor-load')
          .map((problem) => problem.message),
      );
    }
  }
  return problems;
}

function refusal(problems: readonly string[]): Rejection {
  const [first] = problems;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
  return reject(`${capitalised(first ?? 'not allowed')}${more}`);
}

const capitalised = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function replaceLots(
  stock: Stock,
  changed: readonly StockLot[],
  added: readonly StockLot[] = [],
): Stock {
  const byId = new Map(changed.map((lot) => [lot.id, lot]));
  return {
    ...stock,
    lots: [...stock.lots.map((lot) => byId.get(lot.id) ?? lot), ...added],
  };
}

function movement(context: RuleContext, fields: Omit<StockMovement, 'id' | 'atMs'>): StockMovement {
  return { id: context.allocateId('stock-move'), atMs: context.nowMs, ...fields };
}

function withMovement(stock: Stock, entry: StockMovement): Stock | Rejection {
  if (stock.movements.length >= MAX_MOVEMENTS) {
    return reject(
      `The stock records are full (${MAX_MOVEMENTS.toLocaleString('en-US')} movements)`,
    );
  }
  return { ...stock, movements: [...stock.movements, entry] };
}

function outcome(stock: Stock | Rejection, entry: StockMovement): StockOutcome | Rejection {
  return stock instanceof Rejection ? stock : { stock, movementId: entry.id };
}

/** An open lot, or the refusal naming why it cannot be used. */
function openLot(index: StockIndex, lotId: string): StockLot | Rejection {
  const lot = index.lots.get(lotId);
  if (!lot) {
    return reject(`There is no lot ${lotId}`);
  }
  if (lot.closed || lot.loadUnitId === null) {
    return reject(`Lot ${lotId} no longer exists: it was ${lot.closed?.reason ?? 'closed'}`);
  }
  return lot;
}

/**
 * The quantity and serials to take from a lot: positive, whole quanta, no
 * more than is unreserved (or exactly a named reservation), and for a
 * serialized product the serials named (default: the lowest numbers).
 */
function portion(
  index: StockIndex,
  lot: StockLot,
  request: {
    readonly quantityMicro: bigint;
    readonly serials?: readonly string[] | null;
    readonly reservationId?: string | null;
  },
): { quantity: bigint; serials: EntityId<'serial'>[] } | Rejection {
  const product = productOf(index, lot.productId);
  if (!product) {
    throw new Error(`${lot.id} is of unknown product ${lot.productId}`);
  }
  const quantity = request.quantityMicro;
  if (quantity <= 0n || !isWholeQuantity(product, quantity)) {
    return reject(
      `${qty(product, quantity)} is not a whole number of ${product.unit === 'each' ? 'items' : `quanta of ${qty(product, product.quantumMicro)}`}`,
    );
  }
  if (quantity > lot.quantityMicro) {
    return reject(
      `Lot ${lot.id} holds ${qty(product, lot.quantityMicro)} of ${product.name}, not ${qty(product, quantity)}`,
    );
  }
  if (request.reservationId) {
    const reservation = index.stock.reservations.find((item) => item.id === request.reservationId);
    if (reservation?.lotId !== lot.id || reservation.quantityMicro !== quantity) {
      return reject(
        `Reservation ${request.reservationId} does not hold ${qty(product, quantity)} of ${lot.id}`,
      );
    }
  } else if (quantity > unreservedMicro(index, lot)) {
    return reject(
      `Only ${qty(product, unreservedMicro(index, lot))} of lot ${lot.id} is free; the rest is reserved`,
    );
  }
  if (product.tracking !== 'serialized') {
    if (request.serials && request.serials.length > 0) {
      return reject(`${product.name} is not serialized`);
    }
    return { quantity, serials: [] };
  }
  const count = Number(itemCount(quantity));
  if (!request.serials || request.serials.length === 0) {
    return { quantity, serials: lot.serials.slice(0, count) };
  }
  const held = new Set<string>(lot.serials);
  const named = [...new Set(request.serials)];
  if (named.length !== count || !named.every((serial) => held.has(serial))) {
    return reject(`Name ${count} distinct serials held in lot ${lot.id}`);
  }
  return {
    quantity,
    serials: lot.serials.filter((serial) => named.includes(serial)),
  };
}

/** The part of a lot that stays when `taken` is split off, and the child lot. */
function splitOff(
  lot: StockLot,
  taken: { quantity: bigint; serials: readonly EntityId<'serial'>[] },
  into: EntityId<'load-unit'>,
  context: RuleContext,
): { parent: StockLot; child: StockLot } {
  const cost = costShare(lot.costCents, taken.quantity, lot.quantityMicro);
  const moved = new Set<string>(taken.serials);
  const child: StockLot = {
    id: context.allocateId('lot'),
    productId: lot.productId,
    ownerFirmId: lot.ownerFirmId,
    grade: lot.grade,
    disposition: lot.disposition,
    quantityMicro: taken.quantity,
    costCents: cost,
    loadUnitId: into,
    serials: [...taken.serials],
    origin: { kind: 'split' },
    parentLotIds: [lot.id],
    createdAtMs: context.nowMs,
    closed: null,
  };
  return {
    parent: {
      ...lot,
      quantityMicro: lot.quantityMicro - taken.quantity,
      costCents: lot.costCents - cost,
      serials: lot.serials.filter((serial) => !moved.has(serial)),
    },
    child,
  };
}

function checkLotRoom(stock: Stock, more: number): Rejection | null {
  return stock.lots.length + more > MAX_LOTS
    ? reject(`The company can keep records of at most ${MAX_LOTS.toLocaleString('en-US')} lots`)
    : null;
}

// ------------------------------------------------------------- receive

export interface DeliveryRequest {
  readonly productId: string;
  /** The quality grade; null for the product's first (best) grade. */
  readonly grade: string | null;
  readonly containerTypeId: string;
  readonly containers: number;
  /** Exact quantity in each container. */
  readonly quantityPerContainerMicro: bigint;
  /** Load the containers onto pallets of this type, or stand each on the floor itself. */
  readonly palletTypeId: string | null;
  readonly containersPerPallet: number | null;
  /** What the whole delivery costs, paid to the supplier at once. */
  readonly totalCostCents: Cents;
}

export interface ReceivedOutcome {
  readonly stock: Stock;
  readonly company: Company;
  readonly receiptId: EntityId<'stock-receipt'>;
  readonly invoiceId: EntityId<'invoice'>;
  readonly loadUnitIds: readonly EntityId<'load-unit'>[];
  readonly lotIds: readonly EntityId<'lot'>[];
}

/**
 * The development-only test delivery (ADR-0055): the diagnostic supplier
 * brings `containers` containers of one product, each holding exactly the
 * quantity asked for (one lot per container), loose or on pallets, and
 * unloads them onto the landings of the company's goods doors. The supplier
 * invoices the cost to Inventory and is paid at once. Refused with nothing
 * changed when any capacity or floor rule fails, there is no room at the
 * doors, or the funds do not cover it.
 */
export function receiveTestDelivery(
  stock: Stock,
  facilities: Facilities,
  realEstate: RealEstate,
  company: Company,
  request: DeliveryRequest,
  context: RuleContext,
): ReceivedOutcome | Rejection {
  const index = indexStock(stock);
  const product = productOf(index, request.productId);
  if (!product) {
    return reject(`There is no product ${request.productId}`);
  }
  const grade = request.grade ?? product.grades[0]?.code ?? '';
  if (!product.grades.some((candidate) => candidate.code === grade)) {
    return reject(`${product.name} has no grade ${grade}`);
  }
  const containerType = index.types.get(request.containerTypeId);
  if (!containerType || !DELIVERABLE.includes(containerType.kind)) {
    return reject(`Goods cannot be delivered in ${request.containerTypeId}`);
  }
  const { containers } = request;
  if (!Number.isInteger(containers) || containers < 1 || containers > MAX_DELIVERY_CONTAINERS) {
    return reject(`A delivery brings 1–${MAX_DELIVERY_CONTAINERS} containers, not ${containers}`);
  }
  const quantity = request.quantityPerContainerMicro;
  if (quantity <= 0n || quantity > MAX_LOT_QUANTITY_MICRO || !isWholeQuantity(product, quantity)) {
    return reject(
      `${qty(product, quantity)} is not a quantity of ${product.name} one container can be filled with`,
    );
  }
  if (product.tracking === 'serialized' && itemCount(quantity) > BigInt(MAX_SERIALS_PER_LOT)) {
    return reject(
      `At most ${MAX_SERIALS_PER_LOT.toLocaleString('en-US')} serialized items per container`,
    );
  }
  let palletType: ContainerType | null = null;
  let perPallet = 1;
  if (request.palletTypeId !== null) {
    palletType = index.types.get(request.palletTypeId) ?? null;
    if (palletType?.kind !== 'pallet') {
      return reject(`${request.palletTypeId} is not a pallet`);
    }
    if (containerType.kind === 'pallet') {
      return reject('Pallets are not delivered on pallets');
    }
    perPallet = request.containersPerPallet ?? 0;
    if (!Number.isInteger(perPallet) || perPallet < 1 || perPallet > MAX_DELIVERY_CONTAINERS) {
      return reject(`Load 1–${MAX_DELIVERY_CONTAINERS} containers per pallet, not ${perPallet}`);
    }
  }
  const pallets = palletType ? Math.ceil(containers / perPallet) : 0;
  if (stock.loadUnits.length + containers + pallets > MAX_LOAD_UNITS) {
    return reject(
      `The company can keep at most ${MAX_LOAD_UNITS.toLocaleString('en-US')} load units`,
    );
  }
  const room = checkLotRoom(stock, containers);
  if (room) {
    return room;
  }
  const total = request.totalCostCents;
  if (total < 1n || total > MAX_AMOUNT_CENTS) {
    return reject(`A delivery costs $0.01 to ${formatUsd(MAX_AMOUNT_CENTS)}`);
  }
  const lease = realEstate.leases.find(
    (candidate) => candidate.status === 'active' && candidate.tenantFirmId === company.firmId,
  );
  const site = lease ? siteOf(facilities, realEstate, lease.propertyId) : null;
  if (!lease || !site || !companyOccupies(realEstate, company, lease.propertyId)) {
    return reject(`${company.legalName} has no premises to deliver to`);
  }
  const available = availableFundsCents(company);
  if (total > available) {
    return reject(
      fundsMessage(available, total, `${containers} × ${containerType.name} of ${product.name}`),
      { availableCents: available.toString(), requiredCents: total.toString() },
    );
  }

  // The goods, as they will be: one lot per container, cost shared to the cent.
  const receiptId = context.allocateId('stock-receipt');
  const placeholder: FloorLocation = {
    kind: 'floor',
    propertyId: site.property.id,
    level: 0,
    xMm: 0,
    yMm: 0,
    rotation: 0,
  };
  const palletUnits: LoadUnit[] = [];
  for (let n = 0; n < pallets; n += 1) {
    palletUnits.push({
      id: context.allocateId('load-unit'),
      typeId: palletType?.id ?? '',
      ownerFirmId: company.firmId,
      location: placeholder,
      createdAtMs: context.nowMs,
      receiptId,
    });
  }
  const containerUnits: LoadUnit[] = [];
  const lots: StockLot[] = [];
  const base = total / BigInt(containers);
  const extra = Number(total % BigInt(containers));
  for (let n = 0; n < containers; n += 1) {
    const carrier = palletUnits[Math.floor(n / perPallet)];
    const unit: LoadUnit = {
      id: context.allocateId('load-unit'),
      typeId: containerType.id,
      ownerFirmId: company.firmId,
      location: carrier ? { kind: 'load-unit', loadUnitId: carrier.id } : placeholder,
      createdAtMs: context.nowMs,
      receiptId,
    };
    containerUnits.push(unit);
    const serials =
      product.tracking === 'serialized'
        ? Array.from({ length: Number(itemCount(quantity)) }, () => context.allocateId('serial'))
        : [];
    lots.push({
      id: context.allocateId('lot'),
      productId: product.id,
      ownerFirmId: company.firmId,
      grade,
      disposition: 'available',
      quantityMicro: quantity,
      costCents: base + (n < extra ? 1n : 0n),
      loadUnitId: unit.id,
      serials,
      origin: { kind: 'receipt', receiptId },
      parentLotIds: [],
      createdAtMs: context.nowMs,
      closed: null,
    });
  }
  let next: Stock = {
    ...stock,
    loadUnits: [...stock.loadUnits, ...palletUnits, ...containerUnits],
    lots: [...stock.lots, ...lots],
  };
  const capacity = [...containerUnits, ...palletUnits].flatMap((unit) =>
    capacityProblems(indexStock(next), unit.id),
  );
  if (capacity.length > 0) {
    return refusal(capacity);
  }

  // Unload each unit that stands on the floor onto a goods door's landing.
  const floorUnits = palletType ? palletUnits : containerUnits;
  const equipment = installedIn(facilities, site.property.id, null);
  const works = worksAreas(facilities, site.property.id);
  let onFloor = floorObstacles(stock, site.property.id);
  const placed = new Map<string, FloorLocation>();
  let doorIndex: number | null = null;
  for (const unit of floorUnits) {
    const nextIndex = indexStock(next);
    const type = typeOfUnit(nextIndex, unit);
    const label = unitLabel(nextIndex, unit);
    const spot = findReceivingSpot(
      site,
      { label, type, grossMassMg: grossMassMg(nextIndex, unit.id) },
      { equipment, stock: onFloor, works },
    );
    if (!spot) {
      return reject(
        placed.size === 0
          ? `There is no room for ${label.replace(/^the /, 'a ')} on the receiving area inside a goods door of ${site.property.address}`
          : `The receiving areas inside the goods doors of ${site.property.address} have room for ${placed.size} of the ${floorUnits.length} load units`,
        { placed: placed.size, needed: floorUnits.length },
      );
    }
    doorIndex ??= spot.doorIndex;
    placed.set(unit.id, spot.location);
    onFloor = [
      ...onFloor,
      { id: unit.id, level: 0, label, rect: floorFootprint(type, spot.location) },
    ];
    next = {
      ...next,
      loadUnits: next.loadUnits.map((candidate) =>
        candidate.id === unit.id ? { ...candidate, location: spot.location } : candidate,
      ),
    };
  }

  // The supplier invoices the goods to Inventory and is paid now.
  const supplier = ensureCounterparty(
    company,
    DIAGNOSTIC_SUPPLIER,
    'diagnostic',
    context.allocateId,
  );
  const books = {
    ...supplier.company,
    ledger: ensureAccount(supplier.company.ledger, INVENTORY_ACCOUNTS.inventory),
  };
  const issued = issueInvoice(
    books,
    {
      direction: 'payable',
      counterpartyId: supplier.counterpartyId,
      description: `Test delivery ${receiptId}: ${product.name}`.slice(0, 120),
      lines: [
        {
          account: INVENTORY_ACCOUNTS.inventory.code,
          description:
            `${containers} × ${containerType.name}, ${qty(product, quantity)} each`.slice(0, 120),
          amountCents: total,
        },
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
    { invoiceId: issued.invoiceId, amountCents: total, initiatedBy: 'player' },
    context,
  );
  if (paid instanceof Rejection) {
    return paid;
  }
  const allUnits = [...palletUnits, ...containerUnits];
  const finalIndex = indexStock(next);
  const units: MovementUnit[] = allUnits.map((unit) => ({
    loadUnitId: unit.id,
    from: null,
    to: finalIndex.units.get(unit.id)?.location ?? unit.location,
  }));
  const lines: MovementLine[] = lots.map((lot) => ({
    lotId: lot.id,
    quantityMicro: lot.quantityMicro,
    fromLoadUnitId: null,
    toLoadUnitId: lot.loadUnitId,
    resultLotId: null,
  }));
  const entry = movement(context, {
    kind: 'receipt',
    handler: { kind: 'supplier', partyId: supplier.counterpartyId },
    lines,
    units,
    reason: null,
    receiptId,
    entryId: null,
    costCents: 0n,
  });
  next = {
    ...next,
    receipts: [
      ...next.receipts,
      {
        id: receiptId,
        kind: 'diagnostic',
        atMs: context.nowMs,
        supplierPartyId: supplier.counterpartyId,
        invoiceId: issued.invoiceId,
        costCents: total,
        propertyId: site.property.id,
        doorIndex: doorIndex ?? 0,
        productId: product.id,
        quantityMicro: quantity * BigInt(containers),
        lotIds: lots.map((lot) => lot.id),
        loadUnitIds: allUnits.map((unit) => unit.id),
      },
    ],
  };
  const recorded = withMovement(next, entry);
  if (recorded instanceof Rejection) {
    return recorded;
  }
  return {
    stock: recorded,
    company: paid.company,
    receiptId,
    invoiceId: issued.invoiceId,
    loadUnitIds: allUnits.map((unit) => unit.id),
    lotIds: lots.map((lot) => lot.id),
  };
}

// ------------------------------------------------------------ transfer

export interface TransferRequest {
  readonly lotId: string;
  readonly quantityMicro: bigint;
  readonly serials?: readonly string[] | null;
  /** Move exactly this reservation's quantity (it follows the goods). */
  readonly reservationId?: string | null;
  readonly toLoadUnitId: string;
  readonly handler: StockHandler;
}

/**
 * Move a quantity of a lot into another load unit within reach. The whole
 * lot moves as itself; a part becomes a child lot in the destination with
 * its share of the cost (and the named reservation, if any).
 */
export function transferStock(
  stock: Stock,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  request: TransferRequest,
  context: RuleContext,
): StockOutcome | Rejection {
  const index = indexStock(stock);
  const lot = openLot(index, request.lotId);
  if (lot instanceof Rejection) {
    return lot;
  }
  const from = lot.loadUnitId;
  const to = index.units.get(request.toLoadUnitId);
  if (!to || from === null) {
    return reject(`There is no load unit ${request.toLoadUnitId}`);
  }
  if (to.id === from) {
    return reject(`Lot ${lot.id} is already in ${unitLabel(index, to)}`);
  }
  if (to.ownerFirmId !== lot.ownerFirmId) {
    return reject(`${unitLabel(index, to)} belongs to someone else`);
  }
  const taken = portion(index, lot, request);
  if (taken instanceof Rejection) {
    return taken;
  }
  const sameStack = rootUnitOf(index, from)?.id === rootUnitOf(index, to.id)?.id;
  if (!sameStack) {
    const a = placeOfUnit(index, facilities, from);
    const b = placeOfUnit(index, facilities, to.id);
    const together =
      a !== null &&
      b !== null &&
      a.propertyId === b.propertyId &&
      a.level === b.level &&
      withinReach(a.rect, b.rect, TRANSFER_REACH_MM);
    if (!together) {
      const source = index.units.get(from);
      return reject(
        `${capitalised(source ? unitLabel(index, source) : from)} and ${unitLabel(index, to)} are not within ${TRANSFER_REACH_MM} mm of each other; the stock must be carried (plan Step 12)`,
      );
    }
  }
  const whole = taken.quantity === lot.quantityMicro;
  let next: Stock;
  let resultLotId: EntityId<'lot'> | null = null;
  if (whole) {
    next = replaceLots(stock, [{ ...lot, loadUnitId: to.id }]);
  } else {
    const room = checkLotRoom(stock, 1);
    if (room) {
      return room;
    }
    const { parent, child } = splitOff(lot, taken, to.id, context);
    resultLotId = child.id;
    next = replaceLots(stock, [parent], [child]);
    if (request.reservationId) {
      next = {
        ...next,
        reservations: next.reservations.map((item) =>
          item.id === request.reservationId ? { ...item, lotId: child.id } : item,
        ),
      };
    }
  }
  const problems = stackProblems(next, facilities, realEstate, to.id);
  if (problems.length > 0) {
    return refusal(problems);
  }
  const entry = movement(context, {
    kind: 'transfer',
    handler: request.handler,
    lines: [
      {
        lotId: lot.id,
        quantityMicro: taken.quantity,
        fromLoadUnitId: from,
        toLoadUnitId: to.id,
        resultLotId,
      },
    ],
    units: [],
    reason: null,
    receiptId: null,
    entryId: null,
    costCents: 0n,
  });
  return outcome(withMovement(next, entry), entry);
}

// ---------------------------------------------------------- split, merge

/**
 * Split a quantity of a lot off into a new lot in the same load unit, so it
 * can be counted, reserved or classified on its own. Items only: part of a
 * bulk solid or liquid cannot be told apart from the rest in one container.
 */
export function splitLot(
  stock: Stock,
  request: {
    readonly lotId: string;
    readonly quantityMicro: bigint;
    readonly serials?: readonly string[] | null;
    readonly handler: StockHandler;
  },
  context: RuleContext,
): (StockOutcome & { readonly lotId: EntityId<'lot'> }) | Rejection {
  const index = indexStock(stock);
  const lot = openLot(index, request.lotId);
  if (lot instanceof Rejection) {
    return lot;
  }
  const product = productOf(index, lot.productId);
  if (product?.form !== 'item') {
    return reject(`Part of a ${product?.form ?? 'lot'} cannot be split off in the same container`);
  }
  const taken = portion(index, lot, request);
  if (taken instanceof Rejection) {
    return taken;
  }
  if (taken.quantity === lot.quantityMicro) {
    return reject('A split leaves part of the lot behind; this is all of it');
  }
  const room = checkLotRoom(stock, 1);
  if (room) {
    return room;
  }
  const unitId = lot.loadUnitId;
  if (unitId === null) {
    throw new Error(`${lot.id} is open but in no load unit`);
  }
  const { parent, child } = splitOff(lot, taken, unitId, context);
  const next = replaceLots(stock, [parent], [child]);
  const problems = capacityProblems(indexStock(next), unitId);
  if (problems.length > 0) {
    return refusal(problems);
  }
  const entry = movement(context, {
    kind: 'split',
    handler: request.handler,
    lines: [
      {
        lotId: lot.id,
        quantityMicro: taken.quantity,
        fromLoadUnitId: unitId,
        toLoadUnitId: unitId,
        resultLotId: child.id,
      },
    ],
    units: [],
    reason: null,
    receiptId: null,
    entryId: null,
    costCents: 0n,
  });
  const recorded = withMovement(next, entry);
  return recorded instanceof Rejection
    ? recorded
    : { stock: recorded, movementId: entry.id, lotId: child.id };
}

/**
 * Merge two or more lots of the same product, grade, disposition and owner
 * in one load unit into a new lot whose parents they are; they close as
 * merged. Reserved lots cannot be merged.
 */
export function mergeLots(
  stock: Stock,
  request: { readonly lotIds: readonly string[]; readonly handler: StockHandler },
  context: RuleContext,
): (StockOutcome & { readonly lotId: EntityId<'lot'> }) | Rejection {
  const index = indexStock(stock);
  const ids = [...new Set(request.lotIds)];
  if (ids.length < 2 || ids.length !== request.lotIds.length) {
    return reject('Name two or more different lots to merge');
  }
  const lots: StockLot[] = [];
  for (const id of ids) {
    const lot = openLot(index, id);
    if (lot instanceof Rejection) {
      return lot;
    }
    lots.push(lot);
  }
  const [first] = lots;
  if (!first) {
    return reject('Name two or more different lots to merge');
  }
  for (const lot of lots) {
    if (
      lot.loadUnitId !== first.loadUnitId ||
      lot.productId !== first.productId ||
      lot.grade !== first.grade ||
      lot.disposition !== first.disposition ||
      lot.ownerFirmId !== first.ownerFirmId
    ) {
      return reject(
        'Only lots of the same product, grade and disposition in the same load unit can be merged',
      );
    }
    if ((index.reserved.get(lot.id) ?? 0n) > 0n) {
      return reject(`Lot ${lot.id} is reserved and cannot be merged`);
    }
  }
  const room = checkLotRoom(stock, 1);
  if (room) {
    return room;
  }
  const quantity = lots.reduce((sum, lot) => sum + lot.quantityMicro, 0n);
  if (quantity > MAX_LOT_QUANTITY_MICRO) {
    return reject('The merged lot would be larger than one lot may be');
  }
  const ordinal = (id: string) => Number(id.slice(id.indexOf(':') + 1));
  const parents = [...lots].sort((a, b) => ordinal(a.id) - ordinal(b.id));
  const merged: StockLot = {
    id: context.allocateId('lot'),
    productId: first.productId,
    ownerFirmId: first.ownerFirmId,
    grade: first.grade,
    disposition: first.disposition,
    quantityMicro: quantity,
    costCents: lots.reduce((sum, lot) => sum + lot.costCents, 0n),
    loadUnitId: first.loadUnitId,
    serials: lots.flatMap((lot) => lot.serials).sort((a, b) => ordinal(a) - ordinal(b)),
    origin: { kind: 'merge' },
    parentLotIds: parents.map((lot) => lot.id),
    createdAtMs: context.nowMs,
    closed: null,
  };
  const closed = lots.map((lot): StockLot => ({
    ...lot,
    quantityMicro: 0n,
    costCents: 0n,
    loadUnitId: null,
    serials: [],
    closed: { atMs: context.nowMs, reason: 'merged', intoLotId: merged.id },
  }));
  const next = replaceLots(stock, closed, [merged]);
  const entry = movement(context, {
    kind: 'merge',
    handler: request.handler,
    lines: parents.map((lot) => ({
      lotId: lot.id,
      quantityMicro: lot.quantityMicro,
      fromLoadUnitId: lot.loadUnitId,
      toLoadUnitId: lot.loadUnitId,
      resultLotId: merged.id,
    })),
    units: [],
    reason: null,
    receiptId: null,
    entryId: null,
    costCents: 0n,
  });
  const recorded = withMovement(next, entry);
  return recorded instanceof Rejection
    ? recorded
    : { stock: recorded, movementId: entry.id, lotId: merged.id };
}

// ------------------------------------------------------------ relocate

/**
 * Move a whole load unit, with everything in and on it, to a floor position
 * or onto or into another load unit (spec §9.3: the commit at the moment it
 * arrives). The route and the time taken are the moving task's (Step 12);
 * this checks the destination: every floor rule, or the carrier's capacity,
 * what it may carry, and that a unit never ends up inside itself.
 */
export function relocateLoadUnit(
  stock: Stock,
  facilities: Facilities,
  realEstate: RealEstate,
  company: Company,
  request: {
    readonly loadUnitId: string;
    readonly to: StockLocation;
    readonly handler: StockHandler;
  },
  context: RuleContext,
): StockOutcome | Rejection {
  const index = indexStock(stock);
  const unit = index.units.get(request.loadUnitId);
  if (!unit) {
    return reject(`There is no load unit ${request.loadUnitId}`);
  }
  const type = typeOfUnit(index, unit);
  const label = unitLabel(index, unit);
  const { to } = request;
  const inside = new Set([unit.id, ...descendantsOf(index, unit.id).map((item) => item.id)]);
  if (type.kind === 'machine-buffer') {
    return reject(`${capitalised(label)} is part of its machine`);
  }
  if (to.kind === 'equipment') {
    return reject('Only a machine buffer stands at a machine port');
  }
  const next: Stock = {
    ...stock,
    loadUnits: stock.loadUnits.map((candidate) =>
      candidate.id === unit.id ? { ...candidate, location: to } : candidate,
    ),
  };
  if (to.kind === 'floor') {
    if (!companyOccupies(realEstate, company, to.propertyId)) {
      return reject(`${company.legalName} does not occupy ${to.propertyId}`);
    }
    const site = siteOf(facilities, realEstate, to.propertyId);
    if (!site) {
      return reject(`There is no property ${to.propertyId}`);
    }
    const problems = floorPlacementProblems(
      site,
      { label, type, grossMassMg: grossMassMg(index, unit.id) },
      to,
      {
        equipment: installedIn(facilities, to.propertyId, null),
        stock: floorObstacles(stock, to.propertyId, inside),
        works: worksAreas(facilities, to.propertyId),
      },
    );
    if (problems.length > 0) {
      return refusal(problems.map((problem) => problem.message));
    }
  } else {
    const carrier = index.units.get(to.loadUnitId);
    if (!carrier) {
      return reject(`There is no load unit ${to.loadUnitId}`);
    }
    if (inside.has(carrier.id)) {
      return reject(`${capitalised(label)} cannot be put inside itself`);
    }
    if (carrier.ownerFirmId !== unit.ownerFirmId) {
      return reject(`${unitLabel(index, carrier)} belongs to someone else`);
    }
    // Carriers above the unit once moved, plus how deep its own contents go.
    const depth = carriersOf(index, carrier.id).length + 1;
    const own = carriersOf(index, unit.id).length;
    const below = Math.max(0, ...[...inside].map((id) => carriersOf(index, id).length - own));
    if (depth + below > MAX_NESTING - 1) {
      return reject(`At most ${MAX_NESTING} load units can be stacked in or on each other`);
    }
    const problems = stackProblems(next, facilities, realEstate, carrier.id);
    if (problems.length > 0) {
      return refusal(problems);
    }
  }
  const entry = movement(context, {
    kind: 'relocation',
    handler: request.handler,
    lines: [],
    units: [{ loadUnitId: unit.id, from: unit.location, to }],
    reason: null,
    receiptId: null,
    entryId: null,
    costCents: 0n,
  });
  return outcome(withMovement(next, entry), entry);
}

// --------------------------------------------------------- reservations

/** Hold back a quantity of an available lot for a purpose (a task, an order). */
export function reserveStock(
  stock: Stock,
  request: { readonly lotId: string; readonly quantityMicro: bigint; readonly purpose: string },
  context: RuleContext,
): { readonly stock: Stock; readonly reservationId: EntityId<'stock-reservation'> } | Rejection {
  const index = indexStock(stock);
  const lot = openLot(index, request.lotId);
  if (lot instanceof Rejection) {
    return lot;
  }
  if (lot.disposition !== 'available') {
    return reject(`Lot ${lot.id} is scrap and cannot be reserved`);
  }
  const taken = portion(index, lot, { quantityMicro: request.quantityMicro });
  if (taken instanceof Rejection) {
    return taken;
  }
  if (stock.reservations.length >= MAX_RESERVATIONS) {
    return reject(`At most ${MAX_RESERVATIONS.toLocaleString('en-US')} reservations can be held`);
  }
  if (request.purpose.length < 1 || request.purpose.length > 60) {
    return reject('A reservation names its purpose in 1–60 characters');
  }
  const reservationId = context.allocateId('stock-reservation');
  return {
    stock: {
      ...stock,
      reservations: [
        ...stock.reservations,
        {
          id: reservationId,
          lotId: lot.id,
          quantityMicro: taken.quantity,
          purpose: request.purpose,
          createdAtMs: context.nowMs,
        },
      ],
    },
    reservationId,
  };
}

export function releaseReservation(stock: Stock, reservationId: string): Stock | Rejection {
  if (!stock.reservations.some((item) => item.id === reservationId)) {
    return reject(`There is no reservation ${reservationId}`);
  }
  return { ...stock, reservations: stock.reservations.filter((item) => item.id !== reservationId) };
}

// --------------------------------------------------- scrap and losses

export interface WriteDownOutcome extends StockOutcome {
  readonly company: Company;
  /** The lot now holding the scrapped quantity (the lot itself when all of it was scrapped). */
  readonly lotId: EntityId<'lot'> | null;
  readonly costCents: Cents;
}

/** Post a write-off of `cost` from Inventory to `account`, if there is anything to write off. */
function writeOff(
  company: Company,
  account: typeof INVENTORY_ACCOUNTS.losses | typeof INVENTORY_ACCOUNTS.scrapped,
  cost: Cents,
  sourceKey: string,
  description: string,
  context: RuleContext,
): { company: Company; entryId: EntityId<'entry'> | null } | Rejection {
  if (cost === 0n) {
    return { company, entryId: null };
  }
  const ledger = ensureAccount(
    ensureAccount(company.ledger, INVENTORY_ACCOUNTS.inventory),
    account,
  );
  const entryId = context.allocateId('entry');
  const posted = postEntry(ledger, {
    id: entryId,
    atMs: context.nowMs,
    description: description.slice(0, 120),
    sourceKey,
    counterpartyId: null,
    lines: [debit(account.code, cost), credit(INVENTORY_ACCOUNTS.inventory.code, cost)],
  });
  return posted instanceof Rejection
    ? posted
    : { company: { ...company, ledger: posted }, entryId };
}

/**
 * Classify a quantity of an available lot as scrap where it stands: nothing
 * moves, its cost is written down to nothing (Dr Inventory written down to
 * scrap, Cr Inventory), and it can no longer be used or reserved. Part of a
 * lot of items becomes a child lot of scrap in the same load unit; a bulk
 * solid or liquid can only be scrapped whole.
 */
export function scrapStock(
  stock: Stock,
  company: Company,
  request: {
    readonly lotId: string;
    readonly quantityMicro: bigint;
    readonly serials?: readonly string[] | null;
    readonly reason: ScrapReason;
  },
  context: RuleContext,
): WriteDownOutcome | Rejection {
  const index = indexStock(stock);
  const lot = openLot(index, request.lotId);
  if (lot instanceof Rejection) {
    return lot;
  }
  if (lot.ownerFirmId !== company.firmId) {
    return reject(`Lot ${lot.id} belongs to someone else`);
  }
  if (lot.disposition === 'scrap') {
    return reject(`Lot ${lot.id} is already scrap`);
  }
  const product = productOf(index, lot.productId);
  const taken = portion(index, lot, request);
  if (taken instanceof Rejection) {
    return taken;
  }
  const whole = taken.quantity === lot.quantityMicro;
  if (!whole && product?.form !== 'item') {
    return reject(
      `Part of a ${product?.form ?? 'lot'} cannot be told apart in its container; scrap the whole lot`,
    );
  }
  const unitId = lot.loadUnitId;
  if (unitId === null) {
    throw new Error(`${lot.id} is open but in no load unit`);
  }
  let next: Stock;
  let scrapLot: StockLot;
  if (whole) {
    scrapLot = { ...lot, disposition: 'scrap', costCents: 0n };
    next = replaceLots(stock, [scrapLot]);
  } else {
    const room = checkLotRoom(stock, 1);
    if (room) {
      return room;
    }
    const { parent, child } = splitOff(lot, taken, unitId, context);
    scrapLot = { ...child, disposition: 'scrap', costCents: 0n };
    next = replaceLots(stock, [parent], [scrapLot]);
    const problems = capacityProblems(indexStock(next), unitId);
    if (problems.length > 0) {
      return refusal(problems);
    }
  }
  const cost = whole ? lot.costCents : costShare(lot.costCents, taken.quantity, lot.quantityMicro);
  const moveId = context.allocateId('stock-move');
  const posted = writeOff(
    company,
    INVENTORY_ACCOUNTS.scrapped,
    cost,
    moveId,
    `Scrapped (${request.reason}): ${product ? qty(product, taken.quantity) : ''} of ${product?.name ?? lot.productId}, ${lot.id}`,
    context,
  );
  if (posted instanceof Rejection) {
    return posted;
  }
  const entry: StockMovement = {
    id: moveId,
    atMs: context.nowMs,
    kind: 'scrap',
    handler: { kind: 'company' },
    lines: [
      {
        lotId: lot.id,
        quantityMicro: taken.quantity,
        fromLoadUnitId: unitId,
        toLoadUnitId: unitId,
        resultLotId: whole ? null : scrapLot.id,
      },
    ],
    units: [],
    reason: request.reason,
    receiptId: null,
    entryId: posted.entryId,
    costCents: cost,
  };
  const recorded = withMovement(next, entry);
  if (recorded instanceof Rejection) {
    return recorded;
  }
  return {
    stock: recorded,
    company: posted.company,
    movementId: moveId,
    lotId: scrapLot.id,
    costCents: cost,
  };
}

/**
 * A quantity leaves the world for a recorded physical cause (destroyed in
 * handling, spilled, found missing): the lot is reduced, or closed as lost
 * when nothing remains, and the cost of what was lost is written off (Dr
 * Inventory losses, Cr Inventory). There is no player command for this: a
 * loss needs a cause, and the steps that bring causes (handling, Step 12;
 * failures and quality, Step 27) call it.
 */
export function loseStock(
  stock: Stock,
  company: Company,
  request: {
    readonly lotId: string;
    readonly quantityMicro: bigint;
    readonly serials?: readonly string[] | null;
    readonly reason: LossReason;
    readonly handler: StockHandler;
  },
  context: RuleContext,
): WriteDownOutcome | Rejection {
  const index = indexStock(stock);
  const lot = openLot(index, request.lotId);
  if (lot instanceof Rejection) {
    return lot;
  }
  if (lot.ownerFirmId !== company.firmId) {
    return reject(`Lot ${lot.id} belongs to someone else`);
  }
  const product = productOf(index, lot.productId);
  const taken = portion(index, lot, request);
  if (taken instanceof Rejection) {
    return taken;
  }
  const whole = taken.quantity === lot.quantityMicro;
  const cost = whole ? lot.costCents : costShare(lot.costCents, taken.quantity, lot.quantityMicro);
  const lost = new Set<string>(taken.serials);
  const unitId = lot.loadUnitId;
  const remaining: StockLot = whole
    ? {
        ...lot,
        quantityMicro: 0n,
        costCents: 0n,
        loadUnitId: null,
        serials: [],
        closed: { atMs: context.nowMs, reason: 'lost', intoLotId: null },
      }
    : {
        ...lot,
        quantityMicro: lot.quantityMicro - taken.quantity,
        costCents: lot.costCents - cost,
        serials: lot.serials.filter((serial) => !lost.has(serial)),
      };
  const moveId = context.allocateId('stock-move');
  const posted = writeOff(
    company,
    INVENTORY_ACCOUNTS.losses,
    cost,
    moveId,
    `Lost (${request.reason}): ${product ? qty(product, taken.quantity) : ''} of ${product?.name ?? lot.productId}, ${lot.id}`,
    context,
  );
  if (posted instanceof Rejection) {
    return posted;
  }
  const entry: StockMovement = {
    id: moveId,
    atMs: context.nowMs,
    kind: 'loss',
    handler: request.handler,
    lines: [
      {
        lotId: lot.id,
        quantityMicro: taken.quantity,
        fromLoadUnitId: unitId,
        toLoadUnitId: null,
        resultLotId: null,
      },
    ],
    units: [],
    reason: request.reason,
    receiptId: null,
    entryId: posted.entryId,
    costCents: cost,
  };
  const recorded = withMovement(replaceLots(stock, [remaining]), entry);
  if (recorded instanceof Rejection) {
    return recorded;
  }
  return {
    stock: recorded,
    company: posted.company,
    movementId: moveId,
    lotId: lot.id,
    costCents: cost,
  };
}
