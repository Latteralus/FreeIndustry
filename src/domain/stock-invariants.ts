import type { Company } from './company';
import { isQuarterTurn } from './equipment';
import { buildingOf, installedIn, type Facilities } from './facilities';
import { levelGeometry, levelOf } from './facility';
import { parseEntityId } from './ids';
import { invoiceOf } from './invoicing';
import { balanceOf, INVENTORY_ACCOUNTS } from './ledger';
import type { RealEstate } from './real-estate';
import {
  capacityProblems,
  carriersOf,
  containerTypeProblems,
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
  productProblems,
  type Stock,
  type StockIndex,
} from './stock';
import { floorPlacementProblems, floorRouteProblems } from './stock-floor';
import { floorObstacles, siteOf, unitLabel } from './stock-operations';

/**
 * Cross-checks of the stock slice (spec §14.1 material conservation,
 * physical provenance and capacity; plan Step 10 acceptance). Returns
 * human-readable violations; empty when consistent. Run on every restore and
 * after every step of the property tests.
 *
 * - **Conservation:** for every product, the quantity held in open lots
 *   equals everything received less everything lost. Splits, merges and
 *   transfers neither create nor destroy a quantum.
 * - **One place:** every open lot is in exactly one load unit that exists;
 *   every load unit is in exactly one place, on a floor, in or on another
 *   unit (never inside itself), or at a machine port; every serial is held
 *   once.
 * - **Capacity:** no load unit holds more mass or volume than it is rated
 *   for, or goods it cannot hold; nothing on a floor overloads the slab or
 *   overlaps structure, equipment or other stock, and walkways stay open.
 * - **Provenance:** every lot's origin is a receipt or lots that existed
 *   before it, so any lot traces back to the deliveries it came from.
 * - **Books:** Inventory equals the cost of the lots held; each receipt is
 *   paid for by its own invoice; each write-down and loss is its own entry.
 */
export function stockProblems(
  stock: Stock,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  company: Company | null,
): string[] {
  const problems = catalogProblems(stock);
  if (problems.length > 0) {
    return problems;
  }
  if (stock.loadUnits.length === 0 && stock.lots.length === 0 && stock.receipts.length === 0) {
    return stock.movements.length > 0 || stock.reservations.length > 0
      ? ['stock movements or reservations exist without any stock']
      : [];
  }
  if (!company || !facilities || !realEstate) {
    return ['stock exists in a world without a company, facilities or real estate'];
  }
  const index = indexStock(stock);
  problems.push(
    ...boundProblems(stock),
    ...unitProblems(index, facilities, realEstate, company),
    ...lotProblems(index, company),
    ...reservationProblems(index),
    ...conservationProblems(index, company),
  );
  return problems;
}

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

const ordinal = (id: string) => parseEntityId(id)?.ordinal ?? 0;

function catalogProblems(stock: Stock): string[] {
  const problems: string[] = [];
  for (const id of duplicates(stock.products.map((product) => product.id))) {
    problems.push(`product ${id} is defined twice`);
  }
  for (const id of duplicates(stock.containerTypes.map((type) => type.id))) {
    problems.push(`container type ${id} is defined twice`);
  }
  for (const product of stock.products) {
    problems.push(
      ...productProblems(product).map((problem) => `product ${product.id}: ${problem}`),
    );
  }
  for (const type of stock.containerTypes) {
    problems.push(
      ...containerTypeProblems(type).map((problem) => `container type ${type.id}: ${problem}`),
    );
  }
  return problems;
}

function boundProblems(stock: Stock): string[] {
  const problems: string[] = [];
  const bounds: [string, number, number][] = [
    ['load units', stock.loadUnits.length, MAX_LOAD_UNITS],
    ['lots', stock.lots.length, MAX_LOTS],
    ['movements', stock.movements.length, MAX_MOVEMENTS],
    ['reservations', stock.reservations.length, MAX_RESERVATIONS],
  ];
  for (const [what, count, max] of bounds) {
    if (count > max) {
      problems.push(`more than ${max} ${what}`);
    }
  }
  for (const [what, ids] of [
    ['load unit', stock.loadUnits.map((unit) => unit.id)],
    ['lot', stock.lots.map((lot) => lot.id)],
    ['movement', stock.movements.map((entry) => entry.id)],
    ['reservation', stock.reservations.map((item) => item.id)],
    ['receipt', stock.receipts.map((receipt) => receipt.id)],
  ] as const) {
    for (const id of duplicates(ids)) {
      problems.push(`${what} ${id} is recorded twice`);
    }
  }
  return problems;
}

function unitProblems(
  index: StockIndex,
  facilities: Facilities,
  realEstate: RealEstate,
  company: Company,
): string[] {
  const { stock } = index;
  const problems: string[] = [];
  const receipts = new Set(stock.receipts.map((receipt) => receipt.id));
  const buffers = new Set<string>();
  const floors = new Set<string>();
  for (const unit of stock.loadUnits) {
    const at = `load unit ${unit.id}`;
    const type = index.types.get(unit.typeId);
    if (!type) {
      problems.push(`${at} has unknown type ${unit.typeId}`);
      continue;
    }
    if (unit.ownerFirmId !== company.firmId) {
      problems.push(`${at} belongs to unknown firm ${unit.ownerFirmId}`);
    }
    if (unit.receiptId !== null && !receipts.has(unit.receiptId)) {
      problems.push(`${at} names unknown receipt ${unit.receiptId}`);
    }
    const { location } = unit;
    if ((type.kind === 'machine-buffer') !== (location.kind === 'equipment')) {
      problems.push(`${at} is a ${type.kind} at a ${location.kind} location`);
      continue;
    }
    switch (location.kind) {
      case 'floor': {
        const site = siteOf(facilities, realEstate, location.propertyId);
        if (!site || !isQuarterTurn(location.rotation)) {
          problems.push(`${at} stands in unknown premises or at an impossible orientation`);
          break;
        }
        floors.add(`${location.propertyId}|${location.level}`);
        const placement = floorPlacementProblems(
          site,
          { label: unitLabel(index, unit), type, grossMassMg: grossMassMg(index, unit.id) },
          location,
          {
            equipment: installedIn(facilities, location.propertyId, null),
            stock: floorObstacles(stock, location.propertyId, new Set([unit.id])).filter(
              // Each overlapping pair is reported once, by the later unit.
              (other) => ordinal(other.id) < ordinal(unit.id),
            ),
            works: [],
          },
          { route: false },
        );
        problems.push(...placement.map((problem) => `${at}: ${problem.message}`));
        break;
      }
      case 'load-unit': {
        if (!index.units.has(location.loadUnitId)) {
          problems.push(`${at} is in unknown load unit ${location.loadUnitId}`);
          break;
        }
        const chain = carriersOf(index, unit.id);
        const last = chain.at(-1) ?? unit;
        if (last.location.kind === 'load-unit') {
          problems.push(`${at} is part of a loop of load units inside each other`);
        } else if (chain.length > MAX_NESTING - 1) {
          problems.push(`${at} is nested more than ${MAX_NESTING} deep`);
        }
        break;
      }
      case 'equipment': {
        const item = facilities.equipment.find(
          (candidate) => candidate.id === location.equipmentId,
        );
        const equipmentType =
          item && facilities.equipmentTypes.find((candidate) => candidate.id === item.typeId);
        const zone = equipmentType?.zones[location.zone];
        if (!item?.placement || !zone || (zone.kind !== 'input' && zone.kind !== 'output')) {
          problems.push(`${at} is a buffer at a port that does not exist`);
        }
        const key = `${location.equipmentId}|${location.zone}`;
        if (buffers.has(key)) {
          problems.push(`${at} shares its machine port with another buffer`);
        }
        buffers.add(key);
        break;
      }
    }
    problems.push(...capacityProblems(index, unit.id).map((problem) => `${at}: ${problem}`));
  }
  // Walkways, once per floor holding stock, with its equipment.
  for (const key of floors) {
    const [propertyId = '', levelText = '0'] = key.split('|');
    const building = buildingOf(facilities, propertyId);
    const property = realEstate.properties.find((candidate) => candidate.id === propertyId);
    const level = building && levelOf(building, Number(levelText));
    if (building && property && level) {
      problems.push(
        ...floorRouteProblems(
          levelGeometry(building, property, level),
          installedIn(facilities, propertyId, null),
          floorObstacles(stock, propertyId),
        ).map((problem) => `stock on ${propertyId}: ${problem}`),
      );
    }
  }
  return problems;
}

function lotProblems(index: StockIndex, company: Company): string[] {
  const { stock } = index;
  const problems: string[] = [];
  const receipts = new Map(stock.receipts.map((receipt) => [receipt.id, receipt]));
  const serials = new Set<string>();
  for (const lot of stock.lots) {
    const at = `lot ${lot.id}`;
    const product = index.products.get(lot.productId);
    if (!product) {
      problems.push(`${at} is of unknown product ${lot.productId}`);
      continue;
    }
    if (!product.grades.some((grade) => grade.code === lot.grade)) {
      problems.push(`${at} has unknown grade ${lot.grade}`);
    }
    if (lot.ownerFirmId !== company.firmId) {
      problems.push(`${at} belongs to unknown firm ${lot.ownerFirmId}`);
    }
    if (lot.costCents < 0n || (lot.disposition === 'scrap' && lot.costCents !== 0n)) {
      problems.push(`${at} carries an impossible cost`);
    }
    if (lot.closed) {
      if (
        lot.quantityMicro !== 0n ||
        lot.costCents !== 0n ||
        lot.loadUnitId !== null ||
        lot.serials.length > 0
      ) {
        problems.push(`${at} is closed but still holds something`);
      }
      const into = lot.closed.intoLotId && index.lots.get(lot.closed.intoLotId);
      if (lot.closed.reason === 'merged' && !into?.parentLotIds.includes(lot.id)) {
        problems.push(`${at} was merged into a lot that does not name it`);
      }
    } else {
      if (lot.loadUnitId === null || !index.units.has(lot.loadUnitId)) {
        problems.push(`${at} is in no load unit`);
      }
      if (
        lot.quantityMicro <= 0n ||
        lot.quantityMicro > MAX_LOT_QUANTITY_MICRO ||
        !isWholeQuantity(product, lot.quantityMicro)
      ) {
        problems.push(`${at} holds an impossible quantity ${lot.quantityMicro}`);
      }
    }
    if (product.tracking === 'serialized') {
      const expected = lot.closed ? 0n : itemCount(lot.quantityMicro);
      if (BigInt(lot.serials.length) !== expected) {
        problems.push(`${at} lists ${lot.serials.length} serials for ${expected} items`);
      }
      for (const serial of lot.serials) {
        if (serials.has(serial)) {
          problems.push(`serial ${serial} is held twice`);
        }
        serials.add(serial);
      }
    } else if (lot.serials.length > 0) {
      problems.push(`${at} lists serials but ${product.id} is not serialized`);
    }
    // Provenance: a receipt, or lots that existed before it.
    const parents = lot.parentLotIds.map((id) => index.lots.get(id));
    if (parents.some((parent) => !parent || ordinal(parent.id) >= ordinal(lot.id))) {
      problems.push(`${at} names a parent lot that did not exist before it`);
    }
    switch (lot.origin.kind) {
      case 'receipt': {
        const receipt = receipts.get(lot.origin.receiptId);
        if (!receipt?.lotIds.includes(lot.id) || lot.parentLotIds.length > 0) {
          problems.push(`${at} does not match the receipt it came from`);
        }
        break;
      }
      case 'split':
        if (parents.length !== 1 || parents[0]?.productId !== lot.productId) {
          problems.push(`${at} was split from something other than one lot of its product`);
        }
        break;
      case 'merge':
        if (
          parents.length < 2 ||
          parents.some(
            (parent) =>
              parent?.closed?.reason !== 'merged' ||
              parent.closed.intoLotId !== lot.id ||
              parent.productId !== lot.productId,
          )
        ) {
          problems.push(`${at} was merged from lots that were not closed into it`);
        }
        break;
    }
  }
  return problems;
}

function reservationProblems(index: StockIndex): string[] {
  const problems: string[] = [];
  for (const reservation of index.stock.reservations) {
    const lot = index.lots.get(reservation.lotId);
    const product = lot && index.products.get(lot.productId);
    if (!lot || lot.closed || !product || lot.disposition !== 'available') {
      problems.push(`reservation ${reservation.id} holds a lot that cannot be used`);
    } else if (
      reservation.quantityMicro <= 0n ||
      !isWholeQuantity(product, reservation.quantityMicro)
    ) {
      problems.push(`reservation ${reservation.id} holds an impossible quantity`);
    }
  }
  for (const [lotId, reserved] of index.reserved) {
    const lot = index.lots.get(lotId);
    if (lot && reserved > lot.quantityMicro) {
      problems.push(`lot ${lotId} has more reserved than it holds`);
    }
  }
  return problems;
}

function conservationProblems(index: StockIndex, company: Company): string[] {
  const { stock } = index;
  const problems: string[] = [];
  // Quantity: what is held equals what was received less what was lost.
  const expected = new Map<string, bigint>();
  const add = (productId: string, quantity: bigint) => {
    expected.set(productId, (expected.get(productId) ?? 0n) + quantity);
  };
  for (const receipt of stock.receipts) {
    add(receipt.productId, receipt.quantityMicro);
    const entry = stock.movements.find(
      (candidate) => candidate.kind === 'receipt' && candidate.receiptId === receipt.id,
    );
    const lines = entry?.lines.reduce((sum, line) => sum + line.quantityMicro, 0n);
    if (lines !== receipt.quantityMicro) {
      problems.push(`receipt ${receipt.id} is not recorded by its own movement`);
    }
    const invoice = invoiceOf(company, receipt.invoiceId);
    if (
      invoice?.direction !== 'payable' ||
      invoice.counterpartyId !== receipt.supplierPartyId ||
      invoice.totalCents !== receipt.costCents ||
      !invoice.lines.every((line) => line.account === INVENTORY_ACCOUNTS.inventory.code)
    ) {
      problems.push(`receipt ${receipt.id} does not match its invoice`);
    }
  }
  let scrapped = 0n;
  let lost = 0n;
  const entries = new Map(company.ledger.entries.map((entry) => [entry.id, entry]));
  for (const entry of stock.movements) {
    for (const line of entry.lines) {
      if (!index.lots.has(line.lotId)) {
        problems.push(`movement ${entry.id} names unknown lot ${line.lotId}`);
      }
    }
    for (const unit of entry.units) {
      if (!index.units.has(unit.loadUnitId)) {
        problems.push(`movement ${entry.id} names unknown load unit ${unit.loadUnitId}`);
      }
    }
    if (entry.kind === 'loss') {
      for (const line of entry.lines) {
        const lot = index.lots.get(line.lotId);
        if (lot) {
          add(lot.productId, -line.quantityMicro);
        }
      }
      lost += entry.costCents;
    }
    if (entry.kind === 'scrap') {
      scrapped += entry.costCents;
    }
    if (entry.costCents > 0n) {
      const posted = entry.entryId ? entries.get(entry.entryId) : undefined;
      const debits = posted?.lines.reduce((sum, line) => sum + line.debitCents, 0n);
      if (posted?.sourceKey !== entry.id || debits !== entry.costCents) {
        problems.push(`movement ${entry.id} is not written off by its own ledger entry`);
      }
    }
  }
  const held = new Map<string, bigint>();
  let cost = 0n;
  for (const lot of stock.lots) {
    if (!lot.closed) {
      held.set(lot.productId, (held.get(lot.productId) ?? 0n) + lot.quantityMicro);
      cost += lot.costCents;
    }
  }
  for (const productId of new Set([...expected.keys(), ...held.keys()])) {
    const want = expected.get(productId) ?? 0n;
    const have = held.get(productId) ?? 0n;
    if (want !== have) {
      problems.push(`${productId}: ${have} µ held, but receipts less losses account for ${want} µ`);
    }
  }
  // Books: Inventory is the cost of what is held; write-downs and losses are their own accounts.
  const balance = (code: string) =>
    company.ledger.accounts.some((account) => account.code === code)
      ? balanceOf(company.ledger, code)
      : 0n;
  if (balance(INVENTORY_ACCOUNTS.inventory.code) !== cost) {
    problems.push(
      `Inventory is ${balance(INVENTORY_ACCOUNTS.inventory.code)} ¢ but the lots held cost ${cost} ¢`,
    );
  }
  if (balance(INVENTORY_ACCOUNTS.scrapped.code) !== scrapped) {
    problems.push('the scrap write-downs do not equal their account');
  }
  if (balance(INVENTORY_ACCOUNTS.losses.code) !== lost) {
    problems.push('the stock losses do not equal their account');
  }
  return problems;
}
