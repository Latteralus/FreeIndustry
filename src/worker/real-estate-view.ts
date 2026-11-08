import { encodeBigInt } from '../shared/bigint-codec';
import type { RealEstateView } from '../shared/ipc/real-estate';
import type { Company } from '../domain/company';
import { boundsOf, MM2_PER_SQ_FT_DENOMINATOR, MM2_PER_SQ_FT_NUMERATOR } from '../domain/geometry';
import { nextIssueTimeOf } from '../domain/obligations';
import {
  depositOf,
  districtOf,
  floorAreaMm2,
  upfrontCostOf,
  type RealEstate,
} from '../domain/real-estate';
import { isoDateAt, type CivilDate } from '../domain/time';

/**
 * Builds the real-estate read model (ADR-0040) from the authoritative world
 * state. Every derived figure is computed here, from the stored facts:
 * floor areas from each outline, rents per square foot from rent and area,
 * city averages and counts from the listings and businesses.
 */

/** Annual rent per square foot, in whole cents (rounded half up), for `areaMm2` of floor. */
function perSqFtYear(monthlyRentCents: bigint, areaMm2: bigint): bigint {
  const numerator = monthlyRentCents * 12n * MM2_PER_SQ_FT_NUMERATOR;
  const denominator = areaMm2 * MM2_PER_SQ_FT_DENOMINATOR;
  return denominator === 0n ? 0n : (numerator * 2n + denominator) / (denominator * 2n);
}

/** Annual rent per square metre, in whole cents (rounded half up). */
function perM2Year(monthlyRentCents: bigint, areaMm2: bigint): bigint {
  const numerator = monthlyRentCents * 12n * 1_000_000n;
  return areaMm2 === 0n ? 0n : (numerator * 2n + areaMm2) / (areaMm2 * 2n);
}

export function realEstateView(
  realEstate: RealEstate,
  company: Company | null,
  epoch: CivilDate,
): RealEstateView {
  const big = encodeBigInt;
  const cityOfDistrict = new Map(
    realEstate.districts.map((district) => [district.id, district.cityId]),
  );
  const businesses = new Map(realEstate.businesses.map((business) => [business.id, business]));
  const premisesOf = new Map<string, string>();
  for (const property of realEstate.properties) {
    if (property.occupant?.kind === 'business') {
      premisesOf.set(property.occupant.businessId, property.id);
    }
  }
  const properties = realEstate.properties.map((property) => {
    const area = floorAreaMm2(property);
    const bounds = boundsOf(property.floor);
    const occupant = property.occupant;
    const business = occupant?.kind === 'business' ? businesses.get(occupant.businessId) : null;
    return {
      id: property.id,
      cityId: cityOfDistrict.get(property.districtId) ?? '',
      districtId: property.districtId,
      address: property.address,
      kind: property.kind,
      description: property.description,
      site: { x: property.site.x, y: property.site.y },
      floor: property.floor.map((corner) => ({ x: corner.x, y: corner.y })),
      areaMm2: big(area),
      widthMm: bounds.maxX - bounds.minX,
      depthMm: bounds.maxY - bounds.minY,
      clearHeightMm: property.clearHeightMm,
      floorLoadKgPerM2: property.floorLoadKgPerM2,
      powerKva: property.powerKva,
      threePhase: property.threePhase,
      water: property.water,
      gas: property.gas,
      doors: property.doors.map((door) => ({ ...door })),
      permittedUses: [...property.permittedUses],
      landlord: property.landlord,
      rentCentsPerMonth: big(property.rentCentsPerMonth),
      rentCentsPerSqFtYear: big(perSqFtYear(property.rentCentsPerMonth, area)),
      rentCentsPerM2Year: big(perM2Year(property.rentCentsPerMonth, area)),
      depositMonths: property.depositMonths,
      depositCents: big(depositOf(property)),
      upfrontCents: big(upfrontCostOf(property)),
      minTermMonths: property.minTermMonths,
      maxTermMonths: property.maxTermMonths,
      status:
        occupant === null
          ? ('vacant' as const)
          : occupant.kind === 'business'
            ? ('occupied' as const)
            : ('leased' as const),
      occupant: business
        ? { name: business.name, role: business.role, trade: business.trade }
        : null,
      leaseId: occupant?.kind === 'lease' ? occupant.leaseId : null,
    };
  });

  const cities = realEstate.cities.map((city) => {
    const listings = realEstate.properties.filter(
      (property) => cityOfDistrict.get(property.districtId) === city.id,
    );
    const area = listings.reduce((sum, property) => sum + floorAreaMm2(property), 0n);
    const rent = listings.reduce((sum, property) => sum + property.rentCentsPerMonth, 0n);
    const local = realEstate.businesses.filter((business) => business.cityId === city.id);
    return {
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
      map: { x: city.map.x, y: city.map.y },
      listings: listings.length,
      vacancies: listings.filter((property) => property.occupant === null).length,
      averageRentCentsPerSqFtYear: listings.length === 0 ? null : big(perSqFtYear(rent, area)),
      averageRentCentsPerM2Year: listings.length === 0 ? null : big(perM2Year(rent, area)),
      manufacturers: local.filter((business) => business.role === 'manufacturer').length,
      suppliers: local.filter((business) => business.role === 'supplier').length,
      buyers: local.filter((business) => business.role === 'buyer').length,
    };
  });

  return {
    scenario: { id: realEstate.scenario.id, name: realEstate.scenario.name },
    contentVersion: realEstate.contentVersion,
    cities,
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
        from: { x: street.from.x, y: street.from.y },
        to: { x: street.to.x, y: street.to.y },
        widthM: street.widthM,
      })),
    })),
    businesses: realEstate.businesses.map((business) => ({
      id: business.id,
      cityId: business.cityId,
      name: business.name,
      role: business.role,
      trade: business.trade,
      propertyId: premisesOf.get(business.id) ?? null,
    })),
    properties,
    leases: realEstate.leases.map((lease) => {
      const property = realEstate.properties.find((item) => item.id === lease.propertyId);
      const district = property ? districtOf(realEstate, property.districtId) : undefined;
      const rent = company?.obligations.find((item) => item.id === lease.rentObligationId);
      const next = rent && lease.status === 'active' ? nextIssueTimeOf(rent, epoch) : null;
      return {
        id: lease.id,
        propertyId: lease.propertyId,
        cityId: district?.cityId ?? '',
        address: property?.address ?? lease.propertyId,
        startedOn: isoDateAt(epoch, lease.startedAtMs),
        endsOn: isoDateAt(epoch, lease.endsAtMs),
        termMonths: lease.termMonths,
        rentCentsPerMonth: big(lease.rentCentsPerMonth),
        depositCents: big(lease.depositCents),
        standingOrder: lease.standingOrder,
        status: lease.status,
        endedOn: lease.endedAtMs === null ? null : isoDateAt(epoch, lease.endedAtMs),
        nextRentOn: next === null ? null : isoDateAt(epoch, next),
      };
    }),
  };
}
