import { isPositiveAmount, type Cents } from '../shared/money';
import {
  type Company,
  type Obligation,
  type ObligationCadence,
  type ObligationPurpose,
  type RuleContext,
} from './company';
import type { EntityId } from './ids';
import { issueInvoice } from './invoicing';
import { ACCOUNT, type AccountCode } from './ledger';
import { reject, type Rejection } from './rejection';
import { addCalendarMonths, isoDateAt, MS_PER_DAY, type CivilDate, type SimTimeMs } from './time';

/**
 * Recurring and one-off payment obligations: rent and security deposits
 * (plan Step 05, DECISIONS ADR-0032). The schedule is calendar based: a
 * monthly obligation recurs on the same day of the month (clamped to the
 * month's length) at the same time of day. Each occurrence is invoiced once,
 * in order, at its issue time; there is no midnight batch and no catching up
 * of several months at once (spec §9.1).
 */

const MAX_OCCURRENCES = 120;
const MAX_PAYMENT_TERMS_DAYS = 90;

/** What each obligation purpose is booked to. A deposit is an asset (it is refundable); rent is an expense. */
const PURPOSE_ACCOUNT: Readonly<Record<ObligationPurpose, AccountCode>> = {
  rent: ACCOUNT.rent,
  'security-deposit': ACCOUNT.depositsPaid,
};

export interface ObligationDraft {
  readonly counterpartyId: EntityId<'party'>;
  readonly purpose: ObligationPurpose;
  readonly description: string;
  readonly amountCents: Cents;
  readonly cadence: ObligationCadence;
  readonly firstIssueAtMs: SimTimeMs;
  readonly occurrences: number;
  readonly paymentTermsDays: number;
  readonly standingOrder: boolean;
}

export function addObligation(
  company: Company,
  draft: ObligationDraft,
  context: RuleContext,
): { company: Company; obligationId: EntityId<'obligation'> } | Rejection {
  if (!isPositiveAmount(draft.amountCents)) {
    return reject('An obligation must be for a positive amount');
  }
  if (!Number.isInteger(draft.occurrences) || draft.occurrences < 1) {
    return reject('An obligation needs at least one occurrence');
  }
  if (draft.occurrences > MAX_OCCURRENCES) {
    return reject(`An obligation can have at most ${MAX_OCCURRENCES} occurrences`);
  }
  if (draft.cadence === 'once' && draft.occurrences !== 1) {
    return reject('A one-off obligation has exactly one occurrence');
  }
  if (
    !Number.isInteger(draft.paymentTermsDays) ||
    draft.paymentTermsDays < 0 ||
    draft.paymentTermsDays > MAX_PAYMENT_TERMS_DAYS
  ) {
    return reject(`Payment terms must be 0–${MAX_PAYMENT_TERMS_DAYS} days`);
  }
  if (draft.firstIssueAtMs < context.nowMs) {
    return reject('An obligation cannot start in the past');
  }
  if (!company.counterparties.some((party) => party.id === draft.counterpartyId)) {
    throw new Error(`Unknown counterparty ${draft.counterpartyId}`);
  }
  const obligationId = context.allocateId('obligation');
  const obligation: Obligation = { id: obligationId, ...draft, issued: 0 };
  return {
    company: { ...company, obligations: [...company.obligations, obligation] },
    obligationId,
  };
}

/** Issue time of occurrence `occurrence` (1-based). */
export function issueTimeOf(
  obligation: Obligation,
  occurrence: number,
  epoch: CivilDate,
): SimTimeMs {
  if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > obligation.occurrences) {
    throw new RangeError(`${obligation.id} has no occurrence ${occurrence}`);
  }
  return obligation.cadence === 'once'
    ? obligation.firstIssueAtMs
    : addCalendarMonths(epoch, obligation.firstIssueAtMs, occurrence - 1);
}

/** Issue time of the next occurrence still to be invoiced, or null when all are. */
export function nextIssueTimeOf(obligation: Obligation, epoch: CivilDate): SimTimeMs | null {
  return obligation.issued < obligation.occurrences
    ? issueTimeOf(obligation, obligation.issued + 1, epoch)
    : null;
}

export function obligationOf(company: Company, id: string): Obligation {
  const obligation = company.obligations.find((candidate) => candidate.id === id);
  if (!obligation) {
    throw new Error(`Unknown obligation ${id}`);
  }
  return obligation;
}

/**
 * Invoice occurrence `occurrence` of an obligation, now. Throws unless it is
 * exactly the next occurrence and its issue time is now: occurrences are
 * invoiced once each, in order, on time.
 */
export function invoiceOccurrence(
  company: Company,
  obligationId: string,
  occurrence: number,
  context: RuleContext & { readonly epoch: CivilDate },
): { company: Company; invoiceId: EntityId<'invoice'> } | Rejection {
  const obligation = obligationOf(company, obligationId);
  if (occurrence !== obligation.issued + 1) {
    throw new Error(
      `${obligation.id} occurrence ${occurrence} is out of turn (${obligation.issued} issued)`,
    );
  }
  const issueAt = issueTimeOf(obligation, occurrence, context.epoch);
  if (issueAt !== context.nowMs) {
    throw new Error(`${obligation.id} occurrence ${occurrence} is due at ${issueAt}, not now`);
  }
  const period =
    obligation.cadence === 'monthly'
      ? ` (${occurrence} of ${obligation.occurrences}, from ${isoDateAt(context.epoch, issueAt)})`
      : '';
  const issued = issueInvoice(
    {
      ...company,
      obligations: company.obligations.map((candidate) =>
        candidate.id === obligation.id ? { ...candidate, issued: occurrence } : candidate,
      ),
    },
    {
      direction: 'payable',
      counterpartyId: obligation.counterpartyId,
      description: `${obligation.description}${period}`.slice(0, 120),
      lines: [
        {
          account: PURPOSE_ACCOUNT[obligation.purpose],
          description: obligation.description,
          amountCents: obligation.amountCents,
        },
      ],
      dueAtMs: issueAt + BigInt(obligation.paymentTermsDays) * MS_PER_DAY,
      obligation: { id: obligation.id, occurrence },
    },
    context,
  );
  return issued;
}
