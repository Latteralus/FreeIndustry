import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { PRODUCT_NAME } from '../../shared/app-identity';
import type {
  FreeIndustryBridge,
  SavesBridge,
  SimulationBridge,
  WorkspaceBridge,
} from '../../shared/bridge';
import type { ClockControl } from '../../shared/ipc/clock';
import type { ScenarioSummary } from '../../shared/ipc/real-estate';
import { Dialog } from '../components/Dialog';
import { MenuBar } from '../components/MenuBar';
import { MessageBox } from '../components/MessageBox';
import type { FactoryMode } from '../scenes/factory/camera';
import { FactoryViewport, type LayoutTool } from '../scenes/FactoryViewport';
import { AccountsWindow } from '../windows/AccountsWindow';
import { BillsWindow } from '../windows/BillsWindow';
import { CitiesWindow } from '../windows/CitiesWindow';
import { CityWindow } from '../windows/CityWindow';
import { CompanyWindow } from '../windows/CompanyWindow';
import { DiagnosticsWindow } from '../windows/DiagnosticsWindow';
import { EquipmentWindow } from '../windows/EquipmentWindow';
import { FloorMaterialsWindow } from '../windows/FloorMaterialsWindow';
import { StockWindow } from '../windows/StockWindow';
import type { FloorTool } from '../scenes/factory/floor-selection';
import { HelpWindow } from '../windows/HelpWindow';
import { LeaseDialog } from '../windows/LeaseDialog';
import { MainMenuWindow } from '../windows/MainMenuWindow';
import { NewWorldDialog } from '../windows/NewWorldDialog';
import { OptionsDialog } from '../windows/OptionsDialog';
import { SaveAsDialog, SavesWindow } from '../windows/SavesWindow';
import { MdiWindow } from './desktop/MdiWindow';
import { buildMenus, type RunSpeed } from './desktop/menus';
import {
  memoryProfileStore,
  readUiScale,
  readUnits,
  type ProfileStore,
  type UiScale,
  type Units,
} from './desktop/profile-store';
import { StatusBar, type Alert } from './desktop/StatusBar';
import { Toolbar } from './desktop/Toolbar';
import { useDesktopLayout } from './desktop/useDesktopLayout';
import { useElementSize } from './desktop/useElementSize';
import { WINDOW_CATALOG, type WindowId } from './desktop/window-catalog';
import { activeWindow, displayBounds, type WindowView } from './desktop/window-model';
import { formatCents } from './money-input';
import { describeOutcome } from './outcome';
import { useSaves } from './useSaves';
import { useSimulationHost } from './useSimulationHost';

export interface AppProps {
  /** Runtime versions from the preload bridge, or null if the bridge is absent. */
  readonly runtime: FreeIndustryBridge['runtime'] | null;
  /** Simulation API from the preload bridge, or null if the bridge is absent. */
  readonly simulation: SimulationBridge | null;
  /** Save-slot API from the preload bridge, or null if the bridge is absent. */
  readonly saves?: SavesBridge | null;
  /** Per-save presentation settings (the window layout), or null if absent. */
  readonly workspace?: WorkspaceBridge | null;
  /** Profile preferences (UI scale, last layout); in-memory when omitted. */
  readonly profile?: ProfileStore;
  /** Command ID generator (tests inject a deterministic one). */
  readonly newCommandId?: () => string;
  /** File → Exit. */
  readonly onExit?: () => void;
  /** Quiet period before a layout change is written (ms). */
  readonly layoutWriteDelayMs?: number;
}

type DialogKind =
  | 'saveAs'
  | 'about'
  | 'options'
  | { readonly kind: 'newWorld'; readonly title: 'New Company' | 'Scenarios' }
  | { readonly kind: 'lease'; readonly propertyId: string };

/** The scenario New Company starts from unless another is chosen. */
const STANDARD_SCENARIO = 'standard';

/**
 * The FreeIndustry business desktop (plan Step 06, spec §3.2): menubar,
 * toolbar, the factory viewport as the workspace background, movable
 * management windows over it, and the status bar.
 *
 * The desktop holds presentation state only. World state arrives in the
 * worker's snapshots and changes only through validated commands; clock
 * control only changes pacing; the window layout is a workspace setting
 * kept with each save, outside every fingerprint (ADR-0035).
 */
export function App({
  runtime,
  simulation,
  saves = null,
  workspace = null,
  profile: profileStore,
  newCommandId,
  onExit = () => {
    window.close();
  },
  layoutWriteDelayMs,
}: AppProps) {
  const host = useSimulationHost(simulation, newCommandId);
  const worker = host.snapshot?.worker ?? null;
  const world = host.snapshot?.world ?? null;
  const clock = world?.clock ?? null;
  const company = world?.company ?? null;
  const realEstate = world?.realEstate ?? null;
  const facilities = world?.facilities ?? null;
  const stock = world?.stock ?? null;
  // The factory display mode, the placement tool and the selection are presentation
  // state; only commands change the world (ADR-0051).
  const [factoryMode, setFactoryMode] = useState<FactoryMode>('operating');
  const [tool, setTool] = useState<LayoutTool | null>(null);
  const [floorTool, setFloorTool] = useState<FloorTool | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const scenarios = world?.scenarios ?? [];
  const quickStartScenario = scenarios.find((scenario) => scenario.quickStart !== null) ?? null;
  const premises = realEstate?.leases.find((lease) => lease.status === 'active') ?? null;
  const premisesProperty =
    realEstate?.properties.find((property) => property.id === premises?.propertyId) ?? null;
  const outcome = describeOutcome(host.lastOutcome);

  const fallbackProfile = useMemo(() => memoryProfileStore(), []);
  const profile = profileStore ?? fallbackProfile;
  const [uiScale, setUiScaleState] = useState<UiScale>(() => readUiScale(profile));
  const [units, setUnitsState] = useState<Units>(() => readUnits(profile));
  // A desktop message stays in the status bar until the next save-file message replaces it.
  const [ownMessage, setOwnMessage] = useState<{
    readonly text: string;
    readonly over: string | null;
  } | null>(null);
  const scale = uiScale / 100;
  const [frameRef, frameSize] = useElementSize<HTMLDivElement>();
  const [workspaceRef, workspaceSize] = useElementSize<HTMLDivElement>();

  const desktop = useDesktopLayout({
    catalog: WINDOW_CATALOG,
    workspace,
    worldKey: world?.worldInstanceId ?? null,
    profile,
    workspaceSize,
    ...(layoutWriteDelayMs === undefined ? {} : { writeDelayMs: layoutWriteDelayMs }),
  });
  const { layout, dispatch, flush } = desktop;
  const files = useSaves(saves, simulation, { beforeWorldChange: flush });

  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [systemMenu, setSystemMenu] = useState<string | null>(null);
  const [runSpeed, setRunSpeed] = useState<RunSpeed>('normal');
  const active = activeWindow(layout);
  const windowAction = dispatch;

  const openWindow = useCallback(
    (id: WindowId) => {
      windowAction({ type: 'open', id }, true);
    },
    [windowAction],
  );

  const setView = useCallback(
    (id: string) => (view: WindowView) => {
      dispatch({ type: 'setView', id, view });
    },
    [dispatch],
  );

  const control = useCallback(
    (request: ClockControl) => {
      void host.control(request);
    },
    [host],
  );

  const setUiScale = (next: UiScale) => {
    profile.write('uiScale', next);
    setUiScaleState(next);
  };

  const setUnits = (next: Units) => {
    profile.write('units', next);
    setUnitsState(next);
  };

  const setMessage = (text: string) => {
    setOwnMessage({ text, over: files.outcome });
  };
  const message =
    ownMessage !== null && ownMessage.over === files.outcome ? ownMessage.text : files.outcome;

  /** Show the City View at a city (and optionally a tab), keeping its other view settings. */
  const showCity = (cityId: string | null, tab?: string) => {
    const view = layout.windows['city']?.view ?? {};
    dispatch({
      type: 'setView',
      id: 'city',
      view: {
        ...view,
        ...(tab === undefined ? {} : { tab }),
        filters: cityId === null ? (view.filters ?? {}) : { ...view.filters, city: cityId },
      },
    });
    openWindow('city');
  };

  /**
   * Replace the world with a new one from `scenario` (New Company, Quick
   * Start, Scenarios). The layout is written first so nothing lands in the
   * new world late. A quick-start scenario then founds its company and
   * leases its premises in one command; otherwise the player chooses a city.
   */
  const startWorld = async (scenario: ScenarioSummary, seed: number | null) => {
    await flush();
    const started = await host.newWorld({ scenarioId: scenario.id, seed });
    const next = started?.world;
    if (!next) {
      setMessage('A new world could not be started.');
      return;
    }
    setDialog(null);
    const quick = scenario.quickStart;
    if (!quick) {
      setMessage(`New world: ${scenario.name}. Choose a city.`);
      openWindow('cities');
      return;
    }
    const founded = await host.submit(
      'company.found',
      {
        legalName: quick.legalName,
        presidentName: quick.presidentName,
        startingCapitalCents: scenario.defaultCapitalCents,
        premises: {
          propertyId: quick.propertyId,
          termMonths: quick.termMonths,
          standingOrder: quick.standingOrder,
        },
      },
      next,
    );
    setMessage(
      founded?.kind === 'accepted'
        ? `Quick Start: ${quick.legalName} founded.`
        : `Quick Start failed: ${describeOutcome(founded)}`,
    );
    openWindow('company');
  };

  const quickStart = () => {
    if (quickStartScenario) {
      void startWorld(quickStartScenario, null);
    }
  };

  const session = world?.session ?? null;
  const currentSave = files.saves?.find((save) => save.saveId === session?.savedAs?.saveId) ?? null;
  const save = () => {
    if (currentSave?.kind === 'manual' && currentSave.status === 'ready') {
      void files.overwrite(currentSave);
    } else {
      setDialog('saveAs');
    }
  };

  const worldReady = world !== null;
  const savesAvailable = saves !== null;
  const menus = buildMenus({
    catalog: WINDOW_CATALOG,
    layout,
    activeWindow: active,
    worldReady,
    savesAvailable,
    speed: clock?.speed ?? null,
    advancing: clock?.advance?.until ?? null,
    uiScale,
    factoryMode,
    quickStartAvailable: quickStartScenario !== null,
    actions: {
      openWindow,
      factoryMode: (mode) => {
        if (mode !== 'layout') {
          setTool(null);
          setFloorTool(null);
        }
        setFactoryMode(mode);
      },
      newCompany: () => {
        setDialog({ kind: 'newWorld', title: 'New Company' });
      },
      quickStart,
      scenarios: () => {
        setDialog({ kind: 'newWorld', title: 'Scenarios' });
      },
      options: () => {
        setDialog('options');
      },
      cityListings: () => {
        showCity(null, 'listings');
      },
      window: (action) => {
        windowAction(action, true);
      },
      save,
      saveAs: () => {
        setDialog('saveAs');
      },
      importSave: () => {
        void files.importSave();
      },
      exit: onExit,
      control,
      setUiScale,
      about: () => {
        setDialog('about');
      },
    },
  });

  // Keyboard shortcuts shown in the menus.
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (dialog !== null) {
      return;
    }
    const ctrl = event.ctrlKey && !event.altKey;
    let handled = true;
    if (ctrl && !event.shiftKey && event.key.toLowerCase() === 's') {
      if (worldReady && savesAvailable) {
        save();
      }
    } else if (ctrl && event.shiftKey && event.key.toLowerCase() === 's') {
      if (worldReady && savesAvailable) {
        setDialog('saveAs');
      }
    } else if (ctrl && !event.shiftKey && event.key.toLowerCase() === 'o') {
      if (savesAvailable) {
        openWindow('saves');
      }
    } else if (ctrl && event.key === 'F4') {
      if (active !== null) {
        windowAction({ type: 'close', id: active });
      }
    } else if (ctrl && event.key === 'F6') {
      windowAction({ type: 'cycle', delta: event.shiftKey ? -1 : 1 }, true);
    } else if (event.shiftKey && !event.ctrlKey && event.key === 'F5') {
      windowAction({ type: 'cascade' });
    } else if (event.shiftKey && !event.ctrlKey && event.key === 'F4') {
      windowAction({ type: 'tile', direction: 'horizontal' });
    } else if (event.key === 'Pause') {
      if (clock) {
        const running = clock.speed !== 'paused' || clock.advance !== null;
        control({ action: 'setSpeed', speed: running ? 'paused' : runSpeed });
      }
    } else if (event.altKey && !event.ctrlKey && event.key === '-') {
      setSystemMenu(active);
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      onShortcut(event);
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
    };
  }, []);

  const alerts: Alert[] = [];
  if (worker?.state === 'failed') {
    alerts.push({ id: 'worker', text: 'The simulation worker stopped', opens: null });
  }
  if (clock?.fault) {
    alerts.push({
      id: 'fault',
      text: 'The simulation stopped on a fault',
      opens: () => {
        openWindow('diagnostics');
      },
    });
  }
  if (company && BigInt(company.liquidity.overdueShortfallCents) > 0n) {
    alerts.push({
      id: 'shortfall',
      text: `Overdue bills exceed available funds by ${formatCents(company.liquidity.overdueShortfallCents)}`,
      opens: () => {
        openWindow('bills');
      },
    });
  } else if (company && BigInt(company.liquidity.payablesOverdueCents) > 0n) {
    alerts.push({
      id: 'overdue',
      text: `Overdue bills: ${formatCents(company.liquidity.payablesOverdueCents)}`,
      opens: () => {
        openWindow('bills');
      },
    });
  }
  if (session?.notice) {
    alerts.push({
      id: 'notice',
      text: session.notice,
      opens: () => {
        openWindow('saves');
      },
    });
  }

  const renderContents = (id: WindowId, view: WindowView) => {
    const onViewChange = setView(id);
    switch (id) {
      case 'main-menu':
        return (
          <MainMenuWindow
            worldReady={worldReady}
            savesAvailable={savesAvailable}
            busy={host.pending}
            company={company}
            realEstate={realEstate}
            scenarios={scenarios}
            actions={{
              newCompany: () => {
                setDialog({ kind: 'newWorld', title: 'New Company' });
              },
              quickStart,
              load: () => {
                openWindow('saves');
              },
              scenarios: () => {
                setDialog({ kind: 'newWorld', title: 'Scenarios' });
              },
              options: () => {
                setDialog('options');
              },
              help: () => {
                openWindow('help');
              },
              exit: onExit,
            }}
          />
        );
      case 'company':
        return (
          <CompanyWindow
            company={company}
            host={host}
            outcome={outcome}
            premises={premises}
            onOpenWindow={openWindow}
          />
        );
      case 'cities':
        return (
          <CitiesWindow
            realEstate={realEstate}
            units={units}
            view={view}
            onViewChange={onViewChange}
            onViewCity={(cityId) => {
              showCity(cityId, 'plan');
            }}
          />
        );
      case 'city':
        return (
          <CityWindow
            realEstate={realEstate}
            units={units}
            view={view}
            onViewChange={onViewChange}
            onLease={(propertyId) => {
              setDialog({ kind: 'lease', propertyId });
            }}
          />
        );
      case 'help':
        return <HelpWindow view={view} onViewChange={onViewChange} />;
      case 'accounts':
        return <AccountsWindow company={company} view={view} onViewChange={onViewChange} />;
      case 'bills':
        return (
          <BillsWindow
            company={company}
            host={host}
            outcome={outcome}
            view={view}
            onViewChange={onViewChange}
          />
        );
      case 'saves':
        return (
          <SavesWindow
            saves={files}
            session={session}
            onSaveAs={() => {
              setDialog('saveAs');
            }}
            view={view}
            onViewChange={onViewChange}
          />
        );
      case 'equipment':
        return (
          <EquipmentWindow
            facilities={facilities}
            hasCompany={company !== null}
            units={units}
            host={host}
            onPlace={(next) => {
              setFloorTool(null);
              setTool(next);
              setFactoryMode('layout');
            }}
            selectedId={selectedEntity}
            onShow={(id) => {
              setSelectedEntity(id);
              setFocusRequest((count) => count + 1);
            }}
            view={view}
            onViewChange={onViewChange}
          />
        );
      case 'floor-materials':
        return (
          <FloorMaterialsWindow
            facilities={facilities}
            units={units}
            onLay={(next) => {
              setTool(null);
              setFloorTool(next);
              setFactoryMode('layout');
            }}
            view={view}
            onViewChange={onViewChange}
          />
        );
      case 'stock':
        return (
          <StockWindow
            stock={stock}
            units={units}
            host={host}
            selectedId={selectedEntity}
            onSelect={setSelectedEntity}
            onShow={(id) => {
              setSelectedEntity(id);
              setFocusRequest((count) => count + 1);
            }}
            view={view}
            onViewChange={onViewChange}
          />
        );
      case 'diagnostics':
        return (
          <DiagnosticsWindow
            worker={worker}
            world={world}
            host={host}
            outcome={outcome}
            view={view}
            onViewChange={onViewChange}
          />
        );
    }
  };

  const shownWindows = WINDOW_CATALOG.ids.filter(
    (id): id is WindowId => layout.windows[id]?.open === true && isWindowId(id),
  );
  const minimized = layout.order.filter((id) => layout.windows[id]?.mode === 'minimized');

  return (
    <div ref={frameRef} className="app-frame">
      <div
        className="desktop"
        data-ui-scale={uiScale}
        style={
          frameSize && scale !== 1
            ? {
                zoom: scale,
                width: frameSize.width / scale,
                height: frameSize.height / scale,
              }
            : undefined
        }
      >
        <MenuBar menus={menus} inert={dialog !== null} />
        <Toolbar
          clock={clock}
          runSpeed={runSpeed}
          onControl={control}
          onRunSpeed={setRunSpeed}
          onOpenWindow={openWindow}
          onFactory={() => {
            setFactoryMode('layout');
          }}
        />
        <div ref={workspaceRef} className="workspace" data-testid="workspace">
          <FactoryViewport
            companyName={company?.legalName ?? null}
            premises={premisesProperty}
            units={units}
            facilities={facilities}
            mode={factoryMode}
            onMode={setFactoryMode}
            selectedId={selectedEntity}
            onSelect={setSelectedEntity}
            focusRequest={focusRequest}
            tool={tool}
            onTool={setTool}
            floorTool={floorTool}
            onFloorTool={setFloorTool}
            host={host}
            stock={stock}
            onOpenStock={(id) => {
              setSelectedEntity(id);
              openWindow('stock');
            }}
          />
          {shownWindows.map((id) => {
            const record = layout.windows[id];
            if (!record) {
              return null;
            }
            const definition = WINDOW_CATALOG.get(id);
            return (
              <MdiWindow
                key={id}
                definition={definition}
                record={record}
                bounds={displayBounds(record, workspaceSize)}
                zIndex={10 + layout.order.indexOf(id)}
                active={active === id}
                scale={scale}
                workspace={workspaceSize}
                onAction={(action) => {
                  windowAction(action, action.type === 'cycle');
                }}
                systemMenuOpen={systemMenu === id}
                onSystemMenu={(open) => {
                  setSystemMenu(open ? id : null);
                }}
              >
                {renderContents(id, record.view)}
              </MdiWindow>
            );
          })}
          {minimized.length > 0 && (
            <div className="minimized-strip" aria-label="Minimized windows" role="group">
              {minimized.map((id) => {
                const title = WINDOW_CATALOG.get(id).title;
                return (
                  <span key={id} className="minimized-window">
                    <button
                      type="button"
                      className="minimized-title"
                      aria-label={`Restore ${title}`}
                      onClick={() => {
                        windowAction({ type: 'restore', id }, true);
                      }}
                    >
                      {title}
                    </button>
                    <button
                      type="button"
                      className="window-control"
                      aria-label={`Close ${title}`}
                      onClick={() => {
                        windowAction({ type: 'close', id });
                      }}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {simulation === null && (
            <MessageBox title="Simulation unavailable">
              <p>Preload bridge unavailable: the renderer cannot reach the simulation worker.</p>
            </MessageBox>
          )}
          {worker?.state === 'failed' && (
            <MessageBox
              title="Simulation worker stopped"
              actions={
                <button
                  type="button"
                  disabled={host.pending}
                  onClick={() => {
                    void host.restartWorker();
                  }}
                >
                  Restart worker
                </button>
              }
            >
              <p>{worker.failure?.message ?? 'The simulation worker stopped unexpectedly.'}</p>
              <p>
                Restarting starts a new world. Commands the worker had accepted are in its recovery
                log: the new worker rebuilds them into a &quot;Recovered session&quot; save you can
                load. Details are in the local log file.
              </p>
            </MessageBox>
          )}
          {clock?.fault && (
            <MessageBox title="Simulation stopped">
              <p>{clock.fault}</p>
              <p>
                The clock is paused and will not advance. Load a save, or restart the worker to
                start a new world.
              </p>
            </MessageBox>
          )}
        </div>
        <StatusBar
          worker={worker}
          world={world}
          alerts={alerts}
          message={message}
          facility={premises?.address ?? null}
        />
        {typeof dialog === 'object' && dialog?.kind === 'newWorld' && (
          <NewWorldDialog
            title={dialog.title}
            scenarios={scenarios}
            initialScenarioId={STANDARD_SCENARIO}
            unsavedChanges={session?.unsavedChanges ?? false}
            busy={host.pending}
            onStart={(scenarioId, seed) => {
              const scenario = scenarios.find((item) => item.id === scenarioId);
              if (scenario) {
                void startWorld(scenario, seed);
              }
            }}
            onClose={() => {
              setDialog(null);
            }}
          />
        )}
        {typeof dialog === 'object' &&
          dialog?.kind === 'lease' &&
          (() => {
            const property = realEstate?.properties.find((item) => item.id === dialog.propertyId);
            if (!property) {
              return null;
            }
            const scenario = scenarios.find((item) => item.id === realEstate?.scenario.id);
            return (
              <LeaseDialog
                property={property}
                company={company}
                defaultCapitalCents={scenario?.defaultCapitalCents ?? '5000000'}
                units={units}
                host={host}
                onClose={() => {
                  setDialog(null);
                }}
                onLeased={() => {
                  setDialog(null);
                  setMessage(`Leased ${property.address}.`);
                }}
              />
            );
          })()}
        {dialog === 'options' && (
          <OptionsDialog
            uiScale={uiScale}
            units={units}
            onUiScale={setUiScale}
            onUnits={setUnits}
            onClose={() => {
              setDialog(null);
            }}
          />
        )}
        {dialog === 'saveAs' && (
          <SaveAsDialog
            saves={files}
            initialName={session?.savedAs?.name ?? ''}
            onClose={() => {
              setDialog(null);
            }}
          />
        )}
        {dialog === 'about' && (
          <Dialog
            title={`About ${PRODUCT_NAME}`}
            onClose={() => {
              setDialog(null);
            }}
          >
            <p className="about-product">{PRODUCT_NAME}</p>
            <p>
              An industrial business simulation in development. This build has the deterministic
              simulation, saves, a company with its double-entry books, and cities whose property
              can be leased; the premises are empty, because equipment, staff and stock are not
              built yet.
            </p>
            <p data-testid="runtime-versions">
              {runtime
                ? `Electron ${runtime.electron} · Chromium ${runtime.chrome} · Node ${runtime.node}`
                : 'Preload bridge unavailable'}
            </p>
            <div className="button-row">
              <button
                type="button"
                onClick={() => {
                  setDialog(null);
                }}
              >
                OK
              </button>
            </div>
          </Dialog>
        )}
      </div>
    </div>
  );
}

function isWindowId(id: string): id is WindowId {
  return WINDOW_CATALOG.has(id);
}
