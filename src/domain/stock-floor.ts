import {
  isQuarterTurn,
  routeProblems,
  type FloorWorksArea,
  type PlacementProblem,
  type Rotation,
  type Standing,
  type StockObstacle,
} from './equipment';
import { levelGeometry, levelOf, type Building, type LevelGeometry } from './facility';
import type { Property } from './real-estate';
import { decompose, intersection, overlaps, regionContains, type RectMm } from './region';
import { floorFootprint, maxHeightMm, type ContainerType, type FloorLocation } from './stock';

/**
 * Where a load unit may stand on a floor (spec §5.2, §5.3; ADR-0054). The
 * same exact geometry as equipment placement (ADR-0045, ADR-0048), with the
 * rules that suit stock:
 *
 * - on usable floor: inside the walls, clear of columns, walls, obstacles,
 *   stair flights and no-installation zones;
 * - clear of the landings at personnel doors, utility points and stairs. The
 *   landing inside a goods door (roller shutter or loading dock) is its
 *   receiving and staging area, so stock may stand there;
 * - clear of equipment footprints and of their operator stations,
 *   maintenance areas and safety clearances (a machine's input and output
 *   ports are where its material goes, so stock may stand there);
 * - clear of other stock standing on the floor;
 * - for new placements, off floor still being laid (ADR-0052);
 * - within the clear height when fully loaded, also under a mezzanine;
 * - its gross mass over its footprint within the slab's rating, exactly;
 * - leaving an 800 mm walkway to every door, utility point, stair, operator
 *   station and maintenance area.
 */

export interface FloorSite {
  readonly building: Building;
  readonly property: Property;
}

/** What else is on the building's floors. */
export interface FloorNeighbours {
  readonly equipment: readonly Standing[];
  /** Other load units on the floor (not the one being placed, nor anything it carries). */
  readonly stock: readonly StockObstacle[];
  /** Floor under a contractor's works; pass none to check a unit already standing there. */
  readonly works: readonly FloorWorksArea[];
}

/** The load unit being placed: its type, how it is named in messages and what it weighs. */
export interface UnitOnFloor {
  readonly label: string;
  readonly type: ContainerType;
  readonly grossMassMg: bigint;
}

const mm = (value: number) => `${value.toLocaleString('en-US')} mm`;

/** The clear height over `rect` on a level: its own, or less under a level above. */
function headroomOver(building: Building, levelIndex: number, rect: RectMm) {
  const level = levelOf(building, levelIndex);
  if (!level) {
    return { headroom: 0, under: null };
  }
  let headroom = level.clearHeightMm;
  let under: string | null = null;
  for (const upper of building.levels.filter((candidate) => candidate.index > level.index)) {
    const above = decompose(upper.floor).region;
    if (above.rects.some((part) => overlaps(part, rect))) {
      const clear = upper.elevationMm - upper.deckDepthMm - level.elevationMm;
      if (clear < headroom) {
        headroom = clear;
        under = upper.name;
      }
    }
  }
  return { headroom, under };
}

/**
 * Everything wrong with a load unit standing at `location`; empty when it
 * may. With `route` false the walkway check is left out (callers checking a
 * whole floor do it once for everything standing there).
 */
export function floorPlacementProblems(
  site: FloorSite,
  unit: UnitOnFloor,
  location: FloorLocation,
  neighbours: FloorNeighbours,
  options: { readonly route: boolean } = { route: true },
): PlacementProblem[] {
  const { building, property } = site;
  const { type, label } = unit;
  const coordinates = [location.xMm, location.yMm];
  if (!coordinates.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return [
      {
        code: 'lattice',
        message: `Stock stands at whole millimetres on the plan, not (${location.xMm}, ${location.yMm})`,
        rect: null,
      },
    ];
  }
  if (!isQuarterTurn(location.rotation)) {
    return [
      {
        code: 'rotation',
        message: `Stock is turned in quarter turns only, not ${String(location.rotation)}°`,
        rect: null,
      },
    ];
  }
  const level = levelOf(building, location.level);
  if (!level) {
    return [
      { code: 'level', message: `${property.address} has no level ${location.level}`, rect: null },
    ];
  }
  const geometry = levelGeometry(building, property, level);
  const footprint = floorFootprint(type, location);
  const problems: PlacementProblem[] = [];

  if (!regionContains(decompose(level.floor).region, footprint)) {
    problems.push({
      code: 'fit',
      message: `${label} (${mm(footprint.width)} × ${mm(footprint.depth)}) would stand outside the walls`,
      rect: footprint,
    });
  }
  for (const feature of geometry.structure) {
    const shared = intersection(feature.rect, footprint);
    if (shared) {
      problems.push({
        code: 'structure',
        message: `${label} would overlap ${feature.label}`,
        rect: shared,
      });
    }
  }
  for (const feature of geometry.forbidden) {
    const shared = intersection(feature.rect, footprint);
    if (shared) {
      problems.push({
        code: 'forbidden',
        message: `${label} would stand in a no-installation zone: ${feature.label}`,
        rect: shared,
      });
    }
  }
  for (const zone of geometry.keepClear) {
    const goodsDoor = zone.kind === 'door' && !zone.entrance;
    const shared = goodsDoor ? null : intersection(zone.rect, footprint);
    if (shared) {
      problems.push({
        code: 'keep-clear',
        message: `${label} would block the clear landing at ${zone.label}`,
        rect: shared,
      });
    }
  }
  const equipmentHere = neighbours.equipment.filter((item) => item.placement.level === level.index);
  for (const item of equipmentHere) {
    const shared = intersection(item.shape.footprint, footprint);
    if (shared) {
      problems.push({
        code: 'equipment',
        message: `${label} would stand on the ${item.type.name}${item.id ? ` (${item.id})` : ''}`,
        rect: shared,
      });
    }
    for (const { zone, rect } of item.shape.zones) {
      const port = zone.kind === 'input' || zone.kind === 'output';
      const blocked = port ? null : intersection(rect, footprint);
      if (blocked) {
        problems.push({
          code: 'zone',
          message: `${label} would obstruct the ${zone.kind === 'operator' ? 'operator station' : zone.kind === 'maintenance' ? 'maintenance area' : 'safety clearance'} of the ${item.type.name}${item.id ? ` (${item.id})` : ''}`,
          rect: blocked,
        });
      }
    }
  }
  const stockHere = neighbours.stock.filter((other) => other.level === level.index);
  for (const other of stockHere) {
    const shared = intersection(other.rect, footprint);
    if (shared) {
      problems.push({
        code: 'stock',
        message: `${label} would overlap ${other.label}`,
        rect: shared,
      });
    }
  }
  for (const area of neighbours.works.filter((candidate) => candidate.level === level.index)) {
    const shared = area.rects.map((rect) => intersection(rect, footprint)).find(Boolean);
    if (shared) {
      problems.push({
        code: 'floor-works',
        message: `${label} would stand on floor still being laid (${area.label})`,
        rect: shared,
      });
    }
  }
  const height = maxHeightMm(type);
  const { headroom, under } = headroomOver(building, level.index, footprint);
  if (height > headroom) {
    problems.push({
      code: 'height',
      message: `${label} stands up to ${mm(height)} tall loaded; the clear height ${under ? `under the ${under}` : 'here'} is ${mm(headroom)}`,
      rect: footprint,
    });
  }
  const area = BigInt(footprint.width) * BigInt(footprint.depth);
  // mass (mg) ≤ rating (kg/m²) × area (mm²), because 1 kg/m² is exactly 1 mg/mm².
  if (unit.grossMassMg > BigInt(level.floorLoadKgPerM2) * area) {
    const loading = (unit.grossMassMg + area - 1n) / area;
    problems.push({
      code: 'floor-load',
      message: `${label} would load the floor with ${loading.toLocaleString('en-US')} kg/m²; it is rated for ${level.floorLoadKgPerM2.toLocaleString('en-US')} kg/m²`,
      rect: footprint,
    });
  }
  if (options.route && problems.length === 0) {
    problems.push(
      ...routeProblems(geometry, equipmentHere, [
        ...stockHere.map((other) => other.rect),
        footprint,
      ]).map((problem) => ({
        ...problem,
        message: `${label} here: ${problem.message.charAt(0).toLowerCase()}${problem.message.slice(1)}`,
      })),
    );
  }
  return problems;
}

/** The walkway problems of a whole floor with its equipment and stock (invariants). */
export function floorRouteProblems(
  geometry: LevelGeometry,
  equipment: readonly Standing[],
  stock: readonly StockObstacle[],
): string[] {
  return routeProblems(
    geometry,
    equipment.filter((item) => item.placement.level === geometry.level.index),
    stock.filter((unit) => unit.level === geometry.level.index).map((unit) => unit.rect),
  ).map((problem) => problem.message);
}

// ------------------------------------------------------------ receiving

/** A goods door's landing: where deliveries are unloaded (ground floor). */
export interface ReceivingArea {
  readonly doorIndex: number;
  readonly label: string;
  readonly rect: RectMm;
  /** Which side of the landing is the wall the door is in. */
  readonly wall: 'top' | 'bottom' | 'left' | 'right';
}

/** The landings of the building's roller shutters and loading docks, in door order. */
export function receivingAreas(site: FloorSite): ReceivingArea[] {
  const ground = levelOf(site.building, 0);
  if (!ground) {
    return [];
  }
  const geometry = levelGeometry(site.building, site.property, ground);
  return geometry.keepClear.flatMap((zone): ReceivingArea[] => {
    const door = zone.doorIndex === null ? undefined : site.property.doors[zone.doorIndex];
    if (zone.kind !== 'door' || zone.entrance || zone.doorIndex === null || !door) {
      return [];
    }
    const from = ground.floor[door.edge];
    const to = ground.floor[(door.edge + 1) % ground.floor.length];
    if (!from || !to) {
      return [];
    }
    const { rect } = zone;
    const wall =
      from.y === to.y
        ? from.y === rect.y
          ? 'top'
          : 'bottom'
        : from.x === rect.x
          ? 'left'
          : 'right';
    return [{ doorIndex: zone.doorIndex, label: zone.label, rect, wall }];
  });
}

/** Positions stepped along one side of a span, plus the position flush with its far end. */
function steps(start: number, span: number, size: number, step: number): number[] {
  const positions: number[] = [];
  for (let offset = 0; offset + size <= span; offset += step) {
    positions.push(start + offset);
  }
  const last = start + span - size;
  if (size <= span && !positions.includes(last)) {
    positions.push(last);
  }
  return positions;
}

/** How finely the receiving search tries positions. */
const RECEIVING_STEP_MM = 250;

/**
 * The first place in a goods door's landing where `unit` may stand: landings
 * in door order; in each, the narrower way round along the wall first, then
 * flush against the wall before further in, then along the wall from one
 * end. Deterministic. Null when no landing has room.
 */
export function findReceivingSpot(
  site: FloorSite,
  unit: UnitOnFloor,
  neighbours: FloorNeighbours,
): { readonly location: FloorLocation; readonly doorIndex: number } | null {
  const { outerMm } = unit.type;
  for (const area of receivingAreas(site)) {
    const alongIsX = area.wall === 'top' || area.wall === 'bottom';
    const rotations: Rotation[] = [0, 90];
    const along = (rotation: Rotation) =>
      (rotation === 0) === alongIsX ? outerMm.width : outerMm.depth;
    rotations.sort((a, b) => along(a) - along(b) || a - b);
    for (const rotation of rotations) {
      const quarter = rotation === 90;
      const width = quarter ? outerMm.depth : outerMm.width;
      const depth = quarter ? outerMm.width : outerMm.depth;
      const { rect } = area;
      const xs = steps(rect.x, rect.width, width, RECEIVING_STEP_MM);
      const ys = steps(rect.y, rect.depth, depth, RECEIVING_STEP_MM);
      // Flush against the wall first: order the perpendicular positions from the wall.
      if (area.wall === 'bottom') {
        ys.reverse();
      }
      if (area.wall === 'right') {
        xs.reverse();
      }
      const candidates = alongIsX
        ? ys.flatMap((y) => xs.map((x) => ({ x, y })))
        : xs.flatMap((x) => ys.map((y) => ({ x, y })));
      for (const { x, y } of candidates) {
        const location: FloorLocation = {
          kind: 'floor',
          propertyId: site.property.id,
          level: 0,
          xMm: x,
          yMm: y,
          rotation,
        };
        if (floorPlacementProblems(site, unit, location, neighbours).length === 0) {
          return { location, doorIndex: area.doorIndex };
        }
      }
    }
  }
  return null;
}
