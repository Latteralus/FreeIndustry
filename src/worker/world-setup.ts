import { encodeBigInt } from '../shared/bigint-codec';
import type { JsonValue } from '../shared/canonical-json';
import type { ScenarioSummary } from '../shared/ipc/real-estate';
import type { CivilDate } from '../domain/time';
import { realEstateFor, type ContentCatalog } from '../catalog/content-schema';
import { encodeFacilities } from '../simulation/facilities-codec';
import { encodeRealEstate } from '../simulation/real-estate-codec';
import { encodeStock } from '../simulation/stock-codec';

/**
 * How the worker turns a scenario of the content catalog into a new world
 * (ADR-0037): the scenario's epoch for the kernel, and the world setup — the
 * real estate and, from Step 08, the facilities (building structure, floor
 * materials, equipment catalog) and, from Step 10, the product and container
 * catalogs as plain JSON, copied into the world's state
 * by the rules.
 */

export interface WorldSetup {
  readonly scenarioId: string;
  readonly epoch: CivilDate;
  readonly setup: JsonValue;
}

/** The world setup for `scenarioId`, or null if the catalog has no such scenario. */
export function worldSetupFor(catalog: ContentCatalog, scenarioId: string): WorldSetup | null {
  const scenario = catalog.scenarios.find((candidate) => candidate.id === scenarioId);
  if (!scenario) {
    return null;
  }
  return {
    scenarioId,
    epoch: scenario.epoch,
    setup: {
      realEstate: encodeRealEstate(realEstateFor(catalog, scenario)),
      facilities: encodeFacilities(catalog.facilities),
      stock: encodeStock(catalog.stock),
    },
  };
}

const pad = (value: number, width: number) => String(value).padStart(width, '0');

export function scenarioSummaries(catalog: ContentCatalog): ScenarioSummary[] {
  return catalog.scenarios.map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    epoch: `${pad(scenario.epoch.year, 4)}-${pad(scenario.epoch.month, 2)}-${pad(scenario.epoch.day, 2)}`,
    defaultCapitalCents: encodeBigInt(scenario.defaultCapitalCents),
    quickStart: scenario.quickStart && { ...scenario.quickStart },
  }));
}

/** The scenario every worker's first world uses. */
export const DEFAULT_SCENARIO_ID = 'standard';
