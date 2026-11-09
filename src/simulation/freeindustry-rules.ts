import { z } from 'zod';
import { bigIntString, encodeBigInt } from '../shared/bigint-codec';
import { COMMANDS, type CommandType } from '../shared/ipc/commands';
import {
  INITIAL_DIAGNOSTICS,
  MAX_PENDING_PROBES,
  probeFired,
  recordProbe,
  scheduleProbe,
} from '../domain/diagnostics';
import {
  ensureCounterparty,
  foundCompany,
  type Company,
  type RuleContext,
} from '../domain/company';
import { companyProblems } from '../domain/company-invariants';
import {
  clearPremises,
  facilitiesProblems,
  placeEquipment,
  purchaseEquipment,
  uninstallEquipment,
  type Facilities,
} from '../domain/facilities';
import { isEntityIdOf, type EntityId } from '../domain/ids';
import {
  availableFundsCents,
  invoiceOf,
  markOverdue,
  outstandingOf,
  recordPayment,
} from '../domain/invoicing';
import { addObligation, invoiceOccurrence, issueTimeOf, obligationOf } from '../domain/obligations';
import {
  endLease,
  realEstateProblems,
  signLease,
  type LeaseRequest,
  type RealEstate,
} from '../domain/real-estate';
import { reject, Rejection } from '../domain/rejection';
import { MS_PER_DAY, type CivilDate } from '../domain/time';
import type { FreeIndustryState } from '../domain/world-state';
import { decodeCompany, encodeCompany } from './company-codec';
import { decodeFacilities, encodeFacilities } from './facilities-codec';
import { decodeRealEstate, encodeRealEstate } from './real-estate-codec';
import {
  defineCommand,
  defineEvent,
  type CommandDefinition,
  type KernelContext,
  type SimulationRules,
} from './rules';

/**
 * FreeIndustry's production rules for the kernel: the kernel diagnostics
 * (ADR-0024); from Step 05 the company and its books (ADR-0031, ADR-0032);
 * from Step 07 cities, property and leases (ADR-0037, ADR-0038); from
 * Step 08 building structure, equipment and the floor-covering layer
 * (ADR-0047, ADR-0048). Every later system adds its state slices, commands,
 * events and periodic decision cycles here.
 *
 * Rules version 1 covers all of them: Steps 05, 07 and 08 only *added*
 * commands, events and state slices that are absent from older worlds (and
 * left out of the encoding while absent), so every world made before them
 * continues exactly as it would have, with the same fingerprints (ADR-0033,
 * ADR-0039, ADR-0049).
 */

/**
 * Day 0 of a world created without a scenario (tests): Monday 1 January
 * 1996, the year of the original game's release. Scenarios choose their own
 * epoch (ADR-0037). A FreeIndustry default, not an original rule.
 */
export const DEFAULT_EPOCH: CivilDate = { year: 1996, month: 1, day: 1 };

/** Commands the kernel handles. `diagnostics.injectFault` is the worker's test hook, not a rule. */
type RuleCommandType = Exclude<CommandType, 'diagnostics.injectFault'>;

const probeIdSchema = z
  .string()
  .refine((id): id is EntityId<'probe'> => isEntityIdOf('probe', id), 'Expected a probe ID');

const probeDuePayload = z.strictObject({
  probeId: probeIdSchema,
  label: z.string().min(1).max(80),
  scheduledAtMs: bigIntString,
});

const diagnosticsStateSchema = z.strictObject({
  probeCount: z.int().min(0),
  lastProbeLabel: z.string().nullable(),
  pendingProbes: z.int().min(0),
  firedProbes: z.int().min(0),
  lastFiredProbe: z
    .strictObject({
      probeId: probeIdSchema,
      label: z.string(),
      token: z.int().min(0).max(0xffff_ffff),
      scheduledAtMs: bigIntString,
      firedAtMs: bigIntString,
    })
    .nullable(),
});

const stateSchema = z.strictObject({
  diagnostics: diagnosticsStateSchema,
  /** Absent until a company is founded (ADR-0033). */
  company: z.unknown().optional(),
  /** Absent in worlds created without real estate, as before Step 07 (ADR-0039). */
  realEstate: z.unknown().optional(),
  /** Absent in worlds created before Step 08 (ADR-0049). */
  facilities: z.unknown().optional(),
});

/**
 * A world setup (ADR-0037): `{ realEstate, facilities }` from Step 08. A
 * bare real-estate encoding is still accepted and builds a world without
 * facilities, exactly as Step 07 did (tests use it for hand-made estates).
 */
const setupSchema = z.strictObject({ realEstate: z.unknown(), facilities: z.unknown() });

/** Counterparty of the development-only test obligations (ADR-0033). */
const DIAGNOSTIC_LANDLORD = 'Diagnostic landlord';

const invoiceIdSchema = z
  .string()
  .refine((id): id is EntityId<'invoice'> => isEntityIdOf('invoice', id), 'Expected an invoice ID');

const obligationBillPayload = z.strictObject({
  obligationId: z
    .string()
    .refine(
      (id): id is EntityId<'obligation'> => isEntityIdOf('obligation', id),
      'Expected an obligation ID',
    ),
  occurrence: z.int().min(1),
});

const invoiceDuePayload = z.strictObject({ invoiceId: invoiceIdSchema });

const leaseEndsPayload = z.strictObject({
  leaseId: z
    .string()
    .refine((id): id is EntityId<'lease'> => isEntityIdOf('lease', id), 'Expected a lease ID'),
});

/** A new world's real estate and facilities from its setup: content only, nothing leased or owned. */
function newWorld(setup: unknown): { realEstate: RealEstate; facilities: Facilities | null } {
  const parsed = setupSchema.safeParse(setup);
  const realEstate = newRealEstate(parsed.success ? parsed.data.realEstate : setup);
  if (!parsed.success) {
    return { realEstate, facilities: null };
  }
  const facilities = decodeFacilities(parsed.data.facilities);
  if (
    facilities.equipment.length > 0 ||
    facilities.coverings.length > 0 ||
    facilities.installations.length > 0
  ) {
    throw new Error('A new world cannot start with equipment or floor coverings');
  }
  const problems = facilitiesProblems(facilities, realEstate, null);
  if (problems.length > 0) {
    throw new Error(`Invalid world setup: ${problems.slice(0, 5).join('; ')}`);
  }
  return { realEstate, facilities };
}

/** A new world's real estate from its setup: content only, nothing leased yet. */
function newRealEstate(setup: unknown): RealEstate {
  const realEstate = decodeRealEstate(setup);
  if (
    realEstate.leases.length > 0 ||
    realEstate.properties.some((property) => property.occupant?.kind === 'lease')
  ) {
    throw new Error('A new world cannot start with leases');
  }
  const problems = realEstateProblems(realEstate, null);
  if (problems.length > 0) {
    throw new Error(`Invalid world setup: ${problems.slice(0, 5).join('; ')}`);
  }
  return realEstate;
}

function noCompany(): Rejection {
  return reject('No company has been founded yet');
}

function noFacilities(): Rejection {
  return reject(
    'This world has no equipment or building layouts: it was created before they existed (plan Step 08). Start a new company to lay out a factory.',
  );
}

interface PlacementPayload {
  readonly equipmentId: string;
  readonly propertyId: string;
  readonly level: number;
  readonly xMm: number;
  readonly yMm: number;
  readonly rotation: number;
}

/** Install (`move` false) or move an item, record the fact, and charge any rigging. */
function place(
  state: FreeIndustryState,
  payload: PlacementPayload,
  move: boolean,
  context: KernelContext,
): FreeIndustryState | Rejection {
  if (!state.company) {
    return noCompany();
  }
  if (!state.facilities || !state.realEstate) {
    return noFacilities();
  }
  const { equipmentId, ...placement } = payload;
  const placed = placeEquipment(
    state.facilities,
    state.realEstate,
    state.company,
    { equipmentId, placement, move },
    ruleContext(context),
  );
  if (placed instanceof Rejection) {
    return placed;
  }
  context.record(move ? 'equipment.moved' : 'equipment.installed', {
    equipmentId,
    ...placement,
    chargedCents: encodeBigInt(placed.chargedCents),
    invoiceId: placed.invoiceId,
  });
  return { ...state, facilities: placed.facilities, company: placed.company };
}

function ruleContext(context: KernelContext): RuleContext {
  return { nowMs: context.nowMs, allocateId: (kind) => context.allocateId(kind) };
}

/** A rejection inside an event is a broken rule, not a player error: fail the event loudly. */
function settled<T>(result: T | Rejection, what: string): T {
  if (result instanceof Rejection) {
    throw new Error(`${what}: ${result.reason}`);
  }
  return result;
}

/** Schedule the next bill of an obligation if any occurrences remain. */
function scheduleNextBill(company: Company, obligationId: string, context: KernelContext): void {
  const obligation = obligationOf(company, obligationId);
  if (obligation.issued < obligation.occurrences) {
    const occurrence = obligation.issued + 1;
    context.schedule({
      type: 'finance.obligationBill',
      atMs: issueTimeOf(obligation, occurrence, context.epoch),
      payload: { obligationId: obligation.id, occurrence },
    });
  }
}

/**
 * Sign a lease for the company, schedule its next rent bill and its end, and
 * record the fact. Nothing is staged when it is refused.
 */
function lease(
  realEstate: RealEstate | null,
  company: Company,
  request: LeaseRequest,
  context: KernelContext,
): { realEstate: RealEstate; company: Company } | Rejection {
  if (!realEstate) {
    return reject(
      'This world has no property market: it was created before cities and property existed',
    );
  }
  const signed = signLease(realEstate, company, request, {
    ...ruleContext(context),
    epoch: context.epoch,
  });
  if (signed instanceof Rejection) {
    return signed;
  }
  scheduleNextBill(signed.company, signed.rentObligationId, context);
  context.schedule({
    type: 'realEstate.leaseEnds',
    atMs: signed.endsAtMs,
    payload: { leaseId: signed.leaseId },
  });
  context.record('realEstate.leaseSigned', {
    leaseId: signed.leaseId,
    propertyId: request.propertyId,
    termMonths: request.termMonths,
    endsAtMs: encodeBigInt(signed.endsAtMs),
  });
  return { realEstate: signed.realEstate, company: signed.company };
}

const commands: Readonly<Record<RuleCommandType, CommandDefinition<FreeIndustryState>>> = {
  'company.found': defineCommand(
    COMMANDS['company.found'].payload,
    (state: FreeIndustryState, payload, context) => {
      const company = foundCompany(
        state.company,
        {
          legalName: payload.legalName,
          presidentName: payload.presidentName,
          startingCapitalCents: BigInt(payload.startingCapitalCents),
        },
        ruleContext(context),
      );
      if (company instanceof Rejection) {
        return company;
      }
      context.record('company.founded', {
        firmId: company.firmId,
        legalName: company.legalName,
        startingCapitalCents: encodeBigInt(company.startingCapitalCents),
      });
      if (!payload.premises) {
        return { ...state, company };
      }
      // Founding and leasing succeed or fail together (ADR-0038).
      const leased = lease(state.realEstate, company, payload.premises, context);
      return leased instanceof Rejection ? leased : { ...state, ...leased };
    },
  ),
  'realEstate.lease': defineCommand(
    COMMANDS['realEstate.lease'].payload,
    (state: FreeIndustryState, payload, context) => {
      if (!state.company) {
        return noCompany();
      }
      const leased = lease(state.realEstate, state.company, payload, context);
      return leased instanceof Rejection ? leased : { ...state, ...leased };
    },
  ),
  'equipment.purchase': defineCommand(
    COMMANDS['equipment.purchase'].payload,
    (state: FreeIndustryState, payload, context) => {
      if (!state.company) {
        return noCompany();
      }
      if (!state.facilities) {
        return noFacilities();
      }
      const bought = purchaseEquipment(
        state.facilities,
        state.company,
        payload,
        ruleContext(context),
      );
      if (bought instanceof Rejection) {
        return bought;
      }
      context.record('equipment.purchased', {
        equipmentTypeId: payload.equipmentTypeId,
        quantity: payload.quantity,
        equipmentIds: bought.equipmentIds,
        invoiceId: bought.invoiceId,
        totalCents: encodeBigInt(bought.totalCents),
      });
      return { ...state, facilities: bought.facilities, company: bought.company };
    },
  ),
  'equipment.install': defineCommand(
    COMMANDS['equipment.install'].payload,
    (state: FreeIndustryState, payload, context) => place(state, payload, false, context),
  ),
  'equipment.move': defineCommand(
    COMMANDS['equipment.move'].payload,
    (state: FreeIndustryState, payload, context) => place(state, payload, true, context),
  ),
  'equipment.uninstall': defineCommand(
    COMMANDS['equipment.uninstall'].payload,
    (state: FreeIndustryState, { equipmentId }, context) => {
      if (!state.company) {
        return noCompany();
      }
      if (!state.facilities || !state.realEstate) {
        return noFacilities();
      }
      const from = state.facilities.equipment.find((item) => item.id === equipmentId)?.placement;
      const facilities = uninstallEquipment(
        state.facilities,
        state.company,
        state.realEstate,
        equipmentId,
      );
      if (facilities instanceof Rejection) {
        return facilities;
      }
      context.record('equipment.uninstalled', {
        equipmentId,
        propertyId: from?.propertyId ?? null,
      });
      return { ...state, facilities };
    },
  ),
  'finance.payInvoice': defineCommand(
    COMMANDS['finance.payInvoice'].payload,
    (state: FreeIndustryState, { invoiceId, amountCents }, context) => {
      if (!state.company) {
        return noCompany();
      }
      const invoice = invoiceOf(state.company, invoiceId);
      if (invoice && invoice.direction !== 'payable') {
        return reject(`Invoice ${invoiceId} is owed to the company; the customer pays it`);
      }
      const paid = recordPayment(
        state.company,
        { invoiceId, amountCents: BigInt(amountCents), initiatedBy: 'player' },
        ruleContext(context),
      );
      if (paid instanceof Rejection) {
        return paid;
      }
      context.record('finance.paymentMade', {
        paymentId: paid.paymentId,
        invoiceId,
        amountCents,
        initiatedBy: 'player',
      });
      return { ...state, company: paid.company };
    },
  ),
  'diagnostics.addTestObligation': defineCommand(
    COMMANDS['diagnostics.addTestObligation'].payload,
    (state: FreeIndustryState, payload, context) => {
      if (!state.company) {
        return noCompany();
      }
      const landlord = ensureCounterparty(
        state.company,
        DIAGNOSTIC_LANDLORD,
        'diagnostic',
        ruleContext(context).allocateId,
      );
      const added = addObligation(
        landlord.company,
        {
          counterpartyId: landlord.counterpartyId,
          purpose: payload.purpose,
          description: payload.purpose === 'rent' ? 'Test rent' : 'Test security deposit',
          amountCents: BigInt(payload.amountCents),
          cadence: payload.cadence,
          firstIssueAtMs: context.nowMs + BigInt(payload.firstBillInDays) * MS_PER_DAY,
          occurrences: payload.occurrences,
          paymentTermsDays: payload.paymentTermsDays,
          standingOrder: payload.standingOrder,
        },
        ruleContext(context),
      );
      if (added instanceof Rejection) {
        return added;
      }
      scheduleNextBill(added.company, added.obligationId, context);
      context.record('finance.obligationAdded', { obligationId: added.obligationId });
      return { ...state, company: added.company };
    },
  ),
  'diagnostics.recordProbe': defineCommand(
    COMMANDS['diagnostics.recordProbe'].payload,
    (state: FreeIndustryState, { label }) => ({
      ...state,
      diagnostics: recordProbe(state.diagnostics, label),
    }),
  ),
  'diagnostics.scheduleProbe': defineCommand(
    COMMANDS['diagnostics.scheduleProbe'].payload,
    (state: FreeIndustryState, { label, delayMs }, context) => {
      const diagnostics = scheduleProbe(state.diagnostics);
      if (diagnostics instanceof Rejection) {
        return diagnostics;
      }
      const probeId = context.allocateId('probe');
      const dueAtMs = context.nowMs + BigInt(delayMs);
      context.schedule({
        type: 'diagnostics.probeDue',
        atMs: dueAtMs,
        payload: { probeId, label, scheduledAtMs: encodeBigInt(context.nowMs) },
      });
      context.record('diagnostics.probeScheduled', { probeId, dueAtMs: encodeBigInt(dueAtMs) });
      return { ...state, diagnostics };
    },
  ),
};

export const FREEINDUSTRY_RULES: SimulationRules<FreeIndustryState> = {
  id: 'freeindustry',
  version: 1,
  initialState: (_context, setup) => ({
    diagnostics: INITIAL_DIAGNOSTICS,
    company: null,
    ...(setup === null ? { realEstate: null, facilities: null } : newWorld(setup)),
  }),
  encodeState: ({ diagnostics, company, realEstate, facilities }) => ({
    diagnostics: {
      ...diagnostics,
      lastFiredProbe: diagnostics.lastFiredProbe && {
        ...diagnostics.lastFiredProbe,
        scheduledAtMs: encodeBigInt(diagnostics.lastFiredProbe.scheduledAtMs),
        firedAtMs: encodeBigInt(diagnostics.lastFiredProbe.firedAtMs),
      },
    },
    // Left out while there is no company, so pre-Step-05 worlds keep their fingerprints.
    ...(company ? { company: encodeCompany(company) } : {}),
    // Left out while absent, so worlds without real estate keep their fingerprints.
    ...(realEstate ? { realEstate: encodeRealEstate(realEstate) } : {}),
    // Left out while absent, so worlds made before Step 08 keep their fingerprints.
    ...(facilities ? { facilities: encodeFacilities(facilities) } : {}),
  }),
  decodeState: (json) => {
    const { diagnostics, company, realEstate, facilities } = stateSchema.parse(json);
    return {
      diagnostics,
      company: company === undefined ? null : decodeCompany(company),
      realEstate: realEstate === undefined ? null : decodeRealEstate(realEstate),
      facilities: facilities === undefined ? null : decodeFacilities(facilities),
    };
  },
  checkInvariants: ({ diagnostics, company, realEstate, facilities }) => [
    ...(diagnostics.pendingProbes > MAX_PENDING_PROBES
      ? [`${diagnostics.pendingProbes} probes pending; at most ${MAX_PENDING_PROBES} allowed`]
      : []),
    ...(company ? companyProblems(company).map((problem) => `company: ${problem}`) : []),
    ...(realEstate
      ? realEstateProblems(realEstate, company).map((problem) => `real estate: ${problem}`)
      : []),
    ...(facilities
      ? facilitiesProblems(facilities, realEstate, company).map(
          (problem) => `facilities: ${problem}`,
        )
      : []),
  ],
  commands,
  events: {
    /**
     * A lease term is over: the company moves out, the property is vacant
     * again and the landlord refunds the deposit (ADR-0038).
     */
    'realEstate.leaseEnds': defineEvent({
      lane: 'economic',
      notable: true,
      payload: leaseEndsPayload,
      handle: (state: FreeIndustryState, { leaseId }, context) => {
        if (!state.realEstate || !state.company) {
          throw new Error(`Lease ${leaseId} ended in a world without property or a company`);
        }
        const propertyId = state.realEstate.leases.find((item) => item.id === leaseId)?.propertyId;
        let facilities = state.facilities;
        if (facilities && propertyId !== undefined) {
          // The dealers take the equipment away before the keys are returned (ADR-0048).
          const cleared = clearPremises(facilities, propertyId);
          facilities = cleared.facilities;
          if (cleared.removed.length > 0) {
            context.record('equipment.removedAtLeaseEnd', {
              leaseId,
              equipmentIds: cleared.removed,
            });
          }
        }
        const ended = endLease(state.realEstate, state.company, leaseId, ruleContext(context));
        context.record('realEstate.leaseEnded', {
          leaseId,
          refundInvoiceId: ended.refundInvoiceId,
        });
        return {
          ...state,
          realEstate: ended.realEstate,
          company: ended.company,
          facilities,
        };
      },
    }),
    /** An obligation occurrence falls: the bill arrives as a payable invoice. */
    'finance.obligationBill': defineEvent({
      lane: 'accounting',
      payload: obligationBillPayload,
      handle: (state: FreeIndustryState, { obligationId, occurrence }, context) => {
        if (!state.company) {
          throw new Error('An obligation bill fell due with no company');
        }
        const { company, invoiceId } = settled(
          invoiceOccurrence(state.company, obligationId, occurrence, {
            ...ruleContext(context),
            epoch: context.epoch,
          }),
          `Billing ${obligationId}`,
        );
        const invoice = invoiceOf(company, invoiceId);
        if (!invoice) {
          throw new Error(`Invoice ${invoiceId} was not created`);
        }
        context.schedule({
          type: 'finance.invoiceDue',
          atMs: invoice.dueAtMs,
          payload: { invoiceId },
        });
        scheduleNextBill(company, obligationId, context);
        context.record('finance.invoiceIssued', {
          invoiceId,
          obligationId,
          occurrence,
          totalCents: encodeBigInt(invoice.totalCents),
          dueAtMs: encodeBigInt(invoice.dueAtMs),
        });
        return { ...state, company };
      },
    }),
    /**
     * A bill reaches its due time. Already settled: nothing to do. Covered by
     * a standing order with the funds available: the bank pays it. Otherwise
     * it becomes overdue — explicitly, with the shortfall recorded.
     */
    'finance.invoiceDue': defineEvent({
      lane: 'accounting',
      notable: true,
      payload: invoiceDuePayload,
      handle: (state: FreeIndustryState, { invoiceId }, context) => {
        const company = state.company;
        const invoice = company ? invoiceOf(company, invoiceId) : undefined;
        if (!company || !invoice) {
          throw new Error(`Invoice ${invoiceId} fell due but does not exist`);
        }
        const outstanding = outstandingOf(invoice);
        if (outstanding === 0n) {
          context.record('finance.invoiceSettledBeforeDue', { invoiceId });
          return state;
        }
        const standingOrder =
          invoice.direction === 'payable' &&
          invoice.obligation !== null &&
          obligationOf(company, invoice.obligation.id).standingOrder;
        if (standingOrder) {
          const paid = recordPayment(
            company,
            { invoiceId, amountCents: outstanding, initiatedBy: 'standing-order' },
            ruleContext(context),
          );
          if (!(paid instanceof Rejection)) {
            context.record('finance.paymentMade', {
              paymentId: paid.paymentId,
              invoiceId,
              amountCents: encodeBigInt(outstanding),
              initiatedBy: 'standing-order',
            });
            return { ...state, company: paid.company };
          }
          if (outstanding <= availableFundsCents(company)) {
            throw new Error(`Standing order for ${invoiceId} failed: ${paid.reason}`);
          }
        }
        context.record('finance.invoiceOverdue', {
          invoiceId,
          direction: invoice.direction,
          outstandingCents: encodeBigInt(outstanding),
          availableCents: encodeBigInt(availableFundsCents(company)),
          standingOrderRefused: standingOrder,
        });
        return { ...state, company: markOverdue(company, invoiceId, context.nowMs) };
      },
    }),
    'diagnostics.probeDue': defineEvent({
      lane: 'diagnostic',
      notable: true,
      payload: probeDuePayload,
      handle: (state: FreeIndustryState, { probeId, label, scheduledAtMs }, context) => {
        const token = context.random('diagnostics').nextUint32();
        context.record('diagnostics.probeFired', { probeId, token });
        return {
          ...state,
          diagnostics: probeFired(state.diagnostics, {
            probeId,
            label,
            token,
            scheduledAtMs,
            firedAtMs: context.nowMs,
          }),
        };
      },
    }),
  },
  periodic: {},
};
