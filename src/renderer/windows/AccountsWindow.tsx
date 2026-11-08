import type { CompanyView } from '../../shared/ipc/company';
import { DataTable, type Column } from '../components/DataTable';
import { Dropdown } from '../components/Dropdown';
import { Tabs, selectedTab } from '../components/Tabs';
import {
  filterValue,
  withFilter,
  withSort,
  withTab,
  type WindowViewProps,
} from '../app/desktop/window-catalog';
import { formatCents } from '../app/money-input';

/**
 * Accounts window (Finance → Accounts): the internal account-inspection read
 * model of Step 05 (ADR-0034), as a trial balance and the latest ledger
 * entries. Polished reports, drill-down and CSV export are Step 18.
 */

type Account = CompanyView['accounts'][number];
type Entry = CompanyView['entries']['recent'][number];

const TABS = [
  { id: 'trial-balance', label: 'Trial balance' },
  { id: 'entries', label: 'Ledger entries' },
] as const;

const TYPE_LABEL: Record<Account['type'], string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expense',
};

const TYPE_FILTERS = ['all', 'asset', 'liability', 'equity', 'revenue', 'expense'] as const;
type TypeFilter = (typeof TYPE_FILTERS)[number];

/** Debit-positive balance shown in its natural column. */
function sides(balanceCents: string): { debit: string; credit: string } {
  const balance = BigInt(balanceCents);
  if (balance === 0n) {
    return { debit: '', credit: '' };
  }
  return balance > 0n
    ? { debit: formatCents(balanceCents), credit: '' }
    : { debit: '', credit: formatCents((-balance).toString()) };
}

const ACCOUNT_COLUMNS: readonly Column<Account>[] = [
  { id: 'code', header: 'Code', sortValue: (row) => row.code, render: (row) => row.code },
  { id: 'name', header: 'Account', sortValue: (row) => row.name, render: (row) => row.name },
  {
    id: 'type',
    header: 'Type',
    sortValue: (row) => TYPE_LABEL[row.type],
    render: (row) => TYPE_LABEL[row.type],
  },
  {
    id: 'debit',
    header: 'Debit',
    numeric: true,
    sortValue: (row) => BigInt(row.balanceCents),
    render: (row) => sides(row.balanceCents).debit,
  },
  {
    id: 'credit',
    header: 'Credit',
    numeric: true,
    sortValue: (row) => -BigInt(row.balanceCents),
    render: (row) => sides(row.balanceCents).credit,
  },
];

const ENTRY_COLUMNS: readonly Column<Entry>[] = [
  { id: 'date', header: 'Date', sortValue: (row) => row.postedOn, render: (row) => row.postedOn },
  {
    id: 'entry',
    header: 'Entry',
    sortValue: (row) => Number(row.id.split(':')[1] ?? 0),
    render: (row) => row.id,
  },
  {
    id: 'description',
    header: 'Description',
    sortValue: (row) => row.description,
    render: (row) => row.description,
  },
  {
    id: 'party',
    header: 'Party',
    sortValue: (row) => row.counterparty ?? '',
    render: (row) => row.counterparty ?? '—',
  },
  {
    id: 'postings',
    header: 'Postings',
    render: (row) =>
      row.lines
        .map((line) =>
          line.debitCents === '0'
            ? `Cr ${line.account} ${formatCents(line.creditCents)}`
            : `Dr ${line.account} ${formatCents(line.debitCents)}`,
        )
        .join('; '),
  },
];

export interface AccountsWindowProps extends WindowViewProps {
  readonly company: CompanyView | null;
}

export function AccountsWindow({ company, view, onViewChange }: AccountsWindowProps) {
  if (!company) {
    return (
      <div className="window-content">
        <p>No company has been founded, so there are no books yet.</p>
      </div>
    );
  }
  const tab = selectedTab(TABS, view.tab);
  const typeFilter = filterValue<TypeFilter>(view, 'type', TYPE_FILTERS, 'all');
  const accounts =
    typeFilter === 'all'
      ? company.accounts
      : company.accounts.filter((account) => account.type === typeFilter);

  return (
    <div className="window-content">
      <Tabs
        idPrefix="accounts"
        label="Accounts"
        tabs={TABS}
        selected={tab}
        onSelect={(next) => {
          onViewChange(withTab(view, next));
        }}
      >
        {tab === 'trial-balance' ? (
          <>
            <div className="filter-row">
              <Dropdown<TypeFilter>
                label="Show"
                value={typeFilter}
                options={TYPE_FILTERS.map((value) => ({
                  value,
                  label: value === 'all' ? 'All accounts' : `${TYPE_LABEL[value]} accounts`,
                }))}
                onChange={(value) => {
                  onViewChange(withFilter(view, 'type', value));
                }}
              />
            </div>
            <DataTable
              label="Trial balance"
              testId="trial-balance"
              columns={ACCOUNT_COLUMNS}
              rows={accounts}
              rowKey={(row) => row.code}
              sort={view.sort ?? null}
              onSortChange={(sort) => {
                onViewChange(withSort(view, sort));
              }}
              footer={
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={3}>
                      Trial balance: {company.trialBalance.balanced ? 'balanced' : 'OUT OF BALANCE'}
                    </th>
                    <td className="data-table-number" data-testid="trial-debits">
                      {formatCents(company.trialBalance.debitsCents)}
                    </td>
                    <td className="data-table-number" data-testid="trial-credits">
                      {formatCents(company.trialBalance.creditsCents)}
                    </td>
                  </tr>
                </tfoot>
              }
            />
            {typeFilter !== 'all' && (
              <p className="hint">The totals are for every account, not only those shown.</p>
            )}
          </>
        ) : (
          <>
            <p className="hint">
              {company.entries.total} posted
              {company.entries.total > company.entries.recent.length
                ? `, latest ${company.entries.recent.length} shown`
                : ''}
              .
            </p>
            <DataTable
              label="Ledger entries"
              testId="ledger-entries"
              columns={ENTRY_COLUMNS}
              rows={company.entries.recent}
              rowKey={(row) => row.id}
              sort={view.sort ?? null}
              onSortChange={(sort) => {
                onViewChange(withSort(view, sort));
              }}
            />
          </>
        )}
      </Tabs>
    </div>
  );
}
