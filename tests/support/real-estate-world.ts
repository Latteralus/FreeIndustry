import { baseContent } from '../../src/catalog/base-content';
import { foundCompany, type Company } from '../../src/domain/company';
import { formatEntityId, type AllocateId } from '../../src/domain/ids';
import type { Property, RealEstate } from '../../src/domain/real-estate';
import { Rejection } from '../../src/domain/rejection';
import type { SimTimeMs } from '../../src/domain/time';
import type { FreeIndustryState } from '../../src/domain/world-state';
import { FREEINDUSTRY_RULES } from '../../src/simulation/freeindustry-rules';
import { SimulationKernel } from '../../src/simulation/kernel';
import { worldSetupFor, type WorldSetup } from '../../src/worker/world-setup';

/**
 * Helpers for Step 07 tests: worlds built from the real bundled content
 * exactly as the worker builds them, and a small hand-made estate for the
 * domain rules.
 */

export function setupFor(scenarioId = 'standard'): WorldSetup {
  const setup = worldSetupFor(baseContent(), scenarioId);
  if (!setup) {
    throw new Error(`no scenario ${scenarioId}`);
  }
  return setup;
}

/** A new world with the base content's real estate, as New Company makes it. */
export function estateWorld(
  seed = 7,
  scenarioId = 'standard',
): SimulationKernel<FreeIndustryState> {
  const setup = setupFor(scenarioId);
  return SimulationKernel.create(FREEINDUSTRY_RULES, { seed, epoch: setup.epoch }, setup.setup);
}

/** Deterministic IDs and a fixed time for calling domain rules directly. */
export function ruleContext(nowMs: SimTimeMs = 0n) {
  const counters = new Map<string, number>();
  const allocateId: AllocateId = (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return formatEntityId(kind, next);
  };
  return { nowMs, allocateId, epoch: { year: 1996, month: 1, day: 1 } };
}

export function settledValue<T>(result: T | Rejection): T {
  if (result instanceof Rejection) {
    throw new Error(result.reason);
  }
  return result;
}

export function company(capitalCents: bigint, context = ruleContext()): Company {
  return settledValue(
    foundCompany(
      null,
      { legalName: 'Test Works', presidentName: 'Robin Test', startingCapitalCents: capitalCents },
      context,
    ),
  );
}

const rect = (w: number, d: number) => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: d },
  { x: 0, y: d },
];

function property(overrides: Partial<Property> & Pick<Property, 'id'>): Property {
  return {
    districtId: 'test-district',
    address: `${overrides.id} Test Street`,
    kind: 'workshop',
    description: 'A test property.',
    site: { x: 10, y: 10 },
    floor: rect(8000, 12_000),
    clearHeightMm: 4000,
    floorLoadKgPerM2: 1500,
    powerKva: 15,
    threePhase: false,
    water: true,
    gas: false,
    doors: [
      { kind: 'personnel', edge: 2, offsetMm: 1000, widthMm: 900, heightMm: 2100 },
      { kind: 'roller-shutter', edge: 2, offsetMm: 3000, widthMm: 3000, heightMm: 3000 },
    ],
    permittedUses: ['light-manufacturing', 'storage'],
    landlord: 'Test Estates',
    rentCentsPerMonth: 50_000n,
    depositMonths: 2,
    minTermMonths: 6,
    maxTermMonths: 36,
    occupant: null,
    ...overrides,
  };
}

/** One city, one district, a vacant garage and workshop, and a unit an established business holds. */
export function testRealEstate(): RealEstate {
  return {
    scenario: { id: 'standard', name: 'Standard start' },
    contentVersion: 'test/1',
    cities: [
      {
        id: 'testville',
        name: 'Testville',
        region: 'Ohio',
        population: 100_000,
        description: 'A test city.',
        workforce: 50_000,
        unemploymentPermille: 50,
        wageRates: [{ laborClass: 'production', centsPerHour: 1000n }],
        map: { x: 500, y: 500 },
      },
    ],
    districts: [
      {
        id: 'test-district',
        cityId: 'testville',
        name: 'Test District',
        description: 'A test district.',
        siteWidthM: 300,
        siteDepthM: 200,
        highwayAccessM: 1000,
        railSiding: false,
        streets: [],
      },
    ],
    businesses: [
      {
        id: 'test-rival',
        cityId: 'testville',
        name: 'Rival Co.',
        role: 'manufacturer',
        trade: 'Widgets',
      },
    ],
    properties: [
      property({
        id: 'garage-1',
        kind: 'garage',
        floor: rect(3000, 6000),
        clearHeightMm: 2300,
        doors: [
          { kind: 'roller-shutter', edge: 2, offsetMm: 300, widthMm: 2400, heightMm: 2100 },
          { kind: 'personnel', edge: 3, offsetMm: 600, widthMm: 800, heightMm: 2000 },
        ],
        rentCentsPerMonth: 10_000n,
        depositMonths: 1,
        minTermMonths: 1,
        maxTermMonths: 24,
      }),
      property({ id: 'workshop-2', site: { x: 40, y: 10 } }),
      property({
        id: 'unit-3',
        kind: 'industrial-unit',
        site: { x: 80, y: 10 },
        floor: rect(15_000, 24_000),
        rentCentsPerMonth: 145_000n,
        occupant: { kind: 'business', businessId: 'test-rival' },
      }),
    ],
    leases: [],
  };
}
