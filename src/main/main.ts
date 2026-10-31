import path from 'node:path';
import { app, BrowserWindow, dialog, session } from 'electron';
import started from 'electron-squirrel-startup';
import { ChatApiClient, DEFAULT_BASE_URL } from './api/client';
import { registerIpc } from './ipc';
import {
  APP_ORIGIN,
  applySessionPolicies,
  hardenWebContents,
  registerAppScheme,
  serveRenderer,
} from './security';

// Accesos directos de Windows al instalar o desinstalar con Squirrel.
if (started) {
  app.quit();
}

registerAppScheme();
hardenWebContents();

const devServerUrl: string | undefined = MAIN_WINDOW_VITE_DEV_SERVER_URL;
const rendererOrigin = devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN;

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }
};

app.whenReady().then(() => {
  let client: ChatApiClient;
  try {
    // URL del backend configurable; por defecto, el servidor local de desarrollo.
    client = new ChatApiClient({
      baseUrl: process.env.AI_ASSISTANT_API_URL || DEFAULT_BASE_URL,
    });
  } catch (err) {
    dialog.showErrorBox('Configuración no válida', (err as Error).message);
    app.quit();
    return;
  }

  applySessionPolicies(session.defaultSession, devServerUrl);
  if (!devServerUrl) {
    serveRenderer(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`));
  }
  registerIpc(client, (origin) => origin === rendererOrigin);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
