import { encodeBigInt } from '../shared/bigint-codec';
import type {
  FacilitiesView,
  FloorQuoteQuery,
  FloorQuoteResult,
  PlacementResult,
  QueryResult,
  SimulationQuery,
} from '../shared/ipc/facilities';
import type { Company } from '../domain/company';
import {
  fundsMessage,
  isQuarterTurn,
  placedShape,
  type EquipmentType,
  type PlacedShape,
} from '../domain/equipment';
import { buildingOf, checkPlacement, equipmentTypeOf, type Facilities } from '../domain/facilities';
import { levelGeometry, type Building, type Level } from '../domain/facility';
import type { FloorCovering } from '../domain/floor-covering';
import {
  FLOOR_CONTRACTOR,
  quoteFloorCovering,
  scheduledWorks,
  type FloorContext,
} from '../domain/floor-works';
import { availableFundsCents } from '../domain/invoicing';
import type { Property, RealEstate } from '../domain/real-estate';
import { Rejection } from '../domain/rejection';
import { CELL_AREA_MM2, cellOfKey, gridSpan } from '../domain/region';
import type { Stock } from '../domain/stock';
import { floorObstacles } from '../domain/stock-operations';
import { answerStockRecord } from './stock-view';
import { isoDateAt, type CivilDate } from '../domain/time';

/**
 * Builds the facilities read model (ADR-0048) and answers placement queries
 * (ADR-0050) and floor quotes (ADR-0052) from the authoritative world state.
 * Cell classifications, usable areas, zones, footprints and prices are all
 * computed here, so the renderer never derives a physical fact.
 */

const big = encodeBigInt;

function shapeView(shape: PlacedShape) {
  return {
    footprint: { ...shape.footprint },
    zones: shape.zones.map(({ zone, rect }) => ({ kind: zone.kind, rect: { ...rect } })),
  };
}

type LevelView = NonNullable<FacilitiesView['premises']>['levels'][number];

const levelCache = new WeakMap<Level, Omit<LevelView, 'coverings' | 'works'>>();

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
              coverings: coveringRuns(facilities.coverings, premisesProperty.id, level.index),
              works: scheduledWorks(facilities, premisesProperty.id, level.index).map((job) => ({
                installationId: job.id,
                materialId: job.materialId,
                completesOn: isoDateAt(epoch, job.completesAtMs),
                runs: job.runs.map(
                  ([row, from, to]) => [row, from, to] as [number, number, number],
                ),
              })),
            })),
          }
        : null,
    floorOrders: facilities.installations.map((job) => ({
      id: job.id,
      propertyId: job.propertyId,
      address: property(job.propertyId)?.address ?? job.propertyId,
      level: job.level,
      materialId: job.materialId,
      kind: job.kind,
      status: job.status,
      orderedOn: isoDateAt(epoch, job.atMs),
      completesOn: isoDateAt(epoch, job.completesAtMs),
      cells: job.cells,
      areaMm2: big(job.areaMm2),
      replacedCells: job.replacedCells,
      installCents: big(job.installCents),
      removalCents: big(job.removalCents),
      costCents: big(job.costCents),
    })),
  };
}

type CoveringRun = [number, number, number, string, string];

/** A level's coverings as runs of one material from one order along each row (they are in row order). */
function coveringRuns(
  coverings: readonly FloorCovering[],
  propertyId: string,
  level: number,
): CoveringRun[] {
  const runs: CoveringRun[] = [];
  for (const covering of coverings) {
    if (covering.propertyId !== propertyId || covering.level !== level) {
      continue;
    }
    const last = runs[runs.length - 1];
    if (
      last?.[0] === covering.row &&
      last[2] === covering.col &&
      last[3] === covering.materialId &&
      last[4] === covering.installationId
    ) {
      last[2] = covering.col + 1;
    } else {
      runs.push([
        covering.row,
        covering.col,
        covering.col + 1,
        covering.materialId,
        covering.installationId,
      ]);
    }
  }
  return runs;
}

/** What a query may need besides the facilities: the clock, and the stock standing on floors (Step 10). */
export type QueryContext = FloorContext & { readonly stock?: Stock | null };

/**
 * Answer a read-only query (ADR-0050): a placement verdict, a floor quote
 * (ADR-0052), or a stock record (Step 10, ADR-0055).
 */
export function answerQuery(
  query: Extract<SimulationQuery, { kind: 'placement' }>,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  company: Company | null,
  context?: QueryContext,
): PlacementResult;
export function answerQuery(
  query: FloorQuoteQuery,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  company: Company | null,
  context: FloorContext,
): FloorQuoteResult;
export function answerQuery(
  query: SimulationQuery,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  company: Company | null,
  context: QueryContext,
): QueryResult;
export function answerQuery(
  query: SimulationQuery,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  company: Company | null,
  context?: QueryContext,
): QueryResult {
  if (query.kind === 'floorQuote') {
    if (!context) {
      throw new Error('A floor quote needs the current time and epoch');
    }
    return answerFloorQuote(query, facilities, realEstate, company, context);
  }
  if (query.kind === 'stockRecord') {
    if (!context) {
      throw new Error('A stock record needs the epoch');
    }
    return answerStockRecord(
      query,
      context.stock ?? null,
      facilities,
      realEstate,
      context.epoch,
      company,
    );
  }
  return answerPlacement(query, facilities, realEstate, company, context?.stock ?? null);
}

/**
 * Price a floor order against the current world (ADR-0052): the exact
 * figures, and whether the order would be accepted now. A shortfall of funds
 * still returns the figures, with the refusal the command would give.
 */
function answerFloorQuote(
  query: FloorQuoteQuery,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  company: Company | null,
  context: FloorContext,
): FloorQuoteResult {
  if (!facilities || !realEstate) {
    return {
      kind: 'floorQuote',
      allowed: false,
      refusal: 'This world has no building layouts (created before Step 08).',
      quote: null,
    };
  }
  const quote = quoteFloorCovering(facilities, realEstate, company, query, context);
  if (quote instanceof Rejection) {
    return { kind: 'floorQuote', allowed: false, refusal: quote.reason, quote: null };
  }
  const available = company ? availableFundsCents(company) : 0n;
  const material = facilities.floorMaterials.find((item) => item.id === quote.materialId);
  const short = quote.totalCents > available;
  return {
    kind: 'floorQuote',
    allowed: !short,
    refusal: short
      ? fundsMessage(
          available,
          quote.totalCents,
          `${material?.name ?? quote.materialId} by ${FLOOR_CONTRACTOR}`,
        )
      : null,
    quote: {
      cells: quote.cells,
      skippedCells: quote.skippedCells,
      replacedCells: quote.replacedCells,
      areaMm2: big(quote.areaMm2),
      replacedAreaMm2: big(quote.replacedAreaMm2),
      removals: quote.removals.map((removal) => ({
        materialId: removal.materialId,
        cells: removal.cells,
        areaMm2: big(removal.areaMm2),
      })),
      installCents: big(quote.installCents),
      removalCents: big(quote.removalCents),
      totalCents: big(quote.totalCents),
      availableCents: big(available),
      workDays: quote.workDays,
      completesOn: isoDateAt(context.epoch, quote.completesAtMs),
    },
  };
}

/** Answer a read-only placement query against the current world. */
function answerPlacement(
  query: Extract<SimulationQuery, { kind: 'placement' }>,
  facilities: Facilities | null,
  realEstate: RealEstate | null,
  company: Company | null,
  stock: Stock | null,
): PlacementResult {
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
  // The same obstacles the command meets, so the preview never disagrees with it (Step 10).
  const checked = checkPlacement(
    facilities,
    realEstate,
    company,
    {
      equipmentTypeId: query.equipmentTypeId,
      equipmentId: query.equipmentId,
      placement,
    },
    stock ? floorObstacles(stock, query.propertyId) : [],
  );
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
