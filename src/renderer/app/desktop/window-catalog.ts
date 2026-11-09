import { WindowCatalog, type SortDirection, type WindowView } from './window-model';

/**
 * The management windows that exist in this build. Each one shows the
 * worker's read model and sends real commands; windows for systems that do
 * not exist yet (personnel, catalog, market, contracts, …) are not listed,
 * and their menu commands are disabled with the reason.
 */
export type WindowId =
  | 'main-menu'
  | 'company'
  | 'cities'
  | 'city'
  | 'accounts'
  | 'bills'
  | 'saves'
  | 'help'
  | 'diagnostics'
  | 'equipment';

export const WINDOW_CATALOG = new WindowCatalog<WindowId>([
  {
    // Listed first, so the Company window starts in front of it (and active).
    id: 'main-menu',
    title: 'Main Menu',
    defaultBounds: { x: 476, y: 16, width: 260, height: 330 },
    minSize: { width: 220, height: 300 },
    openByDefault: true,
  },
  {
    id: 'company',
    title: 'Company',
    defaultBounds: { x: 16, y: 16, width: 440, height: 360 },
    minSize: { width: 320, height: 200 },
    openByDefault: true,
  },
  {
    id: 'cities',
    title: 'City Selection',
    defaultBounds: { x: 40, y: 40, width: 1060, height: 600 },
    minSize: { width: 560, height: 320 },
  },
  {
    id: 'city',
    title: 'City View',
    defaultBounds: { x: 24, y: 24, width: 1060, height: 620 },
    minSize: { width: 640, height: 360 },
  },
  {
    id: 'accounts',
    title: 'Accounts',
    defaultBounds: { x: 476, y: 16, width: 620, height: 420 },
    minSize: { width: 380, height: 200 },
  },
  {
    id: 'bills',
    title: 'Bills and Obligations',
    defaultBounds: { x: 60, y: 140, width: 800, height: 380 },
    minSize: { width: 440, height: 200 },
  },
  {
    id: 'saves',
    title: 'Saved Games',
    defaultBounds: { x: 120, y: 90, width: 720, height: 380 },
    minSize: { width: 460, height: 220 },
  },
  {
    id: 'help',
    title: 'Help',
    defaultBounds: { x: 520, y: 80, width: 520, height: 360 },
    minSize: { width: 360, height: 220 },
  },
  {
    id: 'equipment',
    title: 'Equipment Catalog',
    defaultBounds: { x: 640, y: 40, width: 620, height: 560 },
    minSize: { width: 420, height: 300 },
  },
  {
    id: 'diagnostics',
    title: 'Simulation Diagnostics',
    defaultBounds: { x: 700, y: 40, width: 540, height: 480 },
    minSize: { width: 380, height: 240 },
  },
]);

/** Props every window's contents receive: its remembered view and a way to change it. */
export interface WindowViewProps {
  readonly view: WindowView;
  readonly onViewChange: (view: WindowView) => void;
}

export const withTab = (view: WindowView, tab: string): WindowView => ({ ...view, tab });

export const withSort = (
  view: WindowView,
  sort: { column: string; direction: SortDirection },
): WindowView => ({ ...view, sort });

export const withFilter = (view: WindowView, key: string, value: string): WindowView => ({
  ...view,
  filters: { ...view.filters, [key]: value },
});

/** A remembered filter value, if it is one of the allowed values. */
export function filterValue<Value extends string>(
  view: WindowView,
  key: string,
  allowed: readonly Value[],
  fallback: Value,
): Value {
  const value = view.filters?.[key];
  return allowed.find((candidate) => candidate === value) ?? fallback;
}
