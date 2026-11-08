/**
 * Per-profile presentation preferences (ADR-0035): the UI scale, the
 * display units (ADR-0041) and the last window layout used, which a new world starts from. They are kept in
 * the renderer's own browser storage, which Electron keeps under the
 * profile's userData directory. They are not world state and never reach
 * the worker; the authoritative copy of a layout is the one in each save.
 */

export interface ProfileStore {
  read(key: ProfileKey): unknown;
  write(key: ProfileKey, value: unknown): void;
}

export type ProfileKey = 'layout' | 'uiScale' | 'units';

const PREFIX = 'freeindustry.profile.';

/** Browser storage; reads and writes that fail (quota, disabled storage) are ignored. */
export function browserProfileStore(storage: Storage | null): ProfileStore {
  return {
    read(key) {
      try {
        const text = storage?.getItem(PREFIX + key);
        return text === null || text === undefined ? null : (JSON.parse(text) as unknown);
      } catch {
        return null;
      }
    },
    write(key, value) {
      try {
        storage?.setItem(PREFIX + key, JSON.stringify(value));
      } catch {
        // A preference that cannot be stored is simply not remembered.
      }
    },
  };
}

/** In-memory store (tests, or when browser storage is unavailable). */
export function memoryProfileStore(initial: Partial<Record<ProfileKey, unknown>> = {}) {
  // Values go through JSON, as they would in browser storage.
  const copy = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null)) as unknown;
  const values = new Map<ProfileKey, unknown>(Object.entries(initial) as [ProfileKey, unknown][]);
  const store: ProfileStore & { readonly values: Map<ProfileKey, unknown> } = {
    values,
    read: (key) => (values.has(key) ? copy(values.get(key)) : null),
    write: (key, value) => {
      values.set(key, copy(value));
    },
  };
  return store;
}

/** UI scale choices, in percent (spec §3.2: configurable for modern displays). */
export const UI_SCALES = [100, 125, 150, 175, 200] as const;
export type UiScale = (typeof UI_SCALES)[number];

export function readUiScale(store: ProfileStore): UiScale {
  const value = store.read('uiScale');
  return UI_SCALES.find((scale) => scale === value) ?? 100;
}

/** Display units (spec §12.3: US customary by default; metric by setting). */
const UNIT_SYSTEMS = ['us', 'metric'] as const;
export type Units = (typeof UNIT_SYSTEMS)[number];

export function readUnits(store: ProfileStore): Units {
  const value = store.read('units');
  return UNIT_SYSTEMS.find((units) => units === value) ?? 'us';
}
