import { formatUsd, type Cents } from '../shared/money';
import type { AllocateId, EntityId } from './ids';
import {
  ACCOUNT,
  credit,
  debit,
  openLedger,
  postEntry,
  STANDARD_CHART,
  type Ledger,
} from './ledger';
import { reject, Rejection } from './rejection';
import type { SimTimeMs } from './time';

/**
 * The player's company (plan Step 05, spec §3.1 step 5, DECISIONS ADR-0031):
 * its identity, its president, how it was financed, its books, and the
 * commercial documents that move money — invoices, payments and recurring
 * obligations such as rent.
 *
 * A world has no company until the player founds one; the company then
 * starts with only the cash its owner put in. Every later change to its money
 * is a balanced ledger entry caused by a recorded business event.
 */

export const COUNTERPARTY_KINDS = [
  'owner',
  'landlord',
  'supplier',
  'customer',
  'diagnostic',
] as const;

export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

/** Someone the company does business with. The owner is one too: they provide the capital. */
export interface Counterparty {
  readonly id: EntityId<'party'>;
  readonly name: string;
  readonly kind: CounterpartyKind;
  /** The person behind an `owner` counterparty. */
  readonly personId: EntityId<'person'> | null;
}

export interface InvoiceLine {
  readonly account: string;
  readonly description: string;
  readonly amountCents: Cents;
}

export type InvoiceDirection = 'payable' | 'receivable';

/**
 * A bill the company owes (`payable`) or is owed (`receivable`). Issuing it
 * recognises the expense, asset or revenue and the payable or receivable;
 * payments settle it later. Revenue recognition and cash timing are separate
 * (spec §8.1).
 */
export interface Invoice {
  readonly id: EntityId<'invoice'>;
  readonly direction: InvoiceDirection;
  readonly counterpartyId: EntityId<'party'>;
  readonly description: string;
  readonly lines: readonly InvoiceLine[];
  readonly totalCents: Cents;
  readonly paidCents: Cents;
  readonly issuedAtMs: SimTimeMs;
  readonly dueAtMs: SimTimeMs;
  /** When it was found unpaid at its due time; kept as history after payment. */
  readonly overdueSinceMs: SimTimeMs | null;
  /** The obligation occurrence (1-based) that raised it, if any. */
  readonly obligation: {
    readonly id: EntityId<'obligation'>;
    readonly occurrence: number;
  } | null;
  /** The ledger entry that recognised it. */
  readonly entryId: EntityId<'entry'>;
}

type PaymentDirection = 'outgoing' | 'incoming';
export type PaymentInitiator = 'player' | 'standing-order' | 'counterparty';

/** Money that actually moved, settling (part of) one invoice. */
export interface Payment {
  readonly id: EntityId<'payment'>;
  readonly direction: PaymentDirection;
  readonly counterpartyId: EntityId<'party'>;
  readonly invoiceId: EntityId<'invoice'>;
  readonly atMs: SimTimeMs;
  readonly amountCents: Cents;
  readonly initiatedBy: PaymentInitiator;
  readonly entryId: EntityId<'entry'>;
}

export type ObligationPurpose = 'rent' | 'security-deposit';
export type ObligationCadence = 'once' | 'monthly';

/**
 * A commitment to pay a counterparty on a schedule: rent each month, a
 * security deposit once. Each occurrence raises a payable invoice at its
 * issue time, due `paymentTermsDays` later. With a standing order the bank
 * pays it on the due date if the funds are there; otherwise it becomes
 * overdue. Leases (Step 07) create these; until then only the labelled
 * development diagnostics do.
 */
export interface Obligation {
  readonly id: EntityId<'obligation'>;
  readonly counterpartyId: EntityId<'party'>;
  readonly purpose: ObligationPurpose;
  readonly description: string;
  readonly amountCents: Cents;
  readonly cadence: ObligationCadence;
  readonly firstIssueAtMs: SimTimeMs;
  /** Total occurrences; 1 for `once`. */
  readonly occurrences: number;
  /** Occurrences already invoiced. */
  readonly issued: number;
  readonly paymentTermsDays: number;
  readonly standingOrder: boolean;
}

type Financing = 'owner-funds';

export interface Company {
  readonly firmId: EntityId<'firm'>;
  readonly legalName: string;
  readonly president: { readonly personId: EntityId<'person'>; readonly name: string };
  /** The president as the counterparty who contributed the capital. */
  readonly ownerPartyId: EntityId<'party'>;
  readonly foundedAtMs: SimTimeMs;
  readonly financing: Financing;
  readonly startingCapitalCents: Cents;
  readonly counterparties: readonly Counterparty[];
  readonly ledger: Ledger;
  readonly invoices: readonly Invoice[];
  readonly payments: readonly Payment[];
  readonly obligations: readonly Obligation[];
}

/**
 * Bounds on the owner's founding capital: from a small cash-backed garage
 * operation to a large factory start. FreeIndustry values (provisional until
 * New Company and scenarios, Steps 07 and 31), not original-game amounts.
 * Loans and outside investors arrive with banking (Step 25).
 */
export const MIN_STARTING_CAPITAL_CENTS: Cents = 100_000n; // $1,000.00
export const MAX_STARTING_CAPITAL_CENTS: Cents = 10_000_000_000n; // $100,000,000.00

const MAX_NAME_LENGTH = 60;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** A trimmed, non-blank display name without control characters, or a rejection. */
function cleanName(raw: string, what: string): string | Rejection {
  const name = raw.trim();
  if (name.length === 0) {
    return reject(`${what} cannot be blank`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    return reject(`${what} can be at most ${MAX_NAME_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(name)) {
    return reject(`${what} cannot contain control characters`);
  }
  return name;
}

export interface FoundingInput {
  readonly legalName: string;
  readonly presidentName: string;
  readonly startingCapitalCents: Cents;
}

export interface RuleContext {
  readonly nowMs: SimTimeMs;
  readonly allocateId: AllocateId;
}

/**
 * Found the company: register it and its president, open the standard chart
 * of accounts, and post the owner's capital into the bank (Dr Cash, Cr
 * Owner's capital). Nothing else exists yet: no property, people or stock.
 */
export function foundCompany(
  existing: Company | null,
  input: FoundingInput,
  context: RuleContext,
): Company | Rejection {
  if (existing) {
    return reject(`${existing.legalName} has already been founded in this world`);
  }
  const legalName = cleanName(input.legalName, 'Company name');
  if (legalName instanceof Rejection) {
    return legalName;
  }
  const presidentName = cleanName(input.presidentName, "President's name");
  if (presidentName instanceof Rejection) {
    return presidentName;
  }
  const capital = input.startingCapitalCents;
  if (capital < MIN_STARTING_CAPITAL_CENTS || capital > MAX_STARTING_CAPITAL_CENTS) {
    return reject(
      `Starting capital must be between ${formatUsd(MIN_STARTING_CAPITAL_CENTS)} and ${formatUsd(MAX_STARTING_CAPITAL_CENTS)}`,
      { startingCapitalCents: capital.toString() },
    );
  }
  const firmId = context.allocateId('firm');
  const personId = context.allocateId('person');
  const ownerPartyId = context.allocateId('party');
  const ledger = postEntry(openLedger(STANDARD_CHART), {
    id: context.allocateId('entry'),
    atMs: context.nowMs,
    description: `Opening capital from ${presidentName}`,
    sourceKey: `${firmId}/opening-capital`,
    counterpartyId: ownerPartyId,
    lines: [debit(ACCOUNT.cash, capital), credit(ACCOUNT.ownerCapital, capital)],
  });
  if (ledger instanceof Rejection) {
    return ledger;
  }
  return {
    firmId,
    legalName,
    president: { personId, name: presidentName },
    ownerPartyId,
    foundedAtMs: context.nowMs,
    financing: 'owner-funds',
    startingCapitalCents: capital,
    counterparties: [{ id: ownerPartyId, name: presidentName, kind: 'owner', personId }],
    ledger,
    invoices: [],
    payments: [],
    obligations: [],
  };
}

/** The counterparty `name` of `kind`, registering it if the company has not dealt with it before. */
export function ensureCounterparty(
  company: Company,
  name: string,
  kind: Exclude<CounterpartyKind, 'owner'>,
  allocateId: AllocateId,
): { company: Company; counterpartyId: EntityId<'party'> } {
  const known = company.counterparties.find((party) => party.name === name && party.kind === kind);
  if (known) {
    return { company, counterpartyId: known.id };
  }
  const id = allocateId('party');
  return {
    company: {
      ...company,
      counterparties: [...company.counterparties, { id, name, kind, personId: null }],
    },
    counterpartyId: id,
  };
}

export function counterpartyOf(company: Company, id: EntityId<'party'>): Counterparty {
  const party = company.counterparties.find((candidate) => candidate.id === id);
  if (!party) {
    throw new Error(`Unknown counterparty ${id}`);
  }
  return party;
}
