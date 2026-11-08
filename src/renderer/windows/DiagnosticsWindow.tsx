import { useState } from 'react';
import { MAX_PROBE_DELAY_MS, MAX_TEST_OBLIGATION_START_DAYS } from '../../shared/ipc/commands';
import type { WorkerStatus, WorldSnapshot } from '../../shared/ipc/contract';
import { Inspector } from '../components/Inspector';
import { Tabs, selectedTab } from '../components/Tabs';
import { describeLastStop, formatSimDuration } from '../app/clock-format';
import { withTab, type WindowViewProps } from '../app/desktop/window-catalog';
import { parseDollarsToCents } from '../app/money-input';
import type { SimulationHostView } from '../app/useSimulationHost';
import { WORKER_STATE_LABEL } from '../app/worker-format';

/**
 * Simulation Diagnostics (Help → Simulation Diagnostics). Development
 * instruments, clearly labelled as such (ADR-0016, ADR-0024, ADR-0032): the
 * world's identity and fingerprints, the kernel's probe commands, and the
 * test obligation that exercises bills before leases exist. None of it is a
 * game feature.
 */

const TABS = [
  { id: 'world', label: 'World' },
  { id: 'probes', label: 'Probes' },
  { id: 'obligations', label: 'Test obligations' },
] as const;

export interface DiagnosticsWindowProps extends WindowViewProps {
  readonly worker: WorkerStatus | null;
  readonly world: WorldSnapshot | null;
  readonly host: Pick<SimulationHostView, 'submit' | 'pending'>;
  readonly outcome: string;
}

export function DiagnosticsWindow({
  worker,
  world,
  host,
  outcome,
  view,
  onViewChange,
}: DiagnosticsWindowProps) {
  const tab = selectedTab(TABS, view.tab);
  return (
    <div className="window-content">
      <p className="hint">Development instruments: not part of the game.</p>
      <Tabs
        idPrefix="diagnostics"
        label="Diagnostics"
        tabs={TABS}
        selected={tab}
        onSelect={(next) => {
          onViewChange(withTab(view, next));
        }}
      >
        {tab === 'world' && <WorldTab worker={worker} world={world} />}
        {tab === 'probes' && <ProbesTab world={world} host={host} outcome={outcome} />}
        {tab === 'obligations' && <TestObligationTab world={world} host={host} outcome={outcome} />}
      </Tabs>
    </div>
  );
}

function WorldTab({ worker, world }: Pick<DiagnosticsWindowProps, 'worker' | 'world'>) {
  const clock = world?.clock ?? null;
  return (
    <Inspector
      label="World"
      fields={[
        {
          label: 'Worker',
          value: worker
            ? `${WORKER_STATE_LABEL[worker.state]} (generation ${worker.generation})`
            : '—',
        },
        { label: 'World instance', value: world?.worldInstanceId ?? '—', testId: 'world-instance' },
        { label: 'World ID', value: world?.session?.worldId ?? '—' },
        { label: 'World revision', value: world?.worldRevision ?? '—', testId: 'world-revision' },
        { label: 'Seed', value: world?.seed ?? '—', testId: 'world-seed' },
        {
          label: 'Elapsed',
          value: clock ? formatSimDuration(clock.nowMs) : '—',
          testId: 'sim-elapsed',
        },
        {
          label: 'Last advance',
          value: clock ? describeLastStop(clock.lastStop) : '—',
          testId: 'sim-last-stop',
        },
        { label: 'Pending events', value: world?.queue.pending ?? '—', testId: 'sim-pending' },
        {
          label: 'Journal',
          value: world ? `${world.journal.commands} commands, ${world.journal.events} events` : '—',
          testId: 'sim-journal',
        },
        {
          label: 'State hash',
          value: world?.fingerprint.stateHash ?? '—',
          testId: 'state-hash',
          code: true,
        },
        {
          label: 'Journal hash',
          value: world?.fingerprint.journalHash ?? '—',
          testId: 'journal-hash',
          code: true,
        },
      ]}
    />
  );
}

function ProbesTab({
  world,
  host,
  outcome,
}: Pick<DiagnosticsWindowProps, 'world' | 'host' | 'outcome'>) {
  const [probeLabel, setProbeLabel] = useState('probe');
  const [delayMinutes, setDelayMinutes] = useState('30');
  const delay = Number(delayMinutes);
  const delayValid = Number.isInteger(delay) && delay >= 1 && delay * 60_000 <= MAX_PROBE_DELAY_MS;
  const diagnostics = world?.diagnostics ?? null;

  return (
    <>
      <p>
        <em>Send probe</em> changes the world at once. <em>Schedule probe</em> queues a simulation
        event that fires after the given simulated delay and draws a token from the world&apos;s
        seeded random stream.
      </p>
      <form
        className="form-row"
        onSubmit={(event) => {
          event.preventDefault();
          void host.submit('diagnostics.recordProbe', { label: probeLabel });
        }}
      >
        <label htmlFor="probe-label">Probe label</label>
        <input
          id="probe-label"
          value={probeLabel}
          maxLength={80}
          onChange={(event) => {
            setProbeLabel(event.target.value);
          }}
        />
        <button type="submit" disabled={host.pending || world === null}>
          Send probe
        </button>
      </form>
      <form
        className="form-row"
        onSubmit={(event) => {
          event.preventDefault();
          void host.submit('diagnostics.scheduleProbe', {
            label: probeLabel,
            delayMs: delay * 60_000,
          });
        }}
      >
        <label htmlFor="probe-delay">Delay (simulated minutes)</label>
        <input
          id="probe-delay"
          inputMode="numeric"
          size={6}
          value={delayMinutes}
          onChange={(event) => {
            setDelayMinutes(event.target.value);
          }}
        />
        <button type="submit" disabled={host.pending || world === null || !delayValid}>
          Schedule probe
        </button>
      </form>
      <Inspector
        label="Probes"
        fields={[
          {
            label: 'Probes recorded',
            value: diagnostics?.probeCount ?? '—',
            testId: 'probe-count',
          },
          { label: 'Last probe', value: diagnostics?.lastProbeLabel ?? '—' },
          {
            label: 'Probes pending',
            value: diagnostics?.pendingProbes ?? '—',
            testId: 'probes-pending',
          },
          { label: 'Probes fired', value: diagnostics?.firedProbes ?? '—', testId: 'probes-fired' },
          {
            label: 'Last fired',
            value: diagnostics?.lastFiredProbe
              ? `${diagnostics.lastFiredProbe.label} at ${formatSimDuration(diagnostics.lastFiredProbe.firedAtMs)}, token ${diagnostics.lastFiredProbe.token}`
              : '—',
            testId: 'last-fired',
          },
          { label: 'Last result', value: outcome, testId: 'last-outcome' },
        ]}
      />
    </>
  );
}

function TestObligationTab({
  world,
  host,
  outcome,
}: Pick<DiagnosticsWindowProps, 'world' | 'host' | 'outcome'>) {
  const [purpose, setPurpose] = useState<'rent' | 'security-deposit'>('rent');
  const [amount, setAmount] = useState('1,500');
  const [cadence, setCadence] = useState<'once' | 'monthly'>('monthly');
  const [occurrences, setOccurrences] = useState('12');
  const [startDays, setStartDays] = useState('0');
  const [termsDays, setTermsDays] = useState('0');
  const [standingOrder, setStandingOrder] = useState(true);
  const amountCents = parseDollarsToCents(amount);
  const count = cadence === 'once' ? 1 : Number(occurrences);
  const start = Number(startDays);
  const terms = Number(termsDays);
  const valid =
    amountCents !== null &&
    Number.isInteger(count) &&
    count >= 1 &&
    count <= 120 &&
    Number.isInteger(start) &&
    start >= 0 &&
    start <= MAX_TEST_OBLIGATION_START_DAYS &&
    Number.isInteger(terms) &&
    terms >= 0 &&
    terms <= 90;

  if (!world?.company) {
    return <p>Found a company first: test obligations bill the company.</p>;
  }
  return (
    <section aria-labelledby="test-obligation-heading">
      <h3 id="test-obligation-heading">Accounting diagnostics (development only)</h3>
      <p>
        Commits the company to a rent or deposit schedule with a fictional &quot;Diagnostic
        landlord&quot;, to exercise bills, standing orders and overdue handling before leases exist.
      </p>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            void host.submit('diagnostics.addTestObligation', {
              purpose,
              amountCents,
              cadence,
              occurrences: count,
              firstBillInDays: start,
              paymentTermsDays: terms,
              standingOrder,
            });
          }
        }}
      >
        <label htmlFor="obligation-purpose">Purpose</label>
        <select
          id="obligation-purpose"
          value={purpose}
          onChange={(event) => {
            setPurpose(event.target.value === 'rent' ? 'rent' : 'security-deposit');
          }}
        >
          <option value="rent">Rent</option>
          <option value="security-deposit">Security deposit</option>
        </select>
        <label htmlFor="obligation-amount">Amount ($)</label>
        <input
          id="obligation-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
        <label htmlFor="obligation-cadence">Schedule</label>
        <select
          id="obligation-cadence"
          value={cadence}
          onChange={(event) => {
            setCadence(event.target.value === 'once' ? 'once' : 'monthly');
          }}
        >
          <option value="monthly">Monthly</option>
          <option value="once">Once</option>
        </select>
        <label htmlFor="obligation-occurrences">Months</label>
        <input
          id="obligation-occurrences"
          inputMode="numeric"
          size={4}
          disabled={cadence === 'once'}
          value={cadence === 'once' ? '1' : occurrences}
          onChange={(event) => {
            setOccurrences(event.target.value);
          }}
        />
        <label htmlFor="obligation-start">First bill in (days)</label>
        <input
          id="obligation-start"
          inputMode="numeric"
          size={4}
          value={startDays}
          onChange={(event) => {
            setStartDays(event.target.value);
          }}
        />
        <label htmlFor="obligation-terms">Payment terms (days)</label>
        <input
          id="obligation-terms"
          inputMode="numeric"
          size={4}
          value={termsDays}
          onChange={(event) => {
            setTermsDays(event.target.value);
          }}
        />
        <label htmlFor="obligation-standing-order">Standing order</label>
        <input
          id="obligation-standing-order"
          type="checkbox"
          checked={standingOrder}
          onChange={(event) => {
            setStandingOrder(event.target.checked);
          }}
        />
        <span />
        <button type="submit" disabled={host.pending || !valid}>
          Add test obligation
        </button>
      </form>
      <p className="outcome" data-testid="obligation-outcome">
        {outcome}
      </p>
    </section>
  );
}
