import { z } from 'zod';
import { bigIntString, encodeBigInt } from '../shared/bigint-codec';
import type { JsonValue } from '../shared/canonical-json';
import { isEntityIdOf, type EntityId } from '../domain/ids';
import {
  BUSINESS_ROLES,
  DOOR_KINDS,
  isSlug,
  LABOR_CLASSES,
  PERMITTED_USES,
  PROPERTY_KINDS,
  type RealEstate,
} from '../domain/real-estate';

/**
 * Plain-JSON encoding of the real-estate slice: the fingerprint input, the
 * checkpoint format (ADR-0022), and the form in which a new world's content
 * reaches the kernel (ADR-0037). Every bigint is a canonical decimal string;
 * lists keep their domain order. Decoding validates shapes; the business
 * invariants are checked separately (`realEstateProblems`).
 */

function idOf<K extends string>(kind: K) {
  return z
    .string()
    .refine((id): id is EntityId<K> => isEntityIdOf(kind, id), `Expected a ${kind} ID`);
}

const slug = z.string().refine(isSlug, 'Expected a content identifier');
const count = z.int().min(0);
const point = z.strictObject({ x: z.int(), y: z.int() });

const occupantSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('business'), businessId: slug }),
  z.strictObject({ kind: z.literal('lease'), leaseId: idOf('lease') }),
]);

const realEstateSchema = z.strictObject({
  scenario: z.strictObject({ id: slug, name: z.string() }),
  contentVersion: z.string(),
  cities: z.array(
    z.strictObject({
      id: slug,
      name: z.string(),
      region: z.string(),
      population: count,
      description: z.string(),
      workforce: count,
      unemploymentPermille: z.int().min(0).max(1000),
      wageRates: z.array(
        z.strictObject({ laborClass: z.enum(LABOR_CLASSES), centsPerHour: bigIntString }),
      ),
      map: point,
    }),
  ),
  districts: z.array(
    z.strictObject({
      id: slug,
      cityId: slug,
      name: z.string(),
      description: z.string(),
      siteWidthM: z.int().min(1),
      siteDepthM: z.int().min(1),
      highwayAccessM: count,
      railSiding: z.boolean(),
      streets: z.array(
        z.strictObject({ name: z.string(), from: point, to: point, widthM: z.int().min(1) }),
      ),
    }),
  ),
  businesses: z.array(
    z.strictObject({
      id: slug,
      cityId: slug,
      name: z.string(),
      role: z.enum(BUSINESS_ROLES),
      trade: z.string(),
    }),
  ),
  properties: z.array(
    z.strictObject({
      id: slug,
      districtId: slug,
      address: z.string(),
      kind: z.enum(PROPERTY_KINDS),
      description: z.string(),
      site: point,
      floor: z.array(point),
      clearHeightMm: z.int(),
      floorLoadKgPerM2: z.int(),
      powerKva: z.int(),
      threePhase: z.boolean(),
      water: z.boolean(),
      gas: z.boolean(),
      doors: z.array(
        z.strictObject({
          kind: z.enum(DOOR_KINDS),
          edge: z.int(),
          offsetMm: z.int(),
          widthMm: z.int(),
          heightMm: z.int(),
        }),
      ),
      permittedUses: z.array(z.enum(PERMITTED_USES)),
      landlord: z.string(),
      rentCentsPerMonth: bigIntString,
      depositMonths: z.int(),
      minTermMonths: z.int(),
      maxTermMonths: z.int(),
      occupant: occupantSchema.nullable(),
    }),
  ),
  leases: z.array(
    z.strictObject({
      id: idOf('lease'),
      propertyId: slug,
      tenantFirmId: idOf('firm'),
      landlordPartyId: idOf('party'),
      startedAtMs: bigIntString,
      endsAtMs: bigIntString,
      termMonths: z.int().min(1),
      rentCentsPerMonth: bigIntString,
      depositCents: bigIntString,
      rentObligationId: idOf('obligation'),
      depositObligationId: idOf('obligation'),
      standingOrder: z.boolean(),
      status: z.enum(['active', 'ended']),
      endedAtMs: bigIntString.nullable(),
      refundInvoiceId: idOf('invoice').nullable(),
    }),
  ),
});

export function decodeRealEstate(json: unknown): RealEstate {
  return realEstateSchema.parse(json);
}

const big = encodeBigInt;
const xy = (value: { readonly x: number; readonly y: number }) => ({ x: value.x, y: value.y });

export function encodeRealEstate(realEstate: RealEstate): JsonValue {
  return {
    scenario: { id: realEstate.scenario.id, name: realEstate.scenario.name },
    contentVersion: realEstate.contentVersion,
    cities: realEstate.cities.map((city) => ({
      id: city.id,
      name: city.name,
      region: city.region,
      population: city.population,
      description: city.description,
      workforce: city.workforce,
      unemploymentPermille: city.unemploymentPermille,
      wageRates: city.wageRates.map((rate) => ({
        laborClass: rate.laborClass,
        centsPerHour: big(rate.centsPerHour),
      })),
      map: xy(city.map),
    })),
    districts: realEstate.districts.map((district) => ({
      id: district.id,
      cityId: district.cityId,
      name: district.name,
      description: district.description,
      siteWidthM: district.siteWidthM,
      siteDepthM: district.siteDepthM,
      highwayAccessM: district.highwayAccessM,
      railSiding: district.railSiding,
      streets: district.streets.map((street) => ({
        name: street.name,
        from: xy(street.from),
        to: xy(street.to),
        widthM: street.widthM,
      })),
    })),
    businesses: realEstate.businesses.map((business) => ({
      id: business.id,
      cityId: business.cityId,
      name: business.name,
      role: business.role,
      trade: business.trade,
    })),
    properties: realEstate.properties.map((property) => ({
      id: property.id,
      districtId: property.districtId,
      address: property.address,
      kind: property.kind,
      description: property.description,
      site: xy(property.site),
      floor: property.floor.map(xy),
      clearHeightMm: property.clearHeightMm,
      floorLoadKgPerM2: property.floorLoadKgPerM2,
      powerKva: property.powerKva,
      threePhase: property.threePhase,
      water: property.water,
      gas: property.gas,
      doors: property.doors.map((door) => ({
        kind: door.kind,
        edge: door.edge,
        offsetMm: door.offsetMm,
        widthMm: door.widthMm,
        heightMm: door.heightMm,
      })),
      permittedUses: [...property.permittedUses],
      landlord: property.landlord,
      rentCentsPerMonth: big(property.rentCentsPerMonth),
      depositMonths: property.depositMonths,
      minTermMonths: property.minTermMonths,
      maxTermMonths: property.maxTermMonths,
      occupant:
        property.occupant === null
          ? null
          : property.occupant.kind === 'business'
            ? { kind: 'business', businessId: property.occupant.businessId }
            : { kind: 'lease', leaseId: property.occupant.leaseId },
    })),
    leases: realEstate.leases.map((lease) => ({
      id: lease.id,
      propertyId: lease.propertyId,
      tenantFirmId: lease.tenantFirmId,
      landlordPartyId: lease.landlordPartyId,
      startedAtMs: big(lease.startedAtMs),
      endsAtMs: big(lease.endsAtMs),
      termMonths: lease.termMonths,
      rentCentsPerMonth: big(lease.rentCentsPerMonth),
      depositCents: big(lease.depositCents),
      rentObligationId: lease.rentObligationId,
      depositObligationId: lease.depositObligationId,
      standingOrder: lease.standingOrder,
      status: lease.status,
      endedAtMs: lease.endedAtMs === null ? null : big(lease.endedAtMs),
      refundInvoiceId: lease.refundInvoiceId,
    })),
  };
}
