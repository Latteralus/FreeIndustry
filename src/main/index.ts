import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { PRODUCT_NAME } from '../shared/app-identity';
import { secureWebPreferences } from './window-security';

/**
 * Electron main process. It owns platform concerns only (windows, lifecycle,
 * and, from Step 02, the IPC broker and simulation worker). It never performs
 * business calculations and never opens the save database.
 */

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#808080',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(join(import.meta.dirname, '../preload/index.cjs')),
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return window;
}

// Refuse navigation away from the bundled UI and refuse in-app pop-up windows.
// External https links, if any are ever shown, open in the user's own browser.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!(devServerUrl && url.startsWith(devServerUrl))) {
      event.preventDefault();
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
});

void app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
