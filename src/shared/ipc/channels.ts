/**
 * IPC protocol constants (DECISIONS ADR-0013). Deliberately free of Zod and
 * every other import so the sandboxed preload can bundle it without pulling
 * in validation code it does not need: validation happens in main and worker.
 */

/** Version carried by every renderer request. Bump on any incompatible change. */
export const IPC_PROTOCOL_VERSION = 1;

/** The single renderer → main request channel (`ipcRenderer.invoke`). */
export const IPC_REQUEST_CHANNEL = 'freeindustry:request';

/** The single main → renderer push channel (`webContents.send`). */
export const IPC_EVENT_CHANNEL = 'freeindustry:event';
