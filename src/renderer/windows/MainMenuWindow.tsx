import type { CompanyView } from '../../shared/ipc/company';
import type { RealEstateView, ScenarioSummary } from '../../shared/ipc/real-estate';
import { PRODUCT_NAME } from '../../shared/app-identity';

/**
 * The main menu (plan Step 07, spec §3.1 step 1): New Company, Quick Start,
 * Load, Scenarios, Options, Help and Exit, as an ordinary desktop window that
 * opens at start-up and can be closed or reopened (File → Main Menu). Every
 * button does something real; none is a placeholder.
 */

interface MainMenuActions {
  readonly newCompany: () => void;
  readonly quickStart: () => void;
  readonly load: () => void;
  readonly scenarios: () => void;
  readonly options: () => void;
  readonly help: () => void;
  readonly exit: () => void;
}

export interface MainMenuWindowProps {
  readonly actions: MainMenuActions;
  readonly worldReady: boolean;
  readonly savesAvailable: boolean;
  readonly busy: boolean;
  readonly company: CompanyView | null;
  readonly realEstate: RealEstateView | null;
  readonly scenarios: readonly ScenarioSummary[];
}

export function MainMenuWindow({
  actions,
  worldReady,
  savesAvailable,
  busy,
  company,
  realEstate,
  scenarios,
}: MainMenuWindowProps) {
  const quick = scenarios.find((scenario) => scenario.quickStart !== null);
  const premises = realEstate?.leases.find((lease) => lease.status === 'active');
  const noWorld = !worldReady || busy;
  return (
    <div className="window-content main-menu">
      <p className="main-menu-title">{PRODUCT_NAME}</p>
      <p className="main-menu-status" data-testid="main-menu-status">
        {!worldReady
          ? 'The simulation is not running.'
          : company
            ? `${company.legalName}${premises ? `, ${premises.address}` : ', no premises'}.`
            : `No company has been founded in this world${realEstate ? ` (${realEstate.scenario.name})` : ''}.`}
      </p>
      <div className="main-menu-buttons">
        <button type="button" disabled={noWorld} onClick={actions.newCompany}>
          New Company…
        </button>
        <button
          type="button"
          disabled={noWorld || !quick}
          title={quick ? quick.description : 'No quick-start scenario in this build.'}
          onClick={actions.quickStart}
        >
          Quick Start
        </button>
        <button type="button" disabled={!savesAvailable} onClick={actions.load}>
          Load…
        </button>
        <button type="button" disabled={noWorld} onClick={actions.scenarios}>
          Scenarios…
        </button>
        <button type="button" onClick={actions.options}>
          Options…
        </button>
        <button type="button" onClick={actions.help}>
          Help
        </button>
        <button type="button" onClick={actions.exit}>
          Exit
        </button>
      </div>
    </div>
  );
}
