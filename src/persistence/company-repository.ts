import {
  COUNTERPARTY_KINDS,
  type Company,
  type Counterparty,
  type Invoice,
  type InvoiceLine,
  type Obligation,
  type Payment,
} from '../domain/company';
import { isEntityIdOf, parseEntityId, type EntityId } from '../domain/ids';
import {
  ACCOUNT_TYPES,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerLine,
} from '../domain/ledger';
import { bigCell, int64, intCell, textCell, type SqliteDatabase } from './database';

/**
 * Maps the company slice to the save-format-2 tables (ADR-0033) and back.
 * Writes happen inside `writeWorld`'s transaction. Reads validate every
 * enumerated value and ID kind; the kernel then checks the business
 * invariants and the fingerprints on load.
 */

/** Company tables, children before parents, so they can be cleared in this order. */
export const COMPANY_TABLES = [
  'payments',
  'invoice_lines',
  'invoices',
  'obligations',
  'ledger_lines',
  'ledger_entries',
  'ledger_accounts',
  'company',
  'counterparties',
] as const;

type Row = Record<string, unknown>;

function ordinalOf(id: string): number {
  const parsed = parseEntityId(id);
  if (!parsed) {
    throw new Error(`${id} is not an entity ID`);
  }
  return parsed.ordinal;
}

const money = (value: bigint, what: string) => int64(value, what);

export function writeCompany(db: SqliteDatabase, company: Company | null): void {
  if (!company) {
    return;
  }
  const party = db.prepare(
    'INSERT INTO counterparties (ordinal, id, name, kind, person_id) VALUES (?, ?, ?, ?, ?)',
  );
  for (const counterparty of company.counterparties) {
    party.run(
      ordinalOf(counterparty.id),
      counterparty.id,
      counterparty.name,
      counterparty.kind,
      counterparty.personId,
    );
  }
  db.prepare(
    `INSERT INTO company (singleton, firm_id, legal_name, president_person_id, president_name,
       owner_party_id, founded_at_ms, financing, starting_capital_cents)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    company.firmId,
    company.legalName,
    company.president.personId,
    company.president.name,
    company.ownerPartyId,
    int64(company.foundedAtMs, 'Founding time'),
    company.financing,
    money(company.startingCapitalCents, 'Starting capital'),
  );
  const account = db.prepare(
    'INSERT INTO ledger_accounts (position, code, name, type, balance_cents) VALUES (?, ?, ?, ?, ?)',
  );
  company.ledger.accounts.forEach((item, index) => {
    account.run(index + 1, item.code, item.name, item.type, money(item.balanceCents, 'Balance'));
  });
  const entry = db.prepare(
    `INSERT INTO ledger_entries (ordinal, id, at_ms, description, source_key, counterparty_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const line = db.prepare(
    `INSERT INTO ledger_lines (entry_ordinal, line_no, account_code, debit_cents, credit_cents)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const item of company.ledger.entries) {
    const ordinal = ordinalOf(item.id);
    entry.run(
      ordinal,
      item.id,
      int64(item.atMs, 'Entry time'),
      item.description,
      item.sourceKey,
      item.counterpartyId,
    );
    item.lines.forEach((posted, index) => {
      line.run(
        ordinal,
        index + 1,
        posted.account,
        money(posted.debitCents, 'Debit'),
        money(posted.creditCents, 'Credit'),
      );
    });
  }
  const obligation = db.prepare(
    `INSERT INTO obligations (ordinal, id, counterparty_id, purpose, description, amount_cents,
       cadence, first_issue_at_ms, occurrences, issued, payment_terms_days, standing_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of company.obligations) {
    obligation.run(
      ordinalOf(item.id),
      item.id,
      item.counterpartyId,
      item.purpose,
      item.description,
      money(item.amountCents, 'Obligation amount'),
      item.cadence,
      int64(item.firstIssueAtMs, 'Obligation start'),
      item.occurrences,
      item.issued,
      item.paymentTermsDays,
      item.standingOrder ? 1 : 0,
    );
  }
  const invoice = db.prepare(
    `INSERT INTO invoices (ordinal, id, direction, counterparty_id, description, total_cents,
       paid_cents, issued_at_ms, due_at_ms, overdue_since_ms, obligation_id,
       obligation_occurrence, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const invoiceLine = db.prepare(
    `INSERT INTO invoice_lines (invoice_ordinal, line_no, account_code, description, amount_cents)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const item of company.invoices) {
    const ordinal = ordinalOf(item.id);
    invoice.run(
      ordinal,
      item.id,
      item.direction,
      item.counterpartyId,
      item.description,
      money(item.totalCents, 'Invoice total'),
      money(item.paidCents, 'Invoice paid'),
      int64(item.issuedAtMs, 'Invoice time'),
      int64(item.dueAtMs, 'Invoice due time'),
      item.overdueSinceMs === null ? null : int64(item.overdueSinceMs, 'Overdue time'),
      item.obligation?.id ?? null,
      item.obligation?.occurrence ?? null,
      item.entryId,
    );
    item.lines.forEach((posted, index) => {
      invoiceLine.run(
        ordinal,
        index + 1,
        posted.account,
        posted.description,
        money(posted.amountCents, 'Invoice line'),
      );
    });
  }
  const payment = db.prepare(
    `INSERT INTO payments (ordinal, id, direction, counterparty_id, invoice_id, at_ms,
       amount_cents, initiated_by, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of company.payments) {
    payment.run(
      ordinalOf(item.id),
      item.id,
      item.direction,
      item.counterpartyId,
      item.invoiceId,
      int64(item.atMs, 'Payment time'),
      money(item.amountCents, 'Payment amount'),
      item.initiatedBy,
      item.entryId,
    );
  }
}

// ------------------------------------------------------------------ reads

function idCell<K extends string>(kind: K, value: unknown, what: string): EntityId<K> {
  const id = textCell(value, what);
  if (!isEntityIdOf(kind, id)) {
    throw new Error(`${what} ${JSON.stringify(id)} is not a ${kind} ID`);
  }
  return id;
}

function nullableIdCell<K extends string>(
  kind: K,
  value: unknown,
  what: string,
): EntityId<K> | null {
  return value === null ? null : idCell(kind, value, what);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, what: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`Unknown ${what} ${JSON.stringify(value)}`);
  }
  return found;
}

function all(db: SqliteDatabase, sql: string): Row[] {
  return db.prepare(sql).all() as Row[];
}

/** Rows of a child table grouped by their parent ordinal, in line order. */
function grouped(db: SqliteDatabase, sql: string, key: string): Map<number, Row[]> {
  const groups = new Map<number, Row[]>();
  for (const row of all(db, sql)) {
    const parent = intCell(row[key], key);
    const list = groups.get(parent) ?? [];
    list.push(row);
    groups.set(parent, list);
  }
  return groups;
}

export function readCompany(db: SqliteDatabase): Company | null {
  const rows = all(db, 'SELECT * FROM company');
  const [row] = rows;
  if (rows.length > 1) {
    throw new Error(`Expected at most one company, found ${rows.length}`);
  }
  if (!row) {
    return null;
  }
  const counterparties = all(db, 'SELECT * FROM counterparties ORDER BY ordinal').map(
    (party): Counterparty => ({
      id: idCell('party', party['id'], 'counterparty id'),
      name: textCell(party['name'], 'counterparty name'),
      kind: oneOf(COUNTERPARTY_KINDS, party['kind'], 'counterparty kind'),
      personId: nullableIdCell('person', party['person_id'], 'counterparty person'),
    }),
  );
  const accounts = all(db, 'SELECT * FROM ledger_accounts ORDER BY position').map(
    (account): LedgerAccount => ({
      code: textCell(account['code'], 'account code'),
      name: textCell(account['name'], 'account name'),
      type: oneOf(ACCOUNT_TYPES, account['type'], 'account type'),
      balanceCents: bigCell(account['balance_cents'], 'balance'),
    }),
  );
  const lines = grouped(
    db,
    'SELECT * FROM ledger_lines ORDER BY entry_ordinal, line_no',
    'entry_ordinal',
  );
  const entries = all(db, 'SELECT * FROM ledger_entries ORDER BY ordinal').map(
    (entry): LedgerEntry => ({
      id: idCell('entry', entry['id'], 'entry id'),
      atMs: bigCell(entry['at_ms'], 'entry time'),
      description: textCell(entry['description'], 'entry description'),
      sourceKey: textCell(entry['source_key'], 'entry source'),
      counterpartyId: nullableIdCell('party', entry['counterparty_id'], 'entry counterparty'),
      lines: (lines.get(intCell(entry['ordinal'], 'entry ordinal')) ?? []).map(
        (posted): LedgerLine => ({
          account: textCell(posted['account_code'], 'line account'),
          debitCents: bigCell(posted['debit_cents'], 'debit'),
          creditCents: bigCell(posted['credit_cents'], 'credit'),
        }),
      ),
    }),
  );
  const invoiceLines = grouped(
    db,
    'SELECT * FROM invoice_lines ORDER BY invoice_ordinal, line_no',
    'invoice_ordinal',
  );
  const invoices = all(db, 'SELECT * FROM invoices ORDER BY ordinal').map((invoice): Invoice => {
    const obligationId = nullableIdCell('obligation', invoice['obligation_id'], 'obligation');
    const overdue = invoice['overdue_since_ms'];
    return {
      id: idCell('invoice', invoice['id'], 'invoice id'),
      direction: oneOf(['payable', 'receivable'], invoice['direction'], 'invoice direction'),
      counterpartyId: idCell('party', invoice['counterparty_id'], 'invoice counterparty'),
      description: textCell(invoice['description'], 'invoice description'),
      lines: (invoiceLines.get(intCell(invoice['ordinal'], 'invoice ordinal')) ?? []).map(
        (posted): InvoiceLine => ({
          account: textCell(posted['account_code'], 'invoice line account'),
          description: textCell(posted['description'], 'invoice line description'),
          amountCents: bigCell(posted['amount_cents'], 'invoice line amount'),
        }),
      ),
      totalCents: bigCell(invoice['total_cents'], 'invoice total'),
      paidCents: bigCell(invoice['paid_cents'], 'invoice paid'),
      issuedAtMs: bigCell(invoice['issued_at_ms'], 'invoice time'),
      dueAtMs: bigCell(invoice['due_at_ms'], 'invoice due time'),
      overdueSinceMs: overdue === null ? null : bigCell(overdue, 'overdue time'),
      obligation:
        obligationId === null
          ? null
          : {
              id: obligationId,
              occurrence: intCell(invoice['obligation_occurrence'], 'obligation occurrence'),
            },
      entryId: idCell('entry', invoice['entry_id'], 'invoice entry'),
    };
  });
  const payments = all(db, 'SELECT * FROM payments ORDER BY ordinal').map((payment): Payment => ({
    id: idCell('payment', payment['id'], 'payment id'),
    direction: oneOf(['outgoing', 'incoming'], payment['direction'], 'payment direction'),
    counterpartyId: idCell('party', payment['counterparty_id'], 'payment counterparty'),
    invoiceId: idCell('invoice', payment['invoice_id'], 'payment invoice'),
    atMs: bigCell(payment['at_ms'], 'payment time'),
    amountCents: bigCell(payment['amount_cents'], 'payment amount'),
    initiatedBy: oneOf(
      ['player', 'standing-order', 'counterparty'],
      payment['initiated_by'],
      'payment initiator',
    ),
    entryId: idCell('entry', payment['entry_id'], 'payment entry'),
  }));
  const obligations = all(db, 'SELECT * FROM obligations ORDER BY ordinal').map(
    (obligation): Obligation => ({
      id: idCell('obligation', obligation['id'], 'obligation id'),
      counterpartyId: idCell('party', obligation['counterparty_id'], 'obligation counterparty'),
      purpose: oneOf(['rent', 'security-deposit'], obligation['purpose'], 'obligation purpose'),
      description: textCell(obligation['description'], 'obligation description'),
      amountCents: bigCell(obligation['amount_cents'], 'obligation amount'),
      cadence: oneOf(['once', 'monthly'], obligation['cadence'], 'obligation cadence'),
      firstIssueAtMs: bigCell(obligation['first_issue_at_ms'], 'obligation start'),
      occurrences: intCell(obligation['occurrences'], 'occurrences'),
      issued: intCell(obligation['issued'], 'issued'),
      paymentTermsDays: intCell(obligation['payment_terms_days'], 'payment terms'),
      standingOrder: intCell(obligation['standing_order'], 'standing order') === 1,
    }),
  );
  return {
    firmId: idCell('firm', row['firm_id'], 'firm id'),
    legalName: textCell(row['legal_name'], 'legal name'),
    president: {
      personId: idCell('person', row['president_person_id'], 'president'),
      name: textCell(row['president_name'], 'president name'),
    },
    ownerPartyId: idCell('party', row['owner_party_id'], 'owner'),
    foundedAtMs: bigCell(row['founded_at_ms'], 'founding time'),
    financing: oneOf(['owner-funds'], row['financing'], 'financing'),
    startingCapitalCents: bigCell(row['starting_capital_cents'], 'starting capital'),
    counterparties,
    ledger: { accounts, entries },
    invoices,
    payments,
    obligations,
  };
}

/** Problems the DDL cannot express (ADR-0033); empty when the books are consistent. */
export function companyStructureProblems(db: SqliteDatabase): string[] {
  const count = (sql: string): number => intCell((db.prepare(sql).get() as { n: unknown }).n, sql);
  const problems: string[] = [];
  if (count('SELECT count(*) AS n FROM company') === 0) {
    for (const table of COMPANY_TABLES) {
      if (count(`SELECT count(*) AS n FROM ${table}`) > 0) {
        problems.push(`${table} has rows but no company exists`);
      }
    }
    return problems;
  }
  const unbalanced = count(
    `SELECT count(*) AS n FROM ledger_entries e WHERE
       (SELECT count(*) FROM ledger_lines l WHERE l.entry_ordinal = e.ordinal) < 2
       OR (SELECT coalesce(sum(debit_cents), 0) - coalesce(sum(credit_cents), 0)
           FROM ledger_lines l WHERE l.entry_ordinal = e.ordinal) <> 0`,
  );
  if (unbalanced > 0) {
    problems.push(`${unbalanced} ledger entries do not balance`);
  }
  const misstated = count(
    `SELECT count(*) AS n FROM ledger_accounts a WHERE a.balance_cents <>
       (SELECT coalesce(sum(debit_cents - credit_cents), 0) FROM ledger_lines l
        WHERE l.account_code = a.code)`,
  );
  if (misstated > 0) {
    problems.push(`${misstated} account balances differ from their postings`);
  }
  const unsupported = count(
    `SELECT count(*) AS n FROM invoices i WHERE i.total_cents <>
       (SELECT coalesce(sum(amount_cents), 0) FROM invoice_lines l
        WHERE l.invoice_ordinal = i.ordinal)`,
  );
  if (unsupported > 0) {
    problems.push(`${unsupported} invoices differ from the sum of their lines`);
  }
  const misPaid = count(
    `SELECT count(*) AS n FROM invoices i WHERE i.paid_cents <>
       (SELECT coalesce(sum(amount_cents), 0) FROM payments p WHERE p.invoice_id = i.id)`,
  );
  if (misPaid > 0) {
    problems.push(`${misPaid} invoices record payments that do not exist`);
  }
  return problems;
}

/** Whether `db` has the company tables (save format 2 and later). */
export function hasCompanyTables(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'company'")
    .get() as { n: unknown };
  return intCell(row.n, 'company table') === 1;
}
