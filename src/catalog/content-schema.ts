import { z } from 'zod';
import { formatUsd, type Cents } from '../shared/money';
import { MAX_STARTING_CAPITAL_CENTS, MIN_STARTING_CAPITAL_CENTS } from '../domain/company';
import { EQUIPMENT_CATEGORIES, SIDES, ZONE_KINDS, type EquipmentType } from '../domain/equipment';
import { facilitiesProblems, type Facilities } from '../domain/facilities';
import {
  FEATURE_KINDS,
  UTILITY_KINDS,
  type Building,
  type Feature,
  type Level,
} from '../domain/facility';
import { FLOOR_MATERIAL_CATEGORIES, type FloorMaterial } from '../domain/floor-covering';
import { boundsOf, type PointMm } from '../domain/geometry';
import { decompose, intersection, regionContains, type RectMm } from '../domain/region';
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
import {
  BASE_UNITS,
  CONTAINER_KINDS,
  MIXING_RULES,
  PRODUCT_CATEGORIES,
  PRODUCT_FORMS,
  TRACKING_KINDS,
  boxVolumeMm3,
  type ContainerType,
  type Product,
  type Stock,
} from '../domain/stock';
import { stockProblems } from '../domain/stock-invariants';
import { isValidCivilDate, type CivilDate } from '../domain/time';

/**
 * The content catalog (spec §12; plan Steps 07–08; DECISIONS ADR-0037,
 * ADR-0047, ADR-0048): the declarative JSON under `content/` turned into
 * validated domain data — cities and property, each building's structure,
 * the floor materials and the equipment catalog.
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
const centsOrZero = z.int().min(0).max(10_000_000_000);
/** `[x, y, width, depth]` in millimetres. */
const rectMm = z.tuple([
  wholeMm,
  wholeMm,
  z.int().min(1).max(1_000_000),
  z.int().min(1).max(1_000_000),
]);
const label = z.string().min(1).max(60);
const featureSchema = z.strictObject({ kind: z.enum(FEATURE_KINDS), label, rect: rectMm });

/**
 * A building's structure in a property listing (ADR-0047). Columns may be
 * given as a grid: every pair of an x and a y centre line holds a column of
 * the given size. A grid column outside the floor is left out (L-shaped
 * buildings); one that straddles a wall is an error.
 */
const structureSchema = z.strictObject({
  /** The plot, `[x, y, width, depth]` in site-plan metres; defaults to the building's footprint. */
  parcel: z
    .tuple([
      z.int().min(0).max(100_000),
      z.int().min(0).max(100_000),
      z.int().min(1).max(100_000),
      z.int().min(1).max(100_000),
    ])
    .optional(),
  columns: z
    .strictObject({
      label,
      sizeMm: z.tuple([z.int().min(100).max(2000), z.int().min(100).max(2000)]),
      xMm: z.array(wholeMm).max(40),
      yMm: z.array(wholeMm).max(40),
    })
    .optional(),
  features: z.array(featureSchema).max(200).optional(),
  utilities: z
    .array(
      z.strictObject({
        kind: z.enum(UTILITY_KINDS),
        label,
        edge: z.int().min(0),
        offsetMm: wholeMm,
        widthMm: z.int().min(100).max(10_000),
      }),
    )
    .min(1)
    .max(16),
  levels: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(40),
        elevationMm: z.int().min(1).max(50_000),
        deckDepthMm: z.int().min(1).max(2000),
        clearHeightMm: z.int().min(1).max(50_000),
        floorLoadKgPerM2: z.int().min(1).max(100_000),
        floor: z
          .array(z.tuple([wholeMm, wholeMm]))
          .min(4)
          .max(64),
        features: z.array(featureSchema).max(200).optional(),
      }),
    )
    .max(3)
    .optional(),
  stairs: z
    .array(
      z.strictObject({
        upperLevel: z.int().min(1).max(3),
        flight: rectMm,
        foot: rectMm,
        head: rectMm,
      }),
    )
    .max(8)
    .optional(),
});

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
        /** The floor material every cell starts in (ADR-0046). */
        surface: slug,
        structure: structureSchema,
      }),
    )
    .max(500),
});

const floorMaterialsFileSchema = z.strictObject({
  materials: z
    .array(
      z.strictObject({
        id: slug,
        name,
        category: z.enum(FLOOR_MATERIAL_CATEGORIES),
        description: text,
        /** Null for a surface buildings may have but nobody installs (worn concrete). */
        installCentsPerM2: cents.nullable(),
        removalCentsPerM2: centsOrZero,
        colour: z.string().regex(/^#[0-9a-f]{6}$/),
        texture: z.strictObject({
          set: slug,
          variants: z.int().min(1).max(16),
          patternMm: z.tuple([z.int().min(1).max(20_000), z.int().min(1).max(20_000)]),
        }),
      }),
    )
    .min(1)
    .max(200),
});

const zoneSchema = z.strictObject({
  kind: z.enum(ZONE_KINDS),
  side: z.enum(SIDES),
  offsetMm: z.int().min(0).max(100_000),
  widthMm: z.int().min(1).max(100_000),
  depthMm: z.int().min(1).max(10_000),
});

const equipmentFileSchema = z.strictObject({
  equipment: z
    .array(
      z.strictObject({
        id: slug,
        name,
        category: z.enum(EQUIPMENT_CATEGORIES),
        description: text,
        supplier: name,
        priceCents: cents,
        relocationCents: centsOrZero,
        footprintMm: z.tuple([z.int().min(1).max(100_000), z.int().min(1).max(100_000)]),
        heightMm: z.int().min(1).max(20_000),
        weightKg: z.int().min(1).max(1_000_000),
        powerVa: z.int().min(0).max(10_000_000),
        threePhase: z.boolean(),
        water: z.boolean(),
        gas: z.boolean(),
        uses: z.array(z.enum(PERMITTED_USES)).min(1),
        zones: z.array(zoneSchema).max(16),
      }),
    )
    .min(1)
    .max(500),
});

const box3 = z.tuple([
  z.int().min(1).max(20_000),
  z.int().min(1).max(20_000),
  z.int().min(1).max(20_000),
]);
const colour = z.string().regex(/^#[0-9a-f]{6}$/);

/** Products (Step 10, ADR-0053): quantities are exact; mass and volume are per quantum. */
const productsFileSchema = z.strictObject({
  products: z
    .array(
      z.strictObject({
        id: slug,
        name,
        category: z.enum(PRODUCT_CATEGORIES),
        description: text,
        unit: z.enum(BASE_UNITS),
        form: z.enum(PRODUCT_FORMS),
        tracking: z.enum(TRACKING_KINDS),
        /** Millionths of the base unit in the smallest quantity handled: 1,000,000 for one item, 1,000 for a gram or a millilitre. */
        quantumMicro: z.int().min(1).max(1_000_000),
        /** An item's size in mm; null for bulk solids and liquids. */
        itemMm: box3.nullable(),
        massPerQuantumMg: z.int().min(1).max(1_000_000_000),
        /** Null for items (their dimensions give it). */
        volumePerQuantumMm3: z.int().min(1).max(1_000_000_000_000).nullable(),
        packUnits: z
          .array(z.strictObject({ id: slug, name, quanta: z.int().min(1).max(10_000_000) }))
          .max(8),
        grades: z
          .array(z.strictObject({ code: slug, name }))
          .min(1)
          .max(6),
        colour,
      }),
    )
    .min(1)
    .max(1000),
});

/** Containers and load units (Step 10, ADR-0053). */
const containersFileSchema = z.strictObject({
  containers: z
    .array(
      z.strictObject({
        id: slug,
        name,
        kind: z.enum(CONTAINER_KINDS),
        description: text,
        outerMm: box3,
        innerMm: box3,
        tareMassG: z.int().min(1).max(10_000_000),
        payloadMassG: z.int().min(1).max(10_000_000),
        holds: z.array(z.enum(PRODUCT_FORMS)).max(3),
        carries: z.array(z.enum(CONTAINER_KINDS)).max(8),
        mixing: z.enum(MIXING_RULES),
        colour,
      }),
    )
    .min(1)
    .max(200),
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

const fileName = z.string().regex(/^[a-z0-9-]+\.json$/);

const manifestSchema = z.strictObject({
  id: slug,
  version: z.int().min(1),
  description: z.string().min(1).max(400),
  realEstate: z.array(fileName).min(1),
  scenarios: fileName,
  floorMaterials: fileName,
  equipment: fileName,
  products: fileName,
  containers: fileName,
});

/** The raw JSON documents of a content pack, by file name. */
export interface ContentSources {
  readonly manifest: unknown;
  readonly realEstate: Readonly<Record<string, unknown>>;
  readonly scenarios: Readonly<Record<string, unknown>>;
  readonly floorMaterials: Readonly<Record<string, unknown>>;
  readonly equipment: Readonly<Record<string, unknown>>;
  readonly products: Readonly<Record<string, unknown>>;
  readonly containers: Readonly<Record<string, unknown>>;
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
  /** Materials, equipment and building structure every new world starts from: nothing owned. */
  readonly facilities: Facilities;
  /** The product and container catalogs every new world starts from: no stock (Step 10). */
  readonly stock: Stock;
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

/** A building's parcel on its district plan, in millimetres. */
function parcelOf(property: Property, buildings: ReadonlyMap<string, Building>): Box {
  const parcel = buildings.get(property.id)?.parcel;
  return parcel
    ? {
        id: property.id,
        x0: parcel.x,
        y0: parcel.y,
        x1: parcel.x + parcel.width,
        y1: parcel.y + parcel.depth,
      }
    : footprintOf(property);
}

type RectTuple = readonly [number, number, number, number];
const rectOf = ([x, y, width, depth]: RectTuple): RectMm => ({ x, y, width, depth });

interface StructureInput {
  readonly parcel?: RectTuple | undefined;
  readonly columns?:
    | {
        readonly label: string;
        readonly sizeMm: readonly [number, number];
        readonly xMm: readonly number[];
        readonly yMm: readonly number[];
      }
    | undefined;
  readonly features?:
    readonly { kind: Feature['kind']; label: string; rect: RectTuple }[] | undefined;
  readonly utilities: readonly {
    kind: Building['utilities'][number]['kind'];
    label: string;
    edge: number;
    offsetMm: number;
    widthMm: number;
  }[];
  readonly levels?:
    | readonly {
        name: string;
        elevationMm: number;
        deckDepthMm: number;
        clearHeightMm: number;
        floorLoadKgPerM2: number;
        floor: readonly (readonly [number, number])[];
        features?: readonly { kind: Feature['kind']; label: string; rect: RectTuple }[] | undefined;
      }[]
    | undefined;
  readonly stairs?:
    | readonly { upperLevel: number; flight: RectTuple; foot: RectTuple; head: RectTuple }[]
    | undefined;
}

const GRID_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Grid columns that stand on the floor; one straddling a wall is a content error. */
function gridColumns(
  floor: readonly PointMm[],
  columns: NonNullable<StructureInput['columns']>,
  problems: string[],
): Feature[] {
  const [width, depth] = columns.sizeMm;
  if (width % 2 !== 0 || depth % 2 !== 0) {
    problems.push('column sizes must be even numbers of mm, so a column centres on its grid line');
    return [];
  }
  const outline = decompose(floor).region;
  const out: Feature[] = [];
  columns.yMm.forEach((cy, row) => {
    columns.xMm.forEach((cx, col) => {
      const r = { x: cx - width / 2, y: cy - depth / 2, width, depth };
      const reference = `${GRID_LETTERS[row] ?? '?'}${col + 1}`;
      if (regionContains(outline, r)) {
        out.push({ kind: 'column', label: `${columns.label} ${reference}`, rect: r });
      } else if (outline.rects.some((part) => intersection(part, r))) {
        problems.push(`column ${reference} straddles a wall`);
      }
    });
  });
  return out;
}

/** The building record for a property listing, from its structure. */
function buildingFrom(
  property: Property,
  surface: string,
  structure: StructureInput,
  problems: string[],
): Building {
  const features = (list: StructureInput['features']): Feature[] =>
    (list ?? []).map((feature) => ({
      kind: feature.kind,
      label: feature.label,
      rect: rectOf(feature.rect),
    }));
  const ground: Level = {
    index: 0,
    name: 'Ground floor',
    elevationMm: 0,
    deckDepthMm: 0,
    floor: property.floor,
    clearHeightMm: property.clearHeightMm,
    floorLoadKgPerM2: property.floorLoadKgPerM2,
    features: [
      ...(structure.columns ? gridColumns(property.floor, structure.columns, problems) : []),
      ...features(structure.features),
    ],
  };
  const upper: Level[] = (structure.levels ?? []).map((level, index) => ({
    index: index + 1,
    name: level.name,
    elevationMm: level.elevationMm,
    deckDepthMm: level.deckDepthMm,
    floor: level.floor.map(([x, y]) => ({ x, y })),
    clearHeightMm: level.clearHeightMm,
    floorLoadKgPerM2: level.floorLoadKgPerM2,
    features: features(level.features),
  }));
  const bounds = boundsOf(property.floor);
  const parcel = structure.parcel
    ? {
        x: structure.parcel[0] * 1000,
        y: structure.parcel[1] * 1000,
        width: structure.parcel[2] * 1000,
        depth: structure.parcel[3] * 1000,
      }
    : {
        x: property.site.x * 1000 + bounds.minX,
        y: property.site.y * 1000 + bounds.minY,
        width: bounds.maxX - bounds.minX,
        depth: bounds.maxY - bounds.minY,
      };
  return {
    propertyId: property.id,
    surfaceMaterialId: surface,
    parcel,
    levels: [ground, ...upper],
    utilities: structure.utilities.map((utility) => ({ ...utility })),
    stairs: (structure.stairs ?? []).map((stair) => ({
      upperLevel: stair.upperLevel,
      flight: rectOf(stair.flight),
      foot: rectOf(stair.foot),
      head: rectOf(stair.head),
    })),
  };
}

/** Parcels (which contain their buildings) must lie inside their district, clear of streets and of each other. */
function sitePlanProblems(
  district: District,
  properties: readonly Property[],
  buildings: ReadonlyMap<string, Building>,
): string[] {
  const problems: string[] = [];
  const boxes = properties.map((property) => parcelOf(property, buildings));
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
  const buildings = new Map<string, Building>();
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
      const structureProblems: string[] = [];
      buildings.set(
        item.id,
        buildingFrom(property, item.surface, item.structure, structureProblems),
      );
      problems.push(...structureProblems.map((problem) => `${file}: ${item.id}: ${problem}`));
    }
    for (const [id, district] of fileDistricts) {
      problems.push(
        ...sitePlanProblems(district, byDistrict.get(id) ?? [], buildings).map(
          (p) => `${file}: ${p}`,
        ),
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

  const floorMaterials: FloorMaterial[] = [];
  const materialsFile = sources.floorMaterials[manifest.data.floorMaterials];
  const parsedMaterials = floorMaterialsFileSchema.safeParse(materialsFile);
  if (materialsFile === undefined) {
    problems.push(`manifest.json names ${manifest.data.floorMaterials}, which was not provided`);
  } else if (!parsedMaterials.success) {
    problems.push(...zodProblems(manifest.data.floorMaterials, parsedMaterials.error));
  } else {
    for (const material of parsedMaterials.data.materials) {
      floorMaterials.push({
        id: material.id,
        name: material.name,
        category: material.category,
        description: material.description,
        installCentsPerM2:
          material.installCentsPerM2 === null ? null : BigInt(material.installCentsPerM2),
        removalCentsPerM2: BigInt(material.removalCentsPerM2),
        colour: material.colour,
        textureSet: material.texture.set,
        textureVariants: material.texture.variants,
        patternMm: { x: material.texture.patternMm[0], y: material.texture.patternMm[1] },
      });
    }
  }
  const equipmentTypes: EquipmentType[] = [];
  const equipmentFile = sources.equipment[manifest.data.equipment];
  const parsedEquipment = equipmentFileSchema.safeParse(equipmentFile);
  if (equipmentFile === undefined) {
    problems.push(`manifest.json names ${manifest.data.equipment}, which was not provided`);
  } else if (!parsedEquipment.success) {
    problems.push(...zodProblems(manifest.data.equipment, parsedEquipment.error));
  } else {
    for (const item of parsedEquipment.data.equipment) {
      equipmentTypes.push({
        id: item.id,
        name: item.name,
        category: item.category,
        description: item.description,
        supplier: item.supplier,
        priceCents: BigInt(item.priceCents),
        relocationCents: BigInt(item.relocationCents),
        widthMm: item.footprintMm[0],
        depthMm: item.footprintMm[1],
        heightMm: item.heightMm,
        weightKg: item.weightKg,
        powerVa: item.powerVa,
        threePhase: item.threePhase,
        water: item.water,
        gas: item.gas,
        uses: item.uses,
        zones: item.zones,
      });
    }
  }
  const facilities: Facilities = {
    floorMaterials,
    equipmentTypes,
    buildings: properties.flatMap((property) => {
      const building = buildings.get(property.id);
      return building ? [building] : [];
    }),
    equipment: [],
    coverings: [],
    installations: [],
  };
  if (problems.length === 0) {
    problems.push(...facilitiesProblems(facilities, realEstate, null));
  }

  const stock = stockCatalog(sources, manifest.data, problems);

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
      facilities,
      stock,
      scenarios,
    },
  };
}

/**
 * The product and container catalogs (Step 10, ADR-0053). Problems are
 * appended to `problems`; the catalog returned is only used when there are
 * none.
 */
function stockCatalog(
  sources: ContentSources,
  manifest: z.infer<typeof manifestSchema>,
  problems: string[],
): Stock {
  const products: Product[] = [];
  const productsFile = sources.products[manifest.products];
  const parsedProducts = productsFileSchema.safeParse(productsFile);
  if (productsFile === undefined) {
    problems.push(`manifest.json names ${manifest.products}, which was not provided`);
  } else if (!parsedProducts.success) {
    problems.push(...zodProblems(manifest.products, parsedProducts.error));
  } else {
    for (const product of parsedProducts.data.products) {
      const itemMm = product.itemMm && {
        width: product.itemMm[0],
        depth: product.itemMm[1],
        height: product.itemMm[2],
      };
      if ((product.volumePerQuantumMm3 === null) !== (itemMm !== null)) {
        problems.push(
          `${manifest.products}: ${product.id}: give item dimensions or a volume per quantum, not both`,
        );
        continue;
      }
      products.push({
        id: product.id,
        name: product.name,
        category: product.category,
        description: product.description,
        unit: product.unit,
        form: product.form,
        tracking: product.tracking,
        quantumMicro: BigInt(product.quantumMicro),
        itemMm,
        massPerQuantumMg: BigInt(product.massPerQuantumMg),
        volumePerQuantumMm3: itemMm
          ? boxVolumeMm3(itemMm)
          : BigInt(product.volumePerQuantumMm3 ?? 0),
        packUnits: product.packUnits,
        grades: product.grades,
        colour: product.colour,
      });
    }
  }
  const containerTypes: ContainerType[] = [];
  const containersFile = sources.containers[manifest.containers];
  const parsedContainers = containersFileSchema.safeParse(containersFile);
  if (containersFile === undefined) {
    problems.push(`manifest.json names ${manifest.containers}, which was not provided`);
  } else if (!parsedContainers.success) {
    problems.push(...zodProblems(manifest.containers, parsedContainers.error));
  } else {
    const box = ([width, depth, height]: readonly [number, number, number]) => ({
      width,
      depth,
      height,
    });
    for (const type of parsedContainers.data.containers) {
      containerTypes.push({
        ...type,
        outerMm: box(type.outerMm),
        innerMm: box(type.innerMm),
      });
    }
  }
  const stock: Stock = {
    products,
    containerTypes,
    receipts: [],
    loadUnits: [],
    lots: [],
    movements: [],
    reservations: [],
  };
  problems.push(...stockProblems(stock, null, null, null));
  return stock;
}

/** The real estate a new world in `scenario` starts with. */
export function realEstateFor(catalog: ContentCatalog, scenario: Scenario): RealEstate {
  return {
    scenario: { id: scenario.id, name: scenario.name },
    contentVersion: catalog.contentVersion,
    ...catalog.realEstate,
  };
}
