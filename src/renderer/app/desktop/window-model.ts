/**
 * The classic window manager's state, as pure functions (plan Step 06, spec
 * §3.2). Management windows open over the factory viewport, overlap, move,
 * resize, minimize, maximize within the workspace, close and reopen
 * independently, and remember their bounds, last tab, sort and filters.
 *
 * This is presentation state only. It is persisted with each save as a
 * workspace setting (ADR-0028), outside every fingerprint, and nothing here
 * can reach the simulation: moving a window cannot change an outcome.
 *
 * Coordinates are integer CSS pixels relative to the workspace, before UI
 * scaling (the scale is applied to the whole desktop).
 */

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

type WindowMode = 'normal' | 'minimized' | 'maximized';

export type SortDirection = 'asc' | 'desc';

/** What a window remembers about its contents: last tab, sort and filters. */
export interface WindowView {
  readonly tab?: string;
  readonly sort?: { readonly column: string; readonly direction: SortDirection };
  readonly filters?: Readonly<Record<string, string>>;
}

export interface WindowRecord {
  readonly open: boolean;
  /** Bounds in the normal (restored) state; kept while minimized, maximized or closed. */
  readonly bounds: Bounds;
  readonly mode: WindowMode;
  readonly view: WindowView;
}

export interface DesktopLayout {
  readonly version: 1;
  readonly windows: Readonly<Record<string, WindowRecord>>;
  /** Open windows from back to front; the last non-minimized one is active. */
  readonly order: readonly string[];
}

/** Static description of a kind of window. */
export interface WindowDefinition<Id extends string = string> {
  readonly id: Id;
  readonly title: string;
  readonly defaultBounds: Bounds;
  readonly minSize: Size;
  /** Open in the built-in default layout. */
  readonly openByDefault?: boolean;
}

/** Height of a window's title bar; it must stay reachable inside the workspace. */
export const TITLE_BAR_HEIGHT = 20;
/** Width of title bar that must stay inside the workspace horizontally. */
const GRAB_MARGIN = 64;
/** Offset between windows when cascading. */
const CASCADE_STEP = 22;
/** Bounds are kept within ±this many pixels; anything else in a save is refused. */
export const MAX_COORDINATE = 100_000;

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

type TileDirection = 'horizontal' | 'vertical';

export type WindowAction =
  | { readonly type: 'open'; readonly id: string }
  | { readonly type: 'close'; readonly id: string }
  | { readonly type: 'focus'; readonly id: string }
  | { readonly type: 'move'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly type: 'setBounds'; readonly id: string; readonly bounds: Bounds }
  | { readonly type: 'minimize'; readonly id: string }
  | { readonly type: 'maximize'; readonly id: string }
  | { readonly type: 'restore'; readonly id: string }
  | { readonly type: 'setView'; readonly id: string; readonly view: WindowView }
  | { readonly type: 'cycle'; readonly delta: 1 | -1 }
  | { readonly type: 'cascade' }
  | { readonly type: 'tile'; readonly direction: TileDirection }
  | { readonly type: 'closeAll' }
  | { readonly type: 'reset' };

export class WindowCatalog<Id extends string = string> {
  readonly #definitions: ReadonlyMap<string, WindowDefinition>;

  constructor(definitions: readonly WindowDefinition<Id>[]) {
    const map = new Map<string, WindowDefinition>();
    for (const definition of definitions) {
      if (map.has(definition.id)) {
        throw new Error(`Duplicate window definition ${definition.id}`);
      }
      map.set(definition.id, definition);
    }
    this.#definitions = map;
  }

  get ids(): readonly string[] {
    return [...this.#definitions.keys()];
  }

  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  get(id: string): WindowDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) {
      throw new Error(`Unknown window ${id}`);
    }
    return definition;
  }

  /** The built-in layout: every window at its default bounds, the default ones open. */
  defaultLayout(): DesktopLayout {
    const windows: Record<string, WindowRecord> = {};
    const order: string[] = [];
    for (const definition of this.#definitions.values()) {
      const open = definition.openByDefault === true;
      windows[definition.id] = {
        open,
        bounds: definition.defaultBounds,
        mode: 'normal',
        view: {},
      };
      if (open) {
        order.push(definition.id);
      }
    }
    return { version: 1, windows, order };
  }
}

const clampInt = (value: number, low: number, high: number) =>
  Math.round(Math.min(Math.max(value, low), Math.max(low, high)));

/** Bounds no smaller than the window's minimum size, with integer coordinates. */
export function normalizeBounds(bounds: Bounds, minSize: Size): Bounds {
  return {
    x: clampInt(bounds.x, -MAX_COORDINATE, MAX_COORDINATE),
    y: clampInt(bounds.y, -MAX_COORDINATE, MAX_COORDINATE),
    width: clampInt(bounds.width, minSize.width, MAX_COORDINATE),
    height: clampInt(bounds.height, minSize.height, MAX_COORDINATE),
  };
}

/**
 * Where a normal window may sit in a workspace: its title bar stays
 * reachable (at least `GRAB_MARGIN` pixels of it horizontally, all of it
 * vertically), so a window can never be lost off-screen. Part of a window
 * may hang outside the workspace, as in a classic desktop.
 */
export function placeInWorkspace(bounds: Bounds, workspace: Size | null): Bounds {
  if (!workspace || workspace.width <= 0 || workspace.height <= 0) {
    return bounds;
  }
  const grab = Math.min(GRAB_MARGIN, bounds.width);
  return {
    ...bounds,
    x: clampInt(bounds.x, grab - bounds.width, workspace.width - grab),
    y: clampInt(bounds.y, 0, workspace.height - TITLE_BAR_HEIGHT),
  };
}

/** Bounds at which a window is drawn: maximized fills the workspace. */
export function displayBounds(record: WindowRecord, workspace: Size | null): Bounds {
  if (record.mode === 'maximized' && workspace && workspace.width > 0 && workspace.height > 0) {
    return { x: 0, y: 0, width: workspace.width, height: workspace.height };
  }
  return placeInWorkspace(record.bounds, workspace);
}

/**
 * New bounds while dragging an edge or corner by (dx, dy). The opposite
 * edge stays put; the window never shrinks below its minimum size.
 */
export function resizeFromEdge(
  start: Bounds,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  minSize: Size,
): Bounds {
  let { x, y, width, height } = start;
  if (edge.includes('e')) {
    width = Math.max(minSize.width, start.width + dx);
  }
  if (edge.includes('s')) {
    height = Math.max(minSize.height, start.height + dy);
  }
  if (edge.includes('w')) {
    width = Math.max(minSize.width, start.width - dx);
    x = start.x + start.width - width;
  }
  if (edge.includes('n')) {
    height = Math.max(minSize.height, start.height - dy);
    y = start.y + start.height - height;
  }
  return normalizeBounds({ x, y, width, height }, minSize);
}

/** The window that has the focus: the front-most open window that is not minimized. */
export function activeWindow(layout: DesktopLayout): string | null {
  for (let index = layout.order.length - 1; index >= 0; index -= 1) {
    const id = layout.order[index];
    if (id !== undefined && layout.windows[id]?.mode !== 'minimized') {
      return id;
    }
  }
  return null;
}

/** Open windows that are not minimized, back to front. */
function visibleWindows(layout: DesktopLayout): string[] {
  return layout.order.filter((id) => layout.windows[id]?.mode !== 'minimized');
}

function withRecord(
  layout: DesktopLayout,
  id: string,
  change: (record: WindowRecord) => WindowRecord,
): DesktopLayout {
  const record = layout.windows[id];
  if (!record) {
    return layout;
  }
  return { ...layout, windows: { ...layout.windows, [id]: change(record) } };
}

function toFront(order: readonly string[], id: string): string[] {
  return [...order.filter((other) => other !== id), id];
}

/**
 * Apply one window-manager action. Unknown windows, and actions on closed
 * windows that need an open one, leave the layout unchanged (the same
 * object), so callers can tell nothing happened.
 */
export function reduceLayout(
  layout: DesktopLayout,
  action: WindowAction,
  catalog: WindowCatalog,
  workspace: Size | null,
): DesktopLayout {
  switch (action.type) {
    case 'open': {
      const record = layout.windows[action.id];
      if (!record || !catalog.has(action.id)) {
        return layout;
      }
      // Reopening (or re-choosing) a window shows it where it was; a minimized one is restored.
      const reopened = withRecord(layout, action.id, (current) => ({
        ...current,
        open: true,
        mode: current.mode === 'minimized' ? 'normal' : current.mode,
        bounds: placeInWorkspace(current.bounds, workspace),
      }));
      return { ...reopened, order: toFront(layout.order, action.id) };
    }
    case 'close': {
      const record = layout.windows[action.id];
      if (!record?.open) {
        return layout;
      }
      const closed = withRecord(layout, action.id, (current) => ({
        ...current,
        open: false,
        mode: current.mode === 'minimized' ? 'normal' : current.mode,
      }));
      return { ...closed, order: layout.order.filter((id) => id !== action.id) };
    }
    case 'focus': {
      const record = layout.windows[action.id];
      if (!record?.open) {
        return layout;
      }
      if (record.mode === 'minimized') {
        return reduceLayout(layout, { type: 'restore', id: action.id }, catalog, workspace);
      }
      if (layout.order[layout.order.length - 1] === action.id) {
        return layout;
      }
      return { ...layout, order: toFront(layout.order, action.id) };
    }
    case 'move': {
      const record = layout.windows[action.id];
      if (!record?.open || record.mode !== 'normal') {
        return layout;
      }
      const bounds = placeInWorkspace(
        normalizeBounds(
          { ...record.bounds, x: action.x, y: action.y },
          catalog.get(action.id).minSize,
        ),
        workspace,
      );
      return withRecord(layout, action.id, (current) => ({ ...current, bounds }));
    }
    case 'setBounds': {
      const record = layout.windows[action.id];
      if (!record?.open || record.mode !== 'normal') {
        return layout;
      }
      const bounds = placeInWorkspace(
        normalizeBounds(action.bounds, catalog.get(action.id).minSize),
        workspace,
      );
      return withRecord(layout, action.id, (current) => ({ ...current, bounds }));
    }
    case 'minimize': {
      const record = layout.windows[action.id];
      if (!record?.open || record.mode === 'minimized') {
        return layout;
      }
      return withRecord(layout, action.id, (current) => ({ ...current, mode: 'minimized' }));
    }
    case 'maximize': {
      const record = layout.windows[action.id];
      if (!record?.open) {
        return layout;
      }
      const maximized = withRecord(layout, action.id, (current) => ({
        ...current,
        mode: 'maximized',
      }));
      return { ...maximized, order: toFront(layout.order, action.id) };
    }
    case 'restore': {
      const record = layout.windows[action.id];
      if (!record?.open) {
        return layout;
      }
      const restored = withRecord(layout, action.id, (current) => ({
        ...current,
        mode: 'normal',
        bounds: placeInWorkspace(current.bounds, workspace),
      }));
      return { ...restored, order: toFront(layout.order, action.id) };
    }
    case 'setView': {
      if (!layout.windows[action.id]) {
        return layout;
      }
      return withRecord(layout, action.id, (current) => ({ ...current, view: action.view }));
    }
    case 'cycle': {
      const visible = visibleWindows(layout);
      if (visible.length < 2) {
        return layout;
      }
      // Next: bring the back-most window forward. Previous: send the front one to the back.
      if (action.delta === 1) {
        const back = visible[0];
        return back === undefined ? layout : { ...layout, order: toFront(layout.order, back) };
      }
      const front = visible[visible.length - 1];
      return front === undefined
        ? layout
        : { ...layout, order: [front, ...layout.order.filter((id) => id !== front)] };
    }
    case 'cascade':
      return arrange(layout, catalog, workspace, (index, _count, size) => {
        const steps = Math.max(
          1,
          Math.floor(Math.min(size.width, size.height - TITLE_BAR_HEIGHT) / 3 / CASCADE_STEP),
        );
        const offset = (index % steps) * CASCADE_STEP;
        return { x: offset, y: offset, width: size.width * 0.6, height: size.height * 0.6 };
      });
    case 'tile':
      return arrange(layout, catalog, workspace, (index, count, size) =>
        action.direction === 'horizontal'
          ? tileCell(index, count, size, 'rows')
          : tileCell(index, count, size, 'columns'),
      );
    case 'closeAll': {
      if (layout.order.length === 0) {
        return layout;
      }
      let next = layout;
      for (const id of layout.order) {
        next = reduceLayout(next, { type: 'close', id }, catalog, workspace);
      }
      return next;
    }
    case 'reset':
      return catalog.defaultLayout();
  }
}

/**
 * Tiling. With "rows" (Tile Horizontally) windows are stacked one above the
 * other; with "columns" (Tile Vertically) they stand side by side. More than
 * three windows form a grid.
 */
function tileCell(index: number, count: number, size: Size, primary: 'rows' | 'columns'): Bounds {
  const lines = count <= 3 ? 1 : Math.ceil(Math.sqrt(count));
  const perLine = Math.ceil(count / lines);
  const line = Math.floor(index / perLine);
  const slot = index % perLine;
  const inThisLine = line === lines - 1 ? count - perLine * (lines - 1) : perLine;
  if (primary === 'rows') {
    // Each line is a column of stacked windows.
    const width = size.width / lines;
    const height = size.height / inThisLine;
    return { x: line * width, y: slot * height, width, height };
  }
  const width = size.width / inThisLine;
  const height = size.height / lines;
  return { x: slot * width, y: line * height, width, height };
}

function arrange(
  layout: DesktopLayout,
  catalog: WindowCatalog,
  workspace: Size | null,
  place: (index: number, count: number, size: Size) => Bounds,
): DesktopLayout {
  const visible = visibleWindows(layout);
  if (visible.length === 0 || !workspace || workspace.width <= 0 || workspace.height <= 0) {
    return layout;
  }
  const windows = { ...layout.windows };
  visible.forEach((id, index) => {
    const record = windows[id];
    if (!record) {
      return;
    }
    const cell = place(index, visible.length, workspace);
    // Round edges, not sizes, so neighbouring tiles meet exactly.
    const x = Math.round(cell.x);
    const y = Math.round(cell.y);
    const bounds = placeInWorkspace(
      normalizeBounds(
        {
          x,
          y,
          width: Math.round(cell.x + cell.width) - x,
          height: Math.round(cell.y + cell.height) - y,
        },
        catalog.get(id).minSize,
      ),
      workspace,
    );
    windows[id] = { ...record, mode: 'normal', bounds };
  });
  return { ...layout, windows };
}
