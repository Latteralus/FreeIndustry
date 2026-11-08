import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavesBridge, SimulationBridge } from '../../shared/bridge';
import type { IpcError, IpcResult } from '../../shared/ipc/contract';
import type { SaveSummary } from '../../shared/ipc/saves';

/**
 * Renderer view of the save slots. Presentation state only: the list the
 * worker last reported and the outcome of the last save action. Every
 * action is a request the worker validates; the renderer never sees a path.
 */

interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface SavesView {
  readonly saves: readonly SaveSummary[] | null;
  readonly outcome: string | null;
  readonly busy: boolean;
  saveNew(name: string): Promise<ActionResult>;
  overwrite(save: SaveSummary): Promise<ActionResult>;
  load(save: SaveSummary): Promise<ActionResult>;
  exportSave(save: SaveSummary): Promise<ActionResult>;
  importSave(): Promise<ActionResult>;
}

export interface SavesOptions {
  /**
   * Called before the world is written or replaced (save, overwrite, load),
   * so presentation settings that travel with a save (the window layout) are
   * stored first.
   */
  readonly beforeWorldChange?: () => Promise<void>;
}

const failed = (action: string, error: IpcError): ActionResult => ({
  ok: false,
  message: `${action} failed (${error.code}): ${error.message}`,
});
const done = (message: string): ActionResult => ({ ok: true, message });
const UNAVAILABLE: ActionResult = { ok: false, message: 'Saves are unavailable' };

export function useSaves(
  bridge: SavesBridge | null,
  simulation: SimulationBridge | null,
  options: SavesOptions = {},
): SavesView {
  const [saves, setSaves] = useState<readonly SaveSummary[] | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const { beforeWorldChange } = options;

  const apply = useCallback((result: IpcResult<SaveSummary[]>) => {
    if (!mounted.current) {
      return;
    }
    if (result.ok) {
      setSaves(result.value);
    } else {
      setOutcome(failed('Listing saves', result.error).message);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (bridge) {
      apply(await bridge.list());
    }
  }, [bridge, apply]);

  useEffect(() => {
    mounted.current = true;
    if (!bridge) {
      return undefined;
    }
    // Saves change on autosave, recovery, import and load: refetch the list whenever told so.
    const resync = () => {
      void bridge.list().then(apply);
    };
    const unsubscribe = simulation?.subscribe((event) => {
      if (event.type === 'saves.changed' || event.type === 'worker.status') {
        resync();
      }
    });
    resync();
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, [bridge, simulation, apply]);

  const run = useCallback(
    async (action: (saves: SavesBridge) => Promise<ActionResult>, changesWorld: boolean) => {
      if (!bridge) {
        setOutcome(UNAVAILABLE.message);
        return UNAVAILABLE;
      }
      setBusy(true);
      if (changesWorld) {
        await beforeWorldChange?.();
      }
      const result = await action(bridge);
      if (!mounted.current) {
        return result;
      }
      setBusy(false);
      setOutcome(result.message);
      await refresh();
      return result;
    },
    [bridge, refresh, beforeWorldChange],
  );

  return {
    saves,
    outcome,
    busy,
    saveNew: (name) =>
      run(async (saves) => {
        const result = await saves.save({ name, saveId: null });
        return result.ok ? done(`Saved "${name}".`) : failed('Save', result.error);
      }, true),
    overwrite: (save) =>
      run(async (saves) => {
        if (save.name === null) {
          return UNAVAILABLE;
        }
        const result = await saves.save({ name: save.name, saveId: save.saveId });
        return result.ok ? done(`Saved over "${save.name}".`) : failed('Save', result.error);
      }, true),
    load: (save) =>
      run(async (saves) => {
        const result = await saves.load(save.saveId);
        return result.ok
          ? done(`Loaded "${save.name ?? save.saveId}".`)
          : failed('Load', result.error);
      }, true),
    exportSave: (save) =>
      run(async (saves) => {
        const result = await saves.exportSave(save.saveId);
        if (!result.ok) {
          return failed('Export', result.error);
        }
        return result.value.status === 'exported'
          ? done(`Exported "${save.name ?? save.saveId}".`)
          : done('Export cancelled.');
      }, false),
    importSave: () =>
      run(async (saves) => {
        const result = await saves.importSave();
        if (!result.ok) {
          return failed('Import', result.error);
        }
        return result.value.status === 'imported'
          ? done(`Imported "${result.value.save.name ?? result.value.save.saveId}".`)
          : done('Import cancelled.');
      }, false),
  };
}
