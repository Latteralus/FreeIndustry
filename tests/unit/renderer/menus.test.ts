import { buildMenus, type MenuContext } from '../../../src/renderer/app/desktop/menus';
import { WINDOW_CATALOG } from '../../../src/renderer/app/desktop/window-catalog';
import { reduceLayout } from '../../../src/renderer/app/desktop/window-model';
import type { CommandEntry } from '../../../src/renderer/components/PopupMenu';

function context(overrides: Partial<MenuContext> = {}) {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(args.length > 0 ? `${name} ${JSON.stringify(args[0])}` : name);
    };
  const value: MenuContext = {
    catalog: WINDOW_CATALOG,
    layout: WINDOW_CATALOG.defaultLayout(),
    activeWindow: 'company',
    worldReady: true,
    savesAvailable: true,
    speed: 'paused',
    advancing: null,
    uiScale: 100,
    factoryMode: 'operating',
    quickStartAvailable: true,
    actions: {
      openWindow: record('open'),
      factoryMode: record('factoryMode'),
      newCompany: record('newCompany'),
      quickStart: record('quickStart'),
      scenarios: record('scenarios'),
      options: record('options'),
      cityListings: record('cityListings'),
      window: record('window'),
      save: record('save'),
      saveAs: record('saveAs'),
      importSave: record('import'),
      exit: record('exit'),
      control: record('control'),
      setUiScale: record('scale'),
      about: record('about'),
    },
    ...overrides,
  };
  return { value, calls };
}

const commands = (menus: ReturnType<typeof buildMenus>) =>
  menus.flatMap((menu) =>
    menu.entries
      .filter((entry): entry is CommandEntry => entry.kind === 'command')
      .map((entry) => ({ menu: menu.label, entry })),
  );

function find(menus: ReturnType<typeof buildMenus>, label: string): CommandEntry {
  const found = commands(menus).find(({ entry }) => entry.label === label);
  if (!found) {
    throw new Error(`no command ${label}`);
  }
  return found.entry;
}

describe('menubar', () => {
  it('has the menus of the specification, in order, with unique access letters', () => {
    const menus = buildMenus(context().value);
    expect(menus.map((menu) => menu.label)).toEqual([
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
    const letters = menus.map((menu) => menu.mnemonic.toLowerCase());
    expect(new Set(letters).size).toBe(letters.length);
    for (const menu of menus) {
      expect(menu.label.toLowerCase()).toContain(menu.mnemonic.toLowerCase());
    }
  });

  it('nothing pretends to work: every unavailable command is disabled and says why', () => {
    const { value, calls } = context();
    const menus = buildMenus(value);
    const notBuilt = commands(menus).filter(({ entry }) =>
      entry.disabledReason?.startsWith('Not built yet'),
    );
    // Systems that do not exist yet are listed, and none can be chosen.
    expect(notBuilt.map(({ entry }) => entry.label)).toEqual(
      expect.arrayContaining([
        'Products',
        'Staff',
        'Hiring',
        'Production',
        'Suppliers',
        'Purchase Guidelines',
        'Customers',
        'Contracts',
        'Research Projects',
        'Bank',
        'Loans',
        'Financial Statements',
      ]),
    );
    for (const { entry } of notBuilt) {
      entry.onSelect();
    }
    expect(calls).toEqual([]);
    // Since Step 07 the city and its property exist, and New Company is real.
    for (const label of ['New Company…', 'Quick Start', 'Scenarios…', 'City View…', 'Cities…']) {
      expect(find(menus, label).disabledReason ?? null).toBeNull();
    }
    // Since Step 08 the factory layout and the equipment catalog are real; Step 09 adds
    // the operating and inspection modes, a radio group showing the current one.
    find(menus, 'Factory Layout').onSelect();
    find(menus, 'Factory Operation').onSelect();
    find(menus, 'Factory Inspection').onSelect();
    find(menus, 'Equipment Catalog…').onSelect();
    expect(calls).toEqual([
      'factoryMode "layout"',
      'factoryMode "operating"',
      'factoryMode "inspection"',
      'open "equipment"',
    ]);
    expect(find(menus, 'Factory Operation')).toMatchObject({
      role: 'menuitemradio',
      checked: true,
    });
    expect(find(menus, 'Factory Layout')).toMatchObject({ checked: false });
    calls.length = 0;
    // Menus with no working system have no enabled command at all.
    for (const menu of menus.filter((candidate) =>
      ['Personnel', 'Purchasing', 'Sales', 'Contracts', 'Research'].includes(candidate.label),
    )) {
      expect(
        menu.entries.filter(
          (entry) => entry.kind === 'command' && (entry.disabledReason ?? null) === null,
        ),
      ).toEqual([]);
    }
  });

  it('every enabled command does something', () => {
    const { value, calls } = context({
      layout: reduceLayout(
        WINDOW_CATALOG.defaultLayout(),
        { type: 'open', id: 'bills' },
        WINDOW_CATALOG,
        null,
      ),
    });
    const enabled = commands(buildMenus(value)).filter(
      ({ entry }) => (entry.disabledReason ?? null) === null,
    );
    for (const { entry } of enabled) {
      const before = calls.length;
      entry.onSelect();
      expect(calls.length).toBe(before + 1);
    }
  });

  it('routes commands to windows, files and the clock', () => {
    const { value, calls } = context();
    const menus = buildMenus(value);
    for (const label of [
      'Company Profile…',
      'Accounts…',
      'Bills and Obligations…',
      'Saved Games…',
      'Simulation Diagnostics…',
      'Save',
      'Save As…',
      'Import Save…',
      'Faster (100×)',
      'Advance: End of day',
      'Tile Vertically',
      'UI Scale 150%',
      'About FreeIndustry…',
      'Exit',
      'New Company…',
      'Quick Start',
      'Scenarios…',
      'Main Menu…',
      'Options…',
      'City View…',
      'Cities…',
      'Properties for Lease…',
      'Premises…',
      'Help Topics…',
    ]) {
      find(menus, label).onSelect();
    }
    expect(calls).toEqual([
      'open "company"',
      'open "accounts"',
      'open "bills"',
      'open "saves"',
      'open "diagnostics"',
      'save',
      'saveAs',
      'import',
      'control {"action":"setSpeed","speed":"faster"}',
      'control {"action":"advance","until":"endOfDay"}',
      'window {"type":"tile","direction":"vertical"}',
      'scale 150',
      'about',
      'exit',
      'newCompany',
      'quickStart',
      'scenarios',
      'open "main-menu"',
      'options',
      'open "city"',
      'open "cities"',
      'cityListings',
      'open "company"',
      'open "help"',
    ]);
  });

  it('without a quick-start scenario, Quick Start says why', () => {
    const menus = buildMenus(context({ quickStartAvailable: false }).value);
    expect(find(menus, 'Quick Start').disabledReason).toBe('No quick-start scenario.');
  });

  it('marks the current speed, scale and window, and lists open windows', () => {
    const layout = reduceLayout(
      reduceLayout(
        WINDOW_CATALOG.defaultLayout(),
        { type: 'open', id: 'bills' },
        WINDOW_CATALOG,
        null,
      ),
      { type: 'minimize', id: 'company' },
      WINDOW_CATALOG,
      null,
    );
    const menus = buildMenus(
      context({ speed: 'faster', uiScale: 125, layout, activeWindow: 'bills' }).value,
    );
    expect(find(menus, 'Faster (100×)').checked).toBe(true);
    expect(find(menus, 'Normal (20×)').checked).toBe(false);
    expect(find(menus, 'UI Scale 125%').checked).toBe(true);
    // The Main Menu and Company windows open by default (Step 07), then Bills.
    expect(find(menus, '1 Main Menu').checked).toBe(false);
    expect(find(menus, '2 Company (minimized)').checked).toBe(false);
    expect(find(menus, '3 Bills and Obligations').checked).toBe(true);
  });

  it('without a world, file and clock commands are disabled with the reason', () => {
    const menus = buildMenus(context({ worldReady: false, speed: null }).value);
    for (const label of ['Save', 'Save As…', 'Pause', 'Normal (20×)', 'Advance: Next event']) {
      expect(find(menus, label).disabledReason).toBe('The simulation is not running.');
    }
    const noSaves = buildMenus(context({ savesAvailable: false }).value);
    expect(find(noSaves, 'Saved Games…').disabledReason).toBe('Saves are unavailable.');
  });
});
