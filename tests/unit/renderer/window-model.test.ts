import fc from 'fast-check';
import { decodeLayout, encodeLayout } from '../../../src/renderer/app/desktop/layout-codec';
import { WINDOW_CATALOG } from '../../../src/renderer/app/desktop/window-catalog';
import {
  activeWindow,
  displayBounds,
  placeInWorkspace,
  reduceLayout,
  resizeFromEdge,
  TITLE_BAR_HEIGHT,
  WindowCatalog,
  type DesktopLayout,
  type ResizeEdge,
  type Size,
  type WindowAction,
} from '../../../src/renderer/app/desktop/window-model';

const WORKSPACE: Size = { width: 1264, height: 690 };

/**
 * A fixed catalog for the model's own tests: the five windows of Step 06 with
 * their Step 06 bounds, so later windows in the production catalog do not
 * change what these tests measure. The production default is tested below.
 */
const catalog = new WindowCatalog([
  {
    id: 'company',
    title: 'Company',
    defaultBounds: { x: 16, y: 16, width: 440, height: 360 },
    minSize: { width: 320, height: 200 },
    openByDefault: true,
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
    id: 'diagnostics',
    title: 'Simulation Diagnostics',
    defaultBounds: { x: 700, y: 40, width: 540, height: 480 },
    minSize: { width: 380, height: 240 },
  },
]);
const ids = catalog.ids;

const apply = (layout: DesktopLayout, ...actions: WindowAction[]) =>
  actions.reduce((current, action) => reduceLayout(current, action, catalog, WORKSPACE), layout);

const start = () => catalog.defaultLayout();

describe('the production window catalog', () => {
  it('opens the Main Menu and the Company window by default, with the Company window active', () => {
    const layout = WINDOW_CATALOG.defaultLayout();
    expect(layout.order).toEqual(['main-menu', 'company']);
    expect(activeWindow(layout)).toBe('company');
    expect(WINDOW_CATALOG.ids).toEqual([
      'main-menu',
      'company',
      'cities',
      'city',
      'accounts',
      'bills',
      'saves',
      'help',
      'equipment',
      'floor-materials',
      'stock',
      'diagnostics',
    ]);
  });
});

describe('window manager model', () => {
  it('starts from the default layout: only the Company window open', () => {
    const layout = start();
    expect(layout.order).toEqual(['company']);
    expect(activeWindow(layout)).toBe('company');
    for (const id of ids) {
      expect(layout.windows[id]?.bounds).toEqual(catalog.get(id).defaultBounds);
    }
  });

  it('opens a window at the front, focuses and closes; closing keeps its bounds and view', () => {
    let layout = apply(start(), { type: 'open', id: 'accounts' }, { type: 'open', id: 'bills' });
    expect(layout.order).toEqual(['company', 'accounts', 'bills']);
    expect(activeWindow(layout)).toBe('bills');
    layout = apply(layout, { type: 'focus', id: 'company' });
    expect(layout.order).toEqual(['accounts', 'bills', 'company']);
    layout = apply(
      layout,
      { type: 'setBounds', id: 'bills', bounds: { x: 33, y: 44, width: 500, height: 300 } },
      {
        type: 'setView',
        id: 'bills',
        view: { tab: 'obligations', filters: { status: 'overdue' } },
      },
      { type: 'close', id: 'bills' },
    );
    expect(layout.order).toEqual(['accounts', 'company']);
    expect(layout.windows['bills']?.open).toBe(false);
    layout = apply(layout, { type: 'open', id: 'bills' });
    expect(layout.windows['bills']).toEqual({
      open: true,
      mode: 'normal',
      bounds: { x: 33, y: 44, width: 500, height: 300 },
      view: { tab: 'obligations', filters: { status: 'overdue' } },
    });
    expect(activeWindow(layout)).toBe('bills');
  });

  it('minimizes, maximizes and restores; a minimized window is never active', () => {
    let layout = apply(
      start(),
      { type: 'open', id: 'accounts' },
      { type: 'minimize', id: 'accounts' },
    );
    expect(activeWindow(layout)).toBe('company');
    expect(layout.order).toContain('accounts');
    layout = apply(layout, { type: 'focus', id: 'accounts' });
    expect(layout.windows['accounts']?.mode).toBe('normal');
    expect(activeWindow(layout)).toBe('accounts');
    layout = apply(layout, { type: 'maximize', id: 'company' });
    expect(activeWindow(layout)).toBe('company');
    const company = layout.windows['company'];
    if (!company) {
      throw new Error('missing');
    }
    expect(displayBounds(company, WORKSPACE)).toEqual({ x: 0, y: 0, ...WORKSPACE });
    // Maximized windows keep their restore bounds and cannot be moved.
    expect(company.bounds).toEqual(catalog.get('company').defaultBounds);
    expect(apply(layout, { type: 'move', id: 'company', x: 300, y: 300 })).toBe(layout);
    layout = apply(layout, { type: 'restore', id: 'company' });
    expect(layout.windows['company']?.mode).toBe('normal');
    expect(layout.windows['company']?.bounds).toEqual(catalog.get('company').defaultBounds);
  });

  it('a window minimized when closed reopens restored', () => {
    const layout = apply(
      start(),
      { type: 'minimize', id: 'company' },
      { type: 'close', id: 'company' },
      { type: 'open', id: 'company' },
    );
    expect(layout.windows['company']?.mode).toBe('normal');
  });

  it('never makes a window smaller than its minimum size', () => {
    const layout = apply(start(), {
      type: 'setBounds',
      id: 'company',
      bounds: { x: 10, y: 10, width: 5, height: 5 },
    });
    expect(layout.windows['company']?.bounds).toMatchObject(catalog.get('company').minSize);
  });

  it('keeps every title bar reachable inside the workspace', () => {
    const layout = apply(start(), { type: 'move', id: 'company', x: 5000, y: 5000 });
    const bounds = layout.windows['company']?.bounds;
    expect(bounds?.x).toBeLessThanOrEqual(WORKSPACE.width - 64);
    expect(bounds?.y).toBe(WORKSPACE.height - TITLE_BAR_HEIGHT);
    const left = apply(start(), { type: 'move', id: 'company', x: -5000, y: -40 });
    expect(left.windows['company']?.bounds.x).toBe(64 - 440);
    expect(left.windows['company']?.bounds.y).toBe(0);
  });

  it('resizes from each edge with the opposite edge fixed', () => {
    const from = { x: 100, y: 100, width: 400, height: 300 };
    const min = { width: 200, height: 150 };
    const cases: [ResizeEdge, number, number, object][] = [
      ['e', 50, 99, { x: 100, y: 100, width: 450, height: 300 }],
      ['s', 99, 40, { x: 100, y: 100, width: 400, height: 340 }],
      ['w', 30, 0, { x: 130, y: 100, width: 370, height: 300 }],
      ['n', 0, -20, { x: 100, y: 80, width: 400, height: 320 }],
      ['se', 10, 10, { x: 100, y: 100, width: 410, height: 310 }],
      ['nw', 500, 500, { x: 300, y: 250, width: 200, height: 150 }],
    ];
    for (const [edge, dx, dy, expected] of cases) {
      expect(resizeFromEdge(from, edge, dx, dy, min)).toEqual(expected);
    }
  });

  it('cycles through visible windows (Ctrl+F6 / Ctrl+Shift+F6)', () => {
    let layout = apply(start(), { type: 'open', id: 'accounts' }, { type: 'open', id: 'bills' });
    layout = apply(layout, { type: 'cycle', delta: 1 });
    expect(activeWindow(layout)).toBe('company');
    layout = apply(layout, { type: 'cycle', delta: 1 });
    expect(activeWindow(layout)).toBe('accounts');
    layout = apply(layout, { type: 'cycle', delta: -1 });
    expect(activeWindow(layout)).toBe('company');
  });

  it('tiles side by side and stacked, edge to edge, within the workspace', () => {
    const open = apply(start(), { type: 'open', id: 'accounts' }, { type: 'open', id: 'bills' });
    const vertical = apply(open, { type: 'tile', direction: 'vertical' });
    const columns = open.order.map((id) => vertical.windows[id]?.bounds);
    expect(columns).toEqual([
      { x: 0, y: 0, width: 421, height: 690 },
      { x: 421, y: 0, width: 422, height: 690 },
      // A tile narrower than the window's minimum width (440) gets the minimum instead.
      { x: 843, y: 0, width: 440, height: 690 },
    ]);
    const horizontal = apply(open, { type: 'tile', direction: 'horizontal' });
    expect(open.order.map((id) => horizontal.windows[id]?.bounds)).toEqual([
      { x: 0, y: 0, width: 1264, height: 230 },
      { x: 0, y: 230, width: 1264, height: 230 },
      { x: 0, y: 460, width: 1264, height: 230 },
    ]);
  });

  it('cascades windows down and to the right, each one title bar apart', () => {
    const open = apply(start(), { type: 'open', id: 'accounts' }, { type: 'open', id: 'bills' });
    const cascaded = apply(open, { type: 'cascade' });
    const positions = open.order.map((id) => {
      const bounds = cascaded.windows[id]?.bounds;
      return [bounds?.x, bounds?.y];
    });
    expect(positions).toEqual([
      [0, 0],
      [22, 22],
      [44, 44],
    ]);
    expect(cascaded.order).toEqual(open.order);
  });

  it('reports nothing changed for actions on closed or unknown windows', () => {
    const layout = start();
    for (const action of [
      { type: 'close', id: 'bills' },
      { type: 'focus', id: 'bills' },
      { type: 'move', id: 'bills', x: 1, y: 1 },
      { type: 'minimize', id: 'bills' },
      { type: 'open', id: 'personnel' },
      { type: 'cycle', delta: 1 },
    ] as WindowAction[]) {
      expect(apply(layout, action)).toBe(layout);
    }
  });

  it('refuses duplicate window definitions', () => {
    const definition = {
      id: 'a',
      title: 'A',
      defaultBounds: { x: 0, y: 0, width: 100, height: 100 },
      minSize: { width: 50, height: 50 },
    };
    expect(() => new WindowCatalog([definition, definition])).toThrow('Duplicate');
  });
});

// ------------------------------------------------------------- properties

const idArb = fc.constantFrom(...ids, 'unknown');
const coordinate = fc.integer({ min: -3000, max: 3000 });
const actionArb: fc.Arbitrary<WindowAction> = fc.oneof(
  idArb.map((id) => ({ type: 'open' as const, id })),
  idArb.map((id) => ({ type: 'close' as const, id })),
  idArb.map((id) => ({ type: 'focus' as const, id })),
  idArb.map((id) => ({ type: 'minimize' as const, id })),
  idArb.map((id) => ({ type: 'maximize' as const, id })),
  idArb.map((id) => ({ type: 'restore' as const, id })),
  fc.record({ id: idArb, x: coordinate, y: coordinate }).map((value) => ({
    type: 'move' as const,
    ...value,
  })),
  fc
    .record({
      id: idArb,
      bounds: fc.record({
        x: coordinate,
        y: coordinate,
        width: fc.integer({ min: -100, max: 3000 }),
        height: fc.integer({ min: -100, max: 3000 }),
      }),
    })
    .map((value) => ({ type: 'setBounds' as const, ...value })),
  fc
    .record({ id: idArb, tab: fc.string({ minLength: 1, maxLength: 12 }) })
    .map(({ id, tab }) => ({ type: 'setView' as const, id, view: { tab } })),
  fc.constantFrom(1 as const, -1 as const).map((delta) => ({ type: 'cycle' as const, delta })),
  fc.constant({ type: 'cascade' as const }),
  fc
    .constantFrom('horizontal' as const, 'vertical' as const)
    .map((direction) => ({ type: 'tile' as const, direction })),
  fc.constant({ type: 'closeAll' as const }),
);
const workspaceArb = fc.record({
  width: fc.integer({ min: 400, max: 4000 }),
  height: fc.integer({ min: 300, max: 2400 }),
});

describe('window manager properties', () => {
  it('any sequence keeps the stack, sizes and reachability invariants', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 60 }), workspaceArb, (actions, workspace) => {
        let layout = start();
        for (const action of actions) {
          layout = reduceLayout(layout, action, catalog, workspace);
          // The stack lists exactly the open windows, each once.
          const open = ids.filter((id) => layout.windows[id]?.open);
          expect([...layout.order].sort()).toEqual([...open].sort());
          expect(new Set(layout.order).size).toBe(layout.order.length);
          for (const id of ids) {
            const record = layout.windows[id];
            if (!record) {
              throw new Error(`lost ${id}`);
            }
            const { minSize } = catalog.get(id);
            expect(record.bounds.width).toBeGreaterThanOrEqual(minSize.width);
            expect(record.bounds.height).toBeGreaterThanOrEqual(minSize.height);
            for (const value of Object.values(record.bounds)) {
              expect(Number.isInteger(value)).toBe(true);
            }
            if (record.open && record.mode !== 'minimized') {
              // The title bar can always be grabbed.
              const shown = displayBounds(record, workspace);
              expect(shown.y).toBeGreaterThanOrEqual(0);
              expect(shown.y).toBeLessThanOrEqual(workspace.height - TITLE_BAR_HEIGHT);
              expect(shown.x + shown.width).toBeGreaterThanOrEqual(Math.min(64, shown.width));
              expect(shown.x).toBeLessThanOrEqual(workspace.width - Math.min(64, shown.width));
            }
          }
          const active = activeWindow(layout);
          if (active !== null) {
            expect(layout.windows[active]?.mode).not.toBe('minimized');
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('closing and reopening a window restores its bounds and view exactly', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { maxLength: 30 }),
        fc.constantFrom(...ids),
        (actions, id) => {
          let layout = apply(start(), ...actions, { type: 'open', id }, { type: 'restore', id });
          const before = layout.windows[id];
          layout = apply(layout, { type: 'close', id }, { type: 'open', id });
          expect(layout.windows[id]).toEqual(before);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('placing in the workspace is idempotent', () => {
    fc.assert(
      fc.property(
        fc.record({
          x: coordinate,
          y: coordinate,
          width: fc.integer({ min: 1, max: 3000 }),
          height: fc.integer({ min: 1, max: 3000 }),
        }),
        workspaceArb,
        (bounds, workspace) => {
          const once = placeInWorkspace(bounds, workspace);
          expect(placeInWorkspace(once, workspace)).toEqual(once);
        },
      ),
    );
  });

  it('any reachable layout survives encoding and decoding unchanged', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 40 }), (actions) => {
        const layout = apply(start(), ...actions);
        const stored = JSON.parse(JSON.stringify(encodeLayout(layout))) as unknown;
        expect(decodeLayout(stored, catalog)).toEqual(layout);
      }),
      { numRuns: 200 },
    );
  });
});
