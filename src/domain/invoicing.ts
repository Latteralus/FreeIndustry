import { formatUsd, isPositiveAmount, MAX_AMOUNT_CENTS, type Cents } from '../shared/money';
import {
  counterpartyOf,
  type Company,
  type Invoice,
  type InvoiceDirection,
  type InvoiceLine,
  type PaymentInitiator,
  type RuleContext,
} from './company';
import type { EntityId } from './ids';
import {
  ACCOUNT,
  balanceOf,
  CONTROL_ACCOUNTS,
  credit,
  debit,
  MAX_DESCRIPTION_LENGTH,
  postEntry,
  type LedgerLine,
} from './ledger';
import { reject, Rejection } from './rejection';
import type { SimTimeMs } from './time';

/**
 * Invoices and payments: receivables and payables (spec §8.1, §5.5;
 * DECISIONS ADR-0031).
 *
 * Issuing a payable posts Dr expense/asset lines, Cr Accounts payable.
 * Issuing a receivable posts Dr Accounts receivable, Cr revenue lines.
 * Paying a payable posts Dr Accounts payable, Cr Cash; collecting a
 * receivable posts Dr Cash, Cr Accounts receivable. A payment settles at most
 * what is still outstanding, and an outgoing payment needs the funds to be
 * available now. No document is ever posted twice: each ledger entry's
 * source key is the invoice or payment ID.
 */

export interface InvoiceDraft {
  readonly direction: InvoiceDirection;
  readonly counterpartyId: EntityId<'party'>;
  readonly description: string;
  readonly lines: readonly InvoiceLine[];
  readonly dueAtMs: SimTimeMs;
  readonly obligation: Invoice['obligation'];
}

export function outstandingOf(invoice: Invoice): Cents {
  return invoice.totalCents - invoice.paidCents;
}

/** Funds the company can spend now: its cash, plus undrawn credit (none until Step 25). */
export function availableFundsCents(company: Company): Cents {
  return balanceOf(company.ledger, ACCOUNT.cash);
}

export function invoiceOf(company: Company, id: string): Invoice | undefined {
  return company.invoices.find((invoice) => invoice.id === id);
}

/** Raise an invoice and recognise it in the ledger. Throws for a malformed draft. */
export function issueInvoice(
  company: Company,
  draft: InvoiceDraft,
  context: RuleContext,
): { company: Company; invoiceId: EntityId<'invoice'> } | Rejection {
  counterpartyOf(company, draft.counterpartyId);
  if (draft.description.length < 1 || draft.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Invoice description must be 1–${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (draft.lines.length < 1) {
    throw new Error('An invoice needs at least one line');
  }
  if (draft.dueAtMs < context.nowMs) {
    throw new Error('An invoice cannot fall due before it is issued');
  }
  let totalCents = 0n;
  for (const line of draft.lines) {
    if (!isPositiveAmount(line.amountCents)) {
      throw new Error(`Invoice line amount ${line.amountCents} is not a positive amount`);
    }
    if (CONTROL_ACCOUNTS.includes(line.account)) {
      throw new Error(`An invoice line cannot post to control account ${line.account}`);
    }
    totalCents += line.amountCents;
  }
  if (totalCents > MAX_AMOUNT_CENTS) {
    return reject(`An invoice can total at most ${formatUsd(MAX_AMOUNT_CENTS)}`);
  }
  const invoiceId = context.allocateId('invoice');
  const entryId = context.allocateId('entry');
  const payable = draft.direction === 'payable';
  const lines: LedgerLine[] = payable
    ? [
        ...draft.lines.map((line) => debit(line.account, line.amountCents)),
        credit(ACCOUNT.payables, totalCents),
      ]
    : [
        debit(ACCOUNT.receivables, totalCents),
        ...draft.lines.map((line) => credit(line.account, line.amountCents)),
      ];
  const ledger = postEntry(company.ledger, {
    id: entryId,
    atMs: context.nowMs,
    description: draft.description,
    sourceKey: invoiceId,
    counterpartyId: draft.counterpartyId,
    lines,
  });
  if (ledger instanceof Rejection) {
    return ledger;
  }
  const invoice: Invoice = {
    id: invoiceId,
    direction: draft.direction,
    counterpartyId: draft.counterpartyId,
    description: draft.description,
    lines: draft.lines,
    totalCents,
    paidCents: 0n,
    issuedAtMs: context.nowMs,
    dueAtMs: draft.dueAtMs,
    overdueSinceMs: null,
    obligation: draft.obligation,
    entryId,
  };
  return { company: { ...company, ledger, invoices: [...company.invoices, invoice] }, invoiceId };
}

/**
 * Settle `amountCents` of an invoice: the company pays a payable, or receives
 * payment of a receivable. Refused (never partially applied) when the invoice
 * is unknown or already settled, the amount exceeds what is outstanding, or,
 * for an outgoing payment, the funds are not available.
 */
export function recordPayment(
  company: Company,
  request: {
    readonly invoiceId: string;
    readonly amountCents: Cents;
    readonly initiatedBy: PaymentInitiator;
  },
  context: RuleContext,
): { company: Company; paymentId: EntityId<'payment'> } | Rejection {
  const invoice = invoiceOf(company, request.invoiceId);
  if (!invoice) {
    return reject(`There is no invoice ${request.invoiceId}`, { invoiceId: request.invoiceId });
  }
  const outstanding = outstandingOf(invoice);
  if (outstanding === 0n) {
    return reject(`Invoice ${invoice.id} is already settled`, { invoiceId: invoice.id });
  }
  if (!isPositiveAmount(request.amountCents)) {
    return reject('A payment must be a positive amount');
  }
  if (request.amountCents > outstanding) {
    return reject(
      `Invoice ${invoice.id} has ${formatUsd(outstanding)} outstanding; ${formatUsd(request.amountCents)} is more than that`,
      { outstandingCents: outstanding.toString() },
    );
  }
  const outgoing = invoice.direction === 'payable';
  if ((request.initiatedBy === 'counterparty') === outgoing) {
    throw new Error(`A ${request.initiatedBy} payment cannot settle a ${invoice.direction}`);
  }
  if (outgoing) {
    const available = availableFundsCents(company);
    if (request.amountCents > available) {
      return reject(
        `Insufficient funds: ${formatUsd(available)} available, ${formatUsd(request.amountCents)} needed`,
        {
          availableCents: available.toString(),
          requiredCents: request.amountCents.toString(),
        },
      );
    }
  }
  const party = counterpartyOf(company, invoice.counterpartyId);
  const paymentId = context.allocateId('payment');
  const entryId = context.allocateId('entry');
  const ledger = postEntry(company.ledger, {
    id: entryId,
    atMs: context.nowMs,
    description: outgoing
      ? `Payment to ${party.name}: ${invoice.description}`.slice(0, MAX_DESCRIPTION_LENGTH)
      : `Receipt from ${party.name}: ${invoice.description}`.slice(0, MAX_DESCRIPTION_LENGTH),
    sourceKey: paymentId,
    counterpartyId: invoice.counterpartyId,
    lines: outgoing
      ? [debit(ACCOUNT.payables, request.amountCents), credit(ACCOUNT.cash, request.amountCents)]
      : [
          debit(ACCOUNT.cash, request.amountCents),
          credit(ACCOUNT.receivables, request.amountCents),
        ],
  });
  if (ledger instanceof Rejection) {
    return ledger;
  }
  return {
    company: {
      ...company,
      ledger,
      invoices: company.invoices.map((candidate) =>
        candidate.id === invoice.id
          ? { ...candidate, paidCents: candidate.paidCents + request.amountCents }
          : candidate,
      ),
      payments: [
        ...company.payments,
        {
          id: paymentId,
          direction: outgoing ? 'outgoing' : 'incoming',
          counterpartyId: invoice.counterpartyId,
          invoiceId: invoice.id,
          atMs: context.nowMs,
          amountCents: request.amountCents,
          initiatedBy: request.initiatedBy,
          entryId,
        },
      ],
    },
    paymentId,
  };
}

/** Record that an invoice was still unpaid at its due time. */
export function markOverdue(company: Company, invoiceId: string, nowMs: SimTimeMs): Company {
  const invoice = invoiceOf(company, invoiceId);
  if (!invoice || outstandingOf(invoice) === 0n || invoice.overdueSinceMs !== null) {
    throw new Error(`Invoice ${invoiceId} cannot become overdue`);
  }
  if (nowMs < invoice.dueAtMs) {
    throw new Error(`Invoice ${invoiceId} is not due until ${invoice.dueAtMs}`);
  }
  return {
    ...company,
    invoices: company.invoices.map((candidate) =>
      candidate.id === invoiceId ? { ...candidate, overdueSinceMs: nowMs } : candidate,
    ),
  };
}

export interface Liquidity {
  readonly cashCents: Cents;
  /** Undrawn credit; always zero until banking (Step 25). */
  readonly creditAvailableCents: Cents;
  readonly availableCents: Cents;
  readonly payablesOpenCents: Cents;
  readonly payablesOverdueCents: Cents;
  readonly receivablesOpenCents: Cents;
  readonly receivablesOverdueCents: Cents;
  /** Overdue bills the available funds cannot cover. */
  readonly overdueShortfallCents: Cents;
}

/**
 * The company's short-term position, from its books. A positive shortfall
 * means it cannot pay bills that are already overdue: the explicit
 * insolvency signal of Step 05 (consequences such as default arrive with
 * credit in Step 25).
 */
export function liquidityOf(company: Company): Liquidity {
  const cashCents = availableFundsCents(company);
  let payablesOpenCents = 0n;
  let payablesOverdueCents = 0n;
  let receivablesOpenCents = 0n;
  let receivablesOverdueCents = 0n;
  for (const invoice of company.invoices) {
    const outstanding = outstandingOf(invoice);
    const overdue = invoice.overdueSinceMs !== null ? outstanding : 0n;
    if (invoice.direction === 'payable') {
      payablesOpenCents += outstanding;
      payablesOverdueCents += overdue;
    } else {
      receivablesOpenCents += outstanding;
      receivablesOverdueCents += overdue;
    }
  }
  const shortfall = payablesOverdueCents - cashCents;
  return {
    cashCents,
    creditAvailableCents: 0n,
    availableCents: cashCents,
    payablesOpenCents,
    payablesOverdueCents,
    receivablesOpenCents,
    receivablesOverdueCents,
    overdueShortfallCents: shortfall > 0n ? shortfall : 0n,
  };
}
