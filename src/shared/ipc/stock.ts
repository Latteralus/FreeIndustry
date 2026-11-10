import { z } from 'zod';
import { nonNegativeCentsString } from '../money';

/**
 * Stock read model and record query (plan Step 10, ADR-0055): the product
 * and container catalogs, every load unit with where it is and what it
 * weighs, every open lot, the receipts, and a stock-take. Everything is
 * computed by the worker from the authoritative world; the renderer only
 * formats it. Lengths are integer millimetres; quantities are millionths of
 * the product's base unit, masses milligrams and volumes mm³, all as decimal
 * strings; money is cents strings.
 */

const contentId = z.string().max(48);
const name = z.string().max(60);
const text = z.string().max(240);
const id = z.string().max(40);
const size = z.int().min(0).max(2_000_000);
const coordinate = z.int().min(-2_000_000).max(2_000_000);
const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const isoDate = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
const box = z.strictObject({ width: size, depth: size, height: size });
const rect = z.strictObject({ x: coordinate, y: coordinate, width: size, depth: size });
const LIST_LIMIT = 50_000;

const FORM = z.enum(['item', 'bulk', 'liquid']);
const KIND = z.enum([
  'pallet',
  'crate',
  'carton',
  'tote',
  'drum',
  'bulk-bag',
  'cart',
  'machine-buffer',
]);

const locationView = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('floor'),
    propertyId: contentId,
    address: name,
    level: z.int().min(0),
    rotation: z.int(),
    /** The footprint on the plan. */
    rect,
    /** Whether the company still holds the premises (stock stays when a lease ends). */
    held: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('load-unit'), loadUnitId: id }),
  z.strictObject({ kind: z.literal('equipment'), equipmentId: id, zone: z.int().min(0) }),
]);

export const stockViewSchema = z.strictObject({
  products: z
    .array(
      z.strictObject({
        id: contentId,
        name,
        category: z.string().max(40),
        description: text,
        unit: z.enum(['each', 'kg', 'L']),
        form: FORM,
        tracking: z.enum(['lot', 'serialized']),
        quantumMicro: decimal,
        itemMm: box.nullable(),
        massPerQuantumMg: decimal,
        volumePerQuantumMm3: decimal,
        packUnits: z.array(z.strictObject({ id: contentId, name, quanta: z.int().min(1) })).max(8),
        grades: z.array(z.strictObject({ code: contentId, name })).max(6),
        colour: z.string().regex(/^#[0-9a-f]{6}$/),
      }),
    )
    .max(1000),
  containerTypes: z
    .array(
      z.strictObject({
        id: contentId,
        name,
        kind: KIND,
        description: text,
        outerMm: box,
        innerMm: box,
        /** Tallest it may stand fully loaded. */
        maxHeightMm: size,
        tareMassG: z.int().min(0),
        payloadMassG: z.int().min(0),
        holds: z.array(FORM).max(3),
        carries: z.array(KIND).max(8),
        mixing: z.enum(['mixed', 'single-product', 'single-lot']),
        colour: z.string().regex(/^#[0-9a-f]{6}$/),
      }),
    )
    .max(200),
  loadUnits: z
    .array(
      z.strictObject({
        id,
        typeId: contentId,
        name,
        kind: KIND,
        location: locationView,
        /** The unit at the bottom of its stack (itself when it is not carried). */
        rootId: id,
        receiptId: id.nullable(),
        receivedOn: isoDate,
        grossMassMg: decimal,
        contentsMassMg: decimal,
        payloadMassMg: decimal,
        contentsVolumeMm3: decimal,
        volumeMm3: decimal,
        lotIds: z.array(id).max(500),
        childIds: z.array(id).max(500),
        /** Load units at any depth inside it. */
        nestedUnits: z.int().min(0),
        /** Colour of the goods seen from above (the largest lot's product), or null when empty. */
        loadColour: z
          .string()
          .regex(/^#[0-9a-f]{6}$/)
          .nullable(),
      }),
    )
    .max(5000),
  lots: z
    .array(
      z.strictObject({
        id,
        productId: contentId,
        grade: contentId,
        disposition: z.enum(['available', 'scrap']),
        quantityMicro: decimal,
        reservedMicro: decimal,
        costCents: nonNegativeCentsString,
        massMg: decimal,
        loadUnitId: id,
        serialCount: z.int().min(0),
        origin: z.enum(['receipt', 'split', 'merge']),
        receiptId: id.nullable(),
        parentLotIds: z.array(id).max(100),
        createdOn: isoDate,
      }),
    )
    .max(LIST_LIMIT),
  receipts: z
    .array(
      z.strictObject({
        id,
        receivedOn: isoDate,
        supplier: name,
        invoiceId: id,
        costCents: nonNegativeCentsString,
        propertyId: contentId,
        address: name,
        doorIndex: z.int().min(0),
        productId: contentId,
        quantityMicro: decimal,
        lotCount: z.int().min(0),
        loadUnitCount: z.int().min(0),
      }),
    )
    .max(LIST_LIMIT),
  /** The stock-take: counted by walking the stacks, recorded by the lots (Step 10). */
  count: z
    .array(
      z.strictObject({
        productId: contentId,
        propertyId: contentId.nullable(),
        address: name.nullable(),
        countedMicro: decimal,
        recordedMicro: decimal,
        scrapMicro: decimal,
        lots: z.int().min(0),
        massMg: decimal,
        costCents: nonNegativeCentsString,
      }),
    )
    .max(LIST_LIMIT),
  totals: z.strictObject({
    loadUnits: z.int().min(0),
    lots: z.int().min(0),
    costCents: nonNegativeCentsString,
    /** The Inventory account's balance, which must equal the lots' cost. */
    inventoryCents: z.string().regex(/^-?(?:0|[1-9][0-9]{0,18})$/),
  }),
});

export type StockView = z.infer<typeof stockViewSchema>;
export type LoadUnitView = StockView['loadUnits'][number];
export type LotView = StockView['lots'][number];
export type ProductView = StockView['products'][number];

/** Ask for the full record of a load unit or a lot: contents, provenance and history. */
export const stockRecordQuerySchema = z.strictObject({
  kind: z.literal('stockRecord'),
  id: z.string().regex(/^(?:load-unit|lot):[1-9][0-9]{0,15}$/),
});

const locationText = z.string().max(200);

export const stockRecordResultSchema = z.strictObject({
  kind: z.literal('stockRecord'),
  found: z.boolean(),
  /** The load unit the record is about (a closed lot has none). */
  loadUnitId: id.nullable(),
  /** The lot asked for, if a lot was asked for. */
  lotId: id.nullable(),
  /** Where the load unit is, in words, carriers first. */
  whereabouts: locationText,
  carriers: z.array(id).max(8),
  lots: z
    .array(
      z.strictObject({
        id,
        productId: contentId,
        grade: contentId,
        disposition: z.enum(['available', 'scrap']),
        quantityMicro: decimal,
        reservedMicro: decimal,
        costCents: nonNegativeCentsString,
        closed: z.string().max(40).nullable(),
        serials: z.array(id).max(500),
        serialCount: z.int().min(0),
        /** The lot and everything it came from, nearest first. */
        lineage: z
          .array(
            z.strictObject({
              lotId: id,
              origin: z.enum(['receipt', 'split', 'merge']),
              createdOn: isoDate,
              parents: z.array(id).max(100),
              receiptId: id.nullable(),
              supplier: name.nullable(),
              invoiceId: id.nullable(),
            }),
          )
          .max(50),
      }),
    )
    .max(500),
  history: z
    .array(
      z.strictObject({
        id,
        at: z.string().max(20),
        kind: z.enum(['receipt', 'transfer', 'split', 'merge', 'relocation', 'scrap', 'loss']),
        handler: z.string().max(80),
        reason: z.string().max(20).nullable(),
        costCents: nonNegativeCentsString,
        lines: z
          .array(
            z.strictObject({
              lotId: id,
              productId: contentId,
              quantityMicro: decimal,
              from: id.nullable(),
              to: id.nullable(),
              resultLotId: id.nullable(),
            }),
          )
          .max(200),
        units: z
          .array(z.strictObject({ loadUnitId: id, from: locationText, to: locationText }))
          .max(200),
      }),
    )
    .max(200),
});

export type StockRecordResult = z.infer<typeof stockRecordResultSchema>;
