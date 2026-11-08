import { formatUsd, isPositiveAmount, type Cents } from '../shared/money';
import { ensureCounterparty, type Company, type RuleContext } from './company';
import { edgeLengthMm, floorOutlineProblems, polygonAreaMm2, type PointMm } from './geometry';
import type { EntityId } from './ids';
import { availableFundsCents, invoiceOf, issueInvoice, recordPayment } from './invoicing';
import { ACCOUNT } from './ledger';
import { addObligation, invoiceOccurrence } from './obligations';
import { reject, Rejection } from './rejection';
import { addCalendarMonths, type CivilDate, type SimTimeMs } from './time';

/**
 * Cities, industrial districts, the properties in them, the businesses that
 * already occupy some, and the company's leases (plan Step 07, spec §3.1,
 * §5.1; DECISIONS ADR-0037 – ADR-0039).
 *
 * The cities, districts, properties and businesses come from validated
 * content when a world is created and are then part of that world: a later
 * content change never alters an existing world. Physical facts are integer
 * millimetres and areas derive from each floor's outline (design law D05).
 *
 * A lease is a real commitment. Signing one pays the security deposit and the
 * first month's rent at once (refused when the funds are not there), commits
 * the company to monthly rent for the term through the ordinary obligation
 * rules, and occupies the property. At the end of the term the company moves
 * out and the landlord refunds the deposit.
 */

export const PROPERTY_KINDS = [
  'garage',
  'workshop',
  'commercial-unit',
  'industrial-unit',
  'warehouse',
  'factory',
] as const;
type PropertyKind = (typeof PROPERTY_KINDS)[number];

export const PERMITTED_USES = [
  'light-manufacturing',
  'general-manufacturing',
  'assembly',
  'storage',
  'distribution',
  'offices',
] as const;
type PermittedUse = (typeof PERMITTED_USES)[number];

export const DOOR_KINDS = ['personnel', 'roller-shutter', 'loading-dock'] as const;
type DoorKind = (typeof DOOR_KINDS)[number];

export const BUSINESS_ROLES = ['manufacturer', 'supplier', 'buyer'] as const;
type BusinessRole = (typeof BUSINESS_ROLES)[number];

export const LABOR_CLASSES = ['production', 'warehouse', 'office', 'technical'] as const;
type LaborClass = (typeof LABOR_CLASSES)[number];

/** A content identifier: lower-case words and digits joined by hyphens. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 48;

export function isSlug(id: string): boolean {
  return id.length <= MAX_SLUG_LENGTH && SLUG.test(id);
}

interface WageRate {
  readonly laborClass: LaborClass;
  /** Prevailing hourly wage in the city's labour market. */
  readonly centsPerHour: Cents;
}

export interface City {
  readonly id: string;
  readonly name: string;
  /** The (fictional) state or region the city lies in. */
  readonly region: string;
  readonly population: number;
  readonly description: string;
  /** People in the city's labour force. */
  readonly workforce: number;
  /** Unemployment, in tenths of a percent. */
  readonly unemploymentPermille: number;
  readonly wageRates: readonly WageRate[];
  /** Position on the schematic regional map, 0–1000 on each axis. */
  readonly map: { readonly x: number; readonly y: number };
}

interface Street {
  readonly name: string;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly widthM: number;
}

export interface District {
  readonly id: string;
  readonly cityId: string;
  readonly name: string;
  readonly description: string;
  /** Extent of the district site plan, in metres. */
  readonly siteWidthM: number;
  readonly siteDepthM: number;
  /** Road distance to the nearest highway junction, in metres. */
  readonly highwayAccessM: number;
  readonly railSiding: boolean;
  /** Streets drawn on the site plan (metres, plan coordinates). */
  readonly streets: readonly Street[];
}

/** A business already established in a city: a future competitor, supplier or customer. */
export interface Business {
  readonly id: string;
  readonly cityId: string;
  readonly name: string;
  readonly role: BusinessRole;
  readonly trade: string;
}

interface Door {
  readonly kind: DoorKind;
  /** The floor outline edge the door is in (edge i runs from corner i to corner i + 1). */
  readonly edge: number;
  /** Distance from the edge's first corner to the near side of the opening. */
  readonly offsetMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

type Occupant =
  | { readonly kind: 'business'; readonly businessId: string }
  | { readonly kind: 'lease'; readonly leaseId: EntityId<'lease'> };

export interface Property {
  readonly id: string;
  readonly districtId: string;
  readonly address: string;
  readonly kind: PropertyKind;
  readonly description: string;
  /** Where the floor outline's origin lies on the district site plan, in metres. */
  readonly site: { readonly x: number; readonly y: number };
  /** Interior floor outline, millimetres from the building's own origin. */
  readonly floor: readonly PointMm[];
  readonly clearHeightMm: number;
  readonly floorLoadKgPerM2: number;
  /** Electrical supply capacity, in kilovolt-amperes. */
  readonly powerKva: number;
  readonly threePhase: boolean;
  readonly water: boolean;
  readonly gas: boolean;
  readonly doors: readonly Door[];
  readonly permittedUses: readonly PermittedUse[];
  readonly landlord: string;
  readonly rentCentsPerMonth: Cents;
  /** The security deposit, in months of rent. */
  readonly depositMonths: number;
  readonly minTermMonths: number;
  readonly maxTermMonths: number;
  readonly occupant: Occupant | null;
}

export interface Lease {
  readonly id: EntityId<'lease'>;
  readonly propertyId: string;
  readonly tenantFirmId: EntityId<'firm'>;
  readonly landlordPartyId: EntityId<'party'>;
  readonly startedAtMs: SimTimeMs;
  readonly endsAtMs: SimTimeMs;
  readonly termMonths: number;
  readonly rentCentsPerMonth: Cents;
  readonly depositCents: Cents;
  readonly rentObligationId: EntityId<'obligation'>;
  readonly depositObligationId: EntityId<'obligation'>;
  readonly standingOrder: boolean;
  readonly status: 'active' | 'ended';
  readonly endedAtMs: SimTimeMs | null;
  /** The landlord's refund of the deposit, once the lease has ended. */
  readonly refundInvoiceId: EntityId<'invoice'> | null;
}

/** The world's real estate. `scenario` and `contentVersion` record where it came from. */
export interface RealEstate {
  readonly scenario: { readonly id: string; readonly name: string };
  readonly contentVersion: string;
  readonly cities: readonly City[];
  readonly districts: readonly District[];
  readonly businesses: readonly Business[];
  readonly properties: readonly Property[];
  readonly leases: readonly Lease[];
}

/** Longest lease FreeIndustry offers: ten years (obligations run at most 120 months). */
const MAX_LEASE_TERM_MONTHS = 120;
/** Largest security deposit a listing may ask, in months of rent. */
const MAX_DEPOSIT_MONTHS = 6;

// ----------------------------------------------------------- derived facts

export function floorAreaMm2(property: Property): bigint {
  return polygonAreaMm2(property.floor);
}

export function depositOf(property: Property): Cents {
  return property.rentCentsPerMonth * BigInt(property.depositMonths);
}

/** What signing a lease costs at once: the deposit and the first month's rent. */
export function upfrontCostOf(property: Property): Cents {
  return depositOf(property) + property.rentCentsPerMonth;
}

function propertyOf(realEstate: RealEstate, id: string): Property | undefined {
  return realEstate.properties.find((property) => property.id === id);
}

function leaseOf(realEstate: RealEstate, id: string): Lease | undefined {
  return realEstate.leases.find((lease) => lease.id === id);
}

function activeLeases(realEstate: RealEstate): Lease[] {
  return realEstate.leases.filter((lease) => lease.status === 'active');
}

export function districtOf(realEstate: RealEstate, id: string): District | undefined {
  return realEstate.districts.find((district) => district.id === id);
}

// -------------------------------------------------------------- leasing

export interface LeaseRequest {
  readonly propertyId: string;
  readonly termMonths: number;
  /** Let the bank pay each month's rent on its due date. */
  readonly standingOrder: boolean;
}

export interface LeaseContext extends RuleContext {
  readonly epoch: CivilDate;
}

export interface SignedLease {
  readonly realEstate: RealEstate;
  readonly company: Company;
  readonly leaseId: EntityId<'lease'>;
  readonly rentObligationId: EntityId<'obligation'>;
  readonly endsAtMs: SimTimeMs;
}

function describeOccupant(realEstate: RealEstate, property: Property): string {
  const occupant = property.occupant;
  if (occupant?.kind === 'business') {
    const business = realEstate.businesses.find((item) => item.id === occupant.businessId);
    return `${property.address} is occupied by ${business?.name ?? 'another business'}`;
  }
  return `${property.address} is already leased`;
}

/**
 * Sign a lease on a vacant property: register the landlord, commit to the
 * deposit and the monthly rent, invoice and pay the deposit and the first
 * month's rent now, and occupy the property. All or nothing: any refusal
 * leaves both the real estate and the company unchanged.
 */
export function signLease(
  realEstate: RealEstate,
  company: Company,
  request: LeaseRequest,
  context: LeaseContext,
): SignedLease | Rejection {
  const property = propertyOf(realEstate, request.propertyId);
  if (!property) {
    return reject(`There is no property ${request.propertyId}`, {
      propertyId: request.propertyId,
    });
  }
  if (property.occupant !== null) {
    return reject(describeOccupant(realEstate, property), { propertyId: property.id });
  }
  const current = activeLeases(realEstate)[0];
  if (current) {
    const premises = propertyOf(realEstate, current.propertyId);
    return reject(
      `${company.legalName} already leases ${premises?.address ?? current.propertyId}. ` +
        'Running a second facility arrives with multi-site operations (plan Step 26).',
      { leaseId: current.id },
    );
  }
  const { termMonths } = request;
  if (
    !Number.isInteger(termMonths) ||
    termMonths < property.minTermMonths ||
    termMonths > property.maxTermMonths
  ) {
    return reject(
      `${property.address} is let for ${property.minTermMonths}–${property.maxTermMonths} months, not ${termMonths}`,
      { termMonths },
    );
  }
  const deposit = depositOf(property);
  const rent = property.rentCentsPerMonth;
  const upfront = deposit + rent;
  const available = availableFundsCents(company);
  if (upfront > available) {
    return reject(
      `Insufficient funds: ${formatUsd(available)} available, ${formatUsd(upfront)} needed ` +
        `(deposit ${formatUsd(deposit)} and the first month's rent ${formatUsd(rent)})`,
      { availableCents: available.toString(), requiredCents: upfront.toString() },
    );
  }

  const landlord = ensureCounterparty(company, property.landlord, 'landlord', context.allocateId);
  let books = landlord.company;
  const commit = (
    purpose: 'rent' | 'security-deposit',
    amountCents: Cents,
    occurrences: number,
    description: string,
  ) => {
    const added = settled(
      addObligation(
        books,
        {
          counterpartyId: landlord.counterpartyId,
          purpose,
          description,
          amountCents,
          cadence: purpose === 'rent' ? 'monthly' : 'once',
          firstIssueAtMs: context.nowMs,
          occurrences,
          paymentTermsDays: 0,
          standingOrder: purpose === 'rent' && request.standingOrder,
        },
        context,
      ),
    );
    const invoiced = settled(invoiceOccurrence(added.company, added.obligationId, 1, context));
    const amount = invoiceOf(invoiced.company, invoiced.invoiceId)?.totalCents ?? 0n;
    const paid = settled(
      recordPayment(
        invoiced.company,
        { invoiceId: invoiced.invoiceId, amountCents: amount, initiatedBy: 'player' },
        context,
      ),
    );
    books = paid.company;
    return added.obligationId;
  };

  const leaseId = context.allocateId('lease');
  // Listings always ask at least one month's deposit (propertyProblems).
  const depositObligationId = commit(
    'security-deposit',
    deposit,
    1,
    `Security deposit, ${property.address}`,
  );
  const rentObligationId = commit('rent', rent, termMonths, `Rent, ${property.address}`);
  const endsAtMs = addCalendarMonths(context.epoch, context.nowMs, termMonths);
  const lease: Lease = {
    id: leaseId,
    propertyId: property.id,
    tenantFirmId: company.firmId,
    landlordPartyId: landlord.counterpartyId,
    startedAtMs: context.nowMs,
    endsAtMs,
    termMonths,
    rentCentsPerMonth: rent,
    depositCents: deposit,
    rentObligationId,
    depositObligationId,
    standingOrder: request.standingOrder,
    status: 'active',
    endedAtMs: null,
    refundInvoiceId: null,
  };
  return {
    realEstate: {
      ...realEstate,
      properties: realEstate.properties.map((candidate) =>
        candidate.id === property.id
          ? { ...candidate, occupant: { kind: 'lease', leaseId } }
          : candidate,
      ),
      leases: [...realEstate.leases, lease],
    },
    company: books,
    leaseId,
    rentObligationId,
    endsAtMs,
  };
}

/**
 * The lease term is over: the company moves out, the property is vacant
 * again, and the landlord refunds the deposit (a receivable the landlord
 * settles at once). Throws unless the lease is active and ends now.
 */
export function endLease(
  realEstate: RealEstate,
  company: Company,
  leaseId: string,
  context: RuleContext,
): { realEstate: RealEstate; company: Company; refundInvoiceId: EntityId<'invoice'> } {
  const lease = leaseOf(realEstate, leaseId);
  if (lease?.status !== 'active') {
    throw new Error(`Lease ${leaseId} is not active`);
  }
  if (lease.endsAtMs !== context.nowMs) {
    throw new Error(`Lease ${leaseId} ends at ${lease.endsAtMs}, not now`);
  }
  const property = propertyOf(realEstate, lease.propertyId);
  const refund = settled(
    issueInvoice(
      company,
      {
        direction: 'receivable',
        counterpartyId: lease.landlordPartyId,
        description: `Deposit refund, ${property?.address ?? lease.propertyId}`.slice(0, 120),
        lines: [
          {
            account: ACCOUNT.depositsPaid,
            description: 'Security deposit returned at the end of the lease',
            amountCents: lease.depositCents,
          },
        ],
        dueAtMs: context.nowMs,
        obligation: null,
      },
      context,
    ),
  );
  const received = settled(
    recordPayment(
      refund.company,
      { invoiceId: refund.invoiceId, amountCents: lease.depositCents, initiatedBy: 'counterparty' },
      context,
    ),
  );
  return {
    realEstate: {
      ...realEstate,
      properties: realEstate.properties.map((candidate) =>
        candidate.id === lease.propertyId ? { ...candidate, occupant: null } : candidate,
      ),
      leases: realEstate.leases.map((candidate) =>
        candidate.id === lease.id
          ? {
              ...candidate,
              status: 'ended',
              endedAtMs: context.nowMs,
              refundInvoiceId: refund.invoiceId,
            }
          : candidate,
      ),
    },
    company: received.company,
    refundInvoiceId: refund.invoiceId,
  };
}

/** Inside a lease the amounts were checked up front, so a refusal here is a broken rule. */
function settled<T>(result: T | Rejection): T {
  if (result instanceof Rejection) {
    throw new Error(`Lease bookkeeping failed: ${result.reason}`);
  }
  return result;
}

// ----------------------------------------------------------- invariants

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      repeated.add(id);
    }
    seen.add(id);
  }
  return [...repeated];
}

/** Why a property listing is physically or commercially impossible; empty when it is sound. */
export function propertyProblems(property: Property): string[] {
  const problems = floorOutlineProblems(property.floor).map((problem) => `floor: ${problem}`);
  if (problems.length > 0) {
    return problems;
  }
  const positive = (value: number, what: string) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      problems.push(`${what} must be a positive whole number`);
    }
  };
  positive(property.clearHeightMm, 'clear height');
  positive(property.floorLoadKgPerM2, 'floor load');
  positive(property.powerKva, 'power supply');
  if (!isPositiveAmount(property.rentCentsPerMonth)) {
    problems.push('rent must be a positive amount');
  }
  if (
    !Number.isInteger(property.depositMonths) ||
    property.depositMonths < 1 ||
    property.depositMonths > MAX_DEPOSIT_MONTHS
  ) {
    problems.push(`the deposit must be 1–${MAX_DEPOSIT_MONTHS} months of rent`);
  }
  if (
    !Number.isInteger(property.minTermMonths) ||
    !Number.isInteger(property.maxTermMonths) ||
    property.minTermMonths < 1 ||
    property.minTermMonths > property.maxTermMonths ||
    property.maxTermMonths > MAX_LEASE_TERM_MONTHS
  ) {
    problems.push(`lease terms must satisfy 1 ≤ minimum ≤ maximum ≤ ${MAX_LEASE_TERM_MONTHS}`);
  }
  if (property.permittedUses.length === 0) {
    problems.push('no use is permitted');
  }
  if (duplicates([...property.permittedUses]).length > 0) {
    problems.push('a permitted use is listed twice');
  }
  if (!property.doors.some((door) => door.kind === 'personnel')) {
    problems.push('there is no personnel door');
  }
  property.doors.forEach((door, index) => {
    if (!Number.isInteger(door.edge) || door.edge < 0 || door.edge >= property.floor.length) {
      problems.push(`door ${index} is on edge ${door.edge}, which the floor does not have`);
      return;
    }
    const length = edgeLengthMm(property.floor, door.edge);
    if (
      !Number.isSafeInteger(door.offsetMm) ||
      door.offsetMm < 0 ||
      !Number.isSafeInteger(door.widthMm) ||
      door.widthMm <= 0 ||
      door.offsetMm + door.widthMm > length
    ) {
      problems.push(`door ${index} does not fit within its ${length} mm wall`);
    }
    if (!Number.isSafeInteger(door.heightMm) || door.heightMm <= 0) {
      problems.push(`door ${index} has no height`);
    } else if (door.heightMm > property.clearHeightMm) {
      problems.push(`door ${index} is taller than the building's clear height`);
    }
  });
  return problems;
}

/**
 * Cross-checks of the world's real estate, and of its leases against the
 * company's books. Returns human-readable violations; empty when consistent.
 */
export function realEstateProblems(realEstate: RealEstate, company: Company | null): string[] {
  const problems: string[] = [];
  const allIds = [
    ...realEstate.cities.map((city) => city.id),
    ...realEstate.districts.map((district) => district.id),
    ...realEstate.businesses.map((business) => business.id),
    ...realEstate.properties.map((property) => property.id),
  ];
  for (const id of duplicates(allIds)) {
    problems.push(`identifier ${id} is used twice`);
  }
  for (const id of allIds) {
    if (!isSlug(id)) {
      problems.push(`identifier ${JSON.stringify(id)} is not a valid content identifier`);
    }
  }
  const cities = new Set(realEstate.cities.map((city) => city.id));
  const districts = new Map(realEstate.districts.map((district) => [district.id, district]));
  const businesses = new Map(realEstate.businesses.map((business) => [business.id, business]));
  for (const city of realEstate.cities) {
    if (duplicates(city.wageRates.map((rate) => rate.laborClass)).length > 0) {
      problems.push(`city ${city.id} lists a wage rate twice`);
    }
    if (city.workforce > city.population) {
      problems.push(`city ${city.id} has a workforce larger than its population`);
    }
  }
  for (const district of realEstate.districts) {
    if (!cities.has(district.cityId)) {
      problems.push(`district ${district.id} is in unknown city ${district.cityId}`);
    }
  }
  for (const business of realEstate.businesses) {
    if (!cities.has(business.cityId)) {
      problems.push(`business ${business.id} is in unknown city ${business.cityId}`);
    }
  }
  const occupiedBy = new Map<string, string>();
  for (const property of realEstate.properties) {
    for (const problem of propertyProblems(property)) {
      problems.push(`property ${property.id}: ${problem}`);
    }
    const district = districts.get(property.districtId);
    if (!district) {
      problems.push(`property ${property.id} is in unknown district ${property.districtId}`);
    }
    const occupant = property.occupant;
    if (occupant?.kind === 'business') {
      const business = businesses.get(occupant.businessId);
      if (!business) {
        problems.push(`property ${property.id} is occupied by unknown ${occupant.businessId}`);
      } else if (district && business.cityId !== district.cityId) {
        problems.push(`property ${property.id} is occupied by a business from another city`);
      }
      const other = occupiedBy.get(occupant.businessId);
      if (other !== undefined) {
        problems.push(`${occupant.businessId} occupies both ${other} and ${property.id}`);
      }
      occupiedBy.set(occupant.businessId, property.id);
    }
  }

  for (const id of duplicates(realEstate.leases.map((lease) => lease.id))) {
    problems.push(`lease ${id} is recorded twice`);
  }
  const active = activeLeases(realEstate);
  if (active.length > 1) {
    problems.push(`${active.length} leases are active; at most one is allowed`);
  }
  if (realEstate.leases.length > 0 && !company) {
    problems.push('leases exist but no company does');
  }
  for (const lease of realEstate.leases) {
    problems.push(...leaseProblems(realEstate, company, lease));
  }
  for (const property of realEstate.properties) {
    const occupant = property.occupant;
    if (occupant?.kind === 'lease') {
      const lease = leaseOf(realEstate, occupant.leaseId);
      if (lease?.status !== 'active' || lease.propertyId !== property.id) {
        problems.push(
          `property ${property.id} is held by ${occupant.leaseId}, not an active lease`,
        );
      }
    }
  }
  return problems;
}

function leaseProblems(realEstate: RealEstate, company: Company | null, lease: Lease): string[] {
  const problems: string[] = [];
  const at = `lease ${lease.id}`;
  const property = propertyOf(realEstate, lease.propertyId);
  if (!property) {
    return [`${at} is for unknown property ${lease.propertyId}`];
  }
  const holds = property.occupant?.kind === 'lease' && property.occupant.leaseId === lease.id;
  if ((lease.status === 'active') !== holds) {
    problems.push(`${at} is ${lease.status} but the property says otherwise`);
  }
  if (lease.status === 'active' && (lease.endedAtMs !== null || lease.refundInvoiceId !== null)) {
    problems.push(`${at} is active but records an end`);
  }
  if (lease.status === 'ended' && (lease.endedAtMs === null || lease.refundInvoiceId === null)) {
    problems.push(`${at} has ended without a recorded end and deposit refund`);
  }
  if (lease.endsAtMs <= lease.startedAtMs) {
    problems.push(`${at} ends before it starts`);
  }
  if (!company) {
    return problems;
  }
  if (lease.tenantFirmId !== company.firmId) {
    problems.push(`${at} names tenant ${lease.tenantFirmId}, not the company`);
  }
  const landlord = company.counterparties.find((party) => party.id === lease.landlordPartyId);
  if (landlord?.kind !== 'landlord') {
    problems.push(`${at} names ${lease.landlordPartyId}, which is not a landlord`);
  }
  const rent = company.obligations.find((item) => item.id === lease.rentObligationId);
  if (
    rent?.purpose !== 'rent' ||
    rent.cadence !== 'monthly' ||
    rent.amountCents !== lease.rentCentsPerMonth ||
    rent.occurrences !== lease.termMonths ||
    rent.counterpartyId !== lease.landlordPartyId ||
    rent.firstIssueAtMs !== lease.startedAtMs
  ) {
    problems.push(`${at} does not match its rent obligation`);
  }
  const deposit = company.obligations.find((item) => item.id === lease.depositObligationId);
  if (
    deposit?.purpose !== 'security-deposit' ||
    deposit.cadence !== 'once' ||
    deposit.amountCents !== lease.depositCents ||
    deposit.counterpartyId !== lease.landlordPartyId
  ) {
    problems.push(`${at} does not match its deposit obligation`);
  }
  if (lease.refundInvoiceId !== null) {
    const refund = invoiceOf(company, lease.refundInvoiceId);
    if (
      refund?.direction !== 'receivable' ||
      refund.totalCents !== lease.depositCents ||
      refund.paidCents !== lease.depositCents ||
      refund.counterpartyId !== lease.landlordPartyId
    ) {
      problems.push(`${at} records a deposit refund that does not match the deposit`);
    }
  }
  return problems;
}
