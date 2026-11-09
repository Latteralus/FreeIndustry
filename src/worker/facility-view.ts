import { encodeBigInt } from '../shared/bigint-codec';
import type { FacilitiesView, QueryResult, SimulationQuery } from '../shared/ipc/facilities';
import type { Company } from '../domain/company';
import {
  isQuarterTurn,
  placedShape,
  type EquipmentType,
  type PlacedShape,
} from '../domain/equipment';
import { buildingOf, checkPlacement, equipmentTypeOf, type Facilities } from '../domain/facilities';
import { levelGeometry, type Building, type Level } from '../domain/facility';
import type { Property, RealEstate } from '../domain/real-estate';
import { Rejection } from '../domain/rejection';
import { CELL_AREA_MM2, cellOfKey, gridSpan } from '../domain/region';
import { isoDateAt, type CivilDate } from '../domain/time';

/**
 * Builds the facilities read model (ADR-0048) and answers placement queries
 * (ADR-0050) from the authoritative world state. Cell classifications,
 * usable areas, zones and footprints are all computed here, so the renderer
 * never derives a physical fact.
 */

const big = encodeBigInt;

function shapeView(shape: PlacedShape) {
  return {
    footprint: { ...shape.footprint },
    zones: shape.zones.map(({ zone, rect }) => ({ kind: zone.kind, rect: { ...rect } })),
  };
}

type LevelView = NonNullable<FacilitiesView['premises']>['levels'][number];

const levelCache = new WeakMap<Level, Omit<LevelView, 'coverings'>>();

/** The per-level geometry of the view; it never changes, so it is computed once per level. */
function levelStructure(building: Building, property: Property, level: Level) {
  const cached = levelCache.get(level);
  if (cached) {
    return cached;
  }
  const geometry = levelGeometry(building, property, level);
  const span = gridSpan(geometry.bounds);
  const eligible = [...geometry.coverage.keys()].map(cellOfKey);
  const byRow = new Map<number, number[]>();
  for (const cell of eligible) {
    byRow.set(cell.row, [...(byRow.get(cell.row) ?? []), cell.col]);
  }
  const eligibleRuns: [number, number, number][] = [];
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const cols = (byRow.get(row) ?? []).sort((a, b) => a - b);
    let start = cols[0] ?? 0;
    let previous = start;
    for (const col of cols.slice(1)) {
      if (col !== previous + 1) {
        eligibleRuns.push([row, start, previous + 1]);
        start = col;
      }
      previous = col;
    }
    if (cols.length > 0) {
      eligibleRuns.push([row, start, previous + 1]);
    }
  }
  const partialCells: [number, number, number][] = [];
  let full = 0;
  for (const [key, area] of geometry.coverage) {
    if (area >= CELL_AREA_MM2) {
      full += 1;
    } else {
      const { col, row } = cellOfKey(key);
      partialCells.push([col, row, area]);
    }
  }
  partialCells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const view = {
    index: level.index,
    name: level.name,
    elevationMm: level.elevationMm,
    clearHeightMm: level.clearHeightMm,
    floorLoadKgPerM2: level.floorLoadKgPerM2,
    floor: level.floor.map((point) => ({ x: point.x, y: point.y })),
    bounds: { ...geometry.bounds },
    outlineAreaMm2: big(geometry.outlineAreaMm2),
    usableAreaMm2: big(geometry.usable.areaMm2),
    cells: {
      cols: span.cols,
      rows: span.rows,
      full,
      partial: partialCells.length,
      outside: span.cols * span.rows - geometry.coverage.size,
    },
    eligibleRuns,
    partialCells,
    features: [...geometry.structure, ...geometry.forbidden].map((feature) => ({
      kind: feature.kind,
      label: feature.label,
      rect: { ...feature.rect },
    })),
    keepClear: geometry.keepClear.map((zone) => ({
      kind: zone.kind,
      label: zone.label,
      rect: { ...zone.rect },
    })),
  };
  levelCache.set(level, view);
  return view;
}

function typeView(type: EquipmentType) {
  return {
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
    zones: type.zones.map((zone) => ({ ...zone })),
    shape: shapeView(placedShape(type, { xMm: 0, yMm: 0 }, 0)),
  };
}

export function facilitiesView(
  facilities: Facilities,
  realEstate: RealEstate | null,
  company: Company | null,
  epoch: CivilDate,
): FacilitiesView {
  const property = (id: string) => realEstate?.properties.find((candidate) => candidate.id === id);
  const lease = realEstate?.leases.find(
    (candidate) => candidate.status === 'active' && candidate.tenantFirmId === company?.firmId,
  );
  const premisesProperty = lease ? property(lease.propertyId) : undefined;
  const building = premisesProperty && buildingOf(facilities, premisesProperty.id);
  const installedPowerVa = facilities.equipment.reduce((sum, item) => {
    const type = equipmentTypeOf(facilities, item.typeId);
    return item.placement && item.placement.propertyId === premisesProperty?.id && type
      ? sum + type.powerVa
      : sum;
  }, 0);
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
      patternMm: { ...material.patternMm },
    })),
    equipmentTypes: facilities.equipmentTypes.map(typeView),
    equipment: facilities.equipment.map((item) => {
      const type = equipmentTypeOf(facilities, item.typeId);
      const placement = item.placement;
      return {
        id: item.id,
        typeId: item.typeId,
        name: type?.name ?? item.typeId,
        supplier: type?.supplier ?? '',
        purchasedOn: isoDateAt(epoch, item.purchasedAtMs),
        priceCents: big(item.priceCents),
        installations: item.installations,
        status: placement ? ('installed' as const) : ('uninstalled' as const),
        placement:
          placement && type && isQuarterTurn(placement.rotation)
            ? {
                propertyId: placement.propertyId,
                address: property(placement.propertyId)?.address ?? placement.propertyId,
                level: placement.level,
                xMm: placement.xMm,
                yMm: placement.yMm,
                rotation: placement.rotation,
                ...shapeView(placedShape(type, placement, placement.rotation)),
              }
            : null,
      };
    }),
    premises:
      premisesProperty && building
        ? {
            propertyId: premisesProperty.id,
            address: premisesProperty.address,
            surfaceMaterialId: building.surfaceMaterialId,
            powerKva: premisesProperty.powerKva,
            threePhase: premisesProperty.threePhase,
            water: premisesProperty.water,
            gas: premisesProperty.gas,
            permittedUses: [...premisesProperty.permittedUses],
            installedPowerVa,
            levels: building.levels.map((level) => ({
              ...levelStructure(building, premisesProperty, level),
              coverings: facilities.coverings
                .filter(
                  (covering) =>
                    covering.propertyId === premisesProperty.id && covering.level === level.index,
                )
                .map((covering) => ({
                  col: covering.col,
                  row: covering.row,
                  materialId: covering.materialId,
                })),
            })),
          }
        : null,
  };
}

/** Answer a read-only placement query against the current world. */
export function answerQuery(
  query: SimulationQuery,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  company: Company | null,
): QueryResult {
  const empty = {
    kind: 'placement' as const,
    allowed: false,
    problems: [],
    footprint: null,
    zones: [],
    chargeCents: '0',
  };
  if (!facilities || !realEstate) {
    return { ...empty, refusal: 'This world has no building layouts (created before Step 08).' };
  }
  const placement = {
    propertyId: query.propertyId,
    level: query.level,
    xMm: query.xMm,
    yMm: query.yMm,
    rotation: query.rotation,
  };
  const type = equipmentTypeOf(facilities, query.equipmentTypeId);
  const item = facilities.equipment.find((candidate) => candidate.id === query.equipmentId);
  const shape =
    type && isQuarterTurn(query.rotation)
      ? shapeView(placedShape(type, placement, query.rotation))
      : null;
  const charge =
    type && item && (item.placement !== null || item.installations > 0) ? type.relocationCents : 0n;
  const checked = checkPlacement(facilities, realEstate, company, {
    equipmentTypeId: query.equipmentTypeId,
    equipmentId: query.equipmentId,
    placement,
  });
  if (checked instanceof Rejection) {
    return { ...empty, refusal: checked.reason, ...(shape ?? {}) };
  }
  return {
    kind: 'placement',
    allowed: checked.length === 0,
    refusal: null,
    problems: checked.map((problem) => ({
      code: problem.code,
      message: problem.message,
      rect: problem.rect && { ...problem.rect },
    })),
    footprint: shape?.footprint ?? null,
    zones: shape?.zones ?? [],
    chargeCents: big(charge),
  };
}
