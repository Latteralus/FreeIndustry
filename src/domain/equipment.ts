import { formatUsd, type Cents } from '../shared/money';
import {
  levelGeometry,
  levelOf,
  walkwayReach,
  WALKWAY_WIDTH_MM,
  type Building,
  type LevelGeometry,
} from './facility';
import type { EntityId } from './ids';
import type { PERMITTED_USES, Property } from './real-estate';
import { decompose, intersection, overlaps, regionContains, type RectMm } from './region';
import type { SimTimeMs } from './time';

/**
 * Equipment: the data-driven catalog of machines, benches, racks, furniture
 * and fixtures, the items the company owns, and where they stand (spec §5.2,
 * §5.4; plan Step 08; DECISIONS ADR-0045, ADR-0048).
 *
 * A footprint is an exact integer-millimetre rectangle from the catalog,
 * never rounded to cells. Around it each type declares zones in its own
 * frame: operator stations, maintenance areas, safety clearances and
 * material ports. At orientation 0 the type's width runs along x and its
 * depth along y; its **front** is the +y side (down the plan), its **back**
 * the −y side, its **left** the −x side and its **right** the +x side.
 * Orientation is a clockwise quarter turn on the plan. A placed item's
 * position is the minimum corner of its turned footprint, on the 250 mm
 * placement lattice.
 *
 * Every placement rule is tested on that exact geometry: fit inside the
 * walls, columns and obstacles, forbidden zones and the clear landings at
 * doors, utility points and stairs, other equipment and the zones around
 * it, clear height (including under mezzanines), the slab's rated load, the
 * electrical supply and services, the permitted use of the premises, and a
 * walkway at least 800 mm wide from the entrances to every door, utility
 * point, stair, operator station and maintenance area.
 */

export const EQUIPMENT_CATEGORIES = [
  'machining',
  'fabrication',
  'woodworking',
  'plastics',
  'finishing',
  'assembly',
  'material-handling',
  'storage',
  'office',
  'utility',
] as const;
type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export const ZONE_KINDS = ['operator', 'maintenance', 'clearance', 'input', 'output'] as const;
type ZoneKind = (typeof ZONE_KINDS)[number];

export const SIDES = ['front', 'back', 'left', 'right'] as const;
type Side = (typeof SIDES)[number];

const ROTATIONS = [0, 90, 180, 270] as const;
export type Rotation = (typeof ROTATIONS)[number];

/** Positions lie on this lattice (ADR-0045). */
export const PLACEMENT_LATTICE_MM = 250;

/**
 * A zone beside one side of a footprint, in the type's own frame: `widthMm`
 * along the side starting `offsetMm` from its first corner (the left end of
 * the front and back, the back end of the left and right), and `depthMm`
 * out from it.
 */
interface EquipmentZone {
  readonly kind: ZoneKind;
  readonly side: Side;
  readonly offsetMm: number;
  readonly widthMm: number;
  readonly depthMm: number;
}

type PermittedUse = (typeof PERMITTED_USES)[number];

export interface EquipmentType {
  readonly id: string;
  readonly name: string;
  readonly category: EquipmentCategory;
  readonly description: string;
  /** The dealer who sells, delivers, installs and relocates it. */
  readonly supplier: string;
  /** Price delivered and installed once. */
  readonly priceCents: Cents;
  /** What the dealer's riggers charge to install it again or move it. */
  readonly relocationCents: Cents;
  readonly widthMm: number;
  readonly depthMm: number;
  readonly heightMm: number;
  readonly weightKg: number;
  /** Electrical demand in volt-amperes; 0 for unpowered equipment. */
  readonly powerVa: number;
  readonly threePhase: boolean;
  readonly water: boolean;
  readonly gas: boolean;
  /** Premises must permit at least one of these uses. */
  readonly uses: readonly PermittedUse[];
  readonly zones: readonly EquipmentZone[];
}

export interface Placement {
  readonly propertyId: string;
  readonly level: number;
  readonly xMm: number;
  readonly yMm: number;
  readonly rotation: number;
}

/** An item the company owns. Without a placement it is held by its dealer, uninstalled. */
export interface Equipment {
  readonly id: EntityId<'equipment'>;
  readonly typeId: string;
  readonly supplierPartyId: EntityId<'party'>;
  readonly purchaseInvoiceId: EntityId<'invoice'>;
  readonly purchasedAtMs: SimTimeMs;
  readonly priceCents: Cents;
  /** How many times it has been installed (the first installation is in the price). */
  readonly installations: number;
  readonly placement: Placement | null;
}

const MAX_FOOTPRINT_MM = 100_000;
const MAX_HEIGHT_MM = 20_000;
const MAX_ZONE_DEPTH_MM = 10_000;
const MAX_ZONES = 16;

// ------------------------------------------------------------- frames

export function isQuarterTurn(rotation: number): rotation is Rotation {
  return (ROTATIONS as readonly number[]).includes(rotation);
}

/** Map a rectangle in the type's own frame onto the plan. */
function toPlan(
  type: Pick<EquipmentType, 'widthMm' | 'depthMm'>,
  placement: Pick<Placement, 'xMm' | 'yMm'>,
  rotation: Rotation,
  local: RectMm,
): RectMm {
  const W = type.widthMm;
  const D = type.depthMm;
  const map = (u: number, v: number) => {
    switch (rotation) {
      case 0:
        return { x: u, y: v };
      case 90:
        return { x: D - v, y: u };
      case 180:
        return { x: W - u, y: D - v };
      case 270:
        return { x: v, y: W - u };
    }
  };
  const a = map(local.x, local.y);
  const b = map(local.x + local.width, local.y + local.depth);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x: placement.xMm + x,
    y: placement.yMm + y,
    width: Math.max(a.x, b.x) - x,
    depth: Math.max(a.y, b.y) - y,
  };
}

function zoneLocal(type: Pick<EquipmentType, 'widthMm' | 'depthMm'>, zone: EquipmentZone): RectMm {
  switch (zone.side) {
    case 'front':
      return { x: zone.offsetMm, y: type.depthMm, width: zone.widthMm, depth: zone.depthMm };
    case 'back':
      return { x: zone.offsetMm, y: -zone.depthMm, width: zone.widthMm, depth: zone.depthMm };
    case 'left':
      return { x: -zone.depthMm, y: zone.offsetMm, width: zone.depthMm, depth: zone.widthMm };
    case 'right':
      return { x: type.widthMm, y: zone.offsetMm, width: zone.depthMm, depth: zone.widthMm };
  }
}

export interface PlacedShape {
  readonly footprint: RectMm;
  readonly zones: readonly { readonly zone: EquipmentZone; readonly rect: RectMm }[];
}

/** The exact footprint and zones of a type placed at a quarter-turn orientation. */
export function placedShape(
  type: EquipmentType,
  placement: Pick<Placement, 'xMm' | 'yMm'>,
  rotation: Rotation,
): PlacedShape {
  return {
    footprint: toPlan(type, placement, rotation, {
      x: 0,
      y: 0,
      width: type.widthMm,
      depth: type.depthMm,
    }),
    zones: type.zones.map((zone) => ({
      zone,
      rect: toPlan(type, placement, rotation, zoneLocal(type, zone)),
    })),
  };
}

// ----------------------------------------------------------- validation

/** Why a catalog definition is physically impossible; empty when it is sound. */
export function equipmentTypeProblems(type: EquipmentType): string[] {
  const problems: string[] = [];
  const dimension = (value: number, max: number, what: string) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      problems.push(`${what} must be 1–${max.toLocaleString('en-US')}`);
    }
  };
  dimension(type.widthMm, MAX_FOOTPRINT_MM, 'width (mm)');
  dimension(type.depthMm, MAX_FOOTPRINT_MM, 'depth (mm)');
  dimension(type.heightMm, MAX_HEIGHT_MM, 'height (mm)');
  dimension(type.weightKg, 1_000_000, 'weight (kg)');
  if (type.priceCents <= 0n) {
    problems.push('the price must be positive');
  }
  if (type.relocationCents < 0n) {
    problems.push('the relocation charge cannot be negative');
  }
  if (!Number.isSafeInteger(type.powerVa) || type.powerVa < 0 || type.powerVa > 10_000_000) {
    problems.push('electrical demand must be 0–10,000,000 VA');
  }
  if (type.threePhase && type.powerVa === 0) {
    problems.push('a three-phase machine must draw power');
  }
  if (type.uses.length === 0 || new Set(type.uses).size !== type.uses.length) {
    problems.push('it needs one or more distinct permitted uses');
  }
  if (type.zones.length > MAX_ZONES) {
    problems.push(`more than ${MAX_ZONES} zones`);
  }
  type.zones.forEach((zone, index) => {
    const side = zone.side === 'front' || zone.side === 'back' ? type.widthMm : type.depthMm;
    if (
      !Number.isSafeInteger(zone.offsetMm) ||
      !Number.isSafeInteger(zone.widthMm) ||
      zone.offsetMm < 0 ||
      zone.widthMm < 1 ||
      zone.offsetMm + zone.widthMm > side
    ) {
      problems.push(`zone ${index} (${zone.kind}) does not fit along the ${zone.side}`);
    }
    if (
      !Number.isSafeInteger(zone.depthMm) ||
      zone.depthMm < 1 ||
      zone.depthMm > MAX_ZONE_DEPTH_MM
    ) {
      problems.push(`zone ${index} (${zone.kind}) must be 1–${MAX_ZONE_DEPTH_MM} mm deep`);
    }
  });
  return problems;
}

type PlacementProblemCode =
  | 'lattice'
  | 'rotation'
  | 'level'
  | 'use'
  | 'height'
  | 'floor-load'
  | 'power'
  | 'services'
  | 'fit'
  | 'structure'
  | 'forbidden'
  | 'keep-clear'
  | 'equipment'
  | 'zone'
  | 'stock'
  | 'floor-works'
  | 'route';

/** One violated placement rule, with the rectangle where it happens when there is one. */
export interface PlacementProblem {
  readonly code: PlacementProblemCode;
  readonly message: string;
  readonly rect: RectMm | null;
}

/** An item standing in the building (or proposed), with its type and plan shape. */
export interface Standing {
  readonly id: string | null;
  readonly type: EquipmentType;
  readonly placement: Placement;
  readonly shape: PlacedShape;
}

export interface PlacementSite {
  readonly building: Building;
  readonly property: Property;
}

const ZONE_NAME: Record<ZoneKind, string> = {
  operator: 'operator station',
  maintenance: 'maintenance area',
  clearance: 'safety clearance',
  input: 'input port',
  output: 'output port',
};

const mm = (value: number) => `${value.toLocaleString('en-US')} mm`;
const kva = (va: number) =>
  `${(va / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} kVA`;

/** Description of an item for messages: "the Bench drill press (equipment:3)". */
function nameOf(item: Standing): string {
  return item.id ? `the ${item.type.name} (${item.id})` : `the ${item.type.name}`;
}

function zoneLabel(zone: EquipmentZone): string {
  return `${ZONE_NAME[zone.kind]} at the ${zone.side}`;
}

/** Problems with one item where it stands, among `others` (route excluded). */
function itemProblems(
  site: PlacementSite,
  item: Standing,
  others: readonly Standing[],
): PlacementProblem[] {
  const { building, property } = site;
  const problems: PlacementProblem[] = [];
  const { type, placement, shape } = item;
  const level = levelOf(building, placement.level);
  if (!level) {
    return [
      { code: 'level', message: `${property.address} has no level ${placement.level}`, rect: null },
    ];
  }
  const geometry = levelGeometry(building, property, level);
  const footprint = shape.footprint;

  if (!type.uses.some((use) => property.permittedUses.includes(use))) {
    problems.push({
      code: 'use',
      message: `The ${type.name} needs premises permitted for ${type.uses.join(' or ')}; ${property.address} is let for ${property.permittedUses.join(', ')}`,
      rect: null,
    });
  }
  // Clear height, including headroom under any level above.
  let headroom = level.clearHeightMm;
  let under: string | null = null;
  for (const upper of building.levels.filter((candidate) => candidate.index > level.index)) {
    const above = decompose(upper.floor).region;
    if (above.rects.some((part) => overlaps(part, footprint))) {
      const clear = upper.elevationMm - upper.deckDepthMm - level.elevationMm;
      if (clear < headroom) {
        headroom = clear;
        under = upper.name;
      }
    }
  }
  if (type.heightMm > headroom) {
    problems.push({
      code: 'height',
      message: `The ${type.name} is ${mm(type.heightMm)} tall; the clear height ${under ? `under the ${under}` : 'here'} is ${mm(headroom)}`,
      rect: footprint,
    });
  }
  // Floor load: weight over the footprint against the slab's rating, exactly.
  const area = BigInt(footprint.width) * BigInt(footprint.depth);
  if (BigInt(type.weightKg) * 1_000_000n > BigInt(level.floorLoadKgPerM2) * area) {
    const loading = (BigInt(type.weightKg) * 1_000_000n + area - 1n) / area;
    problems.push({
      code: 'floor-load',
      message: `The ${type.name} weighs ${type.weightKg.toLocaleString('en-US')} kg on its footprint, ${loading.toLocaleString('en-US')} kg/m²; the floor here is rated for ${level.floorLoadKgPerM2.toLocaleString('en-US')} kg/m²`,
      rect: footprint,
    });
  }
  // Services.
  if (type.threePhase && !property.threePhase) {
    problems.push({
      code: 'services',
      message: `The ${type.name} needs a three-phase supply; ${property.address} has single-phase power only`,
      rect: null,
    });
  }
  if (type.water && !property.water) {
    problems.push({
      code: 'services',
      message: `The ${type.name} needs a water supply; ${property.address} has none`,
      rect: null,
    });
  }
  if (type.gas && !property.gas) {
    problems.push({
      code: 'services',
      message: `The ${type.name} needs a gas supply; ${property.address} has none`,
      rect: null,
    });
  }
  const demand = others.reduce((sum, other) => sum + other.type.powerVa, type.powerVa);
  if (type.powerVa > 0 && demand > property.powerKva * 1000) {
    problems.push({
      code: 'power',
      message: `With the ${type.name} the installed equipment would draw ${kva(demand)}; the electrical supply of ${property.address} is ${kva(property.powerKva * 1000)}`,
      rect: null,
    });
  }

  // Fit inside the walls.
  const insideOutline = decompose(level.floor).region;
  if (!regionContains(insideOutline, footprint)) {
    const bounds = geometry.bounds;
    const turned = { width: footprint.depth, depth: footprint.width };
    let message: string;
    if (
      (footprint.width > bounds.width || footprint.depth > bounds.depth) &&
      (turned.width > bounds.width || turned.depth > bounds.depth)
    ) {
      message = `The ${type.name} does not fit: its footprint is ${mm(type.widthMm)} × ${mm(type.depthMm)} and the floor of ${property.address} is only ${mm(bounds.width)} × ${mm(bounds.depth)}`;
    } else if (footprint.width > bounds.width || footprint.depth > bounds.depth) {
      message = `Turned this way the ${type.name} is ${mm(footprint.width)} × ${mm(footprint.depth)}, more than the ${mm(bounds.width)} × ${mm(bounds.depth)} floor; turn it a quarter`;
    } else {
      message = `The ${type.name} (${mm(footprint.width)} × ${mm(footprint.depth)}) extends beyond the walls here`;
    }
    problems.push({ code: 'fit', message, rect: footprint });
  }
  for (const feature of geometry.structure) {
    const shared = intersection(feature.rect, footprint);
    if (shared) {
      problems.push({
        code: 'structure',
        message: `The ${type.name} overlaps ${feature.label}`,
        rect: shared,
      });
    }
  }
  for (const feature of geometry.forbidden) {
    const shared = intersection(feature.rect, footprint);
    if (shared) {
      problems.push({
        code: 'forbidden',
        message: `The ${type.name} stands in a no-installation zone: ${feature.label}`,
        rect: shared,
      });
    }
  }
  for (const zone of geometry.keepClear) {
    const shared = intersection(zone.rect, footprint);
    if (shared) {
      problems.push({
        code: 'keep-clear',
        message: `The ${type.name} blocks the clear landing at ${zone.label}`,
        rect: shared,
      });
    }
  }
  // Own zones: on open floor, clear of other equipment.
  for (const { zone, rect: zoneRect } of shape.zones) {
    if (!regionContains(geometry.floor, zoneRect)) {
      problems.push({
        code: 'zone',
        message: `The ${zoneLabel(zone)} of the ${type.name} (${mm(zone.depthMm)} deep) runs into a wall, column or obstacle`,
        rect: zoneRect,
      });
    }
  }
  for (const other of others.filter((candidate) => candidate.placement.level === level.index)) {
    const shared = intersection(other.shape.footprint, footprint);
    if (shared) {
      problems.push({
        code: 'equipment',
        message: `The ${type.name} overlaps ${nameOf(other)}`,
        rect: shared,
      });
    }
    for (const { zone, rect: zoneRect } of shape.zones) {
      const blocked = intersection(zoneRect, other.shape.footprint);
      if (blocked) {
        problems.push({
          code: 'zone',
          message: `The ${zoneLabel(zone)} of the ${type.name} is obstructed by ${nameOf(other)}`,
          rect: blocked,
        });
      }
    }
    for (const { zone, rect: zoneRect } of other.shape.zones) {
      const blocked = intersection(zoneRect, footprint);
      if (blocked) {
        problems.push({
          code: 'zone',
          message: `The ${type.name} stands in the ${zoneLabel(zone)} of ${nameOf(other)}`,
          rect: blocked,
        });
      }
    }
  }
  return problems;
}

/** Report order: what does not physically fit first, then what the building cannot supply. */
const PRIORITY: readonly PlacementProblemCode[] = [
  'lattice',
  'rotation',
  'level',
  'fit',
  'structure',
  'keep-clear',
  'forbidden',
  'equipment',
  'zone',
  'stock',
  'floor-works',
  'height',
  'floor-load',
  'route',
  'use',
  'services',
  'power',
];

function byPriority(problems: PlacementProblem[]): PlacementProblem[] {
  return problems
    .map((problem, index) => ({ problem, index }))
    .sort(
      (a, b) =>
        PRIORITY.indexOf(a.problem.code) - PRIORITY.indexOf(b.problem.code) || a.index - b.index,
    )
    .map(({ problem }) => problem);
}

/**
 * Walkway problems of one level with `items` standing on it, and `blocked`
 * other footprints on the floor (stock standing there, Step 10).
 */
export function routeProblems(
  geometry: LevelGeometry,
  items: readonly Standing[],
  blocked: readonly RectMm[] = [],
): PlacementProblem[] {
  const reachZones = items.flatMap((item) =>
    item.shape.zones
      .filter(({ zone }) => zone.kind === 'operator' || zone.kind === 'maintenance')
      .map(({ zone, rect: zoneRect }) => ({ item, zone, rect: zoneRect })),
  );
  const reach = walkwayReach(
    geometry,
    [...items.map((item) => item.shape.footprint), ...blocked],
    reachZones.map((target) => target.rect),
  );
  const problems: PlacementProblem[] = [];
  const way = `a clear way at least ${mm(WALKWAY_WIDTH_MM)} wide is needed`;
  geometry.keepClear.forEach((zone, index) => {
    if (reach.keepClear[index] !== true) {
      problems.push({
        code: 'route',
        message: `This would leave ${zone.label} unreachable on foot: ${way}`,
        rect: zone.rect,
      });
    }
  });
  reachZones.forEach((target, index) => {
    if (reach.extra[index] !== true) {
      problems.push({
        code: 'route',
        message: `The ${zoneLabel(target.zone)} of ${nameOf(target.item)} could not be reached on foot: ${way}`,
        rect: target.rect,
      });
    }
  });
  return problems;
}

/** Rules that need no geometry: the lattice and the quarter turn. */
function framingProblems(placement: Placement): PlacementProblem[] {
  const problems: PlacementProblem[] = [];
  if (placement.xMm % PLACEMENT_LATTICE_MM !== 0 || placement.yMm % PLACEMENT_LATTICE_MM !== 0) {
    problems.push({
      code: 'lattice',
      message: `Equipment stands on the ${PLACEMENT_LATTICE_MM} mm placement lattice; (${mm(placement.xMm)}, ${mm(placement.yMm)}) is not on it`,
      rect: null,
    });
  }
  if (!isQuarterTurn(placement.rotation)) {
    problems.push({
      code: 'rotation',
      message: `Equipment turns in quarter turns only (0°, 90°, 180° or 270°), not ${placement.rotation}°`,
      rect: null,
    });
  }
  return problems;
}

/** An installed item, ready for placement checks. */
export function standing(
  id: string | null,
  type: EquipmentType,
  placement: Placement,
): Standing | null {
  if (!isQuarterTurn(placement.rotation)) {
    return null;
  }
  return { id, type, placement, shape: placedShape(type, placement, placement.rotation) };
}

/** Floor being laid on a level: the cells of one contractor's job, as rectangles (ADR-0052). */
export interface FloorWorksArea {
  readonly level: number;
  readonly label: string;
  readonly rects: readonly RectMm[];
}

/** A load unit standing on a floor (Step 10, ADR-0054): equipment may not go on it. */
export interface StockObstacle {
  readonly id: string;
  readonly level: number;
  /** "the Wooden pallet (load-unit:3)". */
  readonly label: string;
  readonly rect: RectMm;
}

/** Stock in the way of a footprint or of its operator, maintenance and clearance zones. */
function stockProblems(
  type: EquipmentType,
  shape: PlacedShape,
  stock: readonly StockObstacle[],
): PlacementProblem[] {
  const problems: PlacementProblem[] = [];
  for (const unit of stock) {
    const shared = intersection(unit.rect, shape.footprint);
    if (shared) {
      problems.push({
        code: 'stock',
        message: `The ${type.name} would stand on ${unit.label}; the stock must be moved first`,
        rect: shared,
      });
    }
    for (const { zone, rect: zoneRect } of shape.zones) {
      const blocked =
        zone.kind === 'input' || zone.kind === 'output' ? null : intersection(zoneRect, unit.rect);
      if (blocked) {
        problems.push({
          code: 'zone',
          message: `The ${zoneLabel(zone)} of the ${type.name} is obstructed by ${unit.label}`,
          rect: blocked,
        });
      }
    }
  }
  return problems;
}

/**
 * Everything wrong with placing `type` at `placement` among `others` (the
 * items already installed in the same building, not including the one being
 * moved), with `works` the floor areas under a contractor's works, which no
 * new footprint may stand on, and `stock` the load units standing on the
 * building's floors, which it may neither stand on nor wall in. Empty when
 * the placement is allowed.
 */
export function placementProblems(
  site: PlacementSite,
  type: EquipmentType,
  placement: Placement,
  others: readonly Standing[],
  works: readonly FloorWorksArea[] = [],
  stock: readonly StockObstacle[] = [],
): PlacementProblem[] {
  const framing = framingProblems(placement);
  const candidate = standing(null, type, placement);
  if (framing.length > 0 || !candidate) {
    return framing;
  }
  const level = levelOf(site.building, placement.level);
  const own = itemProblems(site, candidate, others);
  if (!level || own.some((problem) => problem.code === 'level')) {
    return own;
  }
  const footprint = candidate.shape.footprint;
  const underWorks = works
    .filter((area) => area.level === level.index)
    .flatMap((area): PlacementProblem[] => {
      const shared = area.rects
        .map((rect) => intersection(rect, footprint))
        .find((rect) => rect !== null);
      return shared
        ? [
            {
              code: 'floor-works',
              message: `The ${type.name} would stand on floor still being laid (${area.label}); place it when the works are finished`,
              rect: shared,
            },
          ]
        : [];
    });
  const geometry = levelGeometry(site.building, site.property, level);
  const onLevel = others.filter((other) => other.placement.level === level.index);
  const stockHere = stock.filter((unit) => unit.level === level.index);
  return byPriority([
    ...own,
    ...stockProblems(type, candidate.shape, stockHere),
    ...underWorks,
    ...routeProblems(
      geometry,
      [...onLevel, candidate],
      stockHere.map((unit) => unit.rect),
    ),
  ]);
}

/** Everything wrong with a whole installed layout (invariants); empty when it is valid. */
export function layoutProblems(site: PlacementSite, items: readonly Standing[]): string[] {
  const problems: string[] = [];
  for (const item of items) {
    const framing = framingProblems(item.placement);
    const others = items.filter((other) => other !== item);
    for (const problem of [...framing, ...itemProblems(site, item, others)]) {
      problems.push(`${item.id ?? 'an item'}: ${problem.message}`);
    }
  }
  for (const level of site.building.levels) {
    const onLevel = items.filter((item) => item.placement.level === level.index);
    if (onLevel.length > 0) {
      const geometry = levelGeometry(site.building, site.property, level);
      problems.push(...routeProblems(geometry, onLevel).map((problem) => problem.message));
    }
  }
  return problems;
}

/** "Insufficient funds" text shared by purchases and rigging charges. */
export function fundsMessage(available: Cents, needed: Cents, what: string): string {
  return `Insufficient funds: ${formatUsd(available)} available, ${formatUsd(needed)} needed (${what})`;
}
