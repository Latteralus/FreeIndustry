import { useState } from 'react';
import type { CompanyView } from '../../shared/ipc/company';
import type { LeaseView } from '../../shared/ipc/real-estate';
import { Inspector } from '../components/Inspector';
import { Notice } from '../components/MessageBox';
import { formatCents, parseDollarsToCents } from '../app/money-input';
import type { SimulationHostView } from '../app/useSimulationHost';

/**
 * Company window (Company → Company Profile). Before a company exists it
 * founds one: a real command, with the owner's cash as the only asset (no
 * premises, staff, machines or stock). Afterwards it shows the company's
 * identity and liquidity from the worker's read model; nothing here computes
 * a balance.
 */

export interface CompanyWindowProps {
  readonly company: CompanyView | null;
  readonly host: Pick<SimulationHostView, 'submit' | 'pending'>;
  /** The outcome of the last request, in words. */
  readonly outcome: string;
  /** The company's current lease, if any. */
  readonly premises: LeaseView | null;
  readonly onOpenWindow: (id: 'accounts' | 'bills' | 'city') => void;
}

export function CompanyWindow({
  company,
  host,
  outcome,
  premises,
  onOpenWindow,
}: CompanyWindowProps) {
  return company ? (
    <CompanyProfile
      company={company}
      outcome={outcome}
      premises={premises}
      onOpenWindow={onOpenWindow}
    />
  ) : (
    <FoundingForm host={host} outcome={outcome} />
  );
}

function FoundingForm({ host, outcome }: Pick<CompanyWindowProps, 'host' | 'outcome'>) {
  const [legalName, setLegalName] = useState('');
  const [presidentName, setPresidentName] = useState('');
  const [capital, setCapital] = useState('50,000');
  const capitalCents = parseDollarsToCents(capital);
  const ready =
    legalName.trim().length > 0 && presidentName.trim().length > 0 && capitalCents !== null;

  return (
    <div className="window-content">
      <p>
        No company has been founded. It starts with only the owner&apos;s cash: no premises, staff,
        machines or stock. To found it together with its premises, lease a property from the City
        View instead.
      </p>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (capitalCents !== null) {
            void host.submit('company.found', {
              legalName,
              presidentName,
              startingCapitalCents: capitalCents,
            });
          }
        }}
      >
        <label htmlFor="company-name">Company name</label>
        <input
          id="company-name"
          value={legalName}
          maxLength={60}
          onChange={(event) => {
            setLegalName(event.target.value);
          }}
        />
        <label htmlFor="president-name">President</label>
        <input
          id="president-name"
          value={presidentName}
          maxLength={60}
          onChange={(event) => {
            setPresidentName(event.target.value);
          }}
        />
        <label htmlFor="starting-capital">Starting capital ($)</label>
        <input
          id="starting-capital"
          inputMode="decimal"
          value={capital}
          onChange={(event) => {
            setCapital(event.target.value);
          }}
        />
        <span />
        <button type="submit" disabled={host.pending || !ready}>
          Found company
        </button>
      </form>
      <p className="outcome" data-testid="company-outcome">
        {outcome}
      </p>
    </div>
  );
}

function CompanyProfile({
  company,
  outcome,
  premises,
  onOpenWindow,
}: {
  readonly company: CompanyView;
  readonly outcome: string;
  readonly premises: LeaseView | null;
  readonly onOpenWindow: CompanyWindowProps['onOpenWindow'];
}) {
  const { liquidity } = company;
  const shortfall = BigInt(liquidity.overdueShortfallCents) > 0n;
  return (
    <div className="window-content">
      <h2 className="window-heading">{company.legalName}</h2>
      {shortfall && (
        <Notice kind="warning" testId="company-shortfall">
          Overdue bills exceed the funds available by {formatCents(liquidity.overdueShortfallCents)}
          . Payments beyond the available funds are refused; nothing is overdrawn.
        </Notice>
      )}
      <Inspector
        label="Company profile"
        fields={[
          { label: 'President', value: company.president.name },
          { label: 'Founded', value: company.foundedOn },
          {
            label: 'Financing',
            value: `Owner's funds: ${formatCents(company.startingCapitalCents)}`,
          },
          {
            label: 'Cash at bank',
            value: formatCents(liquidity.cashCents),
            testId: 'company-cash',
          },
          {
            label: 'Available funds',
            value: `${formatCents(liquidity.availableCents)} (no credit until banking exists)`,
            testId: 'company-available',
          },
          {
            label: 'Bills open',
            value: `${formatCents(liquidity.payablesOpenCents)}, of which overdue ${formatCents(liquidity.payablesOverdueCents)}`,
            testId: 'company-payables',
          },
          { label: 'Owed to us', value: formatCents(liquidity.receivablesOpenCents) },
          {
            label: 'Premises',
            value: premises
              ? `${premises.address}: leased ${premises.startedOn} to ${premises.endsOn}, ${formatCents(premises.rentCentsPerMonth)} a month${premises.nextRentOn ? `, next rent ${premises.nextRentOn}` : ''}${premises.standingOrder ? ' (standing order)' : ''}`
              : 'None: lease a property from the City View',
            testId: 'company-premises',
          },
          { label: 'Staff', value: 'None (personnel is not built yet)' },
        ]}
      />
      <div className="button-row">
        <button
          type="button"
          onClick={() => {
            onOpenWindow('accounts');
          }}
        >
          Accounts…
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenWindow('bills');
          }}
        >
          Bills and Obligations…
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenWindow('city');
          }}
        >
          City View…
        </button>
      </div>
      <p className="outcome" data-testid="company-outcome">
        {outcome}
      </p>
    </div>
  );
}
