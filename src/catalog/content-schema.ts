import { z } from 'zod';
import { formatUsd, type Cents } from '../shared/money';
import { MAX_STARTING_CAPITAL_CENTS, MIN_STARTING_CAPITAL_CENTS } from '../domain/company';
import { boundsOf } from '../domain/geometry';
import {
  BUSINESS_ROLES,
  DOOR_KINDS,
  isSlug,
  LABOR_CLASSES,
  PERMITTED_USES,
  PROPERTY_KINDS,
  realEstateProblems,
  upfrontCostOf,
  type Business,
  type City,
  type District,
  type Property,
  type RealEstate,
} from '../domain/real-estate';
import { isValidCivilDate, type CivilDate } from '../domain/time';

/**
 * The content catalog (spec §12, plan Step 07, DECISIONS ADR-0037): the
 * declarative JSON under `content/` turned into validated domain data.
 * Loading reports every problem it finds — unknown fields, duplicate IDs,
 * missing references, impossible dimensions, buildings that overlap each
 * other or a street, scenarios that could not be played — and never repairs
 * anything. Content is data only; nothing in it is executed.
 */

const slug = z.string().refine(isSlug, 'Expected a content identifier (lower-case-words-123)');
const name = z.string().min(1).max(60);
const text = z.string().min(1).max(240);
const wholeMm = z.int().min(0).max(1_000_000);
const xy = z.tuple([z.int().min(0).max(100_000), z.int().min(0).max(100_000)]);
/** Whole cents as a JSON number (content is authored; amounts stay far below 2^53). */
const cents = z.int().min(1).max(10_000_000_000);

const cityFileSchema = z.strictObject({
  city: z.strictObject({
    id: slug,
    name,
    region: name,
    population: z.int().min(1).max(50_000_000),
    description: text,
    workforce: z.int().min(1).max(50_000_000),
    unemploymentPermille: z.int().min(0).max(1000),
    wageCentsPerHour: z.strictObject(
      Object.fromEntries(LABOR_CLASSES.map((laborClass) => [laborClass, cents])) as Record<
        (typeof LABOR_CLASSES)[number],
        typeof cents
      >,
    ),
    map: z.tuple([z.int().min(0).max(1000), z.int().min(0).max(1000)]),
  }),
  districts: z
    .array(
      z.strictObject({
        id: slug,
        name,
        description: text,
        site: z.tuple([z.int().min(10).max(5000), z.int().min(10).max(5000)]),
        highwayAccessM: z.int().min(0).max(100_000),
        railSiding: z.boolean(),
        streets: z
          .array(z.strictObject({ name, from: xy, to: xy, widthM: z.int().min(3).max(60) }))
          .max(20),
      }),
    )
    .min(1)
    .max(20),
  businesses: z
    .array(
      z.strictObject({
        id: slug,
        name,
        role: z.enum(BUSINESS_ROLES),
        trade: z.string().min(1).max(80),
      }),
    )
    .max(200),
  properties: z
    .array(
      z.strictObject({
        id: slug,
        district: slug,
        address: name,
        kind: z.enum(PROPERTY_KINDS),
        description: text,
        site: xy,
        floor: z
          .array(z.tuple([wholeMm, wholeMm]))
          .min(4)
          .max(64),
        clearHeightMm: z.int().min(1).max(50_000),
        floorLoadKgPerM2: z.int().min(1).max(100_000),
        power: z.strictObject({ kva: z.int().min(1).max(100_000), threePhase: z.boolean() }),
        water: z.boolean(),
        gas: z.boolean(),
        doors: z
          .array(
            z.strictObject({
              kind: z.enum(DOOR_KINDS),
              edge: z.int().min(0),
              offsetMm: wholeMm,
              widthMm: wholeMm,
              heightMm: wholeMm,
            }),
          )
          .min(1)
          .max(32),
        uses: z.array(z.enum(PERMITTED_USES)).min(1),
        landlord: name,
        rentCentsPerMonth: cents,
        depositMonths: z.int(),
        termMonths: z.tuple([z.int(), z.int()]),
        occupiedBy: slug.nullable(),
      }),
    )
    .max(500),
});

const isoDate = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, 'Expected a date (YYYY-MM-DD)');

const scenariosFileSchema = z.strictObject({
  scenarios: z
    .array(
      z.strictObject({
        id: slug,
        name,
        description: text,
        epoch: isoDate,
        defaultCapitalCents: cents,
        quickStart: z
          .strictObject({
            legalName: name,
            presidentName: name,
            propertyId: slug,
            termMonths: z.int(),
            standingOrder: z.boolean(),
          })
          .nullable(),
      }),
    )
    .min(1)
    .max(50),
});

const manifestSchema = z.strictObject({
  id: slug,
  version: z.int().min(1),
  description: text,
  realEstate: z.array(z.string().regex(/^[a-z0-9-]+\.json$/)).min(1),
  scenarios: z.string().regex(/^[a-z0-9-]+\.json$/),
});

/** The raw JSON documents of a content pack, by file name. */
export interface ContentSources {
  readonly manifest: unknown;
  readonly realEstate: Readonly<Record<string, unknown>>;
  readonly scenarios: Readonly<Record<string, unknown>>;
}

interface QuickStart {
  readonly legalName: string;
  readonly presidentName: string;
  readonly propertyId: string;
  readonly termMonths: number;
  readonly standingOrder: boolean;
}

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly epoch: CivilDate;
  /** The starting capital the New Company dialog suggests. */
  readonly defaultCapitalCents: Cents;
  /** A complete preset start (main menu Quick Start), or null. */
  readonly quickStart: QuickStart | null;
}

export interface ContentCatalog {
  /** `<pack id>/<version>`, recorded in every world built from it. */
  readonly contentVersion: string;
  /** The real estate every new world starts from: nothing leased. */
  readonly realEstate: Omit<RealEstate, 'scenario' | 'contentVersion'>;
  readonly scenarios: readonly Scenario[];
}

export type ContentResult =
  | { readonly ok: true; readonly catalog: ContentCatalog }
  | { readonly ok: false; readonly problems: readonly string[] };

function zodProblems(file: string, error: z.ZodError): string[] {
  return error.issues
    .slice(0, 20)
    .map((issue) => `${file}: ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
}

function parseDate(text: string): CivilDate | null {
  const [year, month, day] = text.split('-').map(Number);
  const date = { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
  return isValidCivilDate(date) ? date : null;
}

interface Box {
  readonly id: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Footprint of a property on its district plan, in millimetres. */
function footprintOf(property: Property): Box {
  const bounds = boundsOf(property.floor);
  return {
    id: property.id,
    x0: property.site.x * 1000 + bounds.minX,
    y0: property.site.y * 1000 + bounds.minY,
    x1: property.site.x * 1000 + bounds.maxX,
    y1: property.site.y * 1000 + bounds.maxY,
  };
}

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Buildings must lie inside their district, clear of streets and of each other. */
function sitePlanProblems(district: District, properties: readonly Property[]): string[] {
  const problems: string[] = [];
  const boxes = properties.map(footprintOf);
  const streets: Box[] = district.streets.map((street) => {
    const half = (street.widthM * 1000) / 2;
    return {
      id: street.name,
      x0: Math.min(street.from.x, street.to.x) * 1000 - half,
      y0: Math.min(street.from.y, street.to.y) * 1000 - half,
      x1: Math.max(street.from.x, street.to.x) * 1000 + half,
      y1: Math.max(street.from.y, street.to.y) * 1000 + half,
    };
  });
  for (const street of district.streets) {
    if (street.from.x !== street.to.x && street.from.y !== street.to.y) {
      problems.push(`${district.id}: street ${street.name} is not straight along an axis`);
    }
  }
  boxes.forEach((box, index) => {
    if (box.x1 > district.siteWidthM * 1000 || box.y1 > district.siteDepthM * 1000) {
      problems.push(`${district.id}: ${box.id} extends beyond the district site plan`);
    }
    for (const street of streets) {
      if (overlaps(box, street)) {
        problems.push(`${district.id}: ${box.id} stands on ${street.id}`);
      }
    }
    for (const other of boxes.slice(index + 1)) {
      if (overlaps(box, other)) {
        problems.push(`${district.id}: ${box.id} overlaps ${other.id}`);
      }
    }
  });
  return problems;
}

/** Validate a content pack and turn it into domain data, or list every problem found. */
export function validateContent(sources: ContentSources): ContentResult {
  const problems: string[] = [];
  const manifest = manifestSchema.safeParse(sources.manifest);
  if (!manifest.success) {
    return { ok: false, problems: zodProblems('manifest.json', manifest.error) };
  }
  // Cities keep the manifest's order; the files provided must be exactly the files listed.
  const listed = manifest.data.realEstate;
  const provided = Object.keys(sources.realEstate);
  if ([...listed].sort().join() !== [...provided].sort().join()) {
    problems.push(
      `manifest.json lists real-estate files ${listed.join(', ')} but ${provided.join(', ') || 'none'} were provided`,
    );
  }

  const cities: City[] = [];
  const districts: District[] = [];
  const businesses: Business[] = [];
  const properties: Property[] = [];
  for (const file of listed.filter((name) => provided.includes(name))) {
    const parsed = cityFileSchema.safeParse(sources.realEstate[file]);
    if (!parsed.success) {
      problems.push(...zodProblems(file, parsed.error));
      continue;
    }
    const { city, districts: districtList, businesses: businessList } = parsed.data;
    cities.push({
      id: city.id,
      name: city.name,
      region: city.region,
      population: city.population,
      description: city.description,
      workforce: city.workforce,
      unemploymentPermille: city.unemploymentPermille,
      wageRates: LABOR_CLASSES.map((laborClass) => ({
        laborClass,
        centsPerHour: BigInt(city.wageCentsPerHour[laborClass]),
      })),
      map: { x: city.map[0], y: city.map[1] },
    });
    const fileDistricts = new Map<string, District>();
    for (const district of districtList) {
      const converted: District = {
        id: district.id,
        cityId: city.id,
        name: district.name,
        description: district.description,
        siteWidthM: district.site[0],
        siteDepthM: district.site[1],
        highwayAccessM: district.highwayAccessM,
        railSiding: district.railSiding,
        streets: district.streets.map((street) => ({
          name: street.name,
          from: { x: street.from[0], y: street.from[1] },
          to: { x: street.to[0], y: street.to[1] },
          widthM: street.widthM,
        })),
      };
      fileDistricts.set(district.id, converted);
      districts.push(converted);
    }
    const fileBusinesses = new Set(businessList.map((business) => business.id));
    for (const business of businessList) {
      businesses.push({ ...business, cityId: city.id });
    }
    const byDistrict = new Map<string, Property[]>();
    for (const item of parsed.data.properties) {
      if (!fileDistricts.has(item.district)) {
        problems.push(`${file}: ${item.id} is in district ${item.district}, which ${file} lacks`);
      }
      if (item.occupiedBy !== null && !fileBusinesses.has(item.occupiedBy)) {
        problems.push(
          `${file}: ${item.id} is occupied by ${item.occupiedBy}, not a business of ${city.name}`,
        );
      }
      const property: Property = {
        id: item.id,
        districtId: item.district,
        address: item.address,
        kind: item.kind,
        description: item.description,
        site: { x: item.site[0], y: item.site[1] },
        floor: item.floor.map(([x, y]) => ({ x, y })),
        clearHeightMm: item.clearHeightMm,
        floorLoadKgPerM2: item.floorLoadKgPerM2,
        powerKva: item.power.kva,
        threePhase: item.power.threePhase,
        water: item.water,
        gas: item.gas,
        doors: item.doors,
        permittedUses: item.uses,
        landlord: item.landlord,
        rentCentsPerMonth: BigInt(item.rentCentsPerMonth),
        depositMonths: item.depositMonths,
        minTermMonths: item.termMonths[0],
        maxTermMonths: item.termMonths[1],
        occupant:
          item.occupiedBy === null ? null : { kind: 'business', businessId: item.occupiedBy },
      };
      properties.push(property);
      byDistrict.set(item.district, [...(byDistrict.get(item.district) ?? []), property]);
    }
    for (const [id, district] of fileDistricts) {
      problems.push(
        ...sitePlanProblems(district, byDistrict.get(id) ?? []).map((p) => `${file}: ${p}`),
      );
    }
  }

  const realEstate: RealEstate = {
    scenario: { id: 'content', name: 'content' },
    contentVersion: `${manifest.data.id}/${manifest.data.version}`,
    cities,
    districts,
    businesses,
    properties,
    leases: [],
  };
  problems.push(...realEstateProblems(realEstate, null));

  const scenarioFile = sources.scenarios[manifest.data.scenarios];
  const scenarios: Scenario[] = [];
  const parsedScenarios = scenariosFileSchema.safeParse(scenarioFile);
  if (scenarioFile === undefined) {
    problems.push(`manifest.json names ${manifest.data.scenarios}, which was not provided`);
  } else if (!parsedScenarios.success) {
    problems.push(...zodProblems(manifest.data.scenarios, parsedScenarios.error));
  } else {
    const seen = new Set<string>();
    for (const scenario of parsedScenarios.data.scenarios) {
      const at = `${manifest.data.scenarios}: ${scenario.id}`;
      if (seen.has(scenario.id)) {
        problems.push(`${at} is defined twice`);
      }
      seen.add(scenario.id);
      const epoch = parseDate(scenario.epoch);
      if (!epoch) {
        problems.push(`${at} starts on ${scenario.epoch}, which is not a date`);
      }
      const capital = BigInt(scenario.defaultCapitalCents);
      if (capital < MIN_STARTING_CAPITAL_CENTS || capital > MAX_STARTING_CAPITAL_CENTS) {
        problems.push(`${at} suggests a starting capital outside the allowed range`);
      }
      const quick = scenario.quickStart;
      if (quick) {
        const property = properties.find((candidate) => candidate.id === quick.propertyId);
        if (!property) {
          problems.push(`${at} quick-starts in unknown property ${quick.propertyId}`);
        } else {
          if (property.occupant !== null) {
            problems.push(`${at} quick-starts in ${property.id}, which is occupied`);
          }
          if (
            quick.termMonths < property.minTermMonths ||
            quick.termMonths > property.maxTermMonths
          ) {
            problems.push(`${at} quick-starts on a term ${property.id} does not offer`);
          }
          if (upfrontCostOf(property) > capital) {
            problems.push(
              `${at} cannot afford its quick start: ${formatUsd(upfrontCostOf(property))} up front, ${formatUsd(capital)} capital`,
            );
          }
        }
      }
      if (epoch) {
        scenarios.push({
          id: scenario.id,
          name: scenario.name,
          description: scenario.description,
          epoch,
          defaultCapitalCents: capital,
          quickStart: quick,
        });
      }
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    catalog: {
      contentVersion: realEstate.contentVersion,
      realEstate: { cities, districts, businesses, properties, leases: [] },
      scenarios,
    },
  };
}

/** The real estate a new world in `scenario` starts with. */
export function realEstateFor(catalog: ContentCatalog, scenario: Scenario): RealEstate {
  return {
    scenario: { id: scenario.id, name: scenario.name },
    contentVersion: catalog.contentVersion,
    ...catalog.realEstate,
  };
}
