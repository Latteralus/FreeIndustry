import type { Cents } from '../shared/money';
import type { Rotation } from './equipment';
import type { EntityId } from './ids';
import type { RectMm } from './region';
import type { SimTimeMs } from './time';

/**
 * Physical stock (spec §5.3, §5.5; plan Step 10; DECISIONS ADR-0053 –
 * ADR-0055): what goods are, how much there is of them, and exactly where
 * every quantity is.
 *
 * - A **product** is data: its base unit, the smallest quantity the
 *   simulation handles (its *quantum*: one item, one gram, one millilitre),
 *   the exact mass and volume of each quantum, its pack units and quality
 *   grades.
 * - Quantities are `bigint` millionths of the base unit (spec §11.1
 *   `QuantityMicro`) and always a whole number of quanta, so mass and volume
 *   follow in integer arithmetic and nothing drifts.
 * - A **lot** is an exactly counted quantity of one product, of one grade
 *   and owner, in exactly one load unit. Serialized products also list the
 *   serial of every item. A lot records where it came from: a receipt, or
 *   the lots it was split from or merged out of.
 * - A **load unit** (pallet, crate, carton, tote, drum, bulk bag, cart,
 *   machine buffer) is a physical container with a capacity. It stands on a
 *   floor at an exact position, sits in or on another load unit, or is a
 *   machine's port buffer.
 * - Every change is a recorded **movement** with who handled it.
 *
 * This module holds the definitions, the quantity arithmetic and the
 * capacity rules. The operations are in `stock-operations.ts`, floor
 * placement in `stock-floor.ts` and the invariants in `stock-invariants.ts`.
 */

// ------------------------------------------------------------ products

export const BASE_UNITS = ['each', 'kg', 'L'] as const;
type BaseUnit = (typeof BASE_UNITS)[number];

/** What a product physically is: discrete items, a loose solid, or a liquid. */
export const PRODUCT_FORMS = ['item', 'bulk', 'liquid'] as const;
type ProductForm = (typeof PRODUCT_FORMS)[number];

/** `serialized`: every item has its own identity. `lot`: interchangeable units in counted lots. */
export const TRACKING_KINDS = ['lot', 'serialized'] as const;
type Tracking = (typeof TRACKING_KINDS)[number];

export const PRODUCT_CATEGORIES = [
  'lumber',
  'sheet-goods',
  'hardware',
  'metal',
  'plastics',
  'coatings',
  'components',
] as const;
type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** Millionths of a base unit per base unit (spec §11.1 `QuantityMicro`). */
export const MICRO_PER_UNIT = 1_000_000n;

/** The largest quantity one lot may hold: 10⁹ base units. */
export const MAX_LOT_QUANTITY_MICRO = 10n ** 15n;
/** Most items one serialized lot may list (bounded state). */
export const MAX_SERIALS_PER_LOT = 10_000;

/** A unit the product is counted or ordered in: a box of 200, a 25 kg bag. */
interface PackUnit {
  readonly id: string;
  readonly name: string;
  /** How many quanta one pack holds. */
  readonly quanta: number;
}

interface ProductGrade {
  readonly code: string;
  readonly name: string;
}

export interface Box3Mm {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly category: ProductCategory;
  readonly description: string;
  readonly unit: BaseUnit;
  readonly form: ProductForm;
  readonly tracking: Tracking;
  /** The smallest quantity handled, in millionths of the base unit: 10⁶ for one item. */
  readonly quantumMicro: bigint;
  /** Size of one item; null for bulk solids and liquids. */
  readonly itemMm: Box3Mm | null;
  /** Mass of one quantum in milligrams, exact. */
  readonly massPerQuantumMg: bigint;
  /** Volume one quantum occupies in mm³: an item's box, or a measured bulk or liquid volume. */
  readonly volumePerQuantumMm3: bigint;
  readonly packUnits: readonly PackUnit[];
  /** Quality grades, best first; a lot has exactly one. */
  readonly grades: readonly ProductGrade[];
  /** Colour of the goods as seen from above, for the factory view. */
  readonly colour: string;
}

// ------------------------------------------------------ container types

export const CONTAINER_KINDS = [
  'pallet',
  'crate',
  'carton',
  'tote',
  'drum',
  'bulk-bag',
  'cart',
  'machine-buffer',
] as const;
type ContainerKind = (typeof CONTAINER_KINDS)[number];

/** Platforms carry their load on top, inside a load envelope above the deck. */
const PLATFORM_KINDS: readonly ContainerKind[] = ['pallet', 'cart'];

/**
 * How lots may share a container: `mixed` (any products), `single-product`
 * (lots of one product), `single-lot` (one lot). A container holding a bulk
 * solid or a liquid holds exactly one lot whatever its rule: poured together,
 * two lots blend and can no longer be told apart.
 */
export const MIXING_RULES = ['mixed', 'single-product', 'single-lot'] as const;
type Mixing = (typeof MIXING_RULES)[number];

export interface ContainerType {
  readonly id: string;
  readonly name: string;
  readonly kind: ContainerKind;
  readonly description: string;
  /** Outside dimensions; the floor footprint is width × depth. */
  readonly outerMm: Box3Mm;
  /** The space the contents may occupy: inside the container, or the load envelope above a platform. */
  readonly innerMm: Box3Mm;
  readonly tareMassG: number;
  /** Most mass of contents (goods and carried load units) it may hold. */
  readonly payloadMassG: number;
  readonly holds: readonly ProductForm[];
  /** Kinds of load unit it may carry or contain. */
  readonly carries: readonly ContainerKind[];
  readonly mixing: Mixing;
  readonly colour: string;
}

function isPlatform(type: Pick<ContainerType, 'kind'>): boolean {
  return PLATFORM_KINDS.includes(type.kind);
}

/** How tall the unit may stand when fully loaded: the deck plus its envelope, or its outside. */
export function maxHeightMm(type: ContainerType): number {
  return isPlatform(type) ? type.outerMm.height + type.innerMm.height : type.outerMm.height;
}

// ------------------------------------------------------- where things are

/**
 * Where a load unit is.
 * - `floor`: standing on a level of a building; the position is the minimum
 *   corner of its turned footprint, in integer millimetres (stock is not
 *   bound to the 250 mm placement lattice, ADR-0054).
 * - `load-unit`: in or on another load unit (cartons on a pallet).
 * - `equipment`: a machine buffer at one of an installed item's port zones.
 */
export type StockLocation =
  | {
      readonly kind: 'floor';
      readonly propertyId: string;
      readonly level: number;
      readonly xMm: number;
      readonly yMm: number;
      readonly rotation: Rotation;
    }
  | { readonly kind: 'load-unit'; readonly loadUnitId: EntityId<'load-unit'> }
  | {
      readonly kind: 'equipment';
      readonly equipmentId: EntityId<'equipment'>;
      /** Index of the port zone in the equipment type's zones. */
      readonly zone: number;
    };

export type FloorLocation = Extract<StockLocation, { kind: 'floor' }>;

export interface LoadUnit {
  readonly id: EntityId<'load-unit'>;
  readonly typeId: string;
  readonly ownerFirmId: EntityId<'firm'>;
  readonly location: StockLocation;
  readonly createdAtMs: SimTimeMs;
  /** The receipt that brought it in, if it arrived from outside. */
  readonly receiptId: EntityId<'stock-receipt'> | null;
}

/** The footprint of a load unit standing on the floor. */
export function floorFootprint(type: ContainerType, location: FloorLocation): RectMm {
  const quarter = location.rotation === 90 || location.rotation === 270;
  return {
    x: location.xMm,
    y: location.yMm,
    width: quarter ? type.outerMm.depth : type.outerMm.width,
    depth: quarter ? type.outerMm.width : type.outerMm.depth,
  };
}

// ----------------------------------------------------------------- lots

/** `available` stock may be used; `scrap` is kept physically but written down and not usable. */
export const DISPOSITIONS = ['available', 'scrap'] as const;
type Disposition = (typeof DISPOSITIONS)[number];

/** How a lot came to exist. Split and merge lots name their parents in `parentLotIds`. */
export type LotOrigin =
  | { readonly kind: 'receipt'; readonly receiptId: EntityId<'stock-receipt'> }
  | { readonly kind: 'split' }
  | { readonly kind: 'merge' };

export const LOT_CLOSURES = ['merged', 'lost'] as const;
type LotClosure = (typeof LOT_CLOSURES)[number];

export interface StockLot {
  readonly id: EntityId<'lot'>;
  readonly productId: string;
  readonly ownerFirmId: EntityId<'firm'>;
  readonly grade: string;
  readonly disposition: Disposition;
  /** Exact quantity now held; zero once closed. */
  readonly quantityMicro: bigint;
  /** What the quantity held cost (zero for scrap and closed lots). */
  readonly costCents: Cents;
  /** The one load unit holding it; null once closed. */
  readonly loadUnitId: EntityId<'load-unit'> | null;
  /** Serialized products: the serial of every item held, in ascending order. */
  readonly serials: readonly EntityId<'serial'>[];
  readonly origin: LotOrigin;
  readonly parentLotIds: readonly EntityId<'lot'>[];
  readonly createdAtMs: SimTimeMs;
  /** Set when nothing of it remains: merged into another lot, or lost. */
  readonly closed: {
    readonly atMs: SimTimeMs;
    readonly reason: LotClosure;
    readonly intoLotId: EntityId<'lot'> | null;
  } | null;
}

// ------------------------------------------------- receipts and history

/**
 * Goods arriving from outside the company: who delivered them, through which
 * door, what they cost and the invoice that paid for them. Until purchasing
 * (Step 14) the only receipts are the development-only test deliveries.
 */
export interface StockReceipt {
  readonly id: EntityId<'stock-receipt'>;
  readonly kind: 'diagnostic';
  readonly atMs: SimTimeMs;
  readonly supplierPartyId: EntityId<'party'>;
  readonly invoiceId: EntityId<'invoice'>;
  readonly costCents: Cents;
  readonly propertyId: string;
  /** The goods door it came through (index in the listing's doors). */
  readonly doorIndex: number;
  readonly productId: string;
  readonly quantityMicro: bigint;
  readonly lotIds: readonly EntityId<'lot'>[];
  readonly loadUnitIds: readonly EntityId<'load-unit'>[];
}

/**
 * Who physically handled a movement or decided a classification.
 * - `supplier`: a supplier's driver unloading a delivery;
 * - `company`: a decision of the company's management (the player);
 * - `employee`: a named employee (staff arrive with Step 11; tasks that move
 *   stock with Step 12).
 */
export type StockHandler =
  | { readonly kind: 'supplier'; readonly partyId: EntityId<'party'> }
  | { readonly kind: 'company' }
  | { readonly kind: 'employee'; readonly personId: EntityId<'person'> };

export const MOVEMENT_KINDS = [
  'receipt',
  'transfer',
  'split',
  'merge',
  'relocation',
  'scrap',
  'loss',
] as const;
type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** Why stock was scrapped (stays physically present) or lost (left the world). */
export const SCRAP_REASONS = ['damaged', 'defective', 'contaminated', 'obsolete'] as const;
export type ScrapReason = (typeof SCRAP_REASONS)[number];
export const LOSS_REASONS = ['destroyed', 'spilled', 'missing'] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

/** A quantity of a lot taking part in a movement. */
export interface MovementLine {
  readonly lotId: EntityId<'lot'>;
  readonly quantityMicro: bigint;
  readonly fromLoadUnitId: EntityId<'load-unit'> | null;
  readonly toLoadUnitId: EntityId<'load-unit'> | null;
  /** The lot the quantity became: a split's child or a merge's result; null when it stayed itself. */
  readonly resultLotId: EntityId<'lot'> | null;
}

/** A load unit placed or moved by a movement. */
export interface MovementUnit {
  readonly loadUnitId: EntityId<'load-unit'>;
  /** Null when it came from outside the world (a delivery). */
  readonly from: StockLocation | null;
  readonly to: StockLocation;
}

export interface StockMovement {
  readonly id: EntityId<'stock-move'>;
  readonly atMs: SimTimeMs;
  readonly kind: MovementKind;
  readonly handler: StockHandler;
  readonly lines: readonly MovementLine[];
  readonly units: readonly MovementUnit[];
  readonly reason: ScrapReason | LossReason | null;
  readonly receiptId: EntityId<'stock-receipt'> | null;
  /** The ledger entry of a write-down or a loss; null otherwise. */
  readonly entryId: EntityId<'entry'> | null;
  /** The cost the entry wrote off (zero when nothing was posted). */
  readonly costCents: Cents;
}

/** A quantity of a lot held back for a purpose (a task, an order), so nothing else may use it. */
interface StockReservation {
  readonly id: EntityId<'stock-reservation'>;
  readonly lotId: EntityId<'lot'>;
  readonly quantityMicro: bigint;
  /** What it is held for, e.g. `task:3`. */
  readonly purpose: string;
  readonly createdAtMs: SimTimeMs;
}

/**
 * The stock slice of the world (ADR-0055): the product and container
 * catalogs the world was built with, and every receipt, load unit, lot,
 * movement and reservation. Null in worlds made before Step 10.
 */
export interface Stock {
  readonly products: readonly Product[];
  readonly containerTypes: readonly ContainerType[];
  readonly receipts: readonly StockReceipt[];
  readonly loadUnits: readonly LoadUnit[];
  readonly lots: readonly StockLot[];
  readonly movements: readonly StockMovement[];
  readonly reservations: readonly StockReservation[];
}

/** Bounded state (revisit with Step 33). */
export const MAX_LOAD_UNITS = 5_000;
export const MAX_LOTS = 50_000;
export const MAX_MOVEMENTS = 200_000;
export const MAX_RESERVATIONS = 10_000;
/** Deepest nesting of load units: a carton in a crate on a pallet on a cart. */
export const MAX_NESTING = 4;

// ------------------------------------------------- quantity arithmetic

export function isWholeQuantity(product: Product, quantityMicro: bigint): boolean {
  return quantityMicro >= 0n && quantityMicro % product.quantumMicro === 0n;
}

/** How many quanta a quantity is; throws if it is not a whole number of them. */
export function quantaOf(product: Product, quantityMicro: bigint): bigint {
  if (!isWholeQuantity(product, quantityMicro)) {
    throw new RangeError(
      `${quantityMicro} µ${product.unit} of ${product.id} is not a whole number of quanta`,
    );
  }
  return quantityMicro / product.quantumMicro;
}

/** Exact mass of a quantity in milligrams. */
export function massOfMg(product: Product, quantityMicro: bigint): bigint {
  return quantaOf(product, quantityMicro) * product.massPerQuantumMg;
}

/** Exact volume a quantity occupies in mm³. */
export function volumeOfMm3(product: Product, quantityMicro: bigint): bigint {
  return quantaOf(product, quantityMicro) * product.volumePerQuantumMm3;
}

/** The quantity of `count` packs of a pack unit, exactly. */
export function packQuantityMicro(product: Product, packUnitId: string, count: bigint): bigint {
  const pack = product.packUnits.find((unit) => unit.id === packUnitId);
  if (!pack) {
    throw new RangeError(`${product.id} has no pack unit ${packUnitId}`);
  }
  return count * BigInt(pack.quanta) * product.quantumMicro;
}

/** Whole items in a quantity of a counted product. */
export function itemCount(quantityMicro: bigint): bigint {
  return quantityMicro / MICRO_PER_UNIT;
}

const sorted3 = (box: Box3Mm) => [box.width, box.depth, box.height].sort((a, b) => a - b);

/** Whether a box fits inside another in some orientation (axis-aligned). */
export function boxFits(item: Box3Mm, space: Box3Mm): boolean {
  const a = sorted3(item);
  const b = sorted3(space);
  return a.every((value, index) => value <= (b[index] ?? 0));
}

export function boxVolumeMm3(box: Box3Mm): bigint {
  return BigInt(box.width) * BigInt(box.depth) * BigInt(box.height);
}

/**
 * A cost split in proportion to quantity: `part` of `whole` takes this much
 * of `costCents`, rounded half up; the rest stays with the remainder, so the
 * two always add up exactly.
 */
export function costShare(costCents: Cents, part: bigint, whole: bigint): Cents {
  if (part === whole) {
    return costCents;
  }
  return (2n * costCents * part + whole) / (2n * whole);
}

// ------------------------------------------------------------ lookups

/** Lookup tables over a stock slice, built once per check. */
export interface StockIndex {
  readonly stock: Stock;
  readonly products: ReadonlyMap<string, Product>;
  readonly types: ReadonlyMap<string, ContainerType>;
  readonly units: ReadonlyMap<string, LoadUnit>;
  readonly lots: ReadonlyMap<string, StockLot>;
  /** Open lots by the load unit holding them. */
  readonly lotsIn: ReadonlyMap<string, readonly StockLot[]>;
  /** Load units by the load unit carrying them. */
  readonly childrenOf: ReadonlyMap<string, readonly LoadUnit[]>;
  /** Reserved quantity by lot. */
  readonly reserved: ReadonlyMap<string, bigint>;
}

const indexCache = new WeakMap<Stock, StockIndex>();

export function indexStock(stock: Stock): StockIndex {
  const cached = indexCache.get(stock);
  if (cached) {
    return cached;
  }
  const lotsIn = new Map<string, StockLot[]>();
  for (const lot of stock.lots) {
    if (lot.loadUnitId !== null) {
      lotsIn.set(lot.loadUnitId, [...(lotsIn.get(lot.loadUnitId) ?? []), lot]);
    }
  }
  const childrenOf = new Map<string, LoadUnit[]>();
  for (const unit of stock.loadUnits) {
    if (unit.location.kind === 'load-unit') {
      const parent = unit.location.loadUnitId;
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), unit]);
    }
  }
  const reserved = new Map<string, bigint>();
  for (const reservation of stock.reservations) {
    reserved.set(
      reservation.lotId,
      (reserved.get(reservation.lotId) ?? 0n) + reservation.quantityMicro,
    );
  }
  const index: StockIndex = {
    stock,
    products: new Map(stock.products.map((product) => [product.id, product])),
    types: new Map(stock.containerTypes.map((type) => [type.id, type])),
    units: new Map(stock.loadUnits.map((unit) => [unit.id, unit])),
    lots: new Map(stock.lots.map((lot) => [lot.id, lot])),
    lotsIn,
    childrenOf,
    reserved,
  };
  indexCache.set(stock, index);
  return index;
}

/** Quantity of a lot not held by any reservation. */
export function unreservedMicro(index: StockIndex, lot: StockLot): bigint {
  return lot.quantityMicro - (index.reserved.get(lot.id) ?? 0n);
}

/** The load units carrying `unitId`, nearest first; stops at a cycle. */
export function carriersOf(index: StockIndex, unitId: string): LoadUnit[] {
  const chain: LoadUnit[] = [];
  const seen = new Set<string>([unitId]);
  let current = index.units.get(unitId);
  while (current?.location.kind === 'load-unit') {
    const parent = index.units.get(current.location.loadUnitId);
    if (!parent || seen.has(parent.id)) {
      break;
    }
    seen.add(parent.id);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** The unit at the bottom of the stack `unitId` is part of (itself if it is not carried). */
export function rootUnitOf(index: StockIndex, unitId: string): LoadUnit | undefined {
  const chain = carriersOf(index, unitId);
  return chain.at(-1) ?? index.units.get(unitId);
}

/** Every load unit inside `unitId`, at any depth (bounded by MAX_NESTING and cycles). */
export function descendantsOf(index: StockIndex, unitId: string): LoadUnit[] {
  const found: LoadUnit[] = [];
  const seen = new Set<string>([unitId]);
  const visit = (id: string, depth: number) => {
    if (depth > MAX_NESTING + 1) {
      return;
    }
    for (const child of index.childrenOf.get(id) ?? []) {
      if (!seen.has(child.id)) {
        seen.add(child.id);
        found.push(child);
        visit(child.id, depth + 1);
      }
    }
  };
  visit(unitId, 1);
  return found;
}

// --------------------------------------------------------- mass and volume

/** Mass of the goods in a lot. */
export function lotMassMg(index: StockIndex, lot: StockLot): bigint {
  const product = index.products.get(lot.productId);
  return product ? massOfMg(product, lot.quantityMicro) : 0n;
}

/** Mass of everything in or on a load unit: its lots and the gross mass of the units it carries. */
export function contentsMassMg(index: StockIndex, unitId: string, depth = 0): bigint {
  let mass = 0n;
  for (const lot of index.lotsIn.get(unitId) ?? []) {
    mass += lotMassMg(index, lot);
  }
  if (depth <= MAX_NESTING) {
    for (const child of index.childrenOf.get(unitId) ?? []) {
      mass += grossMassMg(index, child.id, depth + 1);
    }
  }
  return mass;
}

/** A load unit's own mass plus everything in or on it. */
export function grossMassMg(index: StockIndex, unitId: string, depth = 0): bigint {
  const unit = index.units.get(unitId);
  const type = unit && index.types.get(unit.typeId);
  const tare = type ? BigInt(type.tareMassG) * 1000n : 0n;
  return tare + contentsMassMg(index, unitId, depth);
}

/** Space the contents of a load unit take up: the goods' volume plus each carried unit's outside. */
export function contentsVolumeMm3(index: StockIndex, unitId: string): bigint {
  let volume = 0n;
  for (const lot of index.lotsIn.get(unitId) ?? []) {
    const product = index.products.get(lot.productId);
    volume += product ? volumeOfMm3(product, lot.quantityMicro) : 0n;
  }
  for (const child of index.childrenOf.get(unitId) ?? []) {
    const type = index.types.get(child.typeId);
    volume += type ? boxVolumeMm3(type.outerMm) : 0n;
  }
  return volume;
}

// ----------------------------------------------------------- capacity

const FORM_NAME: Record<ProductForm, string> = {
  item: 'items',
  bulk: 'loose bulk material',
  liquid: 'liquids',
};

const kg = (mg: bigint) =>
  `${(Number(mg / 1000n) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} kg`;
const litres = (mm3: bigint) =>
  `${(Number(mm3 / 1000n) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} L`;

/**
 * Why the contents of a load unit do not fit it; empty when they do. Checks
 * first what it may hold and carry, every item and carried unit against the
 * inner dimensions, how lots may share it and that a bulk solid or liquid is
 * one lot; then mass against the payload and volume against the inner space.
 */
export function capacityProblems(index: StockIndex, unitId: string): string[] {
  const unit = index.units.get(unitId);
  const type = unit && index.types.get(unit.typeId);
  if (!unit || !type) {
    return [`${unitId} has no known container type`];
  }
  const problems: string[] = [];
  const name = `the ${type.name} ${unit.id}`;
  const lots = index.lotsIn.get(unitId) ?? [];
  const children = index.childrenOf.get(unitId) ?? [];
  const products = new Set<string>();
  let fluids = 0;
  for (const lot of lots) {
    const product = index.products.get(lot.productId);
    if (!product) {
      problems.push(`${lot.id} is of unknown product ${lot.productId}`);
      continue;
    }
    products.add(product.id);
    if (!type.holds.includes(product.form)) {
      problems.push(`${name} cannot hold ${FORM_NAME[product.form]} (${product.name})`);
    }
    if (product.form !== 'item') {
      fluids += 1;
    } else if (product.itemMm && !boxFits(product.itemMm, type.innerMm)) {
      problems.push(`${product.name} (${dims(product.itemMm)}) does not fit in ${name}`);
    }
  }
  if (fluids > 0 && lots.length > 1) {
    problems.push(`${name} holds a bulk solid or liquid, so it can hold only one lot`);
  }
  if (type.mixing === 'single-lot' && lots.length > 1) {
    problems.push(`${name} holds one lot at a time`);
  }
  if (type.mixing === 'single-product' && products.size > 1) {
    problems.push(`${name} holds one product at a time`);
  }
  for (const child of children) {
    const childType = index.types.get(child.typeId);
    if (!childType) {
      problems.push(`${child.id} has no known container type`);
      continue;
    }
    if (!type.carries.includes(childType.kind)) {
      problems.push(`${name} cannot carry a ${childType.name}`);
    } else if (!boxFits(childType.outerMm, type.innerMm)) {
      problems.push(`the ${childType.name} ${child.id} does not fit on or in ${name}`);
    }
  }
  const mass = contentsMassMg(index, unitId);
  const payload = BigInt(type.payloadMassG) * 1000n;
  if (mass > payload) {
    problems.push(`${name} would carry ${kg(mass)}; it is rated for ${kg(payload)}`);
  }
  const volume = contentsVolumeMm3(index, unitId);
  const space = boxVolumeMm3(type.innerMm);
  if (volume > space) {
    problems.push(`the contents of ${name} take ${litres(volume)}; it holds ${litres(space)}`);
  }
  return problems;
}

const dims = (box: Box3Mm) =>
  `${box.width.toLocaleString('en-US')} × ${box.depth.toLocaleString('en-US')} × ${box.height.toLocaleString('en-US')} mm`;

// ---------------------------------------------------- catalog validation

const MAX_DIMENSION_MM = 20_000;
const MAX_MASS_PER_QUANTUM_MG = 10n ** 9n;
const MAX_VOLUME_PER_QUANTUM_MM3 = 10n ** 12n;

function boxProblems(box: Box3Mm, what: string): string[] {
  return [box.width, box.depth, box.height].some(
    (value) => !Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION_MM,
  )
    ? [`${what} must be 1–${MAX_DIMENSION_MM.toLocaleString('en-US')} mm each way`]
    : [];
}

function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** Why a product definition is physically impossible; empty when it is sound. */
export function productProblems(product: Product): string[] {
  const problems: string[] = [];
  if (product.form === 'item') {
    if (product.unit !== 'each') {
      problems.push('items are counted each');
    }
    if (product.quantumMicro !== MICRO_PER_UNIT) {
      problems.push('items are handled one at a time (quantum 1 each)');
    }
    if (!product.itemMm) {
      problems.push('an item needs its dimensions');
    } else {
      problems.push(...boxProblems(product.itemMm, 'an item'));
      if (
        boxProblems(product.itemMm, '').length === 0 &&
        product.volumePerQuantumMm3 !== boxVolumeMm3(product.itemMm)
      ) {
        problems.push("an item's volume must be its dimensions' product");
      }
    }
  } else {
    if (product.itemMm !== null) {
      problems.push('bulk solids and liquids have no item dimensions');
    }
    if (product.form === 'bulk' && product.unit !== 'kg') {
      problems.push('a bulk solid is measured in kg');
    }
    if (product.form === 'liquid' && product.unit !== 'L') {
      problems.push('a liquid is measured in L');
    }
    if (product.tracking === 'serialized') {
      problems.push('only items can be serialized');
    }
  }
  if (product.quantumMicro < 1n || product.quantumMicro > MICRO_PER_UNIT) {
    problems.push('the quantum must be 1 µ to 1 base unit');
  } else if (MICRO_PER_UNIT % product.quantumMicro !== 0n) {
    problems.push('the quantum must divide one base unit exactly');
  }
  if (product.massPerQuantumMg < 1n || product.massPerQuantumMg > MAX_MASS_PER_QUANTUM_MG) {
    problems.push('the mass of a quantum must be 1 mg to 1 t');
  }
  if (
    product.volumePerQuantumMm3 < 1n ||
    product.volumePerQuantumMm3 > MAX_VOLUME_PER_QUANTUM_MM3
  ) {
    problems.push('the volume of a quantum must be 1 mm³ to 1,000 m³');
  }
  if (product.grades.length < 1 || product.grades.length > 6) {
    problems.push('a product has 1–6 quality grades');
  }
  if (!distinct(product.grades.map((grade) => grade.code))) {
    problems.push('grade codes must be distinct');
  }
  if (product.packUnits.length > 8 || !distinct(product.packUnits.map((pack) => pack.id))) {
    problems.push('a product has at most 8 distinct pack units');
  }
  for (const pack of product.packUnits) {
    if (!Number.isSafeInteger(pack.quanta) || pack.quanta < 1 || pack.quanta > 10_000_000) {
      problems.push(`pack unit ${pack.id} must hold 1–10,000,000 quanta`);
    }
  }
  return problems;
}

/** Why a container type is physically impossible; empty when it is sound. */
export function containerTypeProblems(type: ContainerType): string[] {
  const problems = [
    ...boxProblems(type.outerMm, 'the outside'),
    ...boxProblems(type.innerMm, 'the inside'),
  ];
  if (problems.length === 0) {
    const { outerMm: outer, innerMm: inner } = type;
    if (inner.width > outer.width || inner.depth > outer.depth) {
      problems.push('the inside must lie within the footprint');
    }
    if (!isPlatform(type) && inner.height > outer.height) {
      problems.push('the inside must lie within the outside');
    }
  }
  if (!Number.isSafeInteger(type.tareMassG) || type.tareMassG < 1 || type.tareMassG > 10_000_000) {
    problems.push('the tare must be 1 g to 10 t');
  }
  if (
    !Number.isSafeInteger(type.payloadMassG) ||
    type.payloadMassG < 1 ||
    type.payloadMassG > 10_000_000
  ) {
    problems.push('the payload must be 1 g to 10 t');
  }
  if (type.holds.length === 0 && type.carries.length === 0) {
    problems.push('it must hold goods or carry load units');
  }
  if (!distinct(type.holds) || !distinct(type.carries)) {
    problems.push('what it holds and carries must be listed once each');
  }
  if (isPlatform(type) && type.holds.includes('liquid')) {
    problems.push('an open platform cannot hold a liquid');
  }
  if (type.kind === 'machine-buffer' && type.carries.length > 0) {
    problems.push('a machine buffer holds goods, not load units');
  }
  return problems;
}
