import { encodeBigInt } from '../shared/bigint-codec';
import type { StockRecordResult, StockView } from '../shared/ipc/stock';
import type { Company } from '../domain/company';
import type { Facilities } from '../domain/facilities';
import { companyOccupies } from '../domain/facilities';
import { balanceOf, INVENTORY_ACCOUNTS } from '../domain/ledger';
import type { RealEstate } from '../domain/real-estate';
import {
  carriersOf,
  contentsMassMg,
  contentsVolumeMm3,
  descendantsOf,
  floorFootprint,
  grossMassMg,
  boxVolumeMm3,
  indexStock,
  lotMassMg,
  maxHeightMm,
  rootUnitOf,
  unreservedMicro,
  volumeOfMm3,
  type LoadUnit,
  type Stock,
  type StockHandler,
  type StockIndex,
  type StockLocation,
} from '../domain/stock';
import { historyOf, lineageOf, stockTake } from '../domain/stock-records';
import { calendarAt, isoDateAt, type CivilDate, type SimTimeMs } from '../domain/time';

/**
 * Builds the stock read model (ADR-0055) and answers stock-record queries
 * from the authoritative world. Masses, volumes, whereabouts, the stock-take
 * and every lot's lineage are computed here, so the renderer never derives a
 * physical fact.
 */

const big = encodeBigInt;
const MAX_SERIALS_SHOWN = 500;

function addressOf(realEstate: RealEstate | null, propertyId: string): string {
  return (
    realEstate?.properties.find((property) => property.id === propertyId)?.address ?? propertyId
  );
}

/** The colour seen from above: the goods with the most volume, else the first unit carried. */
function loadColour(index: StockIndex, unit: LoadUnit): string | null {
  let best: { colour: string; volume: bigint } | null = null;
  for (const lot of index.lotsIn.get(unit.id) ?? []) {
    const product = index.products.get(lot.productId);
    const volume = product ? volumeOfMm3(product, lot.quantityMicro) : 0n;
    if (product && (!best || volume > best.volume)) {
      best = { colour: product.colour, volume };
    }
  }
  if (best) {
    return best.colour;
  }
  const child = index.childrenOf.get(unit.id)?.[0];
  return child ? (index.types.get(child.typeId)?.colour ?? null) : null;
}

export function stockView(
  stock: Stock,
  realEstate: RealEstate | null,
  company: Company | null,
  epoch: CivilDate,
): StockView {
  const index = indexStock(stock);
  const held = (propertyId: string) =>
    company !== null && realEstate !== null && companyOccupies(realEstate, company, propertyId);
  const date = (time: SimTimeMs) => isoDateAt(epoch, time);
  const inventory = company?.ledger.accounts.some(
    (account) => account.code === INVENTORY_ACCOUNTS.inventory.code,
  )
    ? balanceOf(company.ledger, INVENTORY_ACCOUNTS.inventory.code)
    : 0n;
  const openLots = stock.lots.filter((lot) => !lot.closed);
  return {
    products: stock.products.map((product) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      description: product.description,
      unit: product.unit,
      form: product.form,
      tracking: product.tracking,
      quantumMicro: big(product.quantumMicro),
      itemMm: product.itemMm && { ...product.itemMm },
      massPerQuantumMg: big(product.massPerQuantumMg),
      volumePerQuantumMm3: big(product.volumePerQuantumMm3),
      packUnits: product.packUnits.map((pack) => ({ ...pack })),
      grades: product.grades.map((grade) => ({ ...grade })),
      colour: product.colour,
    })),
    containerTypes: stock.containerTypes.map((type) => ({
      id: type.id,
      name: type.name,
      kind: type.kind,
      description: type.description,
      outerMm: { ...type.outerMm },
      innerMm: { ...type.innerMm },
      maxHeightMm: maxHeightMm(type),
      tareMassG: type.tareMassG,
      payloadMassG: type.payloadMassG,
      holds: [...type.holds],
      carries: [...type.carries],
      mixing: type.mixing,
      colour: type.colour,
    })),
    loadUnits: stock.loadUnits.map((unit) => {
      const type = index.types.get(unit.typeId);
      const { location } = unit;
      return {
        id: unit.id,
        typeId: unit.typeId,
        name: type?.name ?? unit.typeId,
        kind: type?.kind ?? 'pallet',
        location:
          location.kind === 'floor'
            ? {
                kind: 'floor' as const,
                propertyId: location.propertyId,
                address: addressOf(realEstate, location.propertyId),
                level: location.level,
                rotation: location.rotation,
                rect: type
                  ? floorFootprint(type, location)
                  : { x: location.xMm, y: location.yMm, width: 0, depth: 0 },
                held: held(location.propertyId),
              }
            : { ...location },
        rootId: rootUnitOf(index, unit.id)?.id ?? unit.id,
        receiptId: unit.receiptId,
        receivedOn: date(unit.createdAtMs),
        grossMassMg: big(grossMassMg(index, unit.id)),
        contentsMassMg: big(contentsMassMg(index, unit.id)),
        payloadMassMg: big(BigInt(type?.payloadMassG ?? 0) * 1000n),
        contentsVolumeMm3: big(contentsVolumeMm3(index, unit.id)),
        volumeMm3: big(type ? boxVolumeMm3(type.innerMm) : 0n),
        lotIds: (index.lotsIn.get(unit.id) ?? []).map((lot) => lot.id),
        childIds: (index.childrenOf.get(unit.id) ?? []).map((child) => child.id),
        nestedUnits: descendantsOf(index, unit.id).length,
        loadColour: loadColour(index, unit),
      };
    }),
    lots: openLots.map((lot) => ({
      id: lot.id,
      productId: lot.productId,
      grade: lot.grade,
      disposition: lot.disposition,
      quantityMicro: big(lot.quantityMicro),
      reservedMicro: big(lot.quantityMicro - unreservedMicro(index, lot)),
      costCents: big(lot.costCents),
      massMg: big(lotMassMg(index, lot)),
      loadUnitId: lot.loadUnitId ?? '',
      serialCount: lot.serials.length,
      origin: lot.origin.kind,
      receiptId: lot.origin.kind === 'receipt' ? lot.origin.receiptId : null,
      parentLotIds: [...lot.parentLotIds],
      createdOn: date(lot.createdAtMs),
    })),
    receipts: stock.receipts.map((receipt) => ({
      id: receipt.id,
      receivedOn: date(receipt.atMs),
      supplier:
        company?.counterparties.find((party) => party.id === receipt.supplierPartyId)?.name ??
        receipt.supplierPartyId,
      invoiceId: receipt.invoiceId,
      costCents: big(receipt.costCents),
      propertyId: receipt.propertyId,
      address: addressOf(realEstate, receipt.propertyId),
      doorIndex: receipt.doorIndex,
      productId: receipt.productId,
      quantityMicro: big(receipt.quantityMicro),
      lotCount: receipt.lotIds.length,
      loadUnitCount: receipt.loadUnitIds.length,
    })),
    count: stockTake(stock).map((line) => ({
      productId: line.productId,
      propertyId: line.propertyId,
      address: line.propertyId === null ? null : addressOf(realEstate, line.propertyId),
      countedMicro: big(line.countedMicro),
      recordedMicro: big(line.recordedMicro),
      scrapMicro: big(line.scrapMicro),
      lots: line.lots,
      massMg: big(line.massMg),
      costCents: big(line.costCents),
    })),
    totals: {
      loadUnits: stock.loadUnits.length,
      lots: openLots.length,
      costCents: big(openLots.reduce((sum, lot) => sum + lot.costCents, 0n)),
      inventoryCents: big(inventory),
    },
  };
}

function describeLocation(
  index: StockIndex,
  realEstate: RealEstate | null,
  facilities: Facilities | null,
  location: StockLocation | null,
): string {
  if (!location) {
    return 'outside (delivered)';
  }
  switch (location.kind) {
    case 'floor': {
      const property = realEstate?.properties.find((item) => item.id === location.propertyId);
      const building = facilities?.buildings.find(
        (item) => item.propertyId === location.propertyId,
      );
      const level = building?.levels.find((item) => item.index === location.level);
      return `the floor of ${property?.address ?? location.propertyId}, ${level?.name ?? `level ${location.level}`}, at (${location.xMm.toLocaleString('en-US')}, ${location.yMm.toLocaleString('en-US')}) mm, turned ${location.rotation}°`;
    }
    case 'load-unit': {
      const carrier = index.units.get(location.loadUnitId);
      const type = carrier && index.types.get(carrier.typeId);
      return `in or on the ${type?.name ?? 'load unit'} (${location.loadUnitId})`;
    }
    case 'equipment':
      return `the buffer at port ${location.zone} of ${location.equipmentId}`;
  }
}

function handlerName(company: Company | null, handler: StockHandler): string {
  switch (handler.kind) {
    case 'supplier':
      return (
        company?.counterparties.find((party) => party.id === handler.partyId)?.name ??
        handler.partyId
      );
    case 'company':
      return 'Company management';
    case 'employee':
      return handler.personId;
  }
}

/** The full record of a load unit or a lot: contents, provenance and history (ADR-0055). */
export function answerStockRecord(
  query: { readonly kind: 'stockRecord'; readonly id: string },
  stock: Stock | null,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  epoch: CivilDate,
  company: Company | null = null,
): StockRecordResult {
  const missing: StockRecordResult = {
    kind: 'stockRecord',
    found: false,
    loadUnitId: null,
    lotId: null,
    whereabouts: '',
    carriers: [],
    lots: [],
    history: [],
  };
  if (!stock) {
    return missing;
  }
  const index = indexStock(stock);
  const askedLot = query.id.startsWith('lot:') ? index.lots.get(query.id) : undefined;
  const unitId = askedLot ? askedLot.loadUnitId : query.id;
  const unit = unitId === null ? undefined : index.units.get(unitId);
  if (!askedLot && !unit) {
    return missing;
  }
  const lots = askedLot ? [askedLot] : unit ? (index.lotsIn.get(unit.id) ?? []) : [];
  const date = (time: SimTimeMs) => isoDateAt(epoch, time);
  const at = (time: SimTimeMs) => {
    const instant = calendarAt(epoch, time);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date(time)} ${pad(instant.hour)}:${pad(instant.minute)}`;
  };
  const receipts = new Map<string, (typeof stock.receipts)[number]>(
    stock.receipts.map((receipt) => [receipt.id, receipt]),
  );
  const supplierOf = (receiptId: string | null) => {
    const receipt = receiptId ? receipts.get(receiptId) : undefined;
    return receipt
      ? handlerName(company, { kind: 'supplier', partyId: receipt.supplierPartyId })
      : null;
  };
  return {
    kind: 'stockRecord',
    found: true,
    loadUnitId: unit?.id ?? null,
    lotId: askedLot?.id ?? null,
    whereabouts: unit
      ? describeLocation(index, realEstate, facilities, unit.location)
      : `nowhere: the lot was ${askedLot?.closed?.reason ?? 'closed'}`,
    carriers: unit ? carriersOf(index, unit.id).map((carrier) => carrier.id) : [],
    lots: lots.slice(0, 500).map((lot) => ({
      id: lot.id,
      productId: lot.productId,
      grade: lot.grade,
      disposition: lot.disposition,
      quantityMicro: big(lot.quantityMicro),
      reservedMicro: big(lot.quantityMicro - unreservedMicro(index, lot)),
      costCents: big(lot.costCents),
      closed: lot.closed
        ? `${lot.closed.reason}${lot.closed.intoLotId ? ` into ${lot.closed.intoLotId}` : ''}`
        : null,
      serials: lot.serials.slice(0, MAX_SERIALS_SHOWN),
      serialCount: lot.serials.length,
      lineage: lineageOf(index, lot.id).map((ancestor) => {
        const receiptId = ancestor.origin.kind === 'receipt' ? ancestor.origin.receiptId : null;
        return {
          lotId: ancestor.id,
          origin: ancestor.origin.kind,
          createdOn: date(ancestor.createdAtMs),
          parents: [...ancestor.parentLotIds],
          receiptId,
          supplier: supplierOf(receiptId),
          invoiceId: receiptId ? (receipts.get(receiptId)?.invoiceId ?? null) : null,
        };
      }),
    })),
    history: historyOf(stock, {
      loadUnitId: unit?.id ?? null,
      lotIds: lots.map((lot) => lot.id),
    }).map((entry) => ({
      id: entry.id,
      at: at(entry.atMs),
      kind: entry.kind,
      handler: handlerName(company, entry.handler).slice(0, 80),
      reason: entry.reason,
      costCents: big(entry.costCents),
      lines: entry.lines.slice(0, 200).map((line) => ({
        lotId: line.lotId,
        productId: index.lots.get(line.lotId)?.productId ?? '',
        quantityMicro: big(line.quantityMicro),
        from: line.fromLoadUnitId,
        to: line.toLoadUnitId,
        resultLotId: line.resultLotId,
      })),
      units: entry.units.slice(0, 200).map((placed) => ({
        loadUnitId: placed.loadUnitId,
        from: describeLocation(index, realEstate, facilities, placed.from).slice(0, 200),
        to: describeLocation(index, realEstate, facilities, placed.to).slice(0, 200),
      })),
    })),
  };
}
