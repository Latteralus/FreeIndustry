import { useId, useState } from 'react';
import type { ScenarioSummary } from '../../shared/ipc/real-estate';
import { Dialog } from '../components/Dialog';
import { Notice } from '../components/MessageBox';
import { formatCents } from '../app/money-input';

/**
 * New Company and Scenarios (File menu and Main Menu; plan Step 07, spec
 * §3.1 steps 1 and 5): choose the scenario a new world starts from and,
 * optionally, its seed. Starting replaces the current world; the worker
 * autosaves it first if it has changes not yet written anywhere.
 */

export interface NewWorldDialogProps {
  readonly title: 'New Company' | 'Scenarios';
  readonly scenarios: readonly ScenarioSummary[];
  readonly initialScenarioId: string;
  readonly unsavedChanges: boolean;
  readonly busy: boolean;
  readonly onStart: (scenarioId: string, seed: number | null) => void;
  readonly onClose: () => void;
}

const SEED = /^(?:0|[1-9][0-9]{0,9})$/;

export function NewWorldDialog({
  title,
  scenarios,
  initialScenarioId,
  unsavedChanges,
  busy,
  onStart,
  onClose,
}: NewWorldDialogProps) {
  const group = useId();
  const [scenarioId, setScenarioId] = useState(
    scenarios.some((scenario) => scenario.id === initialScenarioId)
      ? initialScenarioId
      : (scenarios[0]?.id ?? ''),
  );
  const [seedText, setSeedText] = useState('');
  const seed = seedText.trim() === '' ? null : SEED.test(seedText.trim()) ? Number(seedText) : NaN;
  const seedValid = seed === null || (Number.isSafeInteger(seed) && seed <= 0xffff_ffff);
  const chosen = scenarios.find((scenario) => scenario.id === scenarioId);

  return (
    <Dialog title={title} onClose={onClose} testId="new-world-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen && seedValid) {
            onStart(chosen.id, seed);
          }
        }}
      >
        <fieldset className="scenario-list">
          <legend>Scenario</legend>
          {scenarios.map((scenario) => (
            <label key={scenario.id} className="scenario-option">
              <input
                type="radio"
                name={group}
                value={scenario.id}
                checked={scenario.id === scenarioId}
                onChange={() => {
                  setScenarioId(scenario.id);
                }}
              />{' '}
              <strong>{scenario.name}</strong>
              <span className="scenario-description">
                {scenario.description} Starts {scenario.epoch}; suggested capital{' '}
                {formatCents(scenario.defaultCapitalCents)}.
              </span>
            </label>
          ))}
        </fieldset>
        <div className="form-grid">
          <label htmlFor="new-world-seed">World seed (optional)</label>
          <input
            id="new-world-seed"
            inputMode="numeric"
            value={seedText}
            placeholder="random"
            onChange={(event) => {
              setSeedText(event.target.value);
            }}
          />
        </div>
        {!seedValid && (
          <Notice kind="warning">A seed is a whole number from 0 to 4,294,967,295.</Notice>
        )}
        {unsavedChanges && (
          <Notice kind="info">
            The current world has unsaved changes. It is autosaved before the new world starts.
          </Notice>
        )}
        <div className="button-row">
          <button type="submit" disabled={busy || !chosen || !seedValid}>
            {chosen?.quickStart ? 'Quick Start' : 'Start'}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
