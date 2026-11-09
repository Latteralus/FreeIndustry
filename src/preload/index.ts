import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  FreeIndustryBridge,
  SavesBridge,
  SimulationBridge,
  WorkspaceBridge,
} from '../shared/bridge';
import {
  IPC_EVENT_CHANNEL,
  IPC_PROTOCOL_VERSION,
  IPC_REQUEST_CHANNEL,
} from '../shared/ipc/channels';
import type { HostEvent } from '../shared/ipc/contract';

// Sandboxed preload: only Electron's renderer-safe modules are available.
// It exposes a deliberately narrow, frozen surface. The renderer never sees
// ipcRenderer, channel names, Node objects or the IpcRendererEvent; it can
// only call these fixed methods, and main validates every request.

function request<T>(body: Record<string, unknown>): Promise<T> {
  return ipcRenderer.invoke(IPC_REQUEST_CHANNEL, {
    protocolVersion: IPC_PROTOCOL_VERSION,
    ...body,
  }) as Promise<T>;
}

const simulation: SimulationBridge = Object.freeze({
  getSnapshot: () => request({ method: 'simulation.getSnapshot' }),
  submitCommand: (envelope) => request({ method: 'simulation.submitCommand', envelope }),
  query: (query) => request({ method: 'simulation.query', query }),
  control: (control) => request({ method: 'simulation.control', control }),
  restartWorker: () => request({ method: 'simulation.restartWorker' }),
  newWorld: (world) => request({ method: 'simulation.newWorld', world }),
  subscribe: (listener: (event: HostEvent) => void) => {
    const forward = (_event: IpcRendererEvent, payload: HostEvent) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_EVENT_CHANNEL, forward);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, forward);
    };
  },
} satisfies SimulationBridge);

const saves: SavesBridge = Object.freeze({
  list: () => request({ method: 'saves.list' }),
  save: (saveRequest) => request({ method: 'saves.save', request: saveRequest }),
  load: (saveId) => request({ method: 'saves.load', saveId }),
  exportSave: (saveId) => request({ method: 'saves.export', saveId }),
  importSave: () => request({ method: 'saves.import' }),
} satisfies SavesBridge);

const workspace: WorkspaceBridge = Object.freeze({
  get: () => request({ method: 'workspace.get' }),
  set: (update) => request({ method: 'workspace.set', update }),
} satisfies WorkspaceBridge);

const bridge: FreeIndustryBridge = Object.freeze({
  protocolVersion: IPC_PROTOCOL_VERSION,
  runtime: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    // Set by main only in unpackaged test runs (ADR-0051); mirrors SCENE_PROBE_ARGUMENT.
    sceneProbe: process.argv.includes('--freeindustry-scene-probe'),
  }),
  simulation,
  saves,
  workspace,
});

contextBridge.exposeInMainWorld('freeIndustry', bridge);
