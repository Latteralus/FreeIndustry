import { z } from 'zod';
import { nonNegativeCentsString } from '../money';

/**
 * Real-estate read model (plan Step 07, ADR-0040): the world's cities,
 * districts, properties, established businesses and the company's leases,
 * built by the worker from the authoritative world state. The renderer only
 * displays it. Lengths are integer millimetres (site plans in metres), areas
 * are square millimetres as decimal strings, money is cents strings, and
 * dates are the world calendar ("1996-02-01"). Every derived figure (areas,
 * rents per square foot, averages, counts) is computed by the worker.
 *
 * Also the scenarios a new world can be started from (static content).
 */

const isoDate = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
const contentId = z.string().max(48);
const name = z.string().max(60);
const text = z.string().max(240);
const mm = z.int().min(0).max(1_000_000);
const metres = z.int().min(0).max(100_000);
const mm2 = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const plan = z.strictObject({ x: metres, y: metres });

/** Most properties, businesses and leases a snapshot may carry. */
const LIST_LIMIT = 2000;

export const realEstateViewSchema = z.strictObject({
  scenario: z.strictObject({ id: contentId, name }),
  contentVersion: z.string().max(80),
  cities: z
    .array(
      z.strictObject({
        id: contentId,
        name,
        region: name,
        population: z.int().min(0),
        description: text,
        workforce: z.int().min(0),
        unemploymentPermille: z.int().min(0).max(1000),
        wageRates: z
          .array(
            z.strictObject({
              laborClass: z.enum(['production', 'warehouse', 'office', 'technical']),
              centsPerHour: nonNegativeCentsString,
            }),
          )
          .max(10),
        map: z.strictObject({ x: z.int().min(0).max(1000), y: z.int().min(0).max(1000) }),
        listings: z.int().min(0),
        vacancies: z.int().min(0),
        /** Average asking rent over the city's listings, per square foot per year. */
        averageRentCentsPerSqFtYear: nonNegativeCentsString.nullable(),
        averageRentCentsPerM2Year: nonNegativeCentsString.nullable(),
        manufacturers: z.int().min(0),
        suppliers: z.int().min(0),
        buyers: z.int().min(0),
      }),
    )
    .max(100),
  districts: z
    .array(
      z.strictObject({
        id: contentId,
        cityId: contentId,
        name,
        description: text,
        siteWidthM: metres,
        siteDepthM: metres,
        highwayAccessM: metres,
        railSiding: z.boolean(),
        streets: z
          .array(z.strictObject({ name, from: plan, to: plan, widthM: z.int().min(1) }))
          .max(20),
      }),
    )
    .max(500),
  businesses: z
    .array(
      z.strictObject({
        id: contentId,
        cityId: contentId,
        name,
        role: z.enum(['manufacturer', 'supplier', 'buyer']),
        trade: z.string().max(80),
        propertyId: contentId.nullable(),
      }),
    )
    .max(LIST_LIMIT),
  properties: z
    .array(
      z.strictObject({
        id: contentId,
        cityId: contentId,
        districtId: contentId,
        address: name,
        kind: z.enum([
          'garage',
          'workshop',
          'commercial-unit',
          'industrial-unit',
          'warehouse',
          'factory',
        ]),
        description: text,
        site: plan,
        floor: z
          .array(z.strictObject({ x: mm, y: mm }))
          .min(4)
          .max(64),
        areaMm2: mm2,
        widthMm: mm,
        depthMm: mm,
        clearHeightMm: mm,
        floorLoadKgPerM2: z.int().min(0),
        powerKva: z.int().min(0),
        threePhase: z.boolean(),
        water: z.boolean(),
        gas: z.boolean(),
        doors: z
          .array(
            z.strictObject({
              kind: z.enum(['personnel', 'roller-shutter', 'loading-dock']),
              edge: z.int().min(0),
              offsetMm: mm,
              widthMm: mm,
              heightMm: mm,
            }),
          )
          .max(32),
        permittedUses: z
          .array(
            z.enum([
              'light-manufacturing',
              'general-manufacturing',
              'assembly',
              'storage',
              'distribution',
              'offices',
            ]),
          )
          .max(6),
        landlord: name,
        rentCentsPerMonth: nonNegativeCentsString,
        rentCentsPerSqFtYear: nonNegativeCentsString,
        rentCentsPerM2Year: nonNegativeCentsString,
        depositMonths: z.int().min(0),
        depositCents: nonNegativeCentsString,
        /** Deposit plus the first month's rent: what signing a lease costs at once. */
        upfrontCents: nonNegativeCentsString,
        minTermMonths: z.int().min(1),
        maxTermMonths: z.int().min(1),
        status: z.enum(['vacant', 'occupied', 'leased']),
        /** The established business in an `occupied` property. */
        occupant: z
          .strictObject({
            name,
            role: z.enum(['manufacturer', 'supplier', 'buyer']),
            trade: z.string().max(80),
          })
          .nullable(),
        /** The company's lease of a `leased` property. */
        leaseId: z.string().max(40).nullable(),
      }),
    )
    .max(LIST_LIMIT),
  leases: z
    .array(
      z.strictObject({
        id: z.string().max(40),
        propertyId: contentId,
        cityId: contentId,
        address: name,
        startedOn: isoDate,
        endsOn: isoDate,
        termMonths: z.int().min(1),
        rentCentsPerMonth: nonNegativeCentsString,
        depositCents: nonNegativeCentsString,
        standingOrder: z.boolean(),
        status: z.enum(['active', 'ended']),
        endedOn: isoDate.nullable(),
        nextRentOn: isoDate.nullable(),
      }),
    )
    .max(LIST_LIMIT),
});

export type RealEstateView = z.infer<typeof realEstateViewSchema>;
export type PropertyView = RealEstateView['properties'][number];
export type CityView = RealEstateView['cities'][number];
export type DistrictView = RealEstateView['districts'][number];
export type LeaseView = RealEstateView['leases'][number];

export const scenarioSummarySchema = z.strictObject({
  id: contentId,
  name,
  description: text,
  epoch: isoDate,
  defaultCapitalCents: nonNegativeCentsString,
  quickStart: z
    .strictObject({
      legalName: name,
      presidentName: name,
      propertyId: contentId,
      termMonths: z.int().min(1).max(120),
      standingOrder: z.boolean(),
    })
    .nullable(),
});

export type ScenarioSummary = z.infer<typeof scenarioSummarySchema>;

/** Start a new world (New Company, Quick Start, Scenarios). */
export const newWorldRequestSchema = z.strictObject({
  scenarioId: z
    .string()
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected a scenario ID'),
  /** The world seed, or null to choose one at random. */
  seed: z.int().min(0).max(0xffff_ffff).nullable(),
});

export type NewWorldRequest = z.infer<typeof newWorldRequestSchema>;
