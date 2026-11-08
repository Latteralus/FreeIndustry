import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, type AppProps } from '../../../src/renderer/app/App';
import { LAYOUT_KEY } from '../../../src/renderer/app/desktop/layout-codec';
import { memoryProfileStore } from '../../../src/renderer/app/desktop/profile-store';
import { WINDOW_CATALOG } from '../../../src/renderer/app/desktop/window-catalog';
import { reduceLayout, type DesktopLayout } from '../../../src/renderer/app/desktop/window-model';
import {
  COMMAND,
  FakeSaves,
  FakeSimulation,
  FakeWorkspace,
  OTHER_WORLD,
  saveSummary,
  WORLD,
} from '../../support/renderer-fakes';
import { SAMPLE_COMPANY_VIEW } from '../../support/sample-company-view';
import {
  leasedRealEstate,
  sampleRealEstate,
  sampleScenarios,
} from '../../support/sample-real-estate';
import { sampleWorldSnapshot } from '../../support/world-snapshot';

async function settle() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  });
}

async function renderApp(props: Partial<AppProps> & { simulation?: FakeSimulation | null } = {}) {
  const simulation = props.simulation === undefined ? new FakeSimulation() : props.simulation;
  const view = render(
    <App
      runtime={null}
      newCommandId={() => COMMAND}
      layoutWriteDelayMs={5}
      {...props}
      simulation={simulation}
    />,
  );
  await settle();
  return { ...view, simulation };
}

function chooseMenu(menu: string, item: string) {
  fireEvent.click(screen.getByRole('menuitem', { name: menu }));
  const popup = within(screen.getByRole('menu'));
  const command =
    popup.queryByRole('menuitem', { name: item }) ??
    popup.getByRole('menuitemradio', { name: item });
  fireEvent.click(command);
}

const windowFrame = (title: string) => screen.getByRole('dialog', { name: title });

const layoutWith = (...actions: Parameters<typeof reduceLayout>[1][]): DesktopLayout =>
  actions.reduce(
    (layout, action) => reduceLayout(layout, action, WINDOW_CATALOG, null),
    WINDOW_CATALOG.defaultLayout(),
  );

describe('classic business desktop', () => {
  it('has the menubar, toolbar, factory viewport, windows and status bar of the specification', async () => {
    await renderApp();
    expect(screen.getAllByRole('menuitem').map((item) => item.getAttribute('aria-label'))).toEqual([
      'File',
      'View',
      'Company',
      'City',
      'Catalog',
      'Personnel',
      'Operations',
      'Purchasing',
      'Sales',
      'Contracts',
      'Research',
      'Finance',
      'Reports',
      'Window',
      'Help',
    ]);
    const toolbar = screen.getByRole('toolbar', { name: 'Main toolbar' });
    for (const name of ['Factory', 'Equipment Catalog', 'Personnel', 'Inbox', 'Bank']) {
      const button = within(toolbar).getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button.getAttribute('title')).toMatch(/^Not built yet/);
    }
    expect(within(toolbar).getByRole('button', { name: 'Reports' })).toBeEnabled();
    expect(within(toolbar).getByRole('button', { name: 'City View' })).toBeEnabled();
    // The main menu opens beside the Company window (Step 07).
    expect(windowFrame('Main Menu')).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Factory floor' })).toHaveTextContent('No facility');
    expect(windowFrame('Company')).toHaveTextContent('No company has been founded.');
    const status = screen.getByRole('contentinfo', { name: 'Status bar' });
    expect(status).toHaveTextContent('Mon 1 Jan 1996 00:00:00');
    expect(status).toHaveTextContent('Facility: none');
    expect(status).toHaveTextContent('Cash: —');
    expect(status).toHaveTextContent('Alerts: 0');
    expect(status).toHaveTextContent('Selected: none');
    expect(screen.getByTestId('sim-speed')).toHaveTextContent('Paused');
    expect(screen.getByTestId('worker-state')).toHaveTextContent('Ready');
  });

  it('shows cash, credit and the overdue shortfall in the status bar', async () => {
    const simulation = new FakeSimulation();
    simulation.snapshot = {
      ...simulation.snapshot,
      world: sampleWorldSnapshot(WORLD, { company: SAMPLE_COMPANY_VIEW }),
    };
    await renderApp({ simulation });
    expect(screen.getByTestId('status-cash')).toHaveTextContent('Cash: $4,000.00');
    expect(screen.getByTestId('status-credit')).toHaveTextContent('Credit: $0.00');
    const alerts = within(screen.getByTestId('status-alerts')).getByRole('button');
    expect(alerts).toHaveTextContent(
      'Alerts: 1 · Overdue bills exceed available funds by $3,000.00',
    );
    fireEvent.click(alerts);
    expect(windowFrame('Bills and Obligations')).toBeInTheDocument();
  });

  it('several windows stay open and interactive together over the factory viewport', async () => {
    const { simulation } = await renderApp();
    chooseMenu('Finance', 'Accounts…');
    chooseMenu('Help', 'Simulation Diagnostics…');
    chooseMenu('Finance', 'Bills and Obligations…');
    expect(
      screen.getAllByRole('dialog').map((frame) => frame.getAttribute('data-window-id')),
    ).toEqual(['main-menu', 'company', 'accounts', 'bills', 'diagnostics']);
    expect(windowFrame('Bills and Obligations')).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('region', { name: 'Factory floor' })).toBeInTheDocument();

    // Use the Diagnostics window, then the Company window, without closing anything.
    const diagnostics = windowFrame('Simulation Diagnostics');
    fireEvent.click(within(diagnostics).getByRole('tab', { name: 'Probes' }));
    fireEvent.change(within(diagnostics).getByLabelText('Probe label'), {
      target: { value: 'hello' },
    });
    await act(async () => {
      fireEvent.click(within(diagnostics).getByRole('button', { name: 'Send probe' }));
      await Promise.resolve();
    });
    const company = windowFrame('Company');
    fireEvent.change(within(company).getByLabelText('Company name'), { target: { value: 'Acme' } });
    fireEvent.change(within(company).getByLabelText('President'), { target: { value: 'Ada' } });
    await act(async () => {
      fireEvent.click(within(company).getByRole('button', { name: 'Found company' }));
      await Promise.resolve();
    });
    expect(simulation?.submitted.map((command) => command.type)).toEqual([
      'diagnostics.recordProbe',
      'company.found',
    ]);
  });

  it('window management never sends a command or touches the clock', async () => {
    const { simulation } = await renderApp({ workspace: new FakeWorkspace() });
    chooseMenu('Finance', 'Accounts…');
    chooseMenu('Help', 'Simulation Diagnostics…');
    fireEvent.click(screen.getByRole('button', { name: 'Minimize Accounts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize Company' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Company' }));
    chooseMenu('Window', 'Cascade');
    chooseMenu('Window', 'Tile Horizontally');
    chooseMenu('Window', 'Tile Vertically');
    chooseMenu('Window', 'Next Window');
    fireEvent.click(screen.getByRole('button', { name: 'Close Simulation Diagnostics' }));
    chooseMenu('Window', 'Close All');
    chooseMenu('Window', 'Reset Layout');
    chooseMenu('View', 'UI Scale 150%');
    await settle();
    expect(simulation?.submitted).toEqual([]);
    expect(simulation?.controls).toEqual([]);
  });

  it('minimizes to the strip, maximizes, restores, closes and reopens where it was', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Minimize Company' }));
    expect(screen.queryByRole('dialog', { name: 'Company' })).not.toBeInTheDocument();
    const strip = screen.getByRole('group', { name: 'Minimized windows' });
    fireEvent.click(within(strip).getByRole('button', { name: 'Restore Company' }));
    expect(windowFrame('Company')).toHaveAttribute('data-mode', 'normal');
    fireEvent.doubleClick(
      within(windowFrame('Company')).getByText('Company', { selector: '.window-title' }),
    );
    expect(windowFrame('Company')).toHaveAttribute('data-mode', 'maximized');
    fireEvent.click(screen.getByRole('button', { name: 'Restore Company' }));
    expect(windowFrame('Company')).toHaveStyle({ left: '16px', top: '16px', width: '440px' });

    // Move it with the keyboard (system menu → Move), then close and reopen.
    fireEvent.click(screen.getByRole('button', { name: 'Window menu: Company' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move' }));
    expect(screen.getByText(/^Move: arrow keys/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowDown', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(windowFrame('Company')).toHaveStyle({ left: '32px', top: '17px' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Company' }));
    expect(screen.queryByRole('dialog', { name: 'Company' })).not.toBeInTheDocument();
    chooseMenu('Company', 'Company Profile…');
    expect(windowFrame('Company')).toHaveStyle({ left: '32px', top: '17px' });
    expect(windowFrame('Company')).toHaveFocus();

    // Size with the keyboard; Escape cancels.
    fireEvent.click(screen.getByRole('button', { name: 'Window menu: Company' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Size' }));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(windowFrame('Company')).toHaveStyle({ width: '448px' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(windowFrame('Company')).toHaveStyle({ width: '440px' });
  });

  it('keyboard shortcuts: Ctrl+O, Ctrl+F6, Ctrl+F4, Ctrl+S, Pause', async () => {
    const saves = new FakeSaves();
    const { simulation } = await renderApp({ saves });
    fireEvent.keyDown(document, { key: 'o', ctrlKey: true });
    expect(windowFrame('Saved Games')).toHaveAttribute('data-active', 'true');
    expect(windowFrame('Saved Games')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'F6', ctrlKey: true });
    expect(windowFrame('Main Menu')).toHaveAttribute('data-active', 'true');
    expect(windowFrame('Main Menu')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'F4', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Main Menu' })).not.toBeInTheDocument();
    // Not saved yet: Ctrl+S asks for a name.
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Save As' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Pause' });
      await Promise.resolve();
    });
    expect(simulation?.controls).toEqual([{ action: 'setSpeed', speed: 'normal' }]);
  });

  it('Ctrl+S saves over the current save when it is one of the player’s', async () => {
    const saves = new FakeSaves();
    saves.saves = [saveSummary({ current: true })];
    const simulation = new FakeSimulation();
    const world = sampleWorldSnapshot(WORLD);
    simulation.snapshot = {
      ...simulation.snapshot,
      world: {
        ...world,
        session: world.session && { ...world.session, savedAs: { saveId: 'save-1', name: 'Shop' } },
      },
    };
    await renderApp({ simulation, saves });
    await act(async () => {
      fireEvent.keyDown(document, { key: 's', ctrlKey: true });
      await Promise.resolve();
    });
    await settle();
    expect(saves.requests).toEqual([{ name: 'Shop', saveId: 'save-1' }]);
    expect(screen.getByTestId('status-message')).toHaveTextContent('Saved over "Shop".');
  });
});

describe('window layout persistence (per save, per profile)', () => {
  it('a new world without a layout keeps the one on screen and stores it with the world', async () => {
    const workspace = new FakeWorkspace();
    await renderApp({ workspace });
    expect(workspace.gets).toBe(1);
    expect(workspace.writes).toEqual([{ key: LAYOUT_KEY, value: WINDOW_CATALOG.defaultLayout() }]);
  });

  it('applies the layout stored with the world: bounds, stacking, state and tab', async () => {
    const workspace = new FakeWorkspace();
    workspace.settings[LAYOUT_KEY] = layoutWith(
      { type: 'open', id: 'diagnostics' },
      { type: 'setBounds', id: 'diagnostics', bounds: { x: 100, y: 120, width: 500, height: 400 } },
      { type: 'setView', id: 'diagnostics', view: { tab: 'probes' } },
      { type: 'focus', id: 'company' },
      { type: 'open', id: 'accounts' },
      { type: 'minimize', id: 'accounts' },
    );
    await renderApp({ workspace });
    const diagnostics = windowFrame('Simulation Diagnostics');
    expect(diagnostics).toHaveStyle({
      left: '100px',
      top: '120px',
      width: '500px',
      height: '400px',
    });
    expect(within(diagnostics).getByRole('tab', { name: 'Probes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(windowFrame('Company')).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('button', { name: 'Restore Accounts' })).toBeInTheDocument();
    expect(workspace.writes).toEqual([]);
  });

  it('writes a change once things are quiet, to the world and to the profile', async () => {
    const workspace = new FakeWorkspace();
    const profile = memoryProfileStore();
    await renderApp({ workspace, profile });
    chooseMenu('Help', 'Simulation Diagnostics…');
    fireEvent.click(
      within(windowFrame('Simulation Diagnostics')).getByRole('tab', { name: 'Test obligations' }),
    );
    await waitFor(() => {
      expect(workspace.writes).toHaveLength(2);
    });
    const stored = workspace.settings[LAYOUT_KEY] as DesktopLayout;
    expect(stored.order).toEqual(['main-menu', 'company', 'diagnostics']);
    expect(stored.windows['diagnostics']?.view).toEqual({ tab: 'obligations' });
    expect(profile.values.get('layout')).toEqual(stored);
  });

  it('a pending change is written before a save, so the save holds it', async () => {
    const log: string[] = [];
    const workspace = new FakeWorkspace(log);
    const saves = new FakeSaves(log);
    await renderApp({ workspace, saves, layoutWriteDelayMs: 60_000 });
    log.length = 0;
    chooseMenu('Finance', 'Accounts…');
    chooseMenu('File', 'Save As…');
    fireEvent.change(screen.getByLabelText('Save name'), { target: { value: 'Layout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(log).toEqual([`workspace ${LAYOUT_KEY}`, 'save Layout']);
    expect((workspace.settings[LAYOUT_KEY] as DesktopLayout).windows['accounts']?.open).toBe(true);
  });

  it('a different world (load, restart) brings its own layout; a pending change is not carried over', async () => {
    const workspace = new FakeWorkspace();
    const simulation = new FakeSimulation();
    simulation.snapshot = {
      worker: { state: 'failed', generation: 1, failure: { message: 'gone', occurredAt: 't' } },
      world: null,
    };
    await renderApp({ workspace, simulation, layoutWriteDelayMs: 60_000 });
    expect(workspace.gets).toBe(0);
    // The restarted world's workspace already holds a layout (say, a recovered one).
    workspace.settings[LAYOUT_KEY] = layoutWith({ type: 'open', id: 'bills' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart worker' }));
      await Promise.resolve();
    });
    await settle();
    expect(simulation.snapshot.world?.worldInstanceId).toBe(OTHER_WORLD);
    expect(workspace.gets).toBe(1);
    expect(windowFrame('Bills and Obligations')).toBeInTheDocument();
    expect(workspace.writes).toEqual([]);
  });

  it('a new session starts from the profile’s last layout', async () => {
    const profile = memoryProfileStore({
      layout: layoutWith({ type: 'close', id: 'company' }, { type: 'open', id: 'saves' }),
    });
    await renderApp({ profile, saves: new FakeSaves() });
    expect(screen.queryByRole('dialog', { name: 'Company' })).not.toBeInTheDocument();
    expect(windowFrame('Saved Games')).toBeInTheDocument();
  });

  it('the UI scale is a profile preference applied to the whole desktop', async () => {
    const profile = memoryProfileStore({ uiScale: 125 });
    const { container } = await renderApp({ profile });
    expect(container.querySelector('.desktop')).toHaveAttribute('data-ui-scale', '125');
    chooseMenu('View', 'UI Scale 175%');
    expect(container.querySelector('.desktop')).toHaveAttribute('data-ui-scale', '175');
    expect(profile.values.get('uiScale')).toBe(175);
  });
});

describe('simulation worker and clock on the desktop', () => {
  it('reports runtime versions in About', async () => {
    await renderApp({ runtime: { electron: '1.2.3', chrome: '4.5', node: '6.7.8' } });
    chooseMenu('Help', 'About FreeIndustry…');
    expect(screen.getByTestId('runtime-versions')).toHaveTextContent(
      'Electron 1.2.3 · Chromium 4.5 · Node 6.7.8',
    );
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByTestId('runtime-versions')).not.toBeInTheDocument();
  });

  it('says so when the preload bridge is missing', async () => {
    await renderApp({ simulation: null });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'the renderer cannot reach the simulation worker',
    );
    expect(screen.getByTestId('worker-state')).toHaveTextContent('Unavailable');
  });

  it('sends a probe as a command against the current world revision', async () => {
    const { simulation } = await renderApp();
    chooseMenu('Help', 'Simulation Diagnostics…');
    fireEvent.click(screen.getByRole('tab', { name: 'Probes' }));
    fireEvent.change(screen.getByLabelText('Probe label'), { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send probe' }));
      await Promise.resolve();
    });
    expect(simulation?.submitted).toEqual([
      {
        commandId: COMMAND,
        worldInstanceId: WORLD,
        expectedWorldRevision: 0,
        type: 'diagnostics.recordProbe',
        payload: { label: 'hello' },
      },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId('last-outcome')).toHaveTextContent('Accepted at revision 1');
    });
    expect(screen.getByTestId('probe-count')).toHaveTextContent('1');
    fireEvent.click(screen.getByRole('tab', { name: 'World' }));
    expect(screen.getByTestId('world-revision')).toHaveTextContent('1');
  });

  it('shows a rejection with its code and leaves the displayed world unchanged', async () => {
    const simulation = new FakeSimulation();
    simulation.nextSubmit = {
      ok: false,
      error: {
        code: 'STALE_REVISION',
        message: 'Command expected world revision 0, but the world is at 3',
      },
    } as never;
    await renderApp({ simulation });
    chooseMenu('Help', 'Simulation Diagnostics…');
    fireEvent.click(screen.getByRole('tab', { name: 'Probes' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send probe' }));
      await Promise.resolve();
    });
    expect(screen.getByTestId('last-outcome')).toHaveTextContent('Rejected (STALE_REVISION)');
    expect(screen.getByTestId('probe-count')).toHaveTextContent('0');
  });

  it.each(['0', '-5', '2.5', 'abc', String(7 * 24 * 60 + 1)])(
    'will not schedule a probe with delay %s',
    async (value) => {
      await renderApp();
      chooseMenu('Help', 'Simulation Diagnostics…');
      fireEvent.click(screen.getByRole('tab', { name: 'Probes' }));
      fireEvent.change(screen.getByLabelText('Delay (simulated minutes)'), { target: { value } });
      expect(screen.getByRole('button', { name: 'Schedule probe' })).toBeDisabled();
    },
  );

  it('schedules a probe with the delay converted to simulated milliseconds', async () => {
    const { simulation } = await renderApp();
    chooseMenu('Help', 'Simulation Diagnostics…');
    fireEvent.click(screen.getByRole('tab', { name: 'Probes' }));
    fireEvent.change(screen.getByLabelText('Delay (simulated minutes)'), {
      target: { value: '90' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Schedule probe' }));
      await Promise.resolve();
    });
    expect(simulation?.submitted.map((command) => command.payload)).toEqual([
      { label: 'probe', delayMs: 5_400_000 },
    ]);
  });

  it('a host event refreshes the view; a stopped worker is an alert with a restart', async () => {
    const { simulation } = await renderApp();
    if (!simulation) {
      throw new Error('no bridge');
    }
    simulation.snapshot = {
      worker: {
        state: 'failed',
        generation: 1,
        failure: {
          message: 'Simulation worker exited unexpectedly (exit code 70)',
          occurredAt: 't',
        },
      },
      world: null,
    };
    await act(async () => {
      simulation.emit({ type: 'worker.status', worker: simulation.snapshot.worker });
      await Promise.resolve();
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Simulation worker stopped');
    expect(alert).toHaveTextContent('exit code 70');
    expect(screen.getByTestId('worker-state')).toHaveTextContent('Failed');
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(simulation.restarts).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart worker' }));
      await Promise.resolve();
    });
    expect(simulation.restarts).toBe(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('worker-state')).toHaveTextContent('Ready');
  });

  it('unsubscribes from host events on unmount', async () => {
    const view = await renderApp();
    expect(view.simulation?.listeners.size).toBe(1);
    view.unmount();
    expect(view.simulation?.listeners.size).toBe(0);
  });

  it('shows the clock, seed and fingerprints from the snapshot', async () => {
    const simulation = new FakeSimulation();
    const world = sampleWorldSnapshot(WORLD, { seed: 1234 });
    simulation.snapshot = {
      ...simulation.snapshot,
      world: {
        ...world,
        clock: {
          ...world.clock,
          nowMs: String(86_400_000 + 8 * 3_600_000 + 5 * 60_000),
          calendar: { year: 1996, month: 1, day: 2, weekday: 2, hour: 8, minute: 5, second: 0 },
          lastStop: { until: 'nextEvent', reason: 'notable', atMs: '0' },
        },
        queue: { pending: 3, nextEventAtMs: '90000000' },
        journal: { commands: 2, events: 5 },
      },
    };
    await renderApp({ simulation });
    expect(screen.getByTestId('sim-date')).toHaveTextContent('Tue 2 Jan 1996');
    expect(screen.getByTestId('sim-time')).toHaveTextContent('08:05:00');
    chooseMenu('Help', 'Simulation Diagnostics…');
    expect(screen.getByTestId('sim-elapsed')).toHaveTextContent('1 d 08:05:00');
    expect(screen.getByTestId('sim-last-stop')).toHaveTextContent(
      'Next event: stopped after an event',
    );
    expect(screen.getByTestId('sim-pending')).toHaveTextContent('3');
    expect(screen.getByTestId('sim-journal')).toHaveTextContent('2 commands, 5 events');
    expect(screen.getByTestId('world-seed')).toHaveTextContent('1234');
    expect(screen.getByTestId('state-hash')).toHaveTextContent('a'.repeat(64));
  });

  it('the toolbar sends clock control requests (never commands) and marks the active speed', async () => {
    const { simulation } = await renderApp();
    const speed = screen.getByRole('group', { name: 'Simulation speed' });
    await act(async () => {
      fireEvent.click(within(speed).getByRole('button', { name: 'Faster' }));
      await Promise.resolve();
    });
    expect(within(speed).getByRole('button', { name: 'Faster' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('sim-speed')).toHaveTextContent('Faster (100×)');
    // Pause, then Run resumes at the speed last chosen.
    await act(async () => {
      fireEvent.click(within(speed).getByRole('button', { name: 'Pause' }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(within(speed).getByRole('button', { name: 'Run' }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'End of day' }));
      await Promise.resolve();
    });
    expect(simulation?.controls).toEqual([
      { action: 'setSpeed', speed: 'faster' },
      { action: 'setSpeed', speed: 'paused' },
      { action: 'setSpeed', speed: 'faster' },
      { action: 'advance', until: 'endOfDay' },
    ]);
    expect(screen.getByTestId('sim-speed')).toHaveTextContent('Advancing: End of day');
    expect(screen.getByRole('button', { name: 'End of day' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(simulation?.submitted).toEqual([]);
  });

  it('alerts when the simulation stopped after a fault', async () => {
    const simulation = new FakeSimulation();
    const world = sampleWorldSnapshot(WORLD);
    simulation.snapshot = {
      ...simulation.snapshot,
      world: { ...world, clock: { ...world.clock, fault: 'Event ev:7 (x) failed: boom' } },
    };
    await renderApp({ simulation });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Simulation stopped');
    expect(alert).toHaveTextContent('Event ev:7 (x) failed: boom');
    expect(screen.getByTestId('status-alerts')).toHaveTextContent(
      'The simulation stopped on a fault',
    );
  });
});

describe('Step 07: new worlds, cities and the factory floor', () => {
  function withCities(simulation: FakeSimulation) {
    simulation.snapshot = {
      ...simulation.snapshot,
      world: sampleWorldSnapshot(WORLD, {
        scenarios: sampleScenarios(),
        realEstate: sampleRealEstate(),
      }),
    };
    simulation.nextWorld = (request) => ({
      worker: { state: 'ready', generation: 1, failure: null },
      world: sampleWorldSnapshot(OTHER_WORLD, {
        scenarios: sampleScenarios(),
        realEstate: { ...sampleRealEstate(), scenario: { id: request.scenarioId, name: 'New' } },
      }),
    });
    return simulation;
  }

  it('Quick Start makes a new world, then founds the preset company with its lease in that world', async () => {
    const simulation = withCities(new FakeSimulation());
    await renderApp({ simulation });
    fireEvent.click(within(windowFrame('Main Menu')).getByRole('button', { name: 'Quick Start' }));
    await settle();
    expect(simulation.newWorlds).toEqual([{ scenarioId: 'quick-start', seed: null }]);
    expect(simulation.submitted).toEqual([
      {
        commandId: COMMAND,
        worldInstanceId: OTHER_WORLD,
        expectedWorldRevision: 0,
        type: 'company.found',
        payload: {
          legalName: 'Harlow Precision Works',
          presidentName: 'Morgan Ellery',
          startingCapitalCents: '5000000',
          premises: { propertyId: 'hf-canal-8', termMonths: 12, standingOrder: true },
        },
      },
    ]);
  });

  it('New Company starts a world from the chosen scenario and seed, then opens the City Selection', async () => {
    const simulation = withCities(new FakeSimulation());
    await renderApp({ simulation });
    chooseMenu('File', 'New Company…');
    const dialog = screen.getByTestId('new-world-dialog');
    fireEvent.change(within(dialog).getByLabelText('World seed (optional)'), {
      target: { value: '77' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await settle();
    expect(simulation.newWorlds).toEqual([{ scenarioId: 'standard', seed: 77 }]);
    expect(simulation.submitted).toEqual([]);
    expect(windowFrame('City Selection')).toHaveAttribute('data-active', 'true');
    expect(screen.queryByTestId('new-world-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-message')).toHaveTextContent(
      'New world: Standard start. Choose a city.',
    );
    // From the city selection to the cityscape of the chosen city.
    fireEvent.click(screen.getByRole('button', { name: 'View Harlow Falls…' }));
    expect(windowFrame('City View')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('site-plan')).toHaveAccessibleName(
      'Site plan of Canal Street Works, drawn to scale',
    );
  });

  it('shows the leased premises in the status bar, the Company window and behind the windows', async () => {
    const simulation = new FakeSimulation();
    simulation.snapshot = {
      ...simulation.snapshot,
      world: sampleWorldSnapshot(WORLD, {
        company: SAMPLE_COMPANY_VIEW,
        scenarios: sampleScenarios(),
        realEstate: leasedRealEstate(),
      }),
    };
    await renderApp({ simulation });
    expect(screen.getByTestId('status-facility')).toHaveTextContent('Facility: 8 Canal Street');
    expect(screen.getByTestId('company-premises')).toHaveTextContent(
      '8 Canal Street: leased 1996-01-01 to 1997-01-01, $520.00 a month, next rent 1996-02-01 (standing order)',
    );
    expect(screen.getByTestId('facility-caption')).toHaveTextContent('Workshop, 1,033 sq ft');
  });

  it('Options switch the units for the profile; nothing is sent to the worker', async () => {
    const profile = memoryProfileStore();
    const simulation = new FakeSimulation();
    simulation.snapshot = {
      ...simulation.snapshot,
      world: sampleWorldSnapshot(WORLD, { realEstate: leasedRealEstate() }),
    };
    await renderApp({ simulation, profile });
    chooseMenu('File', 'Options…');
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: 'metric' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByTestId('facility-caption')).toHaveTextContent('Workshop, 96.0 m²');
    expect(profile.values.get('units')).toBe('metric');
    expect(simulation.submitted).toEqual([]);
    expect(simulation.newWorlds).toEqual([]);
  });
});
