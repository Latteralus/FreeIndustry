/**
 * Save schema version 2 (ADR-0033): the company and its books, added to the
 * version 1 tables by migration 2. All relational and queryable (spec §10.2):
 * the trial balance, an account's postings or the open payables are plain
 * SQL over these tables.
 *
 * Names: the spec's accounting `journal_entries` / `journal_lines` are
 * `ledger_entries` / `ledger_lines` here, because `journal_entries` already
 * holds the kernel's command and event journal (ADR-0026). `company` is the
 * player's company (a singleton); rival firms (Step 21) get their own tables.
 *
 * Each entity row has an `ordinal` primary key equal to the number in its
 * `<kind>:<n>` ID (checked), so lists read back in creation order. Money is
 * integer cents; balances are debit-positive. DDL checks cover single rows;
 * balanced entries and account totals are checked by `integrity.ts` and, on
 * every load, by the kernel's invariants.
 */
export const SCHEMA_V2 = `
CREATE TABLE counterparties (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'party:' || ordinal),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'landlord', 'supplier', 'customer', 'diagnostic')),
  person_id TEXT CHECK (person_id IS NULL OR person_id GLOB 'person:[1-9]*'),
  CHECK ((kind = 'owner') = (person_id IS NOT NULL))
) STRICT;

CREATE TABLE company (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  firm_id TEXT NOT NULL UNIQUE CHECK (firm_id GLOB 'firm:[1-9]*'),
  legal_name TEXT NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 60),
  president_person_id TEXT NOT NULL CHECK (president_person_id GLOB 'person:[1-9]*'),
  president_name TEXT NOT NULL CHECK (length(president_name) BETWEEN 1 AND 60),
  owner_party_id TEXT NOT NULL REFERENCES counterparties (id),
  founded_at_ms INTEGER NOT NULL CHECK (founded_at_ms >= 0),
  financing TEXT NOT NULL CHECK (financing = 'owner-funds'),
  starting_capital_cents INTEGER NOT NULL CHECK (starting_capital_cents > 0)
) STRICT;

CREATE TABLE ledger_accounts (
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  code TEXT NOT NULL UNIQUE CHECK (length(code) = 4 AND code NOT GLOB '*[^0-9]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  balance_cents INTEGER NOT NULL
) STRICT;

CREATE TABLE ledger_entries (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'entry:' || ordinal),
  at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  source_key TEXT NOT NULL UNIQUE CHECK (length(source_key) BETWEEN 1 AND 80),
  counterparty_id TEXT REFERENCES counterparties (id)
) STRICT;

CREATE TABLE ledger_lines (
  entry_ordinal INTEGER NOT NULL REFERENCES ledger_entries (ordinal),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  account_code TEXT NOT NULL REFERENCES ledger_accounts (code),
  debit_cents INTEGER NOT NULL CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL CHECK (credit_cents >= 0),
  CHECK ((debit_cents > 0) + (credit_cents > 0) = 1),
  PRIMARY KEY (entry_ordinal, line_no)
) STRICT;

CREATE INDEX ledger_lines_by_account ON ledger_lines (account_code, entry_ordinal);

CREATE TABLE obligations (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'obligation:' || ordinal),
  counterparty_id TEXT NOT NULL REFERENCES counterparties (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('rent', 'security-deposit')),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  cadence TEXT NOT NULL CHECK (cadence IN ('once', 'monthly')),
  first_issue_at_ms INTEGER NOT NULL CHECK (first_issue_at_ms >= 0),
  occurrences INTEGER NOT NULL CHECK (occurrences BETWEEN 1 AND 120),
  issued INTEGER NOT NULL CHECK (issued BETWEEN 0 AND occurrences),
  payment_terms_days INTEGER NOT NULL CHECK (payment_terms_days BETWEEN 0 AND 90),
  standing_order INTEGER NOT NULL CHECK (standing_order IN (0, 1)),
  CHECK (cadence = 'monthly' OR occurrences = 1)
) STRICT;

CREATE TABLE invoices (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'invoice:' || ordinal),
  direction TEXT NOT NULL CHECK (direction IN ('payable', 'receivable')),
  counterparty_id TEXT NOT NULL REFERENCES counterparties (id),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  paid_cents INTEGER NOT NULL CHECK (paid_cents BETWEEN 0 AND total_cents),
  issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms >= 0),
  due_at_ms INTEGER NOT NULL CHECK (due_at_ms >= issued_at_ms),
  overdue_since_ms INTEGER CHECK (overdue_since_ms IS NULL OR overdue_since_ms >= due_at_ms),
  obligation_id TEXT REFERENCES obligations (id),
  obligation_occurrence INTEGER CHECK (obligation_occurrence IS NULL OR obligation_occurrence >= 1),
  entry_id TEXT NOT NULL UNIQUE REFERENCES ledger_entries (id),
  CHECK ((obligation_id IS NULL) = (obligation_occurrence IS NULL)),
  UNIQUE (obligation_id, obligation_occurrence)
) STRICT;

CREATE TABLE invoice_lines (
  invoice_ordinal INTEGER NOT NULL REFERENCES invoices (ordinal),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  account_code TEXT NOT NULL REFERENCES ledger_accounts (code),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (invoice_ordinal, line_no)
) STRICT;

CREATE TABLE payments (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 1),
  id TEXT NOT NULL UNIQUE CHECK (id = 'payment:' || ordinal),
  direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  counterparty_id TEXT NOT NULL REFERENCES counterparties (id),
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  initiated_by TEXT NOT NULL CHECK (initiated_by IN ('player', 'standing-order', 'counterparty')),
  entry_id TEXT NOT NULL UNIQUE REFERENCES ledger_entries (id)
) STRICT;
`;
