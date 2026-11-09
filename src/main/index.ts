import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { PRODUCT_NAME } from '../shared/app-identity';
import { IPC_EVENT_CHANNEL, IPC_REQUEST_CHANNEL } from '../shared/ipc/channels';
import type { HostEvent } from '../shared/ipc/contract';
import { IpcGateway, type DialogPort, type RequestSender } from './ipc-gateway';
import { describeError, FileLogger } from './logger';
import {
  denyAllPermissions,
  isAllowedExternalUrl,
  isAllowedNavigation,
  isTrustedRendererUrl,
  secureWebPreferences,
  type RendererLocation,
} from './window-security';
import { WorkerSupervisor } from './worker-supervisor';

/**
 * Electron main process: windows, lifecycle, file dialogs and the IPC
 * broker. It owns no world state, performs no business calculations and
 * never opens a save database — the simulation worker does (spec §4.2).
 */

// Development and test overrides. Ignored in packaged builds.
const unpackagedEnv = (name: string): string | undefined =>
  app.isPackaged ? undefined : process.env[name];

const userDataOverride = unpackagedEnv('FREEINDUSTRY_USER_DATA_DIR');
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
}
const faultInjectionEnabled = unpackagedEnv('FREEINDUSTRY_FAULT_INJECTION') === '1';
/** The factory scene's read-only measurement probe for real-app tests (ADR-0051). */
const sceneProbeEnabled = unpackagedEnv('FREEINDUSTRY_SCENE_PROBE') === '1';

// One running FreeIndustry per user profile, so a save file and the recovery
// log only ever have one writer (ADR-0027). A second launch focuses the first.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
}

/** Fixed world seed for reproducible tests (`FREEINDUSTRY_WORLD_SEED`, unpackaged only). */
function seedOverride(): number | null {
  const text = unpackagedEnv('FREEINDUSTRY_WORLD_SEED');
  if (text === undefined || !/^(?:0|[1-9][0-9]{0,9})$/.test(text)) {
    return null;
  }
  const seed = Number(text);
  return seed <= 0xffff_ffff ? seed : null;
}
const worldSeed = seedOverride();

const rendererLocation: RendererLocation = {
  indexFileUrl: pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href,
  devServerUrl: unpackagedEnv('ELECTRON_RENDERER_URL'),
};

const logger = new FileLogger({
  directory: join(app.getPath('userData'), 'logs'),
  mirrorToConsole: !app.isPackaged,
});

let mainWindow: BrowserWindow | null = null;

function broadcast(event: HostEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_EVENT_CHANNEL, event);
  }
}

const supervisor = new WorkerSupervisor({
  createWorker: (workerData) => new Worker(join(import.meta.dirname, 'worker.js'), { workerData }),
  faultInjectionEnabled,
  seed: worldSeed,
  dataDirectory: app.getPath('userData'),
  appVersion: app.getVersion(),
  logger,
  onEvent: (event) => {
    if (event.type === 'worker.status') {
      logger.log('info', 'Worker status', {
        state: event.worker.state,
        generation: event.worker.generation,
      });
    }
    broadcast(event);
  },
});

const SAVE_FILTERS = [{ name: 'FreeIndustry save', extensions: ['fisave'] }];

/** Native dialogs; the chosen paths go to the worker and never to the renderer. */
const dialogs: DialogPort = {
  async chooseExportPath(suggestedFileName) {
    const options = {
      title: 'Export save',
      defaultPath: join(app.getPath('documents'), suggestedFileName),
      filters: SAVE_FILTERS,
    };
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  async chooseImportPath() {
    const options = {
      title: 'Import save',
      filters: SAVE_FILTERS,
      properties: ['openFile' as const],
    };
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
};

const gateway = new IpcGateway({
  worker: supervisor,
  dialogs,
  isTrustedUrl: (url) => isTrustedRendererUrl(url, rendererLocation),
  faultInjectionEnabled,
  logger,
});

function senderOf(event: IpcMainInvokeEvent): RequestSender {
  const frame = event.senderFrame;
  return {
    frameUrl: frame?.url,
    isAppMainFrame:
      mainWindow !== null &&
      !mainWindow.isDestroyed() &&
      event.sender === mainWindow.webContents &&
      frame !== null &&
      frame === event.sender.mainFrame,
  };
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#808080',
    webPreferences: secureWebPreferences(join(import.meta.dirname, '../preload/index.cjs'), {
      sceneProbe: sceneProbeEnabled,
    }),
  });

  window.once('ready-to-show', () => {
    window.show();
  });
  if (!app.isPackaged) {
    // The application menu is removed (ADR-0035), and with it DevTools' shortcut.
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        window.webContents.toggleDevTools();
      }
    });
  }
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (rendererLocation.devServerUrl) {
    void window.loadURL(rendererLocation.devServerUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return window;
}

// Refuse navigation away from the bundled UI, pop-up windows and <webview>.
// External https links, if any are ever shown, open in the user's own browser.
app.on('web-contents-created', (_event, contents) => {
  const refuseUnlessAllowed = (event: { preventDefault(): void }, url: string) => {
    if (!isAllowedNavigation(url, rendererLocation)) {
      event.preventDefault();
      logger.log('warn', 'Blocked renderer navigation', { url });
    }
  };
  contents.on('will-navigate', refuseUnlessAllowed);
  contents.on('will-redirect', refuseUnlessAllowed);
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
});

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});

void app.whenReady().then(() => {
  if (!primaryInstance) {
    return;
  }
  logger.log('info', 'FreeIndustry starting', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron,
    faultInjectionEnabled,
    worldSeed,
  });
  denyAllPermissions(session.defaultSession);
  // The menubar is drawn by the renderer (spec §3.2). Electron's default menu,
  // hidden or not, would answer Alt and F10 and offer Reload and DevTools.
  Menu.setApplicationMenu(null);
  ipcMain.handle(IPC_REQUEST_CHANNEL, (event, raw: unknown) =>
    gateway.handle(senderOf(event), raw),
  );
  supervisor.start();
  mainWindow = createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// Graceful shutdown: let the worker stop cleanly (autosave a changed world,
// close its recovery log) before the process exits.
let shutdown: 'idle' | 'running' | 'done' = 'idle';
app.on('before-quit', (event) => {
  if (shutdown === 'done') {
    return;
  }
  const { state } = supervisor.status;
  if (shutdown === 'idle' && state !== 'ready' && state !== 'starting') {
    return;
  }
  event.preventDefault();
  if (shutdown === 'running') {
    return;
  }
  shutdown = 'running';
  logger.log('info', 'Shutting down');
  supervisor
    .stop()
    .catch((error: unknown) => {
      logger.log('error', 'Error while stopping the simulation worker', describeError(error));
    })
    .finally(() => {
      shutdown = 'done';
      logger.log('info', 'Shutdown complete');
      app.quit();
    });
});
