import fc from 'fast-check';
import { decodeLayout, encodeLayout } from '../../../src/renderer/app/desktop/layout-codec';
import {
  browserProfileStore,
  memoryProfileStore,
  readUiScale,
} from '../../../src/renderer/app/desktop/profile-store';
import { WINDOW_CATALOG } from '../../../src/renderer/app/desktop/window-catalog';
import { reduceLayout } from '../../../src/renderer/app/desktop/window-model';
import { canonicalJson } from '../../../src/shared/canonical-json';
import { workspaceUpdateSchema } from '../../../src/shared/ipc/saves';

const catalog = WINDOW_CATALOG;

describe('desktop layout codec', () => {
  it('a layout from a save is untrusted: anything malformed is ignored as a whole', () => {
    const valid = encodeLayout(catalog.defaultLayout());
    const bad: unknown[] = [
      null,
      'layout',
      42,
      [],
      {},
      { ...valid, version: 2 },
      { ...valid, extra: true },
      { ...valid, order: 'company' },
      { ...valid, windows: { company: { ...valid.windows['company'], open: 'yes' } } },
      {
        ...valid,
        windows: {
          company: {
            ...valid.windows['company'],
            bounds: { x: 1.5, y: 0, width: 400, height: 300 },
          },
        },
      },
      {
        ...valid,
        windows: {
          company: {
            ...valid.windows['company'],
            bounds: { x: 1e9, y: 0, width: 400, height: 300 },
          },
        },
      },
      { ...valid, windows: { company: { ...valid.windows['company'], mode: 'fullscreen' } } },
      {
        ...valid,
        windows: { company: { ...valid.windows['company'], view: { tab: 'x'.repeat(65) } } },
      },
      {
        ...valid,
        windows: { company: { ...valid.windows['company'], view: { script: 'alert(1)' } } },
      },
    ];
    for (const value of bad) {
      expect(decodeLayout(value, catalog)).toBeNull();
    }
  });

  it('drops windows this build does not know and adds the ones a save does not mention', () => {
    const stored = {
      version: 1,
      windows: {
        company: {
          open: true,
          bounds: { x: 5, y: 6, width: 400, height: 300 },
          mode: 'normal',
          view: {},
        },
        personnel: {
          open: true,
          bounds: { x: 5, y: 6, width: 400, height: 300 },
          mode: 'normal',
          view: {},
        },
      },
      order: ['personnel', 'company', 'company'],
    };
    const layout = decodeLayout(stored, catalog);
    expect(layout?.order).toEqual(['company']);
    expect(Object.keys(layout?.windows ?? {}).sort()).toEqual([...catalog.ids].sort());
    expect(layout?.windows['accounts']).toEqual({
      open: false,
      bounds: catalog.get('accounts').defaultBounds,
      mode: 'normal',
      view: {},
    });
  });

  it('repairs a stack that misses an open window, and enforces minimum sizes', () => {
    const stored = {
      version: 1,
      windows: {
        company: {
          open: true,
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          mode: 'normal',
          view: {},
        },
        bills: {
          open: true,
          bounds: { x: 0, y: 0, width: 500, height: 300 },
          mode: 'minimized',
          view: {},
        },
      },
      order: ['company'],
    };
    const layout = decodeLayout(stored, catalog);
    expect(layout?.order).toEqual(['bills', 'company']);
    expect(layout?.windows['company']?.bounds).toMatchObject(catalog.get('company').minSize);
  });

  it('a full layout fits the workspace value limit and passes main’s validation', () => {
    let layout = catalog.defaultLayout();
    for (const id of catalog.ids) {
      layout = reduceLayout(layout, { type: 'open', id }, catalog, null);
      layout = reduceLayout(
        layout,
        {
          type: 'setView',
          id,
          view: {
            tab: 't'.repeat(64),
            sort: { column: 'c'.repeat(64), direction: 'desc' },
            filters: Object.fromEntries(
              Array.from({ length: 8 }, (_, index) => [`${index}`.padEnd(32, 'k'), 'v'.repeat(64)]),
            ),
          },
        },
        catalog,
        null,
      );
    }
    const value = encodeLayout(layout);
    expect(canonicalJson(value).length).toBeLessThan(16 * 1024);
    expect(workspaceUpdateSchema.safeParse({ key: 'desktop.layout', value }).success).toBe(true);
    expect(decodeLayout(JSON.parse(JSON.stringify(value)), catalog)).toEqual(layout);
  });

  it('never throws on arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const layout = decodeLayout(value, catalog);
        if (layout) {
          expect(new Set(layout.order).size).toBe(layout.order.length);
        }
      }),
    );
  });
});

describe('profile preferences', () => {
  it('reads back what was written, and ignores storage that fails', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    } as unknown as Storage;
    const store = browserProfileStore(storage);
    store.write('uiScale', 150);
    expect(data.get('freeindustry.profile.uiScale')).toBe('150');
    expect(readUiScale(store)).toBe(150);

    const broken = browserProfileStore({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage);
    expect(() => {
      broken.write('layout', {});
    }).not.toThrow();
    expect(broken.read('layout')).toBeNull();
    expect(browserProfileStore(null).read('uiScale')).toBeNull();
  });

  it('accepts only the offered UI scales', () => {
    expect(readUiScale(memoryProfileStore({ uiScale: 175 }))).toBe(175);
    for (const value of [0, 90, 1000, '150', null]) {
      expect(readUiScale(memoryProfileStore({ uiScale: value }))).toBe(100);
    }
  });
});
