import { useState } from 'react';
import type { CompanyView } from '../../shared/ipc/company';
import type { PropertyView } from '../../shared/ipc/real-estate';
import { Dialog } from '../components/Dialog';
import { Inspector } from '../components/Inspector';
import { Notice } from '../components/MessageBox';
import type { Units } from '../app/desktop/profile-store';
import { formatCents, parseDollarsToCents } from '../app/money-input';
import { describeOutcome } from '../app/outcome';
import type { SimulationHostView } from '../app/useSimulationHost';
import { formatArea, formatDimensions, PROPERTY_KIND_LABEL } from '../app/units';

/**
 * Lease a property (plan Step 07, spec §3.1 steps 4–5). Without a company,
 * the same dialog founds it: name, president and the owner's starting
 * capital, and the lease is signed in the same command, so founding and
 * leasing succeed or fail together (ADR-0038). The worker decides; this
 * dialog only collects the terms and shows the listing's own figures.
 */

/** Term lengths offered, where the listing allows them. */
const TERM_CHOICES = [1, 3, 6, 12, 18, 24, 36, 48, 60, 84, 120];

export function termOptions(property: PropertyView): number[] {
  const terms = new Set(
    TERM_CHOICES.filter(
      (months) => months >= property.minTermMonths && months <= property.maxTermMonths,
    ),
  );
  terms.add(property.minTermMonths);
  terms.add(property.maxTermMonths);
  return [...terms].sort((a, b) => a - b);
}

export interface LeaseDialogProps {
  readonly property: PropertyView;
  readonly company: CompanyView | null;
  /** The scenario's suggested starting capital, for founding. */
  readonly defaultCapitalCents: string;
  readonly units: Units;
  readonly host: Pick<SimulationHostView, 'submit' | 'pending'>;
  readonly onClose: () => void;
  /** Called after the lease is signed. */
  readonly onLeased: () => void;
}

export function LeaseDialog({
  property,
  company,
  defaultCapitalCents,
  units,
  host,
  onClose,
  onLeased,
}: LeaseDialogProps) {
  const terms = termOptions(property);
  const [term, setTerm] = useState(String(terms.includes(12) ? 12 : (terms[0] ?? 1)));
  const [standingOrder, setStandingOrder] = useState(true);
  const [legalName, setLegalName] = useState('');
  const [presidentName, setPresidentName] = useState('');
  const [capital, setCapital] = useState(() =>
    formatCents(defaultCapitalCents).replace(/^\$/, '').replace(/\.00$/, ''),
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  const capitalCents = parseDollarsToCents(capital);
  const founding = company === null;
  const ready =
    !founding ||
    (legalName.trim().length > 0 && presidentName.trim().length > 0 && capitalCents !== null);
  const available = founding ? capitalCents : company.liquidity.availableCents;
  const shortOfFunds = available !== null && BigInt(available) < BigInt(property.upfrontCents);

  const submit = async () => {
    const premises = { propertyId: property.id, termMonths: Number(term), standingOrder };
    const outcome = founding
      ? capitalCents === null
        ? null
        : await host.submit('company.found', {
            legalName,
            presidentName,
            startingCapitalCents: capitalCents,
            premises,
          })
      : await host.submit('realEstate.lease', premises);
    if (outcome?.kind === 'accepted') {
      onLeased();
    } else if (outcome) {
      setRefusal(describeOutcome(outcome));
    }
  };

  return (
    <Dialog title={`Lease ${property.address}`} onClose={onClose} testId="lease-dialog">
      <Inspector
        label="Listing"
        fields={[
          {
            label: 'Property',
            value: `${PROPERTY_KIND_LABEL[property.kind]}, ${property.address}`,
          },
          {
            label: 'Floor',
            value: `${formatArea(property.areaMm2, units)} (${formatDimensions(property.widthMm, property.depthMm, units)})`,
          },
          { label: 'Rent', value: `${formatCents(property.rentCentsPerMonth)} a month` },
          {
            label: 'Due on signing',
            value: `${formatCents(property.upfrontCents)}: deposit ${formatCents(property.depositCents)} and the first month's rent`,
            testId: 'lease-upfront',
          },
          { label: 'Landlord', value: property.landlord },
        ]}
      />
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {founding && (
          <>
            <span className="form-grid-note">
              No company has been founded yet: it is founded with the lease.
            </span>
            <label htmlFor="lease-company-name">Company name</label>
            <input
              id="lease-company-name"
              value={legalName}
              maxLength={60}
              onChange={(event) => {
                setLegalName(event.target.value);
              }}
            />
            <label htmlFor="lease-president">President</label>
            <input
              id="lease-president"
              value={presidentName}
              maxLength={60}
              onChange={(event) => {
                setPresidentName(event.target.value);
              }}
            />
            <label htmlFor="lease-capital">Starting capital ($)</label>
            <input
              id="lease-capital"
              inputMode="decimal"
              value={capital}
              onChange={(event) => {
                setCapital(event.target.value);
              }}
            />
            <span>Financing</span>
            <span>Owner&apos;s own funds (loans and investors arrive with banking, Step 25)</span>
          </>
        )}
        <label htmlFor="lease-term">Lease term</label>
        <select
          id="lease-term"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
          }}
        >
          {terms.map((months) => (
            <option key={months} value={String(months)}>
              {months} month{months === 1 ? '' : 's'}
            </option>
          ))}
        </select>
        <label htmlFor="lease-standing-order">Standing order</label>
        <span>
          <input
            id="lease-standing-order"
            type="checkbox"
            checked={standingOrder}
            onChange={(event) => {
              setStandingOrder(event.target.checked);
            }}
          />{' '}
          The bank pays each month&apos;s rent on its due date
        </span>
        {!founding && (
          <>
            <span>Available funds</span>
            <span data-testid="lease-available">
              {formatCents(company.liquidity.availableCents)}
            </span>
          </>
        )}
        <span />
        <span className="button-row">
          <button type="submit" disabled={host.pending || !ready}>
            {founding ? 'Found company and sign lease' : 'Sign lease'}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </span>
      </form>
      {shortOfFunds && (
        <Notice kind="warning">
          The funds do not cover what is due on signing; the landlord will refuse the lease.
        </Notice>
      )}
      {refusal !== null && (
        <p className="outcome" role="alert" data-testid="lease-refusal">
          {refusal}
        </p>
      )}
    </Dialog>
  );
}
