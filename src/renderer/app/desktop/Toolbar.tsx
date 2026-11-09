import { ADVANCE_TARGETS, type ClockControl } from '../../../shared/ipc/clock';
import type { WorldSnapshot } from '../../../shared/ipc/contract';
import { speedName, targetName } from '../clock-format';
import { RUN_SPEEDS, type RunSpeed } from './menus';
import type { WindowId } from './window-catalog';

/**
 * The toolbar (spec §3.2: City View, Factory, Equipment Catalog, Personnel,
 * Inbox, Bank, Reports, Pause/Run, Speed). Buttons for systems that are not
 * built yet are disabled, with the reason as their tooltip. Clock buttons
 * send clock-control requests, never world commands (ADR-0023).
 */

export interface ToolbarProps {
  readonly clock: WorldSnapshot['clock'] | null;
  /** The speed Run resumes at. */
  readonly runSpeed: RunSpeed;
  readonly onControl: (control: ClockControl) => void;
  readonly onRunSpeed: (speed: RunSpeed) => void;
  readonly onOpenWindow: (id: WindowId) => void;
  /** Show the factory in layout mode. */
  readonly onFactory: () => void;
}

const NOT_BUILT: readonly { label: string; reason: string }[] = [
  { label: 'Personnel', reason: 'Not built yet: employees.' },
  { label: 'Inbox', reason: 'Not built yet: memos and applications.' },
  { label: 'Bank', reason: 'Not built yet: bank accounts and loans.' },
];

export function Toolbar({
  clock,
  runSpeed,
  onControl,
  onRunSpeed,
  onOpenWindow,
  onFactory,
}: ToolbarProps) {
  const noWorld = clock === null;
  const running = clock !== null && (clock.speed !== 'paused' || clock.advance !== null);
  return (
    <div role="toolbar" aria-label="Main toolbar" className="toolbar">
      <div className="toolbar-group">
        <button
          type="button"
          title="The city's districts and properties"
          onClick={() => {
            onOpenWindow('city');
          }}
        >
          City View
        </button>
        <button type="button" title="The factory floor in layout mode" onClick={onFactory}>
          Factory
        </button>
        <button
          type="button"
          title="Machines, benches, racks and furniture"
          onClick={() => {
            onOpenWindow('equipment');
          }}
        >
          Equipment Catalog
        </button>
        {NOT_BUILT.map((item) => (
          <button key={item.label} type="button" disabled title={item.reason}>
            {item.label}
          </button>
        ))}
        <button
          type="button"
          title="Accounts (internal inspection)"
          onClick={() => {
            onOpenWindow('accounts');
          }}
        >
          Reports
        </button>
      </div>
      <div className="toolbar-group" role="group" aria-label="Simulation speed">
        <button
          type="button"
          disabled={noWorld}
          title={running ? 'Pause the simulation (Pause)' : 'Run the simulation (Pause)'}
          onClick={() => {
            onControl({ action: 'setSpeed', speed: running ? 'paused' : runSpeed });
          }}
        >
          {running ? 'Pause' : 'Run'}
        </button>
        {RUN_SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            aria-pressed={clock?.speed === speed && clock.advance === null}
            disabled={noWorld}
            onClick={() => {
              onRunSpeed(speed);
              onControl({ action: 'setSpeed', speed });
            }}
          >
            {speedName(speed)}
          </button>
        ))}
      </div>
      <div className="toolbar-group" role="group" aria-label="Advance">
        {ADVANCE_TARGETS.map((until) => (
          <button
            key={until}
            type="button"
            aria-pressed={clock?.advance?.until === until}
            disabled={noWorld}
            onClick={() => {
              onControl({ action: 'advance', until });
            }}
          >
            {targetName(until)}
          </button>
        ))}
      </div>
    </div>
  );
}
