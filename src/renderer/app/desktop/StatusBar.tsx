import type { WorkerStatus, WorldSnapshot } from '../../../shared/ipc/contract';
import { describeSpeed, formatDate, formatTime, targetName } from '../clock-format';
import { formatCents } from '../money-input';
import { WORKER_STATE_LABEL } from '../worker-format';

/**
 * The status bar (spec §3.2): date and time, active facility, cash, credit,
 * alerts, selected object, speed and simulation state, plus the last
 * message. Everything is read from the worker's snapshot.
 */

export interface Alert {
  readonly id: string;
  readonly text: string;
  /** The window that explains it, if any. */
  readonly opens: (() => void) | null;
}

export interface StatusBarProps {
  readonly worker: WorkerStatus | null;
  readonly world: WorldSnapshot | null;
  readonly alerts: readonly Alert[];
  readonly message: string | null;
  /** The address of the company's premises, or null. */
  readonly facility: string | null;
}

export function StatusBar({ worker, world, alerts, message, facility }: StatusBarProps) {
  const clock = world?.clock ?? null;
  const company = world?.company ?? null;
  const first = alerts[0];
  return (
    <footer className="statusbar" aria-label="Status bar">
      <span className="status-cell status-cell-clock">
        <span data-testid="sim-date">{clock ? formatDate(clock.calendar) : '—'}</span>{' '}
        <span data-testid="sim-time">{clock ? formatTime(clock.calendar) : '—'}</span>
      </span>
      <span className="status-cell" data-testid="status-facility">
        Facility: {facility ?? 'none'}
      </span>
      <span className="status-cell" data-testid="status-cash">
        Cash: {company ? formatCents(company.liquidity.cashCents) : '—'}
      </span>
      <span className="status-cell" data-testid="status-credit">
        Credit: {company ? formatCents(company.liquidity.creditAvailableCents) : '—'}
      </span>
      <span className="status-cell" data-testid="status-alerts">
        {first ? (
          <button
            type="button"
            className="status-button status-alert"
            title={alerts.map((alert) => alert.text).join('\n')}
            disabled={first.opens === null}
            onClick={() => {
              first.opens?.();
            }}
          >
            Alerts: {alerts.length} · {first.text}
          </button>
        ) : (
          'Alerts: 0'
        )}
      </span>
      <span className="status-cell" data-testid="status-selected">
        Selected: none
      </span>
      <span className="status-cell" data-testid="sim-speed">
        {clock
          ? clock.advance
            ? `Advancing: ${targetName(clock.advance.until)}`
            : describeSpeed(clock.speed)
          : '—'}
      </span>
      <span className="status-cell" title="Simulation worker">
        Simulation:{' '}
        <span data-testid="worker-state">
          {worker ? WORKER_STATE_LABEL[worker.state] : 'Unavailable'}
        </span>
      </span>
      <span className="status-cell status-cell-message" data-testid="status-message" role="status">
        {message ?? ''}
      </span>
    </footer>
  );
}
