import { formatUsd, MAX_AMOUNT_CENTS, MAX_BALANCE_CENTS, type Cents } from '../shared/money';
import type { EntityId } from './ids';
import { reject, type Rejection } from './rejection';
import type { SimTimeMs } from './time';

/**
 * Double-entry general ledger (spec §8.1, plan Step 05, DECISIONS ADR-0030).
 *
 * - Every posting is one balanced entry: total debits equal total credits,
 *   each line is a positive debit or a positive credit, never both.
 * - Entries are immutable and append-only, in time order. A mistake is
 *   corrected by a further entry, never by editing one (Step 18 adds
 *   reversals).
 * - Each entry names the business event that caused it (`sourceKey`, unique),
 *   so the same event can never be posted twice; and any entry that moves
 *   cash names its counterparty.
 * - Balances are kept per account, debit-positive (an asset's or expense's
 *   natural balance is positive, a liability's, equity's or revenue's is
 *   negative), and must always equal the sum of the posted lines.
 * - Cash can never go below zero: there is no overdraft until credit exists
 *   (Step 25). A posting that would overdraw, or push any balance past the
 *   money limit, is refused as a business rule.
 *
 * Malformed postings (unbalanced, unknown account, reused source) are bugs in
 * the calling rule, not player errors, so they throw: the kernel then rolls
 * the whole command or event back.
 */

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Four-digit account code, e.g. "1010". */
export type AccountCode = string;

export interface Account {
  readonly code: AccountCode;
  readonly name: string;
  readonly type: AccountType;
}

const ACCOUNT_CODE = /^[0-9]{4}$/;

/** The accounts the business rules post to by role. */
export const ACCOUNT = {
  cash: '1010',
  receivables: '1100',
  inventory: '1300',
  depositsPaid: '1400',
  machinery: '1500',
  payables: '2000',
  ownerCapital: '3000',
  sales: '4000',
  rent: '6100',
  equipmentRigging: '6200',
  floorInstallation: '6300',
  floorRemoval: '6310',
  inventoryLosses: '5900',
  inventoryScrapped: '5910',
} as const satisfies Record<string, AccountCode>;

/**
 * The chart every new company opens with: only accounts that current rules
 * post to. Later steps add inventory, payroll, equipment, loans and others as
 * their rules arrive (spec §8; Step 18 completes the general ledger). A
 * FreeIndustry design, not a reconstruction of the original's books.
 */
export const STANDARD_CHART: readonly Account[] = [
  { code: ACCOUNT.cash, name: 'Cash at bank', type: 'asset' },
  { code: ACCOUNT.receivables, name: 'Accounts receivable', type: 'asset' },
  { code: ACCOUNT.depositsPaid, name: 'Security deposits paid', type: 'asset' },
  { code: ACCOUNT.payables, name: 'Accounts payable', type: 'liability' },
  { code: ACCOUNT.ownerCapital, name: "Owner's capital", type: 'equity' },
  { code: ACCOUNT.sales, name: 'Sales', type: 'revenue' },
  { code: ACCOUNT.rent, name: 'Rent expense', type: 'expense' },
];

/**
 * Accounts a company opens the first time a rule posts to them, rather than
 * at founding, so the books of companies founded before a rule existed stay
 * exactly as they were (Step 08, ADR-0048).
 */
export const EQUIPMENT_ACCOUNTS = {
  machinery: { code: ACCOUNT.machinery, name: 'Machinery and equipment', type: 'asset' },
  rigging: {
    code: ACCOUNT.equipmentRigging,
    name: 'Equipment installation and relocation',
    type: 'expense',
  },
} as const satisfies Record<string, Account>;

/**
 * Floor-covering works (Step 09A, ADR-0052), opened the same way. The owner
 * chose to expense all of it: laying a covering and taking one up are
 * separate expense accounts, so a replacement is distinguishable from an
 * initial installation in the books.
 */
export const FLOOR_ACCOUNTS = {
  installation: {
    code: ACCOUNT.floorInstallation,
    name: 'Floor covering installation',
    type: 'expense',
  },
  removal: { code: ACCOUNT.floorRemoval, name: 'Floor covering removal', type: 'expense' },
} as const satisfies Record<string, Account>;

/**
 * Stock (Step 10, ADR-0053), opened the same way. Goods received are an
 * asset at what they cost; scrapping writes their cost down to nothing, and
 * a loss writes off what left the world, each on its own expense account.
 * The balance of Inventory always equals the cost of the lots the company
 * holds (an invariant).
 */
export const INVENTORY_ACCOUNTS = {
  inventory: { code: ACCOUNT.inventory, name: 'Inventory', type: 'asset' },
  losses: { code: ACCOUNT.inventoryLosses, name: 'Inventory losses', type: 'expense' },
  scrapped: {
    code: ACCOUNT.inventoryScrapped,
    name: 'Inventory written down to scrap',
    type: 'expense',
  },
} as const satisfies Record<string, Account>;

/**
 * The ledger with `account` in its chart: unchanged if it is there already,
 * otherwise with the account appended at a zero balance. A code already used
 * by a different account is a bug.
 */
export function ensureAccount(ledger: Ledger, account: Account): Ledger {
  const existing = ledger.accounts.find((candidate) => candidate.code === account.code);
  if (existing) {
    if (existing.name !== account.name || existing.type !== account.type) {
      throw new Error(`Account ${account.code} is already ${existing.name}`);
    }
    return ledger;
  }
  if (!ACCOUNT_CODE.test(account.code)) {
    throw new Error(`Invalid account code ${account.code}`);
  }
  return { ...ledger, accounts: [...ledger.accounts, { ...account, balanceCents: 0n }] };
}

/** Control accounts are moved only by invoices and payments, never by an invoice line. */
export const CONTROL_ACCOUNTS: readonly AccountCode[] = [
  ACCOUNT.cash,
  ACCOUNT.receivables,
  ACCOUNT.payables,
];

export interface LedgerAccount extends Account {
  /** Debit-positive balance. */
  readonly balanceCents: Cents;
}

export interface LedgerLine {
  readonly account: AccountCode;
  readonly debitCents: Cents;
  readonly creditCents: Cents;
}

export interface LedgerEntry {
  readonly id: EntityId<'entry'>;
  readonly atMs: SimTimeMs;
  readonly description: string;
  /** The business event this entry records, e.g. `invoice:3`; unique in the ledger. */
  readonly sourceKey: string;
  /** Who the money moved to or from; required whenever cash moves. */
  readonly counterpartyId: EntityId<'party'> | null;
  readonly lines: readonly LedgerLine[];
}

export interface Ledger {
  /** The chart of accounts, in chart order, with current balances. */
  readonly accounts: readonly LedgerAccount[];
  /** Every posted entry, in posting order. */
  readonly entries: readonly LedgerEntry[];
}

export const MAX_DESCRIPTION_LENGTH = 120;
const MAX_SOURCE_KEY_LENGTH = 80;

export function openLedger(chart: readonly Account[]): Ledger {
  const codes = new Set<string>();
  for (const account of chart) {
    if (!ACCOUNT_CODE.test(account.code) || codes.has(account.code)) {
      throw new Error(`Chart of accounts has an invalid or repeated code ${account.code}`);
    }
    codes.add(account.code);
  }
  return { accounts: chart.map((account) => ({ ...account, balanceCents: 0n })), entries: [] };
}

export function balanceOf(ledger: Ledger, code: AccountCode): Cents {
  const account = ledger.accounts.find((candidate) => candidate.code === code);
  if (!account) {
    throw new Error(`No account ${code} in the chart`);
  }
  return account.balanceCents;
}

export function debit(account: AccountCode, cents: Cents): LedgerLine {
  return { account, debitCents: cents, creditCents: 0n };
}

export function credit(account: AccountCode, cents: Cents): LedgerLine {
  return { account, debitCents: 0n, creditCents: cents };
}

/** Signed effect of a line on its account's debit-positive balance. */
function lineEffect(line: LedgerLine): Cents {
  return line.debitCents - line.creditCents;
}

/**
 * Post one entry. Returns the new ledger, or a rejection when the entry is
 * well formed but not allowed (it would overdraw cash or exceed a limit).
 * Throws for a malformed entry.
 */
export function postEntry(ledger: Ledger, entry: LedgerEntry): Ledger | Rejection {
  const problems = entryProblems(ledger, entry);
  if (problems.length > 0) {
    throw new Error(`Invalid ledger entry ${entry.id}: ${problems.join('; ')}`);
  }
  if (ledger.entries.some((posted) => posted.sourceKey === entry.sourceKey)) {
    throw new Error(`${entry.sourceKey} has already been posted to the ledger`);
  }
  if (ledger.entries.some((posted) => posted.id === entry.id)) {
    throw new Error(`Ledger entry ${entry.id} already exists`);
  }
  const last = ledger.entries.at(-1);
  if (last && entry.atMs < last.atMs) {
    throw new Error(`Ledger entry ${entry.id} is dated before the previous entry`);
  }
  const deltas = new Map<AccountCode, Cents>();
  for (const line of entry.lines) {
    deltas.set(line.account, (deltas.get(line.account) ?? 0n) + lineEffect(line));
  }
  const accounts = ledger.accounts.map((account) => {
    const delta = deltas.get(account.code);
    return delta === undefined
      ? account
      : { ...account, balanceCents: account.balanceCents + delta };
  });
  for (const account of accounts) {
    const magnitude = account.balanceCents < 0n ? -account.balanceCents : account.balanceCents;
    if (magnitude > MAX_BALANCE_CENTS) {
      return reject(
        `This would take ${account.name} beyond the largest balance the books can hold (${formatUsd(MAX_BALANCE_CENTS)})`,
        { account: account.code },
      );
    }
  }
  const cash = accounts.find((account) => account.code === ACCOUNT.cash);
  if (cash && cash.balanceCents < 0n) {
    const before = balanceOf(ledger, ACCOUNT.cash);
    return reject(
      `Insufficient funds: ${formatUsd(before)} available, ${formatUsd(before - cash.balanceCents)} needed`,
      { availableCents: before.toString(), requiredCents: (before - cash.balanceCents).toString() },
    );
  }
  return { accounts, entries: [...ledger.entries, entry] };
}

function entryProblems(ledger: Ledger, entry: LedgerEntry): string[] {
  const problems: string[] = [];
  if (entry.lines.length < 2) {
    problems.push('an entry needs at least two lines');
  }
  if (entry.description.length < 1 || entry.description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(`description must be 1–${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (entry.sourceKey.length < 1 || entry.sourceKey.length > MAX_SOURCE_KEY_LENGTH) {
    problems.push(`source key must be 1–${MAX_SOURCE_KEY_LENGTH} characters`);
  }
  let debits = 0n;
  let credits = 0n;
  entry.lines.forEach((line, index) => {
    if (!ledger.accounts.some((account) => account.code === line.account)) {
      problems.push(`line ${index + 1} posts to unknown account ${line.account}`);
    }
    const isDebit = line.debitCents > 0n && line.creditCents === 0n;
    const isCredit = line.creditCents > 0n && line.debitCents === 0n;
    if (!isDebit && !isCredit) {
      problems.push(`line ${index + 1} must be one positive debit or one positive credit`);
    }
    if (line.debitCents > MAX_AMOUNT_CENTS || line.creditCents > MAX_AMOUNT_CENTS) {
      problems.push(`line ${index + 1} exceeds the largest amount allowed`);
    }
    debits += line.debitCents;
    credits += line.creditCents;
  });
  if (debits !== credits) {
    problems.push(`debits ${debits} do not equal credits ${credits}`);
  }
  const movesCash = entry.lines.some((line) => line.account === ACCOUNT.cash);
  if (movesCash && entry.counterpartyId === null) {
    problems.push('an entry that moves cash must name its counterparty');
  }
  return problems;
}

/**
 * Re-derives the ledger from its entries and reports every inconsistency:
 * unbalanced or malformed entries, repeated sources, out-of-order dates,
 * stored balances that differ from the posted lines, overdrawn cash.
 */
export function ledgerProblems(ledger: Ledger): string[] {
  const problems: string[] = [];
  const recomputed = new Map<AccountCode, Cents>(
    ledger.accounts.map((account) => [account.code, 0n]),
  );
  const sources = new Set<string>();
  const ids = new Set<string>();
  let previous: SimTimeMs = 0n;
  for (const entry of ledger.entries) {
    for (const problem of entryProblems(ledger, entry)) {
      problems.push(`entry ${entry.id}: ${problem}`);
    }
    if (sources.has(entry.sourceKey)) {
      problems.push(`${entry.sourceKey} is posted more than once`);
    }
    if (ids.has(entry.id)) {
      problems.push(`entry ${entry.id} appears more than once`);
    }
    if (entry.atMs < previous) {
      problems.push(`entry ${entry.id} is out of time order`);
    }
    sources.add(entry.sourceKey);
    ids.add(entry.id);
    previous = entry.atMs;
    for (const line of entry.lines) {
      const balance = recomputed.get(line.account);
      if (balance !== undefined) {
        recomputed.set(line.account, balance + lineEffect(line));
      }
    }
  }
  let total = 0n;
  for (const account of ledger.accounts) {
    total += account.balanceCents;
    if (recomputed.get(account.code) !== account.balanceCents) {
      problems.push(
        `account ${account.code} holds ${account.balanceCents} but its lines sum to ${recomputed.get(account.code)}`,
      );
    }
  }
  if (total !== 0n) {
    problems.push(`account balances sum to ${total}, not zero (trial balance does not balance)`);
  }
  const cash = ledger.accounts.find((account) => account.code === ACCOUNT.cash);
  if (cash && cash.balanceCents < 0n) {
    problems.push(`cash is overdrawn (${cash.balanceCents})`);
  }
  return problems;
}

/** Totals of the debit and credit balances; equal whenever the ledger is consistent. */
export function trialBalance(ledger: Ledger): { debitsCents: Cents; creditsCents: Cents } {
  let debitsCents = 0n;
  let creditsCents = 0n;
  for (const account of ledger.accounts) {
    if (account.balanceCents > 0n) {
      debitsCents += account.balanceCents;
    } else {
      creditsCents -= account.balanceCents;
    }
  }
  return { debitsCents, creditsCents };
}
