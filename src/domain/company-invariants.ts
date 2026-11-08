import type { Cents } from '../shared/money';
import type { Company } from './company';
import { outstandingOf } from './invoicing';
import { ACCOUNT, balanceOf, ledgerProblems } from './ledger';

/**
 * Cross-checks between the company's documents and its books (plan Step 05
 * acceptance: all postings balance, no unexplained adjustments). Returns
 * human-readable violations; empty when consistent. Run on every restore and
 * after every step of the property tests.
 */
export function companyProblems(company: Company): string[] {
  const problems = ledgerProblems(company.ledger).map((problem) => `ledger: ${problem}`);
  const parties = new Set(company.counterparties.map((party) => party.id));
  const entries = new Map(company.ledger.entries.map((entry) => [entry.id, entry]));
  if (parties.size !== company.counterparties.length) {
    problems.push('a counterparty is registered twice');
  }
  for (const entry of company.ledger.entries) {
    if (entry.counterpartyId !== null && !parties.has(entry.counterpartyId)) {
      problems.push(`entry ${entry.id} names unknown counterparty ${entry.counterpartyId}`);
    }
  }

  // Every invoice is recognised by exactly its own entry; its payments add up.
  const paidByInvoice = new Map<string, Cents>();
  for (const payment of company.payments) {
    paidByInvoice.set(
      payment.invoiceId,
      (paidByInvoice.get(payment.invoiceId) ?? 0n) + payment.amountCents,
    );
  }
  let payables = 0n;
  let receivables = 0n;
  const occurrences = new Set<string>();
  for (const invoice of company.invoices) {
    const entry = entries.get(invoice.entryId);
    if (entry?.sourceKey !== invoice.id) {
      problems.push(`invoice ${invoice.id} is not recognised by its own ledger entry`);
    }
    const lineTotal = invoice.lines.reduce((sum, line) => sum + line.amountCents, 0n);
    if (lineTotal !== invoice.totalCents) {
      problems.push(`invoice ${invoice.id} lines sum to ${lineTotal}, not ${invoice.totalCents}`);
    }
    if (invoice.paidCents < 0n || invoice.paidCents > invoice.totalCents) {
      problems.push(`invoice ${invoice.id} is paid ${invoice.paidCents} of ${invoice.totalCents}`);
    }
    if ((paidByInvoice.get(invoice.id) ?? 0n) !== invoice.paidCents) {
      problems.push(`invoice ${invoice.id} records ${invoice.paidCents} paid; its payments differ`);
    }
    if (!parties.has(invoice.counterpartyId)) {
      problems.push(`invoice ${invoice.id} names unknown counterparty`);
    }
    if (invoice.direction === 'payable') {
      payables += outstandingOf(invoice);
    } else {
      receivables += outstandingOf(invoice);
    }
    if (invoice.obligation) {
      const key = `${invoice.obligation.id}#${invoice.obligation.occurrence}`;
      if (occurrences.has(key)) {
        problems.push(`obligation occurrence ${key} is invoiced twice`);
      }
      occurrences.add(key);
    }
  }
  // Control accounts equal the open documents behind them.
  if (-balanceOf(company.ledger, ACCOUNT.payables) !== payables) {
    problems.push(
      `accounts payable does not equal the ${payables} outstanding on payable invoices`,
    );
  }
  if (balanceOf(company.ledger, ACCOUNT.receivables) !== receivables) {
    problems.push(
      `accounts receivable does not equal the ${receivables} outstanding on receivable invoices`,
    );
  }

  // Every payment is its own entry, against an invoice of the matching direction.
  const invoices = new Map(company.invoices.map((invoice) => [invoice.id, invoice]));
  for (const payment of company.payments) {
    const invoice = invoices.get(payment.invoiceId);
    if (!invoice) {
      problems.push(`payment ${payment.id} settles unknown invoice ${payment.invoiceId}`);
    } else if ((invoice.direction === 'payable') !== (payment.direction === 'outgoing')) {
      problems.push(`payment ${payment.id} runs the wrong way for invoice ${invoice.id}`);
    }
    if (entries.get(payment.entryId)?.sourceKey !== payment.id) {
      problems.push(`payment ${payment.id} is not recorded by its own ledger entry`);
    }
  }

  // No unexplained cash: only the opening capital and recorded payments move it.
  const opening = company.ledger.entries.find(
    (entry) => entry.sourceKey === `${company.firmId}/opening-capital`,
  );
  if (!opening) {
    problems.push('the opening capital entry is missing');
  }
  const explained = new Set([
    ...(opening ? [opening.id] : []),
    ...company.payments.map((payment) => payment.entryId),
  ]);
  let expectedCash = company.startingCapitalCents;
  for (const payment of company.payments) {
    expectedCash += payment.direction === 'incoming' ? payment.amountCents : -payment.amountCents;
  }
  for (const entry of company.ledger.entries) {
    if (entry.lines.some((line) => line.account === ACCOUNT.cash) && !explained.has(entry.id)) {
      problems.push(`entry ${entry.id} moves cash without a recorded payment`);
    }
  }
  if (balanceOf(company.ledger, ACCOUNT.cash) !== expectedCash) {
    problems.push(
      `cash is ${balanceOf(company.ledger, ACCOUNT.cash)}, but capital and payments explain ${expectedCash}`,
    );
  }

  for (const obligation of company.obligations) {
    if (obligation.issued < 0 || obligation.issued > obligation.occurrences) {
      problems.push(`obligation ${obligation.id} has issued ${obligation.issued} occurrences`);
    }
    const invoiced = company.invoices.filter(
      (invoice) => invoice.obligation?.id === obligation.id,
    ).length;
    if (invoiced !== obligation.issued) {
      problems.push(
        `obligation ${obligation.id} records ${obligation.issued} occurrences but ${invoiced} invoices`,
      );
    }
  }
  return problems;
}
