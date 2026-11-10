import type { Facilities } from '../../src/domain/facilities';
import type { FloorCovering } from '../../src/domain/floor-covering';
import { formatEntityId } from '../../src/domain/ids';
import { MS_PER_HOUR } from '../../src/domain/time';
import type { FreeIndustryState } from '../../src/domain/world-state';
import { FREEINDUSTRY_RULES } from '../../src/simulation/freeindustry-rules';
import { SimulationKernel, type SubmitResult } from '../../src/simulation/kernel';
import { estateWorld } from './real-estate-world';
import { testUuid } from './toy-workshop';

/**
 * Helpers for facilities tests (Steps 08 and 09A): worlds built from the
 * real bundled content with a company leasing premises, buying and placing
 * equipment and ordering floor coverings through the real commands, and a
 * way to write an impossible covering straight into a world's state so the
 * invariants can be seen to refuse it.
 */

export type World = SimulationKernel<FreeIndustryState>;

let counter = 10_000;

export function submit(world: World, type: string, payload: unknown): SubmitResult {
  counter += 1;
  return world.submit({
    commandId: testUuid(counter),
    expectedWorldRevision: world.worldRevision,
    type,
    payload,
  });
}

export function accept(world: World, type: string, payload: unknown): void {
  const result = submit(world, type, payload);
  if (!result.ok) {
    throw new Error(`${type}: ${result.error.code} ${result.error.message}`);
  }
}

/** The refusal message of a command that must be rejected. */
export function refusal(world: World, type: string, payload: unknown): string {
  const result = submit(world, type, payload);
  if (result.ok) {
    throw new Error(`${type} was accepted`);
  }
  return result.error.message;
}

/** A new world from the base content, a company founded at 09:00 leasing `propertyId`. */
export function leasedWorld(
  propertyId = 'hf-canal-2',
  options: { capitalCents?: string; seed?: number; termMonths?: number } = {},
): World {
  const world = estateWorld(options.seed ?? 7);
  world.advanceTo(9n * MS_PER_HOUR);
  const property = world.state.realEstate?.properties.find((item) => item.id === propertyId);
  if (!property) {
    throw new Error(`no property ${propertyId}`);
  }
  accept(world, 'company.found', {
    legalName: 'Layout Works',
    presidentName: 'Sam Planner',
    startingCapitalCents: options.capitalCents ?? '50000000',
    premises: {
      propertyId,
      termMonths: options.termMonths ?? property.minTermMonths,
      standingOrder: true,
    },
  });
  return world;
}

export function facilitiesOf(world: World): Facilities {
  const { facilities } = world.state;
  if (!facilities) {
    throw new Error('the world has no facilities');
  }
  return facilities;
}

/** Buy `quantity` of a type; returns the new equipment IDs. */
export function buy(world: World, equipmentTypeId: string, quantity = 1): string[] {
  const before = new Set(facilitiesOf(world).equipment.map((item) => item.id));
  accept(world, 'equipment.purchase', { equipmentTypeId, quantity });
  return facilitiesOf(world)
    .equipment.filter((item) => !before.has(item.id))
    .map((item) => item.id);
}

export function placement(
  equipmentId: string,
  xMm: number,
  yMm: number,
  rotation = 0,
  propertyId = 'hf-canal-2',
  level = 0,
) {
  return { equipmentId, propertyId, level, xMm, yMm, rotation };
}

/** A cell to cover: its level, position and material. */
type CellOrder = Omit<FloorCovering, 'installationId' | 'propertyId'>;

/** One order of 1 × 1 rectangles per level and material, as the layout tools could send it. */
function floorOrders(cells: readonly CellOrder[], propertyId = 'hf-canal-2') {
  const groups = new Map<string, CellOrder[]>();
  for (const cell of cells) {
    const key = `${cell.level}|${cell.materialId}`;
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  return [...groups.values()].map((group) => ({
    propertyId,
    level: group[0]?.level ?? 0,
    materialId: group[0]?.materialId ?? '',
    rectangles: group.map((cell) => ({ col: cell.col, row: cell.row, cols: 1, rows: 1 })),
  }));
}

/** The time the last floor job under way finishes (now if none is). */
export function worksFinishAt(world: World): bigint {
  return facilitiesOf(world).installations.reduce(
    (latest, job) =>
      job.status === 'scheduled' && job.completesAtMs > latest ? job.completesAtMs : latest,
    world.nowMs,
  );
}

/**
 * The world with floor coverings on `cells` of its premises, ordered from
 * the floor contractor through the real command (one order per level and
 * material) and laid: the clock runs until the last job is finished.
 */
export function withCoverings(
  world: World,
  cells: readonly CellOrder[],
  propertyId = 'hf-canal-2',
): World {
  for (const order of floorOrders(cells, propertyId)) {
    accept(world, 'facility.installFloorCovering', order);
  }
  world.advanceTo(worksFinishAt(world));
  return world;
}

/**
 * Restore the world with covering records on `cells` written straight into
 * its state, bypassing the rules. Used only to show that the invariants
 * refuse an impossible covering, so it is expected to throw.
 */
export function injectCoverings(
  world: World,
  cells: readonly CellOrder[],
  propertyId = 'hf-canal-2',
): World {
  const checkpoint = world.checkpoint();
  const facilities = facilitiesOf(world);
  const installationId = formatEntityId('floor-installation', 99);
  const coverings = [
    ...facilities.coverings,
    ...cells.map((cell) => ({ ...cell, propertyId, installationId })),
  ].sort((a, b) => a.level - b.level || a.row - b.row || a.col - b.col);
  const next: FreeIndustryState = { ...world.state, facilities: { ...facilities, coverings } };
  return SimulationKernel.restore(FREEINDUSTRY_RULES, {
    state: { ...checkpoint.state, domain: FREEINDUSTRY_RULES.encodeState(next) },
    journal: checkpoint.journal,
  });
}
