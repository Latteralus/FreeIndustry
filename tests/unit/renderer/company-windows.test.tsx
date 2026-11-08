import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import type { WindowView } from '../../../src/renderer/app/desktop/window-model';
import { AccountsWindow } from '../../../src/renderer/windows/AccountsWindow';
import { BillsWindow } from '../../../src/renderer/windows/BillsWindow';
import { CompanyWindow } from '../../../src/renderer/windows/CompanyWindow';
import { DiagnosticsWindow } from '../../../src/renderer/windows/DiagnosticsWindow';
import { SAMPLE_COMPANY_VIEW } from '../../support/sample-company-view';
import { sampleWorldSnapshot } from '../../support/world-snapshot';
import { WORLD } from '../../support/renderer-fakes';

function host() {
  return { submit: jest.fn(() => Promise.resolve(null)), pending: false };
}

/** Holds a window's view state as the desktop would, and records each change. */
function useViewHarness(initial: WindowView = {}) {
  const [view, setView] = useState<WindowView>(initial);
  return { view, onViewChange: setView };
}

describe('Company window', () => {
  it('founds a company with the capital converted to whole cents', () => {
    const fake = host();
    render(
      <CompanyWindow
        premises={null}
        company={null}
        host={fake}
        outcome="—"
        onOpenWindow={jest.fn()}
      />,
    );
    const found = screen.getByRole('button', { name: 'Found company' });
    expect(found).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('President'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Starting capital ($)'), { target: { value: '1.234' } });
    expect(found).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Starting capital ($)'), {
      target: { value: '$12,345.67' },
    });
    fireEvent.click(found);
    expect(fake.submit).toHaveBeenCalledWith('company.found', {
      legalName: 'Acme',
      presidentName: 'Ada',
      startingCapitalCents: '1234567',
    });
  });

  it('shows identity and liquidity from the read model, the shortfall, and opens the books', () => {
    const open = jest.fn();
    render(
      <CompanyWindow
        premises={null}
        company={SAMPLE_COMPANY_VIEW}
        host={host()}
        outcome="Accepted at revision 4"
        onOpenWindow={open}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Panel Works' })).toBeInTheDocument();
    expect(screen.getByTestId('company-cash')).toHaveTextContent('$4,000.00');
    expect(screen.getByTestId('company-payables')).toHaveTextContent(
      '$7,000.00, of which overdue $7,000.00',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Overdue bills exceed the funds available by $3,000.00',
    );
    expect(screen.getByText('None: lease a property from the City View')).toBeInTheDocument();
    expect(screen.getByTestId('company-outcome')).toHaveTextContent('Accepted at revision 4');
    fireEvent.click(screen.getByRole('button', { name: 'Accounts…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bills and Obligations…' }));
    expect(open.mock.calls).toEqual([['accounts'], ['bills']]);
  });
});

describe('Accounts window', () => {
  function Harness() {
    const props = useViewHarness();
    return <AccountsWindow company={SAMPLE_COMPANY_VIEW} {...props} />;
  }

  it('shows a balanced trial balance and the ledger entries on their own tab', () => {
    render(<Harness />);
    const trial = within(screen.getByTestId('trial-balance'));
    expect(trial.getByText('Trial balance: balanced')).toBeInTheDocument();
    expect(screen.getByTestId('trial-debits')).toHaveTextContent('$12,000.00');
    expect(screen.getByTestId('trial-credits')).toHaveTextContent('$12,000.00');
    expect(trial.getByText('Rent expense').closest('tr')).toHaveTextContent('$7,000.00');
    fireEvent.click(screen.getByRole('tab', { name: 'Ledger entries' }));
    expect(screen.getByTestId('ledger-entries')).toHaveTextContent(
      'Dr 1010 $5,000.00; Cr 3000 $5,000.00',
    );
  });

  it('filters accounts by type; the totals stay those of the whole ledger', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'expense' } });
    const rows = within(screen.getByTestId('trial-balance')).getAllByRole('row');
    // Header, one expense account, totals.
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Rent expense');
    expect(screen.getByTestId('trial-debits')).toHaveTextContent('$12,000.00');
    expect(
      screen.getByText('The totals are for every account, not only those shown.'),
    ).toBeInTheDocument();
  });

  it('says plainly when there are no books', () => {
    render(<AccountsWindow company={null} view={{}} onViewChange={jest.fn()} />);
    expect(
      screen.getByText('No company has been founded, so there are no books yet.'),
    ).toBeInTheDocument();
  });
});

describe('Bills and Obligations window', () => {
  it('offers Pay only on open bills and pays the outstanding amount', () => {
    const fake = host();
    render(
      <BillsWindow
        company={SAMPLE_COMPANY_VIEW}
        host={fake}
        outcome="—"
        view={{}}
        onViewChange={jest.fn()}
      />,
    );
    const settled = within(screen.getByTestId('invoice-invoice:1'));
    expect(settled.getByText('Settled')).toBeInTheDocument();
    expect(settled.queryByRole('button')).toBeNull();
    const overdue = within(screen.getByTestId('invoice-invoice:2'));
    expect(overdue.getByText('Overdue')).toBeInTheDocument();
    fireEvent.click(overdue.getByRole('button', { name: 'Pay invoice:2 in full' }));
    expect(fake.submit).toHaveBeenCalledWith('finance.payInvoice', {
      invoiceId: 'invoice:2',
      amountCents: '700000',
    });
  });

  it('remembers its tab, filter and sort in the window view', () => {
    const changes: WindowView[] = [];
    function Harness() {
      const [view, setView] = useState<WindowView>({});
      return (
        <BillsWindow
          company={SAMPLE_COMPANY_VIEW}
          host={host()}
          outcome="—"
          view={view}
          onViewChange={(next) => {
            changes.push(next);
            setView(next);
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'settled' } });
    expect(screen.queryByTestId('invoice-invoice:2')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoice-invoice:1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Total' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Obligations' }));
    expect(screen.getByTestId('obligations')).toBeInTheDocument();
    expect(changes.at(-1)).toEqual({
      filters: { status: 'settled' },
      sort: { column: 'total', direction: 'asc' },
      tab: 'obligations',
    });
  });
});

describe('Diagnostics window', () => {
  it('is labelled as development instruments and shows the world identity', () => {
    const world = sampleWorldSnapshot(WORLD, { seed: 77 });
    render(
      <DiagnosticsWindow
        worker={{ state: 'ready', generation: 3, failure: null }}
        world={world}
        host={host()}
        outcome="—"
        view={{}}
        onViewChange={jest.fn()}
      />,
    );
    expect(screen.getByText('Development instruments: not part of the game.')).toBeInTheDocument();
    expect(screen.getByTestId('world-instance')).toHaveTextContent(WORLD);
    expect(screen.getByTestId('world-seed')).toHaveTextContent('77');
    expect(screen.getByText('Ready (generation 3)')).toBeInTheDocument();
  });

  it('the test-obligation form sends a labelled development command', () => {
    const fake = host();
    const world = sampleWorldSnapshot(WORLD, { company: SAMPLE_COMPANY_VIEW });
    render(
      <DiagnosticsWindow
        worker={null}
        world={world}
        host={fake}
        outcome="—"
        view={{ tab: 'obligations' }}
        onViewChange={jest.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Accounting diagnostics (development only)' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount ($)'), { target: { value: '2,250' } });
    fireEvent.change(screen.getByLabelText('Months'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('First bill in (days)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Payment terms (days)'), { target: { value: '14' } });
    fireEvent.click(screen.getByLabelText('Standing order'));
    fireEvent.click(screen.getByRole('button', { name: 'Add test obligation' }));
    expect(fake.submit).toHaveBeenCalledWith('diagnostics.addTestObligation', {
      purpose: 'rent',
      amountCents: '225000',
      cadence: 'monthly',
      occurrences: 6,
      firstBillInDays: 3,
      paymentTermsDays: 14,
      standingOrder: false,
    });
    fireEvent.change(screen.getByLabelText('Payment terms (days)'), { target: { value: '91' } });
    expect(screen.getByRole('button', { name: 'Add test obligation' })).toBeDisabled();
  });

  it('asks for a company before test obligations', () => {
    render(
      <DiagnosticsWindow
        worker={null}
        world={sampleWorldSnapshot(WORLD)}
        host={host()}
        outcome="—"
        view={{ tab: 'obligations' }}
        onViewChange={jest.fn()}
      />,
    );
    expect(
      screen.getByText('Found a company first: test obligations bill the company.'),
    ).toBeInTheDocument();
  });
});
