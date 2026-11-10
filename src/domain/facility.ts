import { floorOutlineProblems, polygonAreaMm2, type PointMm } from './geometry';
import type { Property } from './real-estate';
import {
  cellCoverage,
  decompose,
  intersection,
  isValidRect,
  overlaps,
  reachableTargets,
  regionContains,
  type RectMm,
  type Region,
} from './region';

/**
 * The physical structure of a building, layer 1 of the facility model (spec
 * §5.1, §5.6; DECISIONS ADR-0046, ADR-0047): its levels, structural columns,
 * interior walls, fixed obstacles, forbidden zones, utility connection
 * points, stairs between levels and its parcel. Everything is integer
 * millimetres in the level's local frame (origin at the minimum corner of the
 * ground floor's outline, x right, y down the plan).
 *
 * A building comes from validated content when a world is created and never
 * changes afterwards: equipment, floor coverings, people and stock are other
 * layers and cannot alter it. From it derive, exactly:
 *
 * - the **floor region** of each level: the outline minus columns, walls,
 *   obstacles and stair flights (where a person can stand);
 * - the **usable region**: the floor region minus forbidden zones (where
 *   equipment and floor coverings may go; its area is the usable area);
 * - the **keep-clear zones** in front of doors, utility points and stairs,
 *   where nothing may be installed;
 * - the **walkway starts and targets** that must stay connected.
 */

export const FEATURE_KINDS = ['column', 'wall', 'obstacle', 'forbidden'] as const;
type FeatureKind = (typeof FEATURE_KINDS)[number];

export const UTILITY_KINDS = ['power', 'water', 'gas'] as const;
type UtilityKind = (typeof UTILITY_KINDS)[number];

/** A fixed element of a level's structure, or a zone where nothing may be installed. */
export interface Feature {
  readonly kind: FeatureKind;
  /** What it is: "Steel column C3", "Fire exit route to the east door". */
  readonly label: string;
  readonly rect: RectMm;
}

/**
 * Where a service enters the building: a distribution board, water point or
 * gas meter on a ground-floor wall (edge `edge` of the outline, from
 * `offsetMm` along it, `widthMm` wide). It must stay accessible.
 */
interface UtilityPoint {
  readonly kind: UtilityKind;
  readonly label: string;
  readonly edge: number;
  readonly offsetMm: number;
  readonly widthMm: number;
}

/** A staircase from level `upperLevel − 1` up to `upperLevel`. */
interface Stair {
  readonly upperLevel: number;
  /** The flight itself, on the lower level (nothing may stand there). */
  readonly flight: RectMm;
  /** The landing at its foot, on the lower level (kept clear, must be reachable). */
  readonly foot: RectMm;
  /** The landing at its head, on the upper level (kept clear; where people arrive). */
  readonly head: RectMm;
}

export interface Level {
  /** 0 is the ground floor; upper floors and mezzanines count up. */
  readonly index: number;
  readonly name: string;
  /** Height of the floor surface above the ground floor. */
  readonly elevationMm: number;
  /** Depth of the deck structure below the floor surface (0 on the ground floor). */
  readonly deckDepthMm: number;
  readonly floor: readonly PointMm[];
  readonly clearHeightMm: number;
  /** The slab's structural load capacity (no floor covering ever changes it). */
  readonly floorLoadKgPerM2: number;
  readonly features: readonly Feature[];
}

export interface Building {
  readonly propertyId: string;
  /** The floor material every eligible cell starts with (ADR-0046). */
  readonly surfaceMaterialId: string;
  /** The plot of land, in district site-plan millimetres. Contains the building. */
  readonly parcel: RectMm;
  readonly levels: readonly Level[];
  readonly utilities: readonly UtilityPoint[];
  readonly stairs: readonly Stair[];
}

/** Depth of the clear landing kept inside each kind of door (FreeIndustry values, ADR-0047). */
const DOOR_ACCESS_DEPTH_MM = {
  personnel: 1000,
  'roller-shutter': 1500,
  'loading-dock': 3000,
} as const;

/** Working space kept clear in front of a utility point. */
const UTILITY_ACCESS_DEPTH_MM = 1000;

/** Narrowest clear way a person can walk through (ADR-0047). */
export const WALKWAY_WIDTH_MM = 800;

const MAX_LEVELS = 4;
const MAX_FEATURES_PER_LEVEL = 400;
const MAX_UTILITIES = 16;
const MAX_STAIRS = 8;

const DOOR_NAME = {
  personnel: 'personnel door',
  'roller-shutter': 'roller shutter',
  'loading-dock': 'loading dock',
} as const;

// ----------------------------------------------------------- wall edges

/** Twice the signed area: positive when the interior lies left of each edge (x right, y down). */
function signedArea2(points: readonly PointMm[]): number {
  let twice = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    twice += point.x * next.y - next.x * point.y;
  });
  return twice;
}

interface EdgeFrame {
  readonly from: PointMm;
  readonly direction: PointMm;
  readonly inward: PointMm;
  readonly lengthMm: number;
  readonly wall: 'north' | 'south' | 'east' | 'west';
}

/** Start, unit direction, inward normal and compass name of outline edge `edge`, or null. */
function edgeFrame(outline: readonly PointMm[], edge: number): EdgeFrame | null {
  const from = outline[edge];
  const to = outline[(edge + 1) % outline.length];
  if (!from || !to || !Number.isInteger(edge)) {
    return null;
  }
  const direction = { x: Math.sign(to.x - from.x), y: Math.sign(to.y - from.y) };
  const left = signedArea2(outline) > 0;
  const inward = left ? { x: -direction.y, y: direction.x } : { x: direction.y, y: -direction.x };
  const wall = inward.y > 0 ? 'north' : inward.y < 0 ? 'south' : inward.x > 0 ? 'west' : 'east';
  return {
    from,
    direction,
    inward,
    lengthMm: Math.abs(to.x - from.x) + Math.abs(to.y - from.y),
    wall,
  };
}

/** The rectangle inside a wall opening: `widthMm` along edge `edge` from `offsetMm`, `depthMm` deep. */
function inwardZone(
  outline: readonly PointMm[],
  edge: number,
  offsetMm: number,
  widthMm: number,
  depthMm: number,
): RectMm | null {
  const frame = edgeFrame(outline, edge);
  if (!frame || offsetMm < 0 || widthMm <= 0 || offsetMm + widthMm > frame.lengthMm) {
    return null;
  }
  const a = {
    x: frame.from.x + frame.direction.x * offsetMm,
    y: frame.from.y + frame.direction.y * offsetMm,
  };
  const b = { x: a.x + frame.direction.x * widthMm, y: a.y + frame.direction.y * widthMm };
  const c = { x: a.x + frame.inward.x * depthMm, y: a.y + frame.inward.y * depthMm };
  const d = { x: b.x + frame.inward.x * depthMm, y: b.y + frame.inward.y * depthMm };
  const xs = [a.x, b.x, c.x, d.x];
  const ys = [a.y, b.y, c.y, d.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, depth: Math.max(...ys) - y };
}

// ----------------------------------------------------- derived geometry

/** A zone where nothing may be installed, with what it serves. */
interface KeepClearZone {
  readonly kind: 'door' | 'utility' | 'stair-foot' | 'stair-head';
  readonly label: string;
  readonly rect: RectMm;
  /** A personnel door or stair head: where people enter the level. */
  readonly entrance: boolean;
  /** The listing's door this landing is inside (index in its doors); null for other zones. */
  readonly doorIndex: number | null;
}

export interface LevelGeometry {
  readonly level: Level;
  readonly bounds: RectMm;
  /** Outline area, exact. */
  readonly outlineAreaMm2: bigint;
  /** Where a person can stand: the outline minus columns, walls, obstacles and stair flights. */
  readonly floor: Region;
  /** The bounding box minus the floor region: walls, columns and the outside, for walkways. */
  readonly solid: readonly RectMm[];
  /** Where equipment and coverings may go: the floor minus forbidden zones. */
  readonly usable: Region;
  /** Covered area of each usable cell (`cellKey` → mm²); absent cells are outside. */
  readonly coverage: ReadonlyMap<number, number>;
  /** Columns, walls, obstacles and stair flights on this level. */
  readonly structure: readonly Feature[];
  readonly forbidden: readonly Feature[];
  readonly keepClear: readonly KeepClearZone[];
}

/** Derived geometry per immutable building, by level index. */
const geometryCache = new WeakMap<Building, Map<number, LevelGeometry>>();

export function levelOf(building: Building, index: number): Level | undefined {
  return building.levels.find((level) => level.index === index);
}

/** Exact derived geometry of one level (memoised per immutable level). */
export function levelGeometry(building: Building, property: Property, level: Level): LevelGeometry {
  let byLevel = geometryCache.get(building);
  if (!byLevel) {
    byLevel = new Map();
    geometryCache.set(building, byLevel);
  }
  const cached = byLevel.get(level.index);
  if (cached?.level === level) {
    return cached;
  }
  const flights: Feature[] = building.stairs
    .filter((stair) => stair.upperLevel - 1 === level.index)
    .map((stair) => ({
      kind: 'obstacle',
      label: `Stair to ${levelOf(building, stair.upperLevel)?.name ?? `level ${stair.upperLevel}`}`,
      rect: stair.flight,
    }));
  const structure = [
    ...level.features.filter((feature) => feature.kind !== 'forbidden'),
    ...flights,
  ];
  const forbidden = level.features.filter((feature) => feature.kind === 'forbidden');
  const floor = decompose(
    level.floor,
    structure.map((feature) => feature.rect),
  );
  const usable = decompose(level.floor, [
    ...structure.map((feature) => feature.rect),
    ...forbidden.map((feature) => feature.rect),
  ]);
  const keepClear: KeepClearZone[] = [];
  if (level.index === 0) {
    property.doors.forEach((door, index) => {
      const zone = inwardZone(
        level.floor,
        door.edge,
        door.offsetMm,
        door.widthMm,
        DOOR_ACCESS_DEPTH_MM[door.kind],
      );
      const wall = edgeFrame(level.floor, door.edge)?.wall ?? 'outer';
      if (zone) {
        keepClear.push({
          kind: 'door',
          label: `the ${DOOR_NAME[door.kind]} in the ${wall} wall (door ${index + 1})`,
          rect: zone,
          entrance: door.kind === 'personnel',
          doorIndex: index,
        });
      }
    });
    for (const utility of building.utilities) {
      const zone = inwardZone(
        level.floor,
        utility.edge,
        utility.offsetMm,
        utility.widthMm,
        UTILITY_ACCESS_DEPTH_MM,
      );
      if (zone) {
        keepClear.push({
          kind: 'utility',
          label: utility.label,
          rect: zone,
          entrance: false,
          doorIndex: null,
        });
      }
    }
  }
  for (const stair of building.stairs) {
    const upper = levelOf(building, stair.upperLevel)?.name ?? `level ${stair.upperLevel}`;
    if (stair.upperLevel - 1 === level.index) {
      keepClear.push({
        kind: 'stair-foot',
        label: `the foot of the stair to ${upper}`,
        rect: stair.foot,
        entrance: false,
        doorIndex: null,
      });
    }
    if (stair.upperLevel === level.index) {
      keepClear.push({
        kind: 'stair-head',
        label: `the head of the stair to ${upper}`,
        rect: stair.head,
        entrance: true,
        doorIndex: null,
      });
    }
  }
  const geometry: LevelGeometry = {
    level,
    bounds: floor.bounds,
    outlineAreaMm2: polygonAreaMm2(level.floor),
    floor: floor.region,
    solid: floor.outside,
    usable: usable.region,
    coverage: cellCoverage(usable.region),
    structure,
    forbidden,
    keepClear,
  };
  byLevel.set(level.index, geometry);
  return geometry;
}

/** Usable floor area of a level, exact. */
export function usableAreaMm2(building: Building, property: Property, level: Level): bigint {
  return levelGeometry(building, property, level).usable.areaMm2;
}

/**
 * Which walkway targets of a level a person can reach from its entrances,
 * with `blocked` extra footprints standing on it. Targets are the keep-clear
 * zones plus `extraTargets` (operator stations, maintenance areas).
 */
export function walkwayReach(
  geometry: LevelGeometry,
  blocked: readonly RectMm[],
  extraTargets: readonly RectMm[],
): { readonly keepClear: readonly boolean[]; readonly extra: readonly boolean[] } {
  const starts = geometry.keepClear.filter((zone) => zone.entrance).map((zone) => zone.rect);
  const targets = [...geometry.keepClear.map((zone) => zone.rect), ...extraTargets];
  const reached = reachableTargets({
    bounds: geometry.bounds,
    blocked: [...geometry.solid, ...blocked],
    starts,
    targets,
    walkerMm: WALKWAY_WIDTH_MM,
  });
  return {
    keepClear: reached.slice(0, geometry.keepClear.length),
    extra: reached.slice(geometry.keepClear.length),
  };
}

// ----------------------------------------------------------- validation

const describe = (r: RectMm) => `${r.width} × ${r.depth} mm at (${r.x}, ${r.y})`;

function samePoints(a: readonly PointMm[], b: readonly PointMm[]): boolean {
  return a.length === b.length && a.every((point, i) => b[i]?.x === point.x && b[i].y === point.y);
}

function outlineRegion(level: Level): Region {
  return decompose(level.floor).region;
}

/**
 * Why a building's structure is physically impossible or unusable; empty
 * when it is sound. `materials` are the known floor-material IDs.
 */
export function buildingProblems(
  building: Building,
  property: Property,
  materials: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  if (!materials.has(building.surfaceMaterialId)) {
    problems.push(
      `its starting surface ${building.surfaceMaterialId} is not a known floor material`,
    );
  }
  const ground = building.levels[0];
  if (!ground || building.levels.length > MAX_LEVELS) {
    return [...problems, `a building needs 1–${MAX_LEVELS} levels`];
  }
  building.levels.forEach((level, position) => {
    if (level.index !== position) {
      problems.push(`level ${position} is numbered ${level.index}`);
    }
  });
  if (
    !samePoints(ground.floor, property.floor) ||
    ground.clearHeightMm !== property.clearHeightMm ||
    ground.floorLoadKgPerM2 !== property.floorLoadKgPerM2 ||
    ground.elevationMm !== 0 ||
    ground.deckDepthMm !== 0
  ) {
    problems.push('the ground floor does not match the property listing');
  }
  const minX = Math.min(...property.floor.map((point) => point.x));
  const minY = Math.min(...property.floor.map((point) => point.y));
  if (minX !== 0 || minY !== 0) {
    problems.push(`the floor outline must start at (0, 0), not (${minX}, ${minY})`);
  }
  if (problems.length > 0) {
    return problems;
  }

  // Parcel: the building stands on it.
  const footprint: RectMm = {
    x: property.site.x * 1000,
    y: property.site.y * 1000,
    width: Math.max(...property.floor.map((point) => point.x)),
    depth: Math.max(...property.floor.map((point) => point.y)),
  };
  if (!isValidRect(building.parcel, 100_000_000)) {
    problems.push('its parcel is not a valid rectangle');
  } else if (
    building.parcel.x > footprint.x ||
    building.parcel.y > footprint.y ||
    building.parcel.x + building.parcel.width < footprint.x + footprint.width ||
    building.parcel.y + building.parcel.depth < footprint.y + footprint.depth
  ) {
    problems.push('its parcel does not contain the building');
  }

  const groundRegion = outlineRegion(ground);
  let previousTop = 0;
  for (const level of building.levels.slice(1)) {
    const at = `level ${level.index} (${level.name})`;
    const outline = floorOutlineProblems(level.floor);
    if (outline.length > 0) {
      problems.push(...outline.map((problem) => `${at}: ${problem}`));
      continue;
    }
    if (!upperWithinGround(level, groundRegion)) {
      problems.push(`${at} extends beyond the ground floor`);
    }
    const positive = [
      level.elevationMm,
      level.deckDepthMm,
      level.clearHeightMm,
      level.floorLoadKgPerM2,
    ];
    if (!positive.every((value) => Number.isSafeInteger(value) && value > 0)) {
      problems.push(`${at} needs a positive elevation, deck depth, clear height and floor load`);
    } else {
      if (level.elevationMm - level.deckDepthMm <= previousTop) {
        problems.push(`${at} is not above the level below it`);
      }
      if (level.elevationMm + level.clearHeightMm > property.clearHeightMm) {
        problems.push(`${at} does not fit under the roof`);
      }
      previousTop = level.elevationMm;
    }
    if (!building.stairs.some((stair) => stair.upperLevel === level.index)) {
      problems.push(`${at} has no stair`);
    }
  }

  for (const level of building.levels) {
    const at = `level ${level.index}`;
    if (level.name.length < 1 || level.name.length > 40) {
      problems.push(`${at} needs a name of 1–40 characters`);
    }
    if (level.features.length > MAX_FEATURES_PER_LEVEL) {
      problems.push(`${at} has more than ${MAX_FEATURES_PER_LEVEL} features`);
    }
    if (floorOutlineProblems(level.floor).length > 0) {
      continue;
    }
    const region = outlineRegion(level);
    for (const feature of level.features) {
      if (feature.label.length < 1 || feature.label.length > 60) {
        problems.push(`${at}: a ${feature.kind} needs a label of 1–60 characters`);
      }
      if (!isValidRect(feature.rect)) {
        problems.push(`${at}: ${feature.label} is not a valid rectangle`);
      } else if (!regionContains(region, feature.rect)) {
        problems.push(
          `${at}: ${feature.label} (${describe(feature.rect)}) is not inside the floor`,
        );
      }
    }
  }

  if (building.utilities.length > MAX_UTILITIES) {
    problems.push(`more than ${MAX_UTILITIES} utility points`);
  }
  if (!building.utilities.some((utility) => utility.kind === 'power')) {
    problems.push('there is no electrical intake');
  }
  for (const utility of building.utilities) {
    if (utility.kind === 'water' && !property.water) {
      problems.push(`${utility.label} needs a water supply the property does not have`);
    }
    if (utility.kind === 'gas' && !property.gas) {
      problems.push(`${utility.label} needs a gas supply the property does not have`);
    }
    if (
      !Number.isSafeInteger(utility.offsetMm) ||
      !Number.isSafeInteger(utility.widthMm) ||
      !inwardZone(ground.floor, utility.edge, utility.offsetMm, utility.widthMm, 1)
    ) {
      problems.push(`${utility.label} does not fit on its wall`);
    }
  }

  if (building.stairs.length > MAX_STAIRS) {
    problems.push(`more than ${MAX_STAIRS} stairs`);
  }
  for (const stair of building.stairs) {
    const upper = levelOf(building, stair.upperLevel);
    const lower = levelOf(building, stair.upperLevel - 1);
    if (!upper || !lower || stair.upperLevel < 1) {
      problems.push(`a stair leads to level ${stair.upperLevel}, which the building does not have`);
      continue;
    }
    const lowerRegion = outlineRegion(lower);
    for (const [name, r, region] of [
      ['flight', stair.flight, lowerRegion],
      ['foot', stair.foot, lowerRegion],
      ['head', stair.head, outlineRegion(upper)],
    ] as const) {
      if (!isValidRect(r) || !regionContains(region, r)) {
        problems.push(`the ${name} of the stair to level ${stair.upperLevel} is not on its floor`);
      }
    }
    if (overlaps(stair.flight, stair.foot)) {
      problems.push(`the stair to level ${stair.upperLevel} has its foot on its own flight`);
    }
  }
  if (problems.length > 0) {
    return problems;
  }

  // Keep-clear zones must be on open floor, and everything must be reachable on foot.
  for (const level of building.levels) {
    const geometry = levelGeometry(building, property, level);
    for (const zone of geometry.keepClear) {
      if (!regionContains(geometry.floor, zone.rect)) {
        problems.push(`level ${level.index}: ${zone.label} is blocked by the structure`);
      }
    }
    if (!geometry.keepClear.some((zone) => zone.entrance)) {
      problems.push(`level ${level.index} has no way in`);
      continue;
    }
    const reach = walkwayReach(geometry, [], []);
    geometry.keepClear.forEach((zone, index) => {
      if (reach.keepClear[index] !== true) {
        problems.push(
          `level ${level.index}: ${zone.label} cannot be reached on foot through a ${WALKWAY_WIDTH_MM} mm way`,
        );
      }
    });
  }
  return problems;
}

/** Whether an upper level's outline lies within the ground floor's outline, exactly. */
function upperWithinGround(upper: Level, groundRegion: Region): boolean {
  const upperRegion = outlineRegion(upper);
  let inside = 0n;
  for (const part of upperRegion.rects) {
    for (const other of groundRegion.rects) {
      const shared = intersection(part, other);
      if (shared) {
        inside += BigInt(shared.width) * BigInt(shared.depth);
      }
    }
  }
  return inside === upperRegion.areaMm2;
}
