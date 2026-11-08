import { contextBridge } from 'electron';
import type { FreeIndustryBridge } from '../shared/bridge';

// Sandboxed preload: only Electron's renderer-safe modules are available.
// Expose a deliberately narrow, frozen surface; never Node or raw IPC primitives.
const bridge: FreeIndustryBridge = Object.freeze({
  runtime: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }),
});

contextBridge.exposeInMainWorld('freeIndustry', bridge);
