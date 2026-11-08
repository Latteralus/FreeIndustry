import { PRODUCT_NAME } from '../../shared/app-identity';
import type { FreeIndustryBridge } from '../../shared/bridge';

export interface AppProps {
  /** Runtime versions from the preload bridge, or null if the bridge is absent. */
  readonly runtime: FreeIndustryBridge['runtime'] | null;
}

/**
 * Step 01 development shell. It proves the Electron → preload → React path
 * works. It intentionally contains no menus, windows or game controls: the
 * classic desktop arrives in Step 06, and nothing here pretends to be a
 * working feature.
 */
export function App({ runtime }: AppProps) {
  return (
    <div className="shell">
      <header className="shell-titlebar">{PRODUCT_NAME}</header>
      <main className="shell-workspace">
        <section className="shell-notice" aria-labelledby="shell-notice-heading">
          <h1 id="shell-notice-heading">{PRODUCT_NAME} development shell</h1>
          <p>
            Repository foundation only. No simulation, company or factory exists yet, and no game
            commands are available.
          </p>
        </section>
      </main>
      <footer className="shell-statusbar" aria-label="Status bar">
        <span>Simulation: not implemented</span>
        <span data-testid="runtime-versions">
          {runtime
            ? `Electron ${runtime.electron} · Chromium ${runtime.chrome} · Node ${runtime.node}`
            : 'Preload bridge unavailable'}
        </span>
      </footer>
    </div>
  );
}
