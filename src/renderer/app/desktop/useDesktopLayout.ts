import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkspaceBridge } from '../../../shared/bridge';
import type { WorkspaceUpdate } from '../../../shared/ipc/saves';
import { decodeLayout, encodeLayout, LAYOUT_KEY } from './layout-codec';
import type { ProfileStore } from './profile-store';
import {
  activeWindow,
  reduceLayout,
  type DesktopLayout,
  type Size,
  type WindowAction,
  type WindowCatalog,
} from './window-model';

/**
 * The desktop layout and its persistence (ADR-0035).
 *
 * - Each world keeps its layout in its workspace settings (`desktop.layout`),
 *   which travel with its saves. Whenever the loaded world changes (a load, a
 *   worker restart) the layout is read back from the worker.
 * - A world with no layout yet (a new world) keeps the layout on screen and
 *   stores it, so a save made straight away still holds it.
 * - The last layout used is also kept in the profile, so the next launch
 *   starts from it.
 * - Changes are written shortly after they stop (not on every pixel of a
 *   drag); `flush` writes a pending change at once, before a save or load.
 *
 * None of this is world state: workspace settings are outside every
 * fingerprint and are not journaled, so window activity cannot change an
 * outcome (spec §14.1 "UI integrity").
 */

export interface DesktopLayoutOptions {
  readonly catalog: WindowCatalog;
  readonly workspace: WorkspaceBridge | null;
  /** Identity of the loaded world instance; null while there is none. */
  readonly worldKey: string | null;
  readonly profile: ProfileStore;
  /** Current workspace size, for keeping windows reachable. */
  readonly workspaceSize: Size | null;
  /** Quiet period before a change is written (ms). */
  readonly writeDelayMs?: number;
}

export interface DesktopLayoutView {
  readonly layout: DesktopLayout;
  /**
   * Apply a window-manager action. With `focus`, the keyboard focus moves
   * into whichever window is active afterwards (menu and shortcut commands).
   */
  readonly dispatch: (action: WindowAction, focus?: boolean) => void;
  /** Write any pending layout change now. */
  readonly flush: () => Promise<void>;
}

/** The encoded layout is plain JSON (numbers, strings, booleans, objects, arrays). */
const asJson = (layout: DesktopLayout) =>
  encodeLayout(layout) as unknown as NonNullable<WorkspaceUpdate['value']>;

export function useDesktopLayout({
  catalog,
  workspace,
  worldKey,
  profile,
  workspaceSize,
  writeDelayMs = 300,
}: DesktopLayoutOptions): DesktopLayoutView {
  const [layout, setLayout] = useState<DesktopLayout>(
    () => decodeLayout(profile.read('layout'), catalog) ?? catalog.defaultLayout(),
  );
  const layoutRef = useRef(layout);
  const sizeRef = useRef(workspaceSize);
  useLayoutEffect(() => {
    layoutRef.current = layout;
    sizeRef.current = workspaceSize;
  });
  const worldRef = useRef(worldKey);
  /** The layout last read from or written to the store: no need to write it again. */
  const settled = useRef<DesktopLayout>(layout);
  const pending = useRef<DesktopLayout | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPending = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
  }, []);

  const write = useCallback(async () => {
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) {
      return;
    }
    settled.current = next;
    const value = asJson(next);
    profile.write('layout', value);
    if (workspace && worldRef.current !== null) {
      // A failure (worker stopped) only means this world forgets the change.
      await workspace.set({ key: LAYOUT_KEY, value });
    }
  }, [profile, workspace]);

  // A different world: show and keep its layout.
  useEffect(() => {
    worldRef.current = worldKey;
    cancelPending();
    if (!workspace || worldKey === null) {
      return undefined;
    }
    let current = true;
    void workspace.get().then((result) => {
      if (!current || worldRef.current !== worldKey || !result.ok) {
        return;
      }
      const stored = decodeLayout(result.value.settings[LAYOUT_KEY], catalog);
      if (stored) {
        settled.current = stored;
        setLayout(stored);
        profile.write('layout', asJson(stored));
      } else {
        const kept = layoutRef.current;
        settled.current = kept;
        void workspace.set({ key: LAYOUT_KEY, value: asJson(kept) });
      }
    });
    return () => {
      current = false;
    };
  }, [workspace, worldKey, catalog, profile, cancelPending]);

  // A change made on screen: write it once things are quiet.
  useEffect(() => {
    if (layout === settled.current) {
      return;
    }
    pending.current = layout;
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      void write();
    }, writeDelayMs);
  }, [layout, write, writeDelayMs]);

  // On unmount, a pending change is written rather than dropped.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        void write();
      }
    },
    [write],
  );

  const focusRequest = useRef(false);
  const dispatch = useCallback(
    (action: WindowAction, focus = false) => {
      focusRequest.current = focus;
      setLayout((previous) => reduceLayout(previous, action, catalog, sizeRef.current));
    },
    [catalog],
  );

  // After a menu or shortcut command, the active window takes the keyboard focus.
  useEffect(() => {
    if (!focusRequest.current) {
      return;
    }
    focusRequest.current = false;
    const id = activeWindow(layout);
    if (id !== null) {
      document.querySelector<HTMLElement>(`[data-window-id="${id}"]`)?.focus();
    }
  }, [layout]);

  const flush = useCallback(async () => {
    if (pending.current === null && layoutRef.current !== settled.current) {
      pending.current = layoutRef.current;
    }
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    await write();
  }, [write]);

  return { layout, dispatch, flush };
}
