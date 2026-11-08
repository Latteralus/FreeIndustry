import { encodeBigInt } from '../shared/bigint-codec';
import { RECENT_ENTRY_LIMIT, SETTLED_INVOICE_LIMIT, type CompanyView } from '../shared/ipc/company';
import { counterpartyOf, type Company } from '../domain/company';
import { liquidityOf, outstandingOf } from '../domain/invoicing';
import { trialBalance } from '../domain/ledger';
import { nextIssueTimeOf } from '../domain/obligations';
import { isoDateAt, type CivilDate, type SimTimeMs } from '../domain/time';

/**
 * Builds the company / account-inspection read model (ADR-0034) from the
 * authoritative books. Read only: it derives nothing the books do not hold.
 */
export function companyView(company: Company, epoch: CivilDate): CompanyView {
  const big = encodeBigInt;
  const date = (time: SimTimeMs) => isoDateAt(epoch, time);
  const partyName = (id: Company['ownerPartyId']) => counterpartyOf(company, id).name;
  const liquidity = liquidityOf(company);
  const totals = trialBalance(company.ledger);
  const entries = company.ledger.entries;
  const open = company.invoices.filter((invoice) => outstandingOf(invoice) > 0n);
  const settled = company.invoices
    .filter((invoice) => outstandingOf(invoice) === 0n)
    .slice(-SETTLED_INVOICE_LIMIT);
  return {
    firmId: company.firmId,
    legalName: company.legalName,
    president: { personId: company.president.personId, name: company.president.name },
    foundedOn: date(company.foundedAtMs),
    financing: company.financing,
    startingCapitalCents: big(company.startingCapitalCents),
    liquidity: {
      cashCents: big(liquidity.cashCents),
      creditAvailableCents: big(liquidity.creditAvailableCents),
      availableCents: big(liquidity.availableCents),
      payablesOpenCents: big(liquidity.payablesOpenCents),
      payablesOverdueCents: big(liquidity.payablesOverdueCents),
      receivablesOpenCents: big(liquidity.receivablesOpenCents),
      receivablesOverdueCents: big(liquidity.receivablesOverdueCents),
      overdueShortfallCents: big(liquidity.overdueShortfallCents),
    },
    accounts: company.ledger.accounts.map((account) => ({
      code: account.code,
      name: account.name,
      type: account.type,
      balanceCents: big(account.balanceCents),
    })),
    trialBalance: {
      debitsCents: big(totals.debitsCents),
      creditsCents: big(totals.creditsCents),
      balanced: totals.debitsCents === totals.creditsCents,
    },
    entries: {
      total: entries.length,
      recent: entries
        .slice(-RECENT_ENTRY_LIMIT)
        .reverse()
        .map((entry) => ({
          id: entry.id,
          postedOn: date(entry.atMs),
          atMs: big(entry.atMs),
          description: entry.description,
          sourceKey: entry.sourceKey,
          counterparty: entry.counterpartyId ? partyName(entry.counterpartyId) : null,
          lines: entry.lines.map((line) => ({
            account: line.account,
            debitCents: big(line.debitCents),
            creditCents: big(line.creditCents),
          })),
        })),
    },
    invoices: [...open, ...settled.reverse()].map((invoice) => {
      const outstanding = outstandingOf(invoice);
      return {
        id: invoice.id,
        direction: invoice.direction,
        counterparty: partyName(invoice.counterpartyId),
        description: invoice.description,
        totalCents: big(invoice.totalCents),
        paidCents: big(invoice.paidCents),
        outstandingCents: big(outstanding),
        issuedOn: date(invoice.issuedAtMs),
        dueOn: date(invoice.dueAtMs),
        status:
          outstanding === 0n ? 'settled' : invoice.overdueSinceMs !== null ? 'overdue' : 'open',
      };
    }),
    obligations: company.obligations.map((obligation) => {
      const next = nextIssueTimeOf(obligation, epoch);
      return {
        id: obligation.id,
        counterparty: partyName(obligation.counterpartyId),
        purpose: obligation.purpose,
        description: obligation.description,
        amountCents: big(obligation.amountCents),
        cadence: obligation.cadence,
        occurrences: obligation.occurrences,
        issued: obligation.issued,
        nextBillOn: next === null ? null : date(next),
        paymentTermsDays: obligation.paymentTermsDays,
        standingOrder: obligation.standingOrder,
      };
    }),
  };
}
