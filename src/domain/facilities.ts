import { formatUsd, MAX_AMOUNT_CENTS, type Cents } from '../shared/money';
import { ensureCounterparty, type Company, type RuleContext } from './company';
import {
  equipmentTypeProblems,
  fundsMessage,
  layoutProblems,
  placementProblems,
  standing,
  type Equipment,
  type EquipmentType,
  type Placement,
  type PlacementProblem,
} from './equipment';
import {
  buildingProblems,
  levelGeometry,
  levelOf,
  type Building,
  type LevelGeometry,
} from './facility';
import {
  coveringProblems,
  floorMaterialProblems,
  type CoveringInstallation,
  type FloorCovering,
  type FloorMaterial,
} from './floor-covering';
import type { EntityId } from './ids';
import { availableFundsCents, invoiceOf, issueInvoice, recordPayment } from './invoicing';
import { ensureAccount, EQUIPMENT_ACCOUNTS } from './ledger';
import type { Property, RealEstate } from './real-estate';
import { reject, Rejection } from './rejection';

/**
 * The facilities slice of the world (plan Step 08; DECISIONS ADR-0046 –
 * ADR-0048): the floor materials and equipment catalog the world was built
 * with, the structure of every building, the equipment the company owns and
 * where it stands, and the sparse floor-covering layer. Null in worlds made
 * before Step 08.
 *
 * Buying equipment is a real purchase through the books: the dealer
 * invoices the price (an asset, Machinery and equipment) and is paid at
 * once. The dealer holds the item until it is installed; the first
 * installation is included in the price. Installing it again after removal,
 * or moving it, is a rigging job the dealer charges for (an expense).
 * Installing is refused unless every placement rule holds.
 */

export interface Facilities {
  readonly floorMaterials: readonly FloorMaterial[];
  readonly equipmentTypes: readonly EquipmentType[];
  readonly buildings: readonly Building[];
  readonly equipment: readonly Equipment[];
  readonly coverings: readonly FloorCovering[];
  readonly installations: readonly CoveringInstallation[];
}

/** Largest number of items one order may buy. */
const MAX_ORDER_QUANTITY = 20;
/** Most items of equipment a company may own (bounded state; revisit with Step 33). */
const MAX_EQUIPMENT = 1000;

export function buildingOf(facilities: Facilities, propertyId: string): Building | undefined {
  return facilities.buildings.find((building) => building.propertyId === propertyId);
}

export function equipmentTypeOf(facilities: Facilities, id: string): EquipmentType | undefined {
  return facilities.equipmentTypes.find((type) => type.id === id);
}

function equipmentOf(facilities: Facilities, id: string): Equipment | undefined {
  return facilities.equipment.find((item) => item.id === id);
}

function propertyOf(realEstate: RealEstate, id: string): Property | undefined {
  return realEstate.properties.find((property) => property.id === id);
}

/** Whether the company holds `propertyId` by an active lease. */
function occupies(realEstate: RealEstate, company: Company, propertyId: string): boolean {
  return realEstate.leases.some(
    (lease) =>
      lease.status === 'active' &&
      lease.propertyId === propertyId &&
      lease.tenantFirmId === company.firmId,
  );
}

/** Items installed in a building, as placement-check shapes, leaving out `except`. */
function installedIn(facilities: Facilities, propertyId: string, except: string | null) {
  return facilities.equipment.flatMap((item) => {
    const type = equipmentTypeOf(facilities, item.typeId);
    if (!type || item.placement?.propertyId !== propertyId || item.id === except) {
      return [];
    }
    const shape = standing(item.id, type, item.placement);
    return shape ? [shape] : [];
  });
}

/** Geometry of a level of a building, if both exist. */
function geometryOf(
  facilities: Facilities,
  realEstate: RealEstate,
  propertyId: string,
  level: number,
): LevelGeometry | null {
  const building = buildingOf(facilities, propertyId);
  const property = propertyOf(realEstate, propertyId);
  const found = building && levelOf(building, level);
  return building && property && found ? levelGeometry(building, property, found) : null;
}

// ------------------------------------------------------------ purchase

export interface PurchaseRequest {
  readonly equipmentTypeId: string;
  readonly quantity: number;
}

/**
 * Buy `quantity` items of a type: the dealer invoices the price and is paid
 * now, and the items are the company's, held by the dealer until installed.
 * Refused with nothing changed for an unknown type, a quantity outside
 * 1–20, too many items, or funds that do not cover the price.
 */
export function purchaseEquipment(
  facilities: Facilities,
  company: Company,
  request: PurchaseRequest,
  context: RuleContext,
):
  | {
      facilities: Facilities;
      company: Company;
      equipmentIds: EntityId<'equipment'>[];
      invoiceId: EntityId<'invoice'>;
      totalCents: Cents;
    }
  | Rejection {
  const type = equipmentTypeOf(facilities, request.equipmentTypeId);
  if (!type) {
    return reject(`There is no equipment type ${request.equipmentTypeId}`);
  }
  const { quantity } = request;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_QUANTITY) {
    return reject(`An order is for 1–${MAX_ORDER_QUANTITY} items, not ${quantity}`);
  }
  if (facilities.equipment.length + quantity > MAX_EQUIPMENT) {
    return reject(`The company can own at most ${MAX_EQUIPMENT} items of equipment`);
  }
  const total = type.priceCents * BigInt(quantity);
  if (total > MAX_AMOUNT_CENTS) {
    return reject(`An order can total at most ${formatUsd(MAX_AMOUNT_CENTS)}`);
  }
  const available = availableFundsCents(company);
  if (total > available) {
    return reject(
      fundsMessage(available, total, `${quantity} × ${type.name} at ${formatUsd(type.priceCents)}`),
      { availableCents: available.toString(), requiredCents: total.toString() },
    );
  }
  const dealer = ensureCounterparty(company, type.supplier, 'supplier', context.allocateId);
  const books = {
    ...dealer.company,
    ledger: ensureAccount(dealer.company.ledger, EQUIPMENT_ACCOUNTS.machinery),
  };
  const issued = issueInvoice(
    books,
    {
      direction: 'payable',
      counterpartyId: dealer.counterpartyId,
      description: `${type.name} from ${type.supplier}`.slice(0, 120),
      lines: [
        {
          account: EQUIPMENT_ACCOUNTS.machinery.code,
          description: `${quantity} × ${type.name}, delivered and installed`.slice(0, 120),
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
  const equipmentIds: EntityId<'equipment'>[] = [];
  const items: Equipment[] = [];
  for (let n = 0; n < quantity; n += 1) {
    const id = context.allocateId('equipment');
    equipmentIds.push(id);
    items.push({
      id,
      typeId: type.id,
      supplierPartyId: dealer.counterpartyId,
      purchaseInvoiceId: issued.invoiceId,
      purchasedAtMs: context.nowMs,
      priceCents: type.priceCents,
      installations: 0,
      placement: null,
    });
  }
  return {
    facilities: { ...facilities, equipment: [...facilities.equipment, ...items] },
    company: paid.company,
    equipmentIds,
    invoiceId: issued.invoiceId,
    totalCents: total,
  };
}

// ---------------------------------------------------- install and move

/** Placement problems, or a refusal for reasons that come before geometry. */
export function checkPlacement(
  facilities: Facilities,
  realEstate: RealEstate,
  company: Company | null,
  request: {
    readonly equipmentTypeId: string;
    readonly equipmentId: string | null;
    readonly placement: Placement;
  },
): PlacementProblem[] | Rejection {
  if (!company) {
    return reject('No company has been founded yet');
  }
  const type = equipmentTypeOf(facilities, request.equipmentTypeId);
  if (!type) {
    return reject(`There is no equipment type ${request.equipmentTypeId}`);
  }
  const { placement } = request;
  const property = propertyOf(realEstate, placement.propertyId);
  const building = buildingOf(facilities, placement.propertyId);
  if (!property || !building) {
    return reject(`There is no property ${placement.propertyId}`);
  }
  if (!occupies(realEstate, company, property.id)) {
    return reject(`${company.legalName} does not occupy ${property.address}`);
  }
  return placementProblems(
    { building, property },
    type,
    placement,
    installedIn(facilities, property.id, request.equipmentId),
  );
}

function placementRefusal(problems: readonly PlacementProblem[]): Rejection {
  const [first] = problems;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
  return reject(`${first?.message ?? 'The placement is not allowed'}${more}`, {
    problem: first?.code ?? null,
    problems: problems.length,
  });
}

/** Charge the dealer's rigging fee for `item`, paid at once. */
function chargeRigging(
  company: Company,
  item: Equipment,
  type: EquipmentType,
  what: 'Reinstallation' | 'Relocation',
  context: RuleContext,
): { company: Company; invoiceId: EntityId<'invoice'> | null } | Rejection {
  if (type.relocationCents === 0n) {
    return { company, invoiceId: null };
  }
  const available = availableFundsCents(company);
  if (type.relocationCents > available) {
    return reject(
      fundsMessage(
        available,
        type.relocationCents,
        `${what.toLowerCase()} of the ${type.name} by ${type.supplier}`,
      ),
      { availableCents: available.toString(), requiredCents: type.relocationCents.toString() },
    );
  }
  const books = { ...company, ledger: ensureAccount(company.ledger, EQUIPMENT_ACCOUNTS.rigging) };
  const issued = issueInvoice(
    books,
    {
      direction: 'payable',
      counterpartyId: item.supplierPartyId,
      description: `${what} of ${type.name} (${item.id})`.slice(0, 120),
      lines: [
        {
          account: EQUIPMENT_ACCOUNTS.rigging.code,
          description: `${what} by ${type.supplier}`.slice(0, 120),
          amountCents: type.relocationCents,
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
    { invoiceId: issued.invoiceId, amountCents: type.relocationCents, initiatedBy: 'player' },
    context,
  );
  return paid instanceof Rejection ? paid : { company: paid.company, invoiceId: issued.invoiceId };
}

export interface PlacedOutcome {
  readonly facilities: Facilities;
  readonly company: Company;
  readonly chargedCents: Cents;
  readonly invoiceId: EntityId<'invoice'> | null;
}

/**
 * Install an uninstalled item (`move` false) or move an installed one within
 * its building (`move` true). Refused with nothing changed unless the
 * company occupies the premises, every placement rule holds and the funds
 * cover any rigging charge.
 */
export function placeEquipment(
  facilities: Facilities,
  realEstate: RealEstate,
  company: Company,
  request: { readonly equipmentId: string; readonly placement: Placement; readonly move: boolean },
  context: RuleContext,
): PlacedOutcome | Rejection {
  const item = equipmentOf(facilities, request.equipmentId);
  if (!item) {
    return reject(`The company owns no equipment ${request.equipmentId}`);
  }
  const type = equipmentTypeOf(facilities, item.typeId);
  if (!type) {
    throw new Error(`Equipment ${item.id} has unknown type ${item.typeId}`);
  }
  if (request.move) {
    if (!item.placement) {
      return reject(`The ${type.name} (${item.id}) is not installed; install it instead`);
    }
    if (item.placement.propertyId !== request.placement.propertyId) {
      return reject(
        'Equipment can only be moved within the building it stands in; moving between sites arrives with multi-site operations (plan Step 26)',
      );
    }
  } else if (item.placement) {
    return reject(`The ${type.name} (${item.id}) is already installed; move it instead`);
  }
  const problems = checkPlacement(facilities, realEstate, company, {
    equipmentTypeId: type.id,
    equipmentId: item.id,
    placement: request.placement,
  });
  if (problems instanceof Rejection) {
    return problems;
  }
  if (problems.length > 0) {
    return placementRefusal(problems);
  }
  const charged =
    request.move || item.installations > 0
      ? chargeRigging(company, item, type, request.move ? 'Relocation' : 'Reinstallation', context)
      : { company, invoiceId: null };
  if (charged instanceof Rejection) {
    return charged;
  }
  const { propertyId, level, xMm, yMm, rotation } = request.placement;
  return {
    facilities: {
      ...facilities,
      equipment: facilities.equipment.map((candidate) =>
        candidate.id === item.id
          ? {
              ...candidate,
              installations: candidate.installations + (request.move ? 0 : 1),
              placement: { propertyId, level, xMm, yMm, rotation },
            }
          : candidate,
      ),
    },
    company: charged.company,
    chargedCents: charged.invoiceId === null ? 0n : type.relocationCents,
    invoiceId: charged.invoiceId,
  };
}

/**
 * Have the dealer take an installed item off the floor and hold it until it
 * is installed again (that later installation is charged). No charge now.
 */
export function uninstallEquipment(
  facilities: Facilities,
  company: Company,
  realEstate: RealEstate,
  equipmentId: string,
): Facilities | Rejection {
  const item = equipmentOf(facilities, equipmentId);
  if (!item) {
    return reject(`The company owns no equipment ${equipmentId}`);
  }
  if (!item.placement) {
    return reject(`${item.id} is not installed`);
  }
  if (!occupies(realEstate, company, item.placement.propertyId)) {
    throw new Error(`${item.id} stands in premises the company does not occupy`);
  }
  return {
    ...facilities,
    equipment: facilities.equipment.map((candidate) =>
      candidate.id === item.id ? { ...candidate, placement: null } : candidate,
    ),
  };
}

/** A lease is ending: the dealers take every item off those premises (no charge). */
export function clearPremises(
  facilities: Facilities,
  propertyId: string,
): { facilities: Facilities; removed: EntityId<'equipment'>[] } {
  const removed = facilities.equipment
    .filter((item) => item.placement?.propertyId === propertyId)
    .map((item) => item.id);
  return {
    facilities: {
      ...facilities,
      equipment: facilities.equipment.map((item) =>
        item.placement?.propertyId === propertyId ? { ...item, placement: null } : item,
      ),
    },
    removed,
  };
}

// ----------------------------------------------------------- invariants

const buildingProblemCache = new WeakMap<Building, readonly string[]>();

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      repeated.add(id);
    }
    seen.add(id);
  }
  return [...repeated];
}

/**
 * Cross-checks of the facilities slice against the real estate and the
 * books. Returns human-readable violations; empty when consistent.
 */
export function facilitiesProblems(
  facilities: Facilities,
  realEstate: RealEstate | null,
  company: Company | null,
): string[] {
  const problems: string[] = [];
  if (!realEstate) {
    return ['facilities exist in a world without real estate'];
  }
  for (const id of duplicates(facilities.floorMaterials.map((material) => material.id))) {
    problems.push(`floor material ${id} is defined twice`);
  }
  for (const id of duplicates(facilities.equipmentTypes.map((type) => type.id))) {
    problems.push(`equipment type ${id} is defined twice`);
  }
  for (const material of facilities.floorMaterials) {
    problems.push(
      ...floorMaterialProblems(material).map(
        (problem) => `floor material ${material.id}: ${problem}`,
      ),
    );
  }
  for (const type of facilities.equipmentTypes) {
    problems.push(
      ...equipmentTypeProblems(type).map((problem) => `equipment type ${type.id}: ${problem}`),
    );
  }
  const materials = new Set(facilities.floorMaterials.map((material) => material.id));
  const buildingIds = facilities.buildings.map((building) => building.propertyId);
  for (const id of duplicates(buildingIds)) {
    problems.push(`property ${id} has two building records`);
  }
  for (const property of realEstate.properties) {
    if (!buildingIds.includes(property.id)) {
      problems.push(`property ${property.id} has no building record`);
    }
  }
  for (const building of facilities.buildings) {
    const property = propertyOf(realEstate, building.propertyId);
    if (!property) {
      problems.push(`a building record names unknown property ${building.propertyId}`);
      continue;
    }
    let found = buildingProblemCache.get(building);
    if (!found) {
      found = buildingProblems(building, property, materials);
      buildingProblemCache.set(building, found);
    }
    problems.push(...found.map((problem) => `building ${building.propertyId}: ${problem}`));
  }
  if (problems.length > 0) {
    return problems;
  }

  for (const id of duplicates(facilities.equipment.map((item) => item.id))) {
    problems.push(`equipment ${id} is recorded twice`);
  }
  if (facilities.equipment.length > MAX_EQUIPMENT) {
    problems.push(`more than ${MAX_EQUIPMENT} items of equipment`);
  }
  if (facilities.equipment.length > 0 && !company) {
    problems.push('equipment exists but no company does');
  }
  const priced = new Map<string, Cents>();
  for (const item of facilities.equipment) {
    const at = `equipment ${item.id}`;
    const type = equipmentTypeOf(facilities, item.typeId);
    if (!type) {
      problems.push(`${at} has unknown type ${item.typeId}`);
      continue;
    }
    if (!Number.isInteger(item.installations) || item.installations < 0) {
      problems.push(`${at} has an impossible installation count`);
    }
    if (item.placement && item.installations < 1) {
      problems.push(`${at} stands on a floor but was never installed`);
    }
    priced.set(
      item.purchaseInvoiceId,
      (priced.get(item.purchaseInvoiceId) ?? 0n) + item.priceCents,
    );
    if (!company) {
      continue;
    }
    const dealer = company.counterparties.find((party) => party.id === item.supplierPartyId);
    if (dealer?.kind !== 'supplier' || dealer.name !== type.supplier) {
      problems.push(`${at} names ${item.supplierPartyId}, which is not its dealer`);
    }
    const invoice = invoiceOf(company, item.purchaseInvoiceId);
    if (
      invoice?.direction !== 'payable' ||
      invoice.counterpartyId !== item.supplierPartyId ||
      !invoice.lines.every((line) => line.account === EQUIPMENT_ACCOUNTS.machinery.code)
    ) {
      problems.push(`${at} does not match its purchase invoice`);
    }
    if (item.placement && !occupies(realEstate, company, item.placement.propertyId)) {
      problems.push(
        `${at} stands in ${item.placement.propertyId}, which the company does not occupy`,
      );
    }
  }
  if (company) {
    for (const [invoiceId, total] of priced) {
      if (invoiceOf(company, invoiceId)?.totalCents !== total) {
        problems.push(`invoice ${invoiceId} does not total the equipment it bought`);
      }
    }
  }
  for (const building of facilities.buildings) {
    const items = installedIn(facilities, building.propertyId, null);
    const property = propertyOf(realEstate, building.propertyId);
    if (items.length > 0 && property) {
      problems.push(
        ...layoutProblems({ building, property }, items).map(
          (problem) => `layout of ${building.propertyId}: ${problem}`,
        ),
      );
    }
  }
  problems.push(
    ...coveringProblems({
      coverings: facilities.coverings,
      installations: facilities.installations,
      materials,
      geometryOf: (propertyId, level) => geometryOf(facilities, realEstate, propertyId, level),
      company,
    }),
  );
  return problems;
}
