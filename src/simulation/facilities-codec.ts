import { z } from 'zod';
import { bigIntString, encodeBigInt } from '../shared/bigint-codec';
import type { JsonValue } from '../shared/canonical-json';
import { EQUIPMENT_CATEGORIES, SIDES, ZONE_KINDS } from '../domain/equipment';
import type { Facilities } from '../domain/facilities';
import { FEATURE_KINDS, UTILITY_KINDS } from '../domain/facility';
import {
  FLOOR_MATERIAL_CATEGORIES,
  INSTALLATION_KINDS,
  INSTALLATION_STATUSES,
} from '../domain/floor-covering';
import { isEntityIdOf, type EntityId } from '../domain/ids';
import { isSlug, PERMITTED_USES } from '../domain/real-estate';
import type { RectMm } from '../domain/region';

/**
 * Plain-JSON encoding of the facilities slice: the fingerprint input, the
 * checkpoint format (ADR-0022) and the form in which a new world's catalog
 * and building structure reach the kernel (ADR-0037, ADR-0047). Every
 * bigint is a canonical decimal string; lists keep their domain order.
 * Decoding validates shapes; the business invariants are checked separately
 * (`facilitiesProblems`).
 */

function idOf<K extends string>(kind: K) {
  return z
    .string()
    .refine((id): id is EntityId<K> => isEntityIdOf(kind, id), `Expected a ${kind} ID`);
}

const slug = z.string().refine(isSlug, 'Expected a content identifier');
const int = z.int();
const rectSchema = z.strictObject({ x: int, y: int, width: int, depth: int });
const point = z.strictObject({ x: int, y: int });

const facilitiesSchema = z.strictObject({
  floorMaterials: z.array(
    z.strictObject({
      id: slug,
      name: z.string(),
      category: z.enum(FLOOR_MATERIAL_CATEGORIES),
      description: z.string(),
      installCentsPerM2: bigIntString.nullable(),
      removalCentsPerM2: bigIntString,
      colour: z.string(),
      textureSet: z.string(),
      textureVariants: int,
      patternMm: point,
    }),
  ),
  equipmentTypes: z.array(
    z.strictObject({
      id: slug,
      name: z.string(),
      category: z.enum(EQUIPMENT_CATEGORIES),
      description: z.string(),
      supplier: z.string(),
      priceCents: bigIntString,
      relocationCents: bigIntString,
      widthMm: int,
      depthMm: int,
      heightMm: int,
      weightKg: int,
      powerVa: int,
      threePhase: z.boolean(),
      water: z.boolean(),
      gas: z.boolean(),
      uses: z.array(z.enum(PERMITTED_USES)),
      zones: z.array(
        z.strictObject({
          kind: z.enum(ZONE_KINDS),
          side: z.enum(SIDES),
          offsetMm: int,
          widthMm: int,
          depthMm: int,
        }),
      ),
    }),
  ),
  buildings: z.array(
    z.strictObject({
      propertyId: slug,
      surfaceMaterialId: slug,
      parcel: rectSchema,
      levels: z.array(
        z.strictObject({
          index: int,
          name: z.string(),
          elevationMm: int,
          deckDepthMm: int,
          floor: z.array(point),
          clearHeightMm: int,
          floorLoadKgPerM2: int,
          features: z.array(
            z.strictObject({ kind: z.enum(FEATURE_KINDS), label: z.string(), rect: rectSchema }),
          ),
        }),
      ),
      utilities: z.array(
        z.strictObject({
          kind: z.enum(UTILITY_KINDS),
          label: z.string(),
          edge: int,
          offsetMm: int,
          widthMm: int,
        }),
      ),
      stairs: z.array(
        z.strictObject({ upperLevel: int, flight: rectSchema, foot: rectSchema, head: rectSchema }),
      ),
    }),
  ),
  equipment: z.array(
    z.strictObject({
      id: idOf('equipment'),
      typeId: slug,
      supplierPartyId: idOf('party'),
      purchaseInvoiceId: idOf('invoice'),
      purchasedAtMs: bigIntString,
      priceCents: bigIntString,
      installations: int,
      placement: z
        .strictObject({ propertyId: slug, level: int, xMm: int, yMm: int, rotation: int })
        .nullable(),
    }),
  ),
  coverings: z.array(
    z.strictObject({
      propertyId: slug,
      level: int,
      col: int,
      row: int,
      materialId: slug,
      installationId: idOf('floor-installation'),
    }),
  ),
  installations: z.array(
    z.strictObject({
      id: idOf('floor-installation'),
      propertyId: slug,
      level: int,
      materialId: slug,
      firmId: idOf('firm'),
      atMs: bigIntString,
      completesAtMs: bigIntString,
      status: z.enum(INSTALLATION_STATUSES),
      kind: z.enum(INSTALLATION_KINDS),
      cells: int,
      areaMm2: bigIntString,
      replacedCells: int,
      replacedAreaMm2: bigIntString,
      installCents: bigIntString,
      removalCents: bigIntString,
      costCents: bigIntString,
      journalEntryId: idOf('entry'),
      runs: z.array(z.tuple([int, int, int])),
    }),
  ),
});

export function decodeFacilities(json: unknown): Facilities {
  return facilitiesSchema.parse(json);
}

const big = encodeBigInt;
const xy = (value: { readonly x: number; readonly y: number }) => ({ x: value.x, y: value.y });
const box = (r: RectMm) => ({ x: r.x, y: r.y, width: r.width, depth: r.depth });

export function encodeFacilities(facilities: Facilities): JsonValue {
  return {
    floorMaterials: facilities.floorMaterials.map((material) => ({
      id: material.id,
      name: material.name,
      category: material.category,
      description: material.description,
      installCentsPerM2:
        material.installCentsPerM2 === null ? null : big(material.installCentsPerM2),
      removalCentsPerM2: big(material.removalCentsPerM2),
      colour: material.colour,
      textureSet: material.textureSet,
      textureVariants: material.textureVariants,
      patternMm: xy(material.patternMm),
    })),
    equipmentTypes: facilities.equipmentTypes.map((type) => ({
      id: type.id,
      name: type.name,
      category: type.category,
      description: type.description,
      supplier: type.supplier,
      priceCents: big(type.priceCents),
      relocationCents: big(type.relocationCents),
      widthMm: type.widthMm,
      depthMm: type.depthMm,
      heightMm: type.heightMm,
      weightKg: type.weightKg,
      powerVa: type.powerVa,
      threePhase: type.threePhase,
      water: type.water,
      gas: type.gas,
      uses: [...type.uses],
      zones: type.zones.map((zone) => ({
        kind: zone.kind,
        side: zone.side,
        offsetMm: zone.offsetMm,
        widthMm: zone.widthMm,
        depthMm: zone.depthMm,
      })),
    })),
    buildings: facilities.buildings.map((building) => ({
      propertyId: building.propertyId,
      surfaceMaterialId: building.surfaceMaterialId,
      parcel: box(building.parcel),
      levels: building.levels.map((level) => ({
        index: level.index,
        name: level.name,
        elevationMm: level.elevationMm,
        deckDepthMm: level.deckDepthMm,
        floor: level.floor.map(xy),
        clearHeightMm: level.clearHeightMm,
        floorLoadKgPerM2: level.floorLoadKgPerM2,
        features: level.features.map((feature) => ({
          kind: feature.kind,
          label: feature.label,
          rect: box(feature.rect),
        })),
      })),
      utilities: building.utilities.map((utility) => ({
        kind: utility.kind,
        label: utility.label,
        edge: utility.edge,
        offsetMm: utility.offsetMm,
        widthMm: utility.widthMm,
      })),
      stairs: building.stairs.map((stair) => ({
        upperLevel: stair.upperLevel,
        flight: box(stair.flight),
        foot: box(stair.foot),
        head: box(stair.head),
      })),
    })),
    equipment: facilities.equipment.map((item) => ({
      id: item.id,
      typeId: item.typeId,
      supplierPartyId: item.supplierPartyId,
      purchaseInvoiceId: item.purchaseInvoiceId,
      purchasedAtMs: big(item.purchasedAtMs),
      priceCents: big(item.priceCents),
      installations: item.installations,
      placement: item.placement && {
        propertyId: item.placement.propertyId,
        level: item.placement.level,
        xMm: item.placement.xMm,
        yMm: item.placement.yMm,
        rotation: item.placement.rotation,
      },
    })),
    coverings: facilities.coverings.map((covering) => ({
      propertyId: covering.propertyId,
      level: covering.level,
      col: covering.col,
      row: covering.row,
      materialId: covering.materialId,
      installationId: covering.installationId,
    })),
    installations: facilities.installations.map((installation) => ({
      id: installation.id,
      propertyId: installation.propertyId,
      level: installation.level,
      materialId: installation.materialId,
      firmId: installation.firmId,
      atMs: big(installation.atMs),
      completesAtMs: big(installation.completesAtMs),
      status: installation.status,
      kind: installation.kind,
      cells: installation.cells,
      areaMm2: big(installation.areaMm2),
      replacedCells: installation.replacedCells,
      replacedAreaMm2: big(installation.replacedAreaMm2),
      installCents: big(installation.installCents),
      removalCents: big(installation.removalCents),
      costCents: big(installation.costCents),
      journalEntryId: installation.journalEntryId,
      runs: installation.runs.map(([row, from, to]) => [row, from, to]),
    })),
  };
}
