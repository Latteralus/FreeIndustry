import { z } from 'zod';
import { nonNegativeCentsString, signedCentsString } from '../money';
import { simTimeString } from './primitives';

/**
 * Company and account-inspection read model (plan Step 05, ADR-0034). Built
 * by the worker from the authoritative books; the renderer only displays it.
 * Money is whole cents as decimal strings; balances are debit-positive.
 * Dates are the world calendar ("1996-02-01").
 *
 * This is the internal inspection view that validates the ledger before the
 * polished reports of Step 18; lists are bounded so a snapshot stays small.
 */

/** Most recent ledger entries included in a snapshot. */
export const RECENT_ENTRY_LIMIT = 25;
/** Most recent settled invoices included (every open invoice is always included). */
export const SETTLED_INVOICE_LIMIT = 10;

const isoDate = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
const entityId = z.string().max(40);
const name = z.string().max(60);
const text = z.string().max(120);

export const companyViewSchema = z.strictObject({
  firmId: entityId,
  legalName: name,
  president: z.strictObject({ personId: entityId, name }),
  foundedOn: isoDate,
  financing: z.literal('owner-funds'),
  startingCapitalCents: nonNegativeCentsString,
  liquidity: z.strictObject({
    cashCents: nonNegativeCentsString,
    creditAvailableCents: nonNegativeCentsString,
    availableCents: nonNegativeCentsString,
    payablesOpenCents: nonNegativeCentsString,
    payablesOverdueCents: nonNegativeCentsString,
    receivablesOpenCents: nonNegativeCentsString,
    receivablesOverdueCents: nonNegativeCentsString,
    overdueShortfallCents: nonNegativeCentsString,
  }),
  accounts: z
    .array(
      z.strictObject({
        code: z.string().regex(/^[0-9]{4}$/),
        name,
        type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
        balanceCents: signedCentsString,
      }),
    )
    .max(200),
  trialBalance: z.strictObject({
    debitsCents: nonNegativeCentsString,
    creditsCents: nonNegativeCentsString,
    balanced: z.boolean(),
  }),
  entries: z.strictObject({
    total: z.int().min(0),
    recent: z
      .array(
        z.strictObject({
          id: entityId,
          postedOn: isoDate,
          atMs: simTimeString,
          description: text,
          sourceKey: z.string().max(80),
          counterparty: name.nullable(),
          lines: z
            .array(
              z.strictObject({
                account: z.string().regex(/^[0-9]{4}$/),
                debitCents: nonNegativeCentsString,
                creditCents: nonNegativeCentsString,
              }),
            )
            .min(2)
            .max(50),
        }),
      )
      .max(RECENT_ENTRY_LIMIT),
  }),
  invoices: z
    .array(
      z.strictObject({
        id: entityId,
        direction: z.enum(['payable', 'receivable']),
        counterparty: name,
        description: text,
        totalCents: nonNegativeCentsString,
        paidCents: nonNegativeCentsString,
        outstandingCents: nonNegativeCentsString,
        issuedOn: isoDate,
        dueOn: isoDate,
        status: z.enum(['open', 'overdue', 'settled']),
      }),
    )
    .max(2000),
  obligations: z
    .array(
      z.strictObject({
        id: entityId,
        counterparty: name,
        purpose: z.enum(['rent', 'security-deposit']),
        description: text,
        amountCents: nonNegativeCentsString,
        cadence: z.enum(['once', 'monthly']),
        occurrences: z.int().min(1),
        issued: z.int().min(0),
        nextBillOn: isoDate.nullable(),
        paymentTermsDays: z.int().min(0),
        standingOrder: z.boolean(),
      }),
    )
    .max(200),
});

export type CompanyView = z.infer<typeof companyViewSchema>;
