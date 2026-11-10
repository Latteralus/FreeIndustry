import { ADVANCE_TARGETS, type AdvanceTarget, type ClockControl } from '../../../shared/ipc/clock';
import type { MenuDefinition } from '../../components/MenuBar';
import type { MenuEntry } from '../../components/PopupMenu';
import { describeSpeed, targetName } from '../clock-format';
import { UI_SCALES, type UiScale } from './profile-store';
import type { WindowId } from './window-catalog';
import type { DesktopLayout, WindowAction, WindowCatalog } from './window-model';
import type { FactoryMode } from '../../scenes/factory/camera';

const FACTORY_MODE_MENU_LABEL: Record<FactoryMode, string> = {
  operating: 'Factory Operation',
  layout: 'Factory Layout',
  inspection: 'Factory Inspection',
};

/**
 * The menubar (spec §3.2: File, View, Company, City, Catalog, Personnel,
 * Operations, Purchasing, Sales, Contracts, Research, Finance, Reports,
 * Window, Help). Every enabled command does something real. Commands for
 * systems that do not exist yet are listed, disabled, with the reason, so
 * nothing pretends to work (plan Step 06 gate).
 */

export type RunSpeed = 'normal' | 'faster' | 'fastest';
export const RUN_SPEEDS: readonly RunSpeed[] = ['normal', 'faster', 'fastest'];

export interface MenuContext {
  readonly catalog: WindowCatalog;
  readonly layout: DesktopLayout;
  readonly activeWindow: string | null;
  readonly worldReady: boolean;
  readonly savesAvailable: boolean;
  /** The clock's current speed, or null without a world. */
  readonly speed: 'paused' | RunSpeed | null;
  readonly advancing: AdvanceTarget | null;
  readonly uiScale: UiScale;
  /** The factory display mode now shown. */
  readonly factoryMode: FactoryMode;
  /** Whether the content offers a Quick Start scenario. */
  readonly quickStartAvailable: boolean;
  readonly actions: {
    readonly openWindow: (id: WindowId) => void;
    /** Show the factory in a display mode (Step 09: operating, layout, inspection). */
    readonly factoryMode: (mode: FactoryMode) => void;
    readonly newCompany: () => void;
    readonly quickStart: () => void;
    readonly scenarios: () => void;
    readonly options: () => void;
    /** The City View on its listings. */
    readonly cityListings: () => void;
    readonly window: (action: WindowAction) => void;
    readonly save: () => void;
    readonly saveAs: () => void;
    readonly importSave: () => void;
    readonly exit: () => void;
    readonly control: (control: ClockControl) => void;
    readonly setUiScale: (scale: UiScale) => void;
    readonly about: () => void;
  };
}

const NO_WORLD = 'The simulation is not running.';
const NO_SAVES = 'Saves are unavailable.';

/** A command for a system that is not built yet. */
function notBuilt(id: string, label: string, what: string): MenuEntry {
  return {
    kind: 'command',
    id,
    label,
    disabledReason: `Not built yet: ${what}.`,
    onSelect: () => undefined,
  };
}

function command(
  id: string,
  label: string,
  onSelect: () => void,
  options: { shortcut?: string; disabledReason?: string | null } = {},
): MenuEntry {
  return { kind: 'command', id, label, onSelect, ...options };
}

const separator = (id: string): MenuEntry => ({ kind: 'separator', id });

export function buildMenus(context: MenuContext): MenuDefinition[] {
  const { actions, layout, catalog } = context;
  const worldReason = context.worldReady ? null : NO_WORLD;
  const fileReason = !context.savesAvailable ? NO_SAVES : worldReason;
  const visible = layout.order.filter((id) => layout.windows[id]?.mode !== 'minimized');
  const noWindows = layout.order.length === 0 ? 'No windows are open.' : null;
  const noVisible = visible.length === 0 ? 'No windows are open.' : null;

  const speedEntries: MenuEntry[] = RUN_SPEEDS.map((speed) => ({
    kind: 'command',
    id: `speed-${speed}`,
    label: describeSpeed(speed),
    role: 'menuitemradio',
    checked: context.speed === speed && context.advancing === null,
    disabledReason: worldReason,
    onSelect: () => {
      actions.control({ action: 'setSpeed', speed });
    },
  }));

  const advanceEntries: MenuEntry[] = ADVANCE_TARGETS.map((until) =>
    command(
      `advance-${until}`,
      `Advance: ${targetName(until)}`,
      () => {
        actions.control({ action: 'advance', until });
      },
      { disabledReason: worldReason },
    ),
  );

  const windowList: MenuEntry[] = layout.order.map((id, index) => ({
    kind: 'command',
    id: `window-${id}`,
    label: `${index + 1} ${catalog.get(id).title}${layout.windows[id]?.mode === 'minimized' ? ' (minimized)' : ''}`,
    role: 'menuitemradio',
    checked: context.activeWindow === id,
    onSelect: () => {
      actions.window({ type: 'focus', id });
    },
  }));

  return [
    {
      id: 'file',
      label: 'File',
      mnemonic: 'F',
      entries: [
        command('new-company', 'New Company…', actions.newCompany, { disabledReason: worldReason }),
        command('quick-start', 'Quick Start', actions.quickStart, {
          disabledReason:
            worldReason ?? (context.quickStartAvailable ? null : 'No quick-start scenario.'),
        }),
        command('scenarios', 'Scenarios…', actions.scenarios, { disabledReason: worldReason }),
        separator('file-1'),
        command('save', 'Save', actions.save, { shortcut: 'Ctrl+S', disabledReason: fileReason }),
        command('save-as', 'Save As…', actions.saveAs, {
          shortcut: 'Ctrl+Shift+S',
          disabledReason: fileReason,
        }),
        command(
          'saved-games',
          'Saved Games…',
          () => {
            actions.openWindow('saves');
          },
          { shortcut: 'Ctrl+O', disabledReason: context.savesAvailable ? null : NO_SAVES },
        ),
        command('import', 'Import Save…', actions.importSave, {
          disabledReason: context.savesAvailable ? null : NO_SAVES,
        }),
        separator('file-2'),
        command('main-menu', 'Main Menu…', () => {
          actions.openWindow('main-menu');
        }),
        command('options', 'Options…', actions.options),
        separator('file-3'),
        command('exit', 'Exit', actions.exit, { shortcut: 'Alt+F4' }),
      ],
    },
    {
      id: 'view',
      label: 'View',
      mnemonic: 'V',
      entries: [
        ...(['operating', 'layout', 'inspection'] as const).map((mode): MenuEntry => ({
          kind: 'command',
          id: `view-factory-${mode}`,
          label: FACTORY_MODE_MENU_LABEL[mode],
          role: 'menuitemradio',
          checked: context.factoryMode === mode,
          onSelect: () => {
            actions.factoryMode(mode);
          },
        })),
        command('view-city', 'City', () => {
          actions.openWindow('city');
        }),
        separator('view-1'),
        ...UI_SCALES.map((scale): MenuEntry => ({
          kind: 'command',
          id: `scale-${scale}`,
          label: `UI Scale ${scale}%`,
          role: 'menuitemradio',
          checked: context.uiScale === scale,
          onSelect: () => {
            actions.setUiScale(scale);
          },
        })),
      ],
    },
    {
      id: 'company',
      label: 'Company',
      mnemonic: 'C',
      entries: [
        command('company-profile', 'Company Profile…', () => {
          actions.openWindow('company');
        }),
        command('company-premises', 'Premises…', () => {
          actions.openWindow('company');
        }),
      ],
    },
    {
      id: 'city',
      label: 'City',
      mnemonic: 'Y',
      entries: [
        command('city-view', 'City View…', () => {
          actions.openWindow('city');
        }),
        command('city-select', 'Cities…', () => {
          actions.openWindow('cities');
        }),
        command('city-properties', 'Properties for Lease…', actions.cityListings),
      ],
    },
    {
      id: 'catalog',
      label: 'Catalog',
      mnemonic: 'A',
      entries: [
        command('catalog-equipment', 'Equipment Catalog…', () => {
          actions.openWindow('equipment');
        }),
        command('catalog-floor-materials', 'Floor Materials…', () => {
          actions.openWindow('floor-materials');
        }),
        notBuilt('catalog-products', 'Products', 'products and recipes'),
      ],
    },
    {
      id: 'personnel',
      label: 'Personnel',
      mnemonic: 'P',
      entries: [
        notBuilt('personnel-staff', 'Staff', 'employees'),
        notBuilt('personnel-hiring', 'Hiring', 'job advertisements and applicants'),
      ],
    },
    {
      id: 'operations',
      label: 'Operations',
      mnemonic: 'O',
      entries: [
        command(
          'pause',
          'Pause',
          () => {
            actions.control({ action: 'setSpeed', speed: 'paused' });
          },
          {
            shortcut: 'Pause',
            disabledReason:
              worldReason ??
              (context.speed === 'paused' && context.advancing === null ? 'Already paused.' : null),
          },
        ),
        ...speedEntries,
        separator('operations-1'),
        ...advanceEntries,
        separator('operations-2'),
        command('operations-stock', 'Stock…', () => {
          actions.openWindow('stock');
        }),
        notBuilt('operations-production', 'Production', 'machines, work orders and production'),
      ],
    },
    {
      id: 'purchasing',
      label: 'Purchasing',
      mnemonic: 'U',
      entries: [
        notBuilt('purchasing-suppliers', 'Suppliers', 'suppliers and purchase orders'),
        notBuilt('purchasing-guidelines', 'Purchase Guidelines', 'purchasing policies'),
      ],
    },
    {
      id: 'sales',
      label: 'Sales',
      mnemonic: 'S',
      entries: [
        notBuilt('sales-customers', 'Customers', 'customers and sales orders'),
        notBuilt('sales-prices', 'Prices', 'selling prices'),
      ],
    },
    {
      id: 'contracts',
      label: 'Contracts',
      mnemonic: 'T',
      entries: [notBuilt('contracts-list', 'Contracts', 'customer and supplier contracts')],
    },
    {
      id: 'research',
      label: 'Research',
      mnemonic: 'R',
      entries: [notBuilt('research-projects', 'Research Projects', 'research and development')],
    },
    {
      id: 'finance',
      label: 'Finance',
      mnemonic: 'N',
      entries: [
        command('finance-accounts', 'Accounts…', () => {
          actions.openWindow('accounts');
        }),
        command('finance-bills', 'Bills and Obligations…', () => {
          actions.openWindow('bills');
        }),
        separator('finance-1'),
        notBuilt('finance-bank', 'Bank', 'bank accounts and transfers'),
        notBuilt('finance-loans', 'Loans', 'credit and loans'),
      ],
    },
    {
      id: 'reports',
      label: 'Reports',
      mnemonic: 'E',
      entries: [
        command('reports-accounts', 'Accounts (internal inspection)…', () => {
          actions.openWindow('accounts');
        }),
        notBuilt(
          'reports-statements',
          'Financial Statements',
          'income statement and balance sheet',
        ),
        notBuilt('reports-production', 'Production Reports', 'production'),
        notBuilt('reports-market', 'Market Reports', 'the marketplace'),
      ],
    },
    {
      id: 'window',
      label: 'Window',
      mnemonic: 'W',
      entries: [
        command(
          'cascade',
          'Cascade',
          () => {
            actions.window({ type: 'cascade' });
          },
          { shortcut: 'Shift+F5', disabledReason: noVisible },
        ),
        command(
          'tile-horizontal',
          'Tile Horizontally',
          () => {
            actions.window({ type: 'tile', direction: 'horizontal' });
          },
          { shortcut: 'Shift+F4', disabledReason: noVisible },
        ),
        command(
          'tile-vertical',
          'Tile Vertically',
          () => {
            actions.window({ type: 'tile', direction: 'vertical' });
          },
          { disabledReason: noVisible },
        ),
        command(
          'next-window',
          'Next Window',
          () => {
            actions.window({ type: 'cycle', delta: 1 });
          },
          {
            shortcut: 'Ctrl+F6',
            disabledReason: visible.length < 2 ? 'Fewer than two windows are open.' : null,
          },
        ),
        command(
          'close-all',
          'Close All',
          () => {
            actions.window({ type: 'closeAll' });
          },
          { disabledReason: noWindows },
        ),
        command('reset-layout', 'Reset Layout', () => {
          actions.window({ type: 'reset' });
        }),
        ...(windowList.length > 0 ? [separator('window-1'), ...windowList] : []),
      ],
    },
    {
      id: 'help',
      label: 'Help',
      mnemonic: 'H',
      entries: [
        command('help-topics', 'Help Topics…', () => {
          actions.openWindow('help');
        }),
        command('diagnostics', 'Simulation Diagnostics…', () => {
          actions.openWindow('diagnostics');
        }),
        separator('help-1'),
        command('about', 'About FreeIndustry…', actions.about),
      ],
    },
  ];
}
