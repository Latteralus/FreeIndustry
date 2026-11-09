import { z } from 'zod';
import { nonNegativeCentsString } from '../money';

/**
 * Facilities read model and query (plan Step 08, ADR-0048, ADR-0050): the
 * floor materials and equipment catalog, the equipment the company owns,
 * and the exact geometry of the company's premises — every level's outline,
 * structure, keep-clear zones, usable area and construction-grid cells, and
 * every installed item's footprint and zones. Everything is computed by the
 * worker from the authoritative world; the renderer only draws it. Lengths
 * are integer millimetres in the level's frame; areas are mm² as decimal
 * strings; money is cents strings.
 */

const contentId = z.string().max(48);
const name = z.string().max(60);
const text = z.string().max(240);
const coordinate = z.int().min(-2_000_000).max(2_000_000);
const size = z.int().min(0).max(2_000_000);
const mm2 = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const rectSchema = z.strictObject({ x: coordinate, y: coordinate, width: size, depth: size });
const LIST_LIMIT = 20_000;

const ZONE_KIND = z.enum(['operator', 'maintenance', 'clearance', 'input', 'output']);
const PERMITTED_USE = z.enum([
  'light-manufacturing',
  'general-manufacturing',
  'assembly',
  'storage',
  'distribution',
  'offices',
]);

const zoneRect = z.strictObject({ kind: ZONE_KIND, rect: rectSchema });

const placementView = z.strictObject({
  propertyId: contentId,
  address: name,
  level: z.int().min(0),
  xMm: z.int(),
  yMm: z.int(),
  rotation: z.int(),
  footprint: rectSchema,
  zones: z.array(zoneRect).max(16),
});

export const facilitiesViewSchema = z.strictObject({
  floorMaterials: z
    .array(
      z.strictObject({
        id: contentId,
        name,
        category: z.string().max(40),
        description: text,
        installCentsPerM2: nonNegativeCentsString.nullable(),
        removalCentsPerM2: nonNegativeCentsString,
        colour: z.string().regex(/^#[0-9a-f]{6}$/),
        /** The texture family the renderer draws (spec §11.3), and how many per-cell variants it has. */
        textureSet: z.string().max(40),
        textureVariants: z.int().min(1).max(16),
        patternMm: z.strictObject({ x: size, y: size }),
      }),
    )
    .max(500),
  equipmentTypes: z
    .array(
      z.strictObject({
        id: contentId,
        name,
        category: z.string().max(40),
        description: text,
        supplier: name,
        priceCents: nonNegativeCentsString,
        relocationCents: nonNegativeCentsString,
        widthMm: size,
        depthMm: size,
        heightMm: size,
        weightKg: z.int().min(0),
        powerVa: z.int().min(0),
        threePhase: z.boolean(),
        water: z.boolean(),
        gas: z.boolean(),
        uses: z.array(PERMITTED_USE).max(6),
        zones: z
          .array(
            z.strictObject({
              kind: ZONE_KIND,
              side: z.enum(['front', 'back', 'left', 'right']),
              offsetMm: size,
              widthMm: size,
              depthMm: size,
            }),
          )
          .max(16),
        /** The type's zones placed at the origin, orientation 0 (for the spec-sheet diagram). */
        shape: z.strictObject({ footprint: rectSchema, zones: z.array(zoneRect).max(16) }),
      }),
    )
    .max(500),
  equipment: z
    .array(
      z.strictObject({
        id: z.string().max(40),
        typeId: contentId,
        name,
        supplier: name,
        purchasedOn: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
        priceCents: nonNegativeCentsString,
        installations: z.int().min(0),
        /** `uninstalled`: held by its dealer. `installed`: on the floor (idle until production, Step 13). */
        status: z.enum(['uninstalled', 'installed']),
        placement: placementView.nullable(),
      }),
    )
    .max(2000),
  /** The building the company leases; null without premises. */
  premises: z
    .strictObject({
      propertyId: contentId,
      address: name,
      surfaceMaterialId: contentId,
      powerKva: z.int().min(0),
      threePhase: z.boolean(),
      water: z.boolean(),
      gas: z.boolean(),
      permittedUses: z.array(PERMITTED_USE).max(6),
      /** Electrical demand of the installed equipment. */
      installedPowerVa: z.int().min(0),
      levels: z
        .array(
          z.strictObject({
            index: z.int().min(0),
            name: z.string().max(40),
            elevationMm: z.int().min(0),
            clearHeightMm: size,
            floorLoadKgPerM2: z.int().min(0),
            floor: z
              .array(z.strictObject({ x: coordinate, y: coordinate }))
              .min(4)
              .max(64),
            bounds: rectSchema,
            outlineAreaMm2: mm2,
            usableAreaMm2: mm2,
            cells: z.strictObject({
              cols: z.int().min(0),
              rows: z.int().min(0),
              full: z.int().min(0),
              partial: z.int().min(0),
              outside: z.int().min(0),
            }),
            /** Eligible cells as runs: `[row, firstCol, endCol)`. */
            eligibleRuns: z.array(z.tuple([z.int(), z.int(), z.int()])).max(LIST_LIMIT),
            /** Partial cells: `[col, row, covered mm²]`. */
            partialCells: z.array(z.tuple([z.int(), z.int(), z.int()])).max(LIST_LIMIT),
            features: z
              .array(
                z.strictObject({
                  kind: z.enum(['column', 'wall', 'obstacle', 'forbidden']),
                  label: name,
                  rect: rectSchema,
                }),
              )
              .max(1000),
            keepClear: z
              .array(
                z.strictObject({
                  kind: z.enum(['door', 'utility', 'stair-foot', 'stair-head']),
                  label: z.string().max(120),
                  rect: rectSchema,
                }),
              )
              .max(100),
            /** Cells whose covering differs from the starting surface. */
            coverings: z
              .array(z.strictObject({ col: z.int(), row: z.int(), materialId: contentId }))
              .max(LIST_LIMIT),
          }),
        )
        .min(1)
        .max(4),
    })
    .nullable(),
});

export type FacilitiesView = z.infer<typeof facilitiesViewSchema>;
type PremisesView = NonNullable<FacilitiesView['premises']>;
export type PremisesLevelView = PremisesView['levels'][number];
export type EquipmentTypeView = FacilitiesView['equipmentTypes'][number];
export type EquipmentView = FacilitiesView['equipment'][number];
export type RectView = z.infer<typeof rectSchema>;

/** Read-only questions the renderer may ask the worker (ADR-0050). */
export const simulationQuerySchema = z.discriminatedUnion('kind', [
  /** Would this placement be allowed, and if not, why and where? */
  z.strictObject({
    kind: z.literal('placement'),
    equipmentTypeId: contentId,
    /** The item being moved (left out of the check), or null for a new installation. */
    equipmentId: z
      .string()
      .regex(/^equipment:[1-9][0-9]{0,15}$/)
      .nullable(),
    propertyId: contentId,
    level: z.int().min(0).max(9),
    xMm: z.int().min(0).max(1_000_000),
    yMm: z.int().min(0).max(1_000_000),
    rotation: z.int().min(0).max(359),
  }),
]);

export type SimulationQuery = z.infer<typeof simulationQuerySchema>;

export const queryResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('placement'),
    allowed: z.boolean(),
    /** A reason that comes before geometry (no company, not your premises), or null. */
    refusal: z.string().max(1000).nullable(),
    problems: z
      .array(
        z.strictObject({
          code: z.string().max(20),
          message: z.string().max(1000),
          rect: rectSchema.nullable(),
        }),
      )
      .max(200),
    /** The proposed footprint and zones, when the orientation is a quarter turn. */
    footprint: rectSchema.nullable(),
    zones: z.array(zoneRect).max(16),
    /** The dealer's rigging charge this placement would cost. */
    chargeCents: nonNegativeCentsString,
  }),
]);

export type QueryResult = z.infer<typeof queryResultSchema>;
