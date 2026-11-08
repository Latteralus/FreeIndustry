import type { CompanyView } from '../../shared/ipc/company';
import { DataTable, type Column } from '../components/DataTable';
import { Dropdown } from '../components/Dropdown';
import { Notice } from '../components/MessageBox';
import { Tabs, selectedTab } from '../components/Tabs';
import {
  filterValue,
  withFilter,
  withSort,
  withTab,
  type WindowViewProps,
} from '../app/desktop/window-catalog';
import { formatCents } from '../app/money-input';
import type { SimulationHostView } from '../app/useSimulationHost';

/**
 * Bills and Obligations window (Finance → Bills and Obligations). Paying a
 * bill is the real `finance.payInvoice` command; the worker refuses a
 * payment beyond the available funds, and nothing is ever overdrawn.
 */

type Invoice = CompanyView['invoices'][number];
type Obligation = CompanyView['obligations'][number];

const TABS = [
  { id: 'bills', label: 'Bills' },
  { id: 'obligations', label: 'Obligations' },
] as const;

const STATUS_LABEL: Record<Invoice['status'], string> = {
  open: 'Open',
  overdue: 'Overdue',
  settled: 'Settled',
};

const STATUS_FILTERS = ['all', 'unpaid', 'overdue', 'settled'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'All bills',
  unpaid: 'Unpaid',
  overdue: 'Overdue',
  settled: 'Settled',
};

const PURPOSE_LABEL: Record<Obligation['purpose'], string> = {
  rent: 'Rent',
  'security-deposit': 'Security deposit',
};

const ordinal = (id: string) => Number(id.split(':')[1] ?? 0);

function matches(invoice: Invoice, filter: StatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'unpaid':
      return invoice.status !== 'settled';
    case 'overdue':
      return invoice.status === 'overdue';
    case 'settled':
      return invoice.status === 'settled';
  }
}

export interface BillsWindowProps extends WindowViewProps {
  readonly company: CompanyView | null;
  readonly host: Pick<SimulationHostView, 'submit' | 'pending'>;
  readonly outcome: string;
}

export function BillsWindow({ company, host, outcome, view, onViewChange }: BillsWindowProps) {
  if (!company) {
    return (
      <div className="window-content">
        <p>No company has been founded, so there are no bills.</p>
      </div>
    );
  }
  const tab = selectedTab(TABS, view.tab);
  const status = filterValue<StatusFilter>(view, 'status', STATUS_FILTERS, 'all');
  const shortfall = BigInt(company.liquidity.overdueShortfallCents) > 0n;

  const invoiceColumns: readonly Column<Invoice>[] = [
    {
      id: 'invoice',
      header: 'Invoice',
      sortValue: (row) => ordinal(row.id),
      render: (row) => row.id,
    },
    {
      id: 'party',
      header: 'Party',
      sortValue: (row) => row.counterparty,
      render: (row) => row.counterparty,
    },
    {
      id: 'description',
      header: 'Description',
      sortValue: (row) => row.description,
      render: (row) => row.description,
    },
    {
      id: 'issued',
      header: 'Issued',
      sortValue: (row) => row.issuedOn,
      render: (row) => row.issuedOn,
    },
    { id: 'due', header: 'Due', sortValue: (row) => row.dueOn, render: (row) => row.dueOn },
    {
      id: 'total',
      header: 'Total',
      numeric: true,
      sortValue: (row) => BigInt(row.totalCents),
      render: (row) => formatCents(row.totalCents),
    },
    {
      id: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      sortValue: (row) => BigInt(row.outstandingCents),
      render: (row) => formatCents(row.outstandingCents),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => STATUS_LABEL[row.status],
      render: (row) => STATUS_LABEL[row.status],
    },
    {
      id: 'action',
      header: 'Action',
      render: (row) =>
        row.direction === 'payable' && row.status !== 'settled' ? (
          <button
            type="button"
            disabled={host.pending}
            aria-label={`Pay ${row.id} in full`}
            onClick={() => {
              void host.submit('finance.payInvoice', {
                invoiceId: row.id,
                amountCents: row.outstandingCents,
              });
            }}
          >
            Pay
          </button>
        ) : null,
    },
  ];

  const obligationColumns: readonly Column<Obligation>[] = [
    {
      id: 'obligation',
      header: 'Obligation',
      sortValue: (row) => ordinal(row.id),
      render: (row) => row.id,
    },
    {
      id: 'party',
      header: 'Party',
      sortValue: (row) => row.counterparty,
      render: (row) => row.counterparty,
    },
    {
      id: 'purpose',
      header: 'Purpose',
      sortValue: (row) => PURPOSE_LABEL[row.purpose],
      render: (row) => PURPOSE_LABEL[row.purpose],
    },
    {
      id: 'amount',
      header: 'Amount',
      numeric: true,
      sortValue: (row) => BigInt(row.amountCents),
      render: (row) => formatCents(row.amountCents),
    },
    {
      id: 'schedule',
      header: 'Schedule',
      render: (row) => (row.cadence === 'monthly' ? 'Monthly' : 'Once'),
    },
    { id: 'billed', header: 'Billed', render: (row) => `${row.issued} of ${row.occurrences}` },
    {
      id: 'next',
      header: 'Next bill',
      sortValue: (row) => row.nextBillOn ?? '9999',
      render: (row) => row.nextBillOn ?? '—',
    },
    { id: 'terms', header: 'Terms', render: (row) => `${row.paymentTermsDays} days` },
    {
      id: 'standing',
      header: 'Standing order',
      render: (row) => (row.standingOrder ? 'Yes' : 'No'),
    },
  ];

  return (
    <div className="window-content">
      {shortfall && (
        <Notice kind="warning" testId="bills-shortfall">
          Overdue bills exceed the funds available by{' '}
          {formatCents(company.liquidity.overdueShortfallCents)}.
        </Notice>
      )}
      <Tabs
        idPrefix="bills"
        label="Bills and obligations"
        tabs={TABS}
        selected={tab}
        onSelect={(next) => {
          onViewChange(withTab(view, next));
        }}
      >
        {tab === 'bills' ? (
          <>
            <div className="filter-row">
              <Dropdown<StatusFilter>
                label="Show"
                value={status}
                options={STATUS_FILTERS.map((value) => ({
                  value,
                  label: STATUS_FILTER_LABEL[value],
                }))}
                onChange={(value) => {
                  onViewChange(withFilter(view, 'status', value));
                }}
              />
              <span className="hint">
                Every open bill, and the latest settled ones, as reported by the books.
              </span>
            </div>
            <DataTable
              label="Bills and invoices"
              testId="invoices"
              columns={invoiceColumns}
              rows={company.invoices.filter((invoice) => matches(invoice, status))}
              rowKey={(row) => row.id}
              rowTestId={(row) => `invoice-${row.id}`}
              sort={view.sort ?? null}
              onSortChange={(sort) => {
                onViewChange(withSort(view, sort));
              }}
            />
            <p className="outcome" data-testid="bills-outcome">
              {outcome}
            </p>
          </>
        ) : (
          <DataTable
            label="Obligations"
            testId="obligations"
            columns={obligationColumns}
            rows={company.obligations}
            rowKey={(row) => row.id}
            emptyText="None. Leases arrive with property."
            sort={view.sort ?? null}
            onSortChange={(sort) => {
              onViewChange(withSort(view, sort));
            }}
          />
        )}
      </Tabs>
    </div>
  );
}
