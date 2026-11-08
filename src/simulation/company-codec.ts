import { z } from 'zod';
import { bigIntString, encodeBigInt } from '../shared/bigint-codec';
import type { JsonValue } from '../shared/canonical-json';
import { COUNTERPARTY_KINDS, type Company } from '../domain/company';
import { isEntityIdOf, type EntityId } from '../domain/ids';
import { ACCOUNT_TYPES } from '../domain/ledger';

/**
 * Plain-JSON encoding of the company slice: the fingerprint input and the
 * checkpoint format (ADR-0022). Every bigint is a canonical decimal string;
 * every list keeps its domain order. Decoding validates shapes and ID kinds;
 * the business invariants are checked separately (`companyProblems`).
 */

function idOf<K extends string>(kind: K) {
  return z
    .string()
    .refine((id): id is EntityId<K> => isEntityIdOf(kind, id), `Expected a ${kind} ID`);
}

const accountCode = z.string().regex(/^[0-9]{4}$/);

const companySchema = z.strictObject({
  firmId: idOf('firm'),
  legalName: z.string(),
  president: z.strictObject({ personId: idOf('person'), name: z.string() }),
  ownerPartyId: idOf('party'),
  foundedAtMs: bigIntString,
  financing: z.literal('owner-funds'),
  startingCapitalCents: bigIntString,
  counterparties: z.array(
    z.strictObject({
      id: idOf('party'),
      name: z.string(),
      kind: z.enum(COUNTERPARTY_KINDS),
      personId: idOf('person').nullable(),
    }),
  ),
  ledger: z.strictObject({
    accounts: z.array(
      z.strictObject({
        code: accountCode,
        name: z.string(),
        type: z.enum(ACCOUNT_TYPES),
        balanceCents: bigIntString,
      }),
    ),
    entries: z.array(
      z.strictObject({
        id: idOf('entry'),
        atMs: bigIntString,
        description: z.string(),
        sourceKey: z.string(),
        counterpartyId: idOf('party').nullable(),
        lines: z.array(
          z.strictObject({
            account: accountCode,
            debitCents: bigIntString,
            creditCents: bigIntString,
          }),
        ),
      }),
    ),
  }),
  invoices: z.array(
    z.strictObject({
      id: idOf('invoice'),
      direction: z.enum(['payable', 'receivable']),
      counterpartyId: idOf('party'),
      description: z.string(),
      lines: z.array(
        z.strictObject({
          account: accountCode,
          description: z.string(),
          amountCents: bigIntString,
        }),
      ),
      totalCents: bigIntString,
      paidCents: bigIntString,
      issuedAtMs: bigIntString,
      dueAtMs: bigIntString,
      overdueSinceMs: bigIntString.nullable(),
      obligation: z.strictObject({ id: idOf('obligation'), occurrence: z.int().min(1) }).nullable(),
      entryId: idOf('entry'),
    }),
  ),
  payments: z.array(
    z.strictObject({
      id: idOf('payment'),
      direction: z.enum(['outgoing', 'incoming']),
      counterpartyId: idOf('party'),
      invoiceId: idOf('invoice'),
      atMs: bigIntString,
      amountCents: bigIntString,
      initiatedBy: z.enum(['player', 'standing-order', 'counterparty']),
      entryId: idOf('entry'),
    }),
  ),
  obligations: z.array(
    z.strictObject({
      id: idOf('obligation'),
      counterpartyId: idOf('party'),
      purpose: z.enum(['rent', 'security-deposit']),
      description: z.string(),
      amountCents: bigIntString,
      cadence: z.enum(['once', 'monthly']),
      firstIssueAtMs: bigIntString,
      occurrences: z.int().min(1),
      issued: z.int().min(0),
      paymentTermsDays: z.int().min(0),
      standingOrder: z.boolean(),
    }),
  ),
});

export function decodeCompany(json: unknown): Company {
  return companySchema.parse(json);
}

const big = encodeBigInt;
const nullableBig = (value: bigint | null) => (value === null ? null : big(value));

export function encodeCompany(company: Company): JsonValue {
  return {
    firmId: company.firmId,
    legalName: company.legalName,
    president: { personId: company.president.personId, name: company.president.name },
    ownerPartyId: company.ownerPartyId,
    foundedAtMs: big(company.foundedAtMs),
    financing: company.financing,
    startingCapitalCents: big(company.startingCapitalCents),
    counterparties: company.counterparties.map((party) => ({
      id: party.id,
      name: party.name,
      kind: party.kind,
      personId: party.personId,
    })),
    ledger: {
      accounts: company.ledger.accounts.map((account) => ({
        code: account.code,
        name: account.name,
        type: account.type,
        balanceCents: big(account.balanceCents),
      })),
      entries: company.ledger.entries.map((entry) => ({
        id: entry.id,
        atMs: big(entry.atMs),
        description: entry.description,
        sourceKey: entry.sourceKey,
        counterpartyId: entry.counterpartyId,
        lines: entry.lines.map((line) => ({
          account: line.account,
          debitCents: big(line.debitCents),
          creditCents: big(line.creditCents),
        })),
      })),
    },
    invoices: company.invoices.map((invoice) => ({
      id: invoice.id,
      direction: invoice.direction,
      counterpartyId: invoice.counterpartyId,
      description: invoice.description,
      lines: invoice.lines.map((line) => ({
        account: line.account,
        description: line.description,
        amountCents: big(line.amountCents),
      })),
      totalCents: big(invoice.totalCents),
      paidCents: big(invoice.paidCents),
      issuedAtMs: big(invoice.issuedAtMs),
      dueAtMs: big(invoice.dueAtMs),
      overdueSinceMs: nullableBig(invoice.overdueSinceMs),
      obligation: invoice.obligation && {
        id: invoice.obligation.id,
        occurrence: invoice.obligation.occurrence,
      },
      entryId: invoice.entryId,
    })),
    payments: company.payments.map((payment) => ({
      id: payment.id,
      direction: payment.direction,
      counterpartyId: payment.counterpartyId,
      invoiceId: payment.invoiceId,
      atMs: big(payment.atMs),
      amountCents: big(payment.amountCents),
      initiatedBy: payment.initiatedBy,
      entryId: payment.entryId,
    })),
    obligations: company.obligations.map((obligation) => ({
      id: obligation.id,
      counterpartyId: obligation.counterpartyId,
      purpose: obligation.purpose,
      description: obligation.description,
      amountCents: big(obligation.amountCents),
      cadence: obligation.cadence,
      firstIssueAtMs: big(obligation.firstIssueAtMs),
      occurrences: obligation.occurrences,
      issued: obligation.issued,
      paymentTermsDays: obligation.paymentTermsDays,
      standingOrder: obligation.standingOrder,
    })),
  };
}
