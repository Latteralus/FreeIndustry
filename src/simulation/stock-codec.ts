import { z } from 'zod';
import { bigIntString, encodeBigInt } from '../shared/bigint-codec';
import type { JsonValue } from '../shared/canonical-json';
import { isEntityIdOf, type EntityId } from '../domain/ids';
import { isSlug } from '../domain/real-estate';
import {
  BASE_UNITS,
  CONTAINER_KINDS,
  DISPOSITIONS,
  LOSS_REASONS,
  LOT_CLOSURES,
  MIXING_RULES,
  MOVEMENT_KINDS,
  PRODUCT_CATEGORIES,
  PRODUCT_FORMS,
  SCRAP_REASONS,
  TRACKING_KINDS,
  type Stock,
  type StockLocation,
} from '../domain/stock';

/**
 * Plain-JSON encoding of the stock slice (ADR-0055): the fingerprint input,
 * the checkpoint format (ADR-0022) and the form in which a new world's
 * product and container catalogs reach the kernel. Every bigint is a
 * canonical decimal string; lists keep their domain order. Decoding
 * validates shapes; the business invariants are checked separately
 * (`stockProblems`).
 */

function idOf<K extends string>(kind: K) {
  return z
    .string()
    .refine((id): id is EntityId<K> => isEntityIdOf(kind, id), `Expected a ${kind} ID`);
}

const slug = z.string().refine(isSlug, 'Expected a content identifier');
const int = z.int();
const box = z.strictObject({ width: int, depth: int, height: int });

const locationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('floor'),
    propertyId: slug,
    level: int,
    xMm: int,
    yMm: int,
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  }),
  z.strictObject({ kind: z.literal('load-unit'), loadUnitId: idOf('load-unit') }),
  z.strictObject({ kind: z.literal('equipment'), equipmentId: idOf('equipment'), zone: int }),
]);

const handlerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('supplier'), partyId: idOf('party') }),
  z.strictObject({ kind: z.literal('company') }),
  z.strictObject({ kind: z.literal('employee'), personId: idOf('person') }),
]);

const stockSchema = z.strictObject({
  products: z.array(
    z.strictObject({
      id: slug,
      name: z.string(),
      category: z.enum(PRODUCT_CATEGORIES),
      description: z.string(),
      unit: z.enum(BASE_UNITS),
      form: z.enum(PRODUCT_FORMS),
      tracking: z.enum(TRACKING_KINDS),
      quantumMicro: bigIntString,
      itemMm: box.nullable(),
      massPerQuantumMg: bigIntString,
      volumePerQuantumMm3: bigIntString,
      packUnits: z.array(z.strictObject({ id: slug, name: z.string(), quanta: int })),
      grades: z.array(z.strictObject({ code: slug, name: z.string() })),
      colour: z.string(),
    }),
  ),
  containerTypes: z.array(
    z.strictObject({
      id: slug,
      name: z.string(),
      kind: z.enum(CONTAINER_KINDS),
      description: z.string(),
      outerMm: box,
      innerMm: box,
      tareMassG: int,
      payloadMassG: int,
      holds: z.array(z.enum(PRODUCT_FORMS)),
      carries: z.array(z.enum(CONTAINER_KINDS)),
      mixing: z.enum(MIXING_RULES),
      colour: z.string(),
    }),
  ),
  receipts: z.array(
    z.strictObject({
      id: idOf('stock-receipt'),
      kind: z.literal('diagnostic'),
      atMs: bigIntString,
      supplierPartyId: idOf('party'),
      invoiceId: idOf('invoice'),
      costCents: bigIntString,
      propertyId: slug,
      doorIndex: int,
      productId: slug,
      quantityMicro: bigIntString,
      lotIds: z.array(idOf('lot')),
      loadUnitIds: z.array(idOf('load-unit')),
    }),
  ),
  loadUnits: z.array(
    z.strictObject({
      id: idOf('load-unit'),
      typeId: slug,
      ownerFirmId: idOf('firm'),
      location: locationSchema,
      createdAtMs: bigIntString,
      receiptId: idOf('stock-receipt').nullable(),
    }),
  ),
  lots: z.array(
    z.strictObject({
      id: idOf('lot'),
      productId: slug,
      ownerFirmId: idOf('firm'),
      grade: slug,
      disposition: z.enum(DISPOSITIONS),
      quantityMicro: bigIntString,
      costCents: bigIntString,
      loadUnitId: idOf('load-unit').nullable(),
      serials: z.array(idOf('serial')),
      origin: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('receipt'), receiptId: idOf('stock-receipt') }),
        z.strictObject({ kind: z.literal('split') }),
        z.strictObject({ kind: z.literal('merge') }),
      ]),
      parentLotIds: z.array(idOf('lot')),
      createdAtMs: bigIntString,
      closed: z
        .strictObject({
          atMs: bigIntString,
          reason: z.enum(LOT_CLOSURES),
          intoLotId: idOf('lot').nullable(),
        })
        .nullable(),
    }),
  ),
  movements: z.array(
    z.strictObject({
      id: idOf('stock-move'),
      atMs: bigIntString,
      kind: z.enum(MOVEMENT_KINDS),
      handler: handlerSchema,
      lines: z.array(
        z.strictObject({
          lotId: idOf('lot'),
          quantityMicro: bigIntString,
          fromLoadUnitId: idOf('load-unit').nullable(),
          toLoadUnitId: idOf('load-unit').nullable(),
          resultLotId: idOf('lot').nullable(),
        }),
      ),
      units: z.array(
        z.strictObject({
          loadUnitId: idOf('load-unit'),
          from: locationSchema.nullable(),
          to: locationSchema,
        }),
      ),
      reason: z.enum([...SCRAP_REASONS, ...LOSS_REASONS]).nullable(),
      receiptId: idOf('stock-receipt').nullable(),
      entryId: idOf('entry').nullable(),
      costCents: bigIntString,
    }),
  ),
  reservations: z.array(
    z.strictObject({
      id: idOf('stock-reservation'),
      lotId: idOf('lot'),
      quantityMicro: bigIntString,
      purpose: z.string(),
      createdAtMs: bigIntString,
    }),
  ),
});

const big = encodeBigInt;

function encodeLocation(location: StockLocation): JsonValue {
  return { ...location };
}

export function encodeStock(stock: Stock): JsonValue {
  return {
    products: stock.products.map((product) => ({
      ...product,
      quantumMicro: big(product.quantumMicro),
      itemMm: product.itemMm && { ...product.itemMm },
      massPerQuantumMg: big(product.massPerQuantumMg),
      volumePerQuantumMm3: big(product.volumePerQuantumMm3),
      packUnits: product.packUnits.map((pack) => ({ ...pack })),
      grades: product.grades.map((grade) => ({ ...grade })),
    })),
    containerTypes: stock.containerTypes.map((type) => ({
      ...type,
      outerMm: { ...type.outerMm },
      innerMm: { ...type.innerMm },
      holds: [...type.holds],
      carries: [...type.carries],
    })),
    receipts: stock.receipts.map((receipt) => ({
      ...receipt,
      atMs: big(receipt.atMs),
      costCents: big(receipt.costCents),
      quantityMicro: big(receipt.quantityMicro),
      lotIds: [...receipt.lotIds],
      loadUnitIds: [...receipt.loadUnitIds],
    })),
    loadUnits: stock.loadUnits.map((unit) => ({
      ...unit,
      location: encodeLocation(unit.location),
      createdAtMs: big(unit.createdAtMs),
    })),
    lots: stock.lots.map((lot) => ({
      ...lot,
      quantityMicro: big(lot.quantityMicro),
      costCents: big(lot.costCents),
      serials: [...lot.serials],
      origin: { ...lot.origin },
      parentLotIds: [...lot.parentLotIds],
      createdAtMs: big(lot.createdAtMs),
      closed: lot.closed && { ...lot.closed, atMs: big(lot.closed.atMs) },
    })),
    movements: stock.movements.map((entry) => ({
      ...entry,
      atMs: big(entry.atMs),
      handler: { ...entry.handler },
      lines: entry.lines.map((line) => ({ ...line, quantityMicro: big(line.quantityMicro) })),
      units: entry.units.map((unit) => ({
        loadUnitId: unit.loadUnitId,
        from: unit.from && encodeLocation(unit.from),
        to: encodeLocation(unit.to),
      })),
      costCents: big(entry.costCents),
    })),
    reservations: stock.reservations.map((reservation) => ({
      ...reservation,
      quantityMicro: big(reservation.quantityMicro),
      createdAtMs: big(reservation.createdAtMs),
    })),
  };
}

export function decodeStock(json: unknown): Stock {
  return stockSchema.parse(json);
}
