import { z } from 'zod';
import {
  MAX_COORDINATE,
  normalizeBounds,
  type DesktopLayout,
  type WindowCatalog,
  type WindowRecord,
  type WindowView,
} from './window-model';

/**
 * Reading and writing the desktop layout as a workspace setting
 * (`desktop.layout`, ADR-0028). A layout comes from a save file, which may
 * have been imported from anywhere, so it is validated like any other
 * untrusted input: an unreadable layout is ignored, never trusted in part.
 * Windows this build does not know (a newer save) are dropped; windows the
 * save does not mention (an older save) get their defaults.
 */

export const LAYOUT_KEY = 'desktop.layout';

const MAX_VIEW_TEXT = 64;
/**
 * Remembered filters per window, and the length of a filter's name. With
 * these limits the largest possible layout of every window stays well under
 * the 16 KiB workspace value limit (ADR-0041); revisit as windows are added.
 */
const MAX_FILTERS = 8;
const MAX_FILTER_KEY = 32;

const coordinate = z.int().min(-MAX_COORDINATE).max(MAX_COORDINATE);
const viewText = z.string().min(1).max(MAX_VIEW_TEXT);

const viewSchema = z.strictObject({
  tab: viewText.optional(),
  sort: z.strictObject({ column: viewText, direction: z.enum(['asc', 'desc']) }).optional(),
  filters: z
    .record(z.string().min(1).max(MAX_FILTER_KEY), z.string().max(MAX_VIEW_TEXT))
    .refine((filters) => Object.keys(filters).length <= MAX_FILTERS)
    .optional(),
});

const recordSchema = z.strictObject({
  open: z.boolean(),
  bounds: z.strictObject({ x: coordinate, y: coordinate, width: coordinate, height: coordinate }),
  mode: z.enum(['normal', 'minimized', 'maximized']),
  view: viewSchema,
});

const layoutSchema = z.strictObject({
  version: z.literal(1),
  windows: z.record(z.string().max(MAX_VIEW_TEXT), recordSchema),
  order: z.array(z.string().max(MAX_VIEW_TEXT)).max(256),
});

/** Optional members as Zod reports them: possibly present but undefined. */
interface LooseView {
  readonly tab?: string | undefined;
  readonly sort?: { readonly column: string; readonly direction: 'asc' | 'desc' } | undefined;
  readonly filters?: Readonly<Record<string, string>> | undefined;
}

/** A view with no undefined members, so it is plain JSON. */
function cleanView(view: LooseView): WindowView {
  return {
    ...(view.tab === undefined ? {} : { tab: view.tab }),
    ...(view.sort === undefined
      ? {}
      : { sort: { column: view.sort.column, direction: view.sort.direction } }),
    ...(view.filters === undefined ? {} : { filters: { ...view.filters } }),
  };
}

/** Parse a stored layout; null when it is missing or not a valid layout. */
export function decodeLayout(value: unknown, catalog: WindowCatalog): DesktopLayout | null {
  const parsed = layoutSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const defaults = catalog.defaultLayout();
  const windows: Record<string, WindowRecord> = { ...defaults.windows };
  for (const id of catalog.ids) {
    const stored = parsed.data.windows[id];
    if (stored) {
      windows[id] = {
        open: stored.open,
        bounds: normalizeBounds(stored.bounds, catalog.get(id).minSize),
        mode: stored.mode,
        view: cleanView(stored.view),
      };
    } else {
      const fallback = defaults.windows[id];
      if (fallback) {
        windows[id] = { ...fallback, open: false };
      }
    }
  }
  // The stacking order lists each open, known window once, back to front.
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of parsed.data.order) {
    if (windows[id]?.open && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const id of catalog.ids) {
    const record = windows[id];
    if (record?.open && !seen.has(id)) {
      // Open but not stacked: put it at the back rather than lose it.
      order.unshift(id);
      seen.add(id);
    }
  }
  return { version: 1, windows, order };
}

/** The layout as plain JSON for the workspace store. */
export function encodeLayout(layout: DesktopLayout): DesktopLayout {
  const windows: Record<string, WindowRecord> = {};
  for (const [id, record] of Object.entries(layout.windows)) {
    windows[id] = {
      open: record.open,
      bounds: { ...record.bounds },
      mode: record.mode,
      view: cleanView(record.view),
    };
  }
  return { version: 1, windows, order: [...layout.order] };
}
