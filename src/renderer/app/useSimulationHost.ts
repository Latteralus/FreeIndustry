import { useCallback, useEffect, useRef, useState } from 'react';
import type { SimulationBridge } from '../../shared/bridge';
import type { ClockControl } from '../../shared/ipc/clock';
import type { CommandType } from '../../shared/ipc/commands';
import type { HostSnapshot, IpcError, IpcResult, WorldSnapshot } from '../../shared/ipc/contract';
import type { QueryResult, SimulationQuery } from '../../shared/ipc/facilities';
import type { NewWorldRequest } from '../../shared/ipc/real-estate';

/**
 * Renderer view of the simulation host. Holds presentation state only: the
 * latest snapshot received from the worker and the outcome of the last
 * request. It never computes or edits world state; every change is a
 * command the worker validates (spec §4.2), and clock control only asks the
 * worker to change its pacing.
 */

export type RequestOutcome =
  | {
      readonly kind: 'accepted';
      readonly worldRevision: number;
      readonly atMs: string;
      readonly duplicate: boolean;
    }
  | { readonly kind: 'rejected'; readonly error: IpcError };

export interface SimulationHostView {
  readonly snapshot: HostSnapshot | null;
  readonly lastOutcome: RequestOutcome | null;
  readonly pending: boolean;
  /**
   * Submit a command against the current world (or `against`, a world the
   * caller has just been given) and report its outcome.
   */
  submit(
    type: Exclude<CommandType, 'diagnostics.injectFault'>,
    payload: unknown,
    against?: WorldSnapshot,
  ): Promise<RequestOutcome | null>;
  /** Ask the worker a read-only question; null when it cannot be asked or failed. */
  query(query: SimulationQuery): Promise<QueryResult | null>;
  control(control: ClockControl): Promise<void>;
  restartWorker(): Promise<void>;
  /** Replace the world with a new one; resolves to the new snapshot, or null if refused. */
  newWorld(request: NewWorldRequest): Promise<HostSnapshot | null>;
}

export function useSimulationHost(
  bridge: SimulationBridge | null,
  newCommandId: () => string = () => crypto.randomUUID(),
): SimulationHostView {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [lastOutcome, setLastOutcome] = useState<RequestOutcome | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);

  const applySnapshot = useCallback((result: IpcResult<HostSnapshot>) => {
    if (!mounted.current) {
      return;
    }
    if (result.ok) {
      setSnapshot(result.value);
    } else {
      setLastOutcome({ kind: 'rejected', error: result.error });
    }
  }, []);

  const refresh = useCallback(async () => {
    if (bridge) {
      applySnapshot(await bridge.getSnapshot());
    }
  }, [bridge, applySnapshot]);

  useEffect(() => {
    mounted.current = true;
    if (!bridge) {
      return undefined;
    }
    // Any host event means the snapshot may have changed: fetch a fresh one
    // (a full resync, so a missed event can never leave the view stale).
    const resync = () => {
      void bridge.getSnapshot().then(applySnapshot);
    };
    const unsubscribe = bridge.subscribe(resync);
    resync();
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [bridge, applySnapshot]);

  const submit = useCallback(
    async (
      type: Exclude<CommandType, 'diagnostics.injectFault'>,
      payload: unknown,
      against?: WorldSnapshot,
    ): Promise<RequestOutcome | null> => {
      const world = against ?? snapshot?.world;
      if (!bridge || !world) {
        return null;
      }
      setPending(true);
      const result = await bridge.submitCommand({
        commandId: newCommandId(),
        worldInstanceId: world.worldInstanceId,
        expectedWorldRevision: world.worldRevision,
        type,
        payload,
      });
      const outcome: RequestOutcome = result.ok
        ? {
            kind: 'accepted',
            worldRevision: result.value.worldRevision,
            atMs: result.value.atMs,
            duplicate: result.value.duplicate,
          }
        : { kind: 'rejected', error: result.error };
      if (!mounted.current) {
        return outcome;
      }
      setPending(false);
      setLastOutcome(outcome);
      await refresh();
      return outcome;
    },
    [bridge, snapshot, newCommandId, refresh],
  );

  const query = useCallback(
    async (request: SimulationQuery): Promise<QueryResult | null> => {
      if (!bridge) {
        return null;
      }
      const result = await bridge.query(request);
      return result.ok ? result.value : null;
    },
    [bridge],
  );

  const newWorld = useCallback(
    async (request: NewWorldRequest): Promise<HostSnapshot | null> => {
      if (!bridge) {
        return null;
      }
      setPending(true);
      const result = await bridge.newWorld(request);
      if (!mounted.current) {
        return result.ok ? result.value : null;
      }
      setPending(false);
      if (result.ok) {
        setSnapshot(result.value);
        setLastOutcome(null);
        return result.value;
      }
      setLastOutcome({ kind: 'rejected', error: result.error });
      return null;
    },
    [bridge],
  );

  const control = useCallback(
    async (request: ClockControl) => {
      if (!bridge) {
        return;
      }
      const result = await bridge.control(request);
      if (!mounted.current) {
        return;
      }
      if (result.ok) {
        setSnapshot(result.value);
      } else {
        setLastOutcome({ kind: 'rejected', error: result.error });
      }
    },
    [bridge],
  );

  const restartWorker = useCallback(async () => {
    if (!bridge) {
      return;
    }
    setPending(true);
    const result = await bridge.restartWorker();
    if (!mounted.current) {
      return;
    }
    setPending(false);
    if (result.ok) {
      setSnapshot(result.value);
      setLastOutcome(null);
    } else {
      setLastOutcome({ kind: 'rejected', error: result.error });
    }
  }, [bridge]);

  return { snapshot, lastOutcome, pending, submit, query, control, restartWorker, newWorld };
}
